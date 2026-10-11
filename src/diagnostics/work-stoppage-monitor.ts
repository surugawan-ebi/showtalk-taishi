import { createHash } from "node:crypto";

import type { AgentAdapter, SendMessageRequest } from "../core/adapter.js";
import type {
  AdapterSession,
  AgentApproval,
  AgentCapabilities,
  AgentEvent,
  AgentStatus,
  AgentUserInputResponse,
} from "../core/types.js";
import type {
  CreateSessionRequest,
  ResumeSessionRequest,
} from "../core/adapter.js";
import type { InteractionAuditInput } from "./approval-delivery-audit.js";

export type KoeExecutionState =
  | "queued"
  | "running"
  | "tool_running"
  | "waiting_for_input"
  | "failed"
  | "terminal"
  | "unknown";

export type WorkAttentionReason =
  | "hidden_approval_wait"
  | "visible_approval_wait"
  | "queued_progress_stall_suspected"
  | "running_progress_stall_suspected"
  | "tool_progress_stall_suspected"
  | "execution_failed"
  | "connection_lost";

export type WorkAttentionNextAction =
  | "check_slack_controls"
  | "respond_in_slack"
  | "inspect_queue"
  | "inspect_progress"
  | "inspect_tool"
  | "inspect_failure"
  | "check_connection"
  | "no_action_recovered";

export interface WorkAttentionNotification {
  readonly component: "showtalk.work_attention";
  readonly version: 1;
  readonly event: "attention_required" | "recovered";
  readonly incidentRef: string;
  readonly occurrence: number;
  readonly agentId: string;
  readonly sourceChannelId?: string;
  readonly sourceRootThreadTs?: string;
  readonly state: KoeExecutionState;
  readonly reason: WorkAttentionReason;
  readonly lastProgressAt: string;
  readonly detectedAt: string;
  readonly nextAction: WorkAttentionNextAction;
}

export interface WorkAttentionDeliveryFailure {
  readonly component: "showtalk.work_attention";
  readonly version: 1;
  readonly event: "notification_delivery_failed";
  readonly incidentRef: string;
  readonly agentId: string;
  readonly reason: WorkAttentionReason;
  readonly detectedAt: string;
}

export interface PersistedWorkAttentionIncident {
  readonly agentId: string;
  readonly sourceChannelId?: string;
  readonly sourceRootThreadTs?: string;
  readonly reason: WorkAttentionReason;
  readonly occurrence: number;
  readonly active: boolean;
  readonly openedAt: string;
  readonly lastProgressAt: string;
  readonly notificationAttempted: boolean;
}

export interface WorkStoppageMonitorSnapshot {
  readonly version: 1;
  readonly incidents: readonly PersistedWorkAttentionIncident[];
}

export interface WorkStoppageMonitorOptions {
  readonly now?: () => number;
  readonly notify?: (notification: WorkAttentionNotification) => void | Promise<void>;
  readonly observeDeliveryFailure?: (event: WorkAttentionDeliveryFailure) => void;
  readonly onSnapshotChanged?: (snapshot: WorkStoppageMonitorSnapshot) => void;
  readonly hiddenWaitGraceMs?: number;
  readonly queuedStallMs?: number;
  readonly runningStallMs?: number;
  readonly toolStallMs?: number;
  readonly connectionGraceMs?: number;
  readonly snapshot?: WorkStoppageMonitorSnapshot;
}

export interface KoeRuntimeObservation {
  readonly agentId: string;
  readonly state: KoeExecutionState;
  readonly sessionId?: string;
  readonly sourceChannelId?: string;
  readonly sourceRootThreadTs?: string;
  readonly updatedAt?: string;
}

interface PendingInput {
  readonly requestId: string;
  readonly kind: "approval" | "input";
  readonly startedAt: number;
  visible: boolean;
}

interface KoeRuntimeState {
  state: KoeExecutionState;
  stateSince: number;
  lastProgressAt: number;
  sessionId?: string;
  sourceChannelId?: string;
  sourceRootThreadTs?: string;
  disconnectedAt?: number;
  readonly activeTools: Set<string>;
  readonly pendingInputs: Map<string, PendingInput>;
}

interface IncidentState {
  agentId: string;
  sourceChannelId?: string;
  sourceRootThreadTs?: string;
  reason: WorkAttentionReason;
  occurrence: number;
  active: boolean;
  openedAt: number;
  lastProgressAt: number;
  notificationAttempted: boolean;
}

const DEFAULT_HIDDEN_WAIT_GRACE_MS = 30_000;
const DEFAULT_QUEUED_STALL_MS = 5 * 60_000;
const DEFAULT_RUNNING_STALL_MS = 15 * 60_000;
const DEFAULT_TOOL_STALL_MS = 60 * 60_000;
const DEFAULT_CONNECTION_GRACE_MS = 30_000;
const MAX_PERSISTED_INCIDENTS = 512;

/**
 * Deterministic, payload-free work-state classifier. It never calls an LLM and
 * never resolves, retries, interrupts, or restarts work.
 */
export class WorkStoppageMonitor {
  readonly #now: () => number;
  readonly #notify: NonNullable<WorkStoppageMonitorOptions["notify"]>;
  readonly #observeDeliveryFailure: NonNullable<
    WorkStoppageMonitorOptions["observeDeliveryFailure"]
  >;
  readonly #onSnapshotChanged: NonNullable<
    WorkStoppageMonitorOptions["onSnapshotChanged"]
  >;
  readonly #hiddenWaitGraceMs: number;
  readonly #queuedStallMs: number;
  readonly #runningStallMs: number;
  readonly #toolStallMs: number;
  readonly #connectionGraceMs: number;
  readonly #states = new Map<string, KoeRuntimeState>();
  readonly #agentIdBySessionId = new Map<string, string>();
  readonly #agentIdByRequestId = new Map<string, string>();
  readonly #incidents = new Map<string, IncidentState>();

  constructor(options: WorkStoppageMonitorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#notify = options.notify ?? (() => undefined);
    this.#observeDeliveryFailure = options.observeDeliveryFailure ?? (() => undefined);
    this.#onSnapshotChanged = options.onSnapshotChanged ?? (() => undefined);
    this.#hiddenWaitGraceMs = boundedDuration(
      options.hiddenWaitGraceMs,
      DEFAULT_HIDDEN_WAIT_GRACE_MS,
      "hiddenWaitGraceMs",
    );
    this.#queuedStallMs = boundedDuration(
      options.queuedStallMs,
      DEFAULT_QUEUED_STALL_MS,
      "queuedStallMs",
    );
    this.#runningStallMs = boundedDuration(
      options.runningStallMs,
      DEFAULT_RUNNING_STALL_MS,
      "runningStallMs",
    );
    this.#toolStallMs = boundedDuration(
      options.toolStallMs,
      DEFAULT_TOOL_STALL_MS,
      "toolStallMs",
    );
    this.#connectionGraceMs = boundedDuration(
      options.connectionGraceMs,
      DEFAULT_CONNECTION_GRACE_MS,
      "connectionGraceMs",
    );
    for (const incident of validateWorkStoppageMonitorSnapshot(
      options.snapshot ?? emptyWorkStoppageMonitorSnapshot(),
    ).incidents) {
      this.#incidents.set(incidentKey(incident.agentId, incident.reason), {
        ...incident,
        openedAt: Date.parse(incident.openedAt),
        lastProgressAt: Date.parse(incident.lastProgressAt),
      });
    }
  }

  observeAgentEvent(
    agentId: string,
    sessionId: string,
    event: AgentEvent,
    at = this.#now(),
  ): void {
    assertIdentity(agentId, "agentId");
    assertIdentity(sessionId, "sessionId");
    const current = this.#state(agentId, at);
    current.sessionId = sessionId;
    this.#agentIdBySessionId.set(sessionId, agentId);
    switch (event.type) {
      case "status.changed":
        this.#observeAgentStatus(current, event.status, at);
        break;
      case "tool.started":
        current.activeTools.add(event.toolCallId);
        this.#progress(current, "tool_running", at);
        break;
      case "tool.completed":
        current.activeTools.delete(event.toolCallId);
        this.#progress(
          current,
          current.activeTools.size > 0 ? "tool_running" : "running",
          at,
        );
        break;
      case "message.delta":
      case "message.completed":
      case "attachment.generated":
        this.#progress(
          current,
          current.activeTools.size > 0 ? "tool_running" : "running",
          at,
        );
        break;
      case "approval.requested":
        this.#agentIdByRequestId.set(monitorRequestKey(event.requestId), agentId);
        this.#recordPendingInput(current, event.requestId, "approval", at);
        break;
      case "user_input.requested":
      case "choice.requested":
        this.#agentIdByRequestId.set(monitorRequestKey(event.requestId), agentId);
        this.#recordPendingInput(current, event.requestId, "input", at);
        break;
      case "git_approval.expired":
      case "choice.expired":
      case "choice.resolved_externally":
      case "choice.answer_dispatched":
      case "choice.delivery_failed":
        this.#agentIdByRequestId.delete(monitorRequestKey(event.requestId));
        this.#clearPendingInput(current, event.requestId, at);
        break;
      case "error":
      case "git_automation.blocked":
        this.#setState(current, "failed", at, true);
        break;
      case "git_approval.resolved_externally":
      case "choice.server_request_resolved":
      case "choice.delivery_signal_unattributed":
      case "choice.auto_selected":
      case "git_automation.executed":
      case "git_approval.reprepare_required":
        this.#progress(current, current.state, at);
        break;
    }
    this.reconcile(at);
  }

  observeTurnStarted(
    agentId: string,
    sessionId: string,
    source: {
      readonly channelId?: string;
      readonly rootThreadTs?: string;
    } = {},
    at = this.#now(),
  ): void {
    const current = this.#state(agentId, at);
    current.sessionId = sessionId;
    this.#replaceSource(current, source.channelId, source.rootThreadTs);
    this.#agentIdBySessionId.set(sessionId, agentId);
    this.#progress(current, "running", at);
    this.reconcile(at);
  }

  observeTurnTerminal(agentId: string, failed: boolean, at = this.#now()): void {
    const current = this.#state(agentId, at);
    current.activeTools.clear();
    this.#clearAllPendingInputs(current);
    this.#setState(current, failed ? "failed" : "terminal", at, true);
    this.reconcile(at);
  }

  observeConnection(agentId: string, connected: boolean, at = this.#now()): void {
    const current = this.#state(agentId, at);
    if (connected) {
      delete current.disconnectedAt;
    } else {
      current.disconnectedAt ??= at;
      this.#setState(current, "unknown", at, false);
    }
    this.#syncIncident(
      agentId,
      "connection_lost",
      !connected && current.disconnectedAt !== undefined &&
        at - current.disconnectedAt >= this.#connectionGraceMs,
      current,
      at,
    );
  }

  observeInteractionAudit(input: InteractionAuditInput, at = this.#now()): void {
    const agentId = (input.sessionId === undefined
      ? undefined
      : this.#agentIdBySessionId.get(input.sessionId)) ??
      (input.requestId === undefined
        ? undefined
        : this.#agentIdByRequestId.get(monitorRequestKey(input.requestId)));
    if (agentId === undefined) return;
    const current = this.#state(agentId, at);
    const requestId = input.requestId;
    switch (input.event) {
      case "structured_input.request_received":
      case "structured_input.callback_bound":
      case "choice.request_received":
      case "git_approval.request_received":
      case "approval.request_received":
        if (requestId !== undefined) {
          this.#agentIdByRequestId.set(monitorRequestKey(requestId), agentId);
          this.#recordPendingInput(current, requestId, "input", at);
        }
        break;
      case "choice.controls_attached":
      case "git_approval.card_posted":
      case "approval.controls_attached":
        if (requestId !== undefined) this.#markInputVisible(current, requestId, at);
        break;
      case "structured_input.request_rejected":
      case "structured_input.request_terminalized":
      case "structured_input.rejected_before_display":
      case "choice.answer_dispatched":
      case "choice.server_request_resolved":
      case "choice.delivery_failed":
      case "choice.card_terminalized":
      case "choice.display_failed":
      case "choice.expired":
      case "choice.resolved_externally":
      case "choice.action_failed":
      case "git_approval.answer_applied":
      case "git_approval.card_terminalized":
      case "git_approval.resolved_externally":
      case "git_approval.expired":
      case "git_approval.action_failed":
        if (requestId !== undefined) {
          this.#agentIdByRequestId.delete(monitorRequestKey(requestId));
          this.#clearPendingInput(current, requestId, at);
        }
        break;
      case "turn.terminalized":
        this.#clearAllPendingInputs(current);
        current.activeTools.clear();
        this.#setState(current, "terminal", at, true);
        break;
      default:
        break;
    }
    this.reconcile(at);
  }

  reconcileRuntime(
    observations: readonly KoeRuntimeObservation[],
    at = this.#now(),
  ): void {
    for (const observation of observations) {
      const firstObservation = !this.#states.has(observation.agentId);
      const current = this.#state(observation.agentId, at);
      if (observation.sessionId !== undefined) {
        current.sessionId = observation.sessionId;
        this.#agentIdBySessionId.set(observation.sessionId, observation.agentId);
      }
      this.#recordSource(
        current,
        observation.sourceChannelId,
        observation.sourceRootThreadTs,
      );
      const observedAt = observation.updatedAt === undefined
        ? at
        : Date.parse(observation.updatedAt);
      if (
        Number.isFinite(observedAt) &&
        (firstObservation || observedAt > current.lastProgressAt)
      ) {
        current.lastProgressAt = observedAt;
      }
      if (
        observation.state === "failed" ||
        observation.state === "terminal" ||
        observation.state === "waiting_for_input" ||
        observation.state === "unknown" ||
        (current.state === "unknown" && current.disconnectedAt === undefined) ||
        (observation.state === "queued" && current.state === "terminal")
      ) {
        this.#setState(current, observation.state, at, false);
      }
    }
    this.reconcile(at);
  }

  reconcile(at = this.#now()): void {
    for (const [agentId, state] of this.#states) {
      const pending = [...state.pendingInputs.values()];
      const visible = pending.some((input) => input.visible);
      const hidden = pending.some(
        (input) => !input.visible && at - input.startedAt >= this.#hiddenWaitGraceMs,
      ) || (
        pending.length === 0 &&
        state.state === "waiting_for_input" &&
        at - state.stateSince >= this.#hiddenWaitGraceMs
      );
      this.#syncIncident(
        agentId,
        "visible_approval_wait",
        visible,
        state,
        at,
      );
      this.#syncIncident(
        agentId,
        "hidden_approval_wait",
        hidden && !visible,
        state,
        at,
      );
      this.#syncIncident(
        agentId,
        "queued_progress_stall_suspected",
        state.state === "queued" && at - state.lastProgressAt >= this.#queuedStallMs,
        state,
        at,
      );
      this.#syncIncident(
        agentId,
        "running_progress_stall_suspected",
        state.state === "running" &&
          state.pendingInputs.size === 0 &&
          at - state.lastProgressAt >= this.#runningStallMs,
        state,
        at,
      );
      this.#syncIncident(
        agentId,
        "tool_progress_stall_suspected",
        state.state === "tool_running" &&
          at - state.lastProgressAt >= this.#toolStallMs,
        state,
        at,
      );
      this.#syncIncident(
        agentId,
        "execution_failed",
        state.state === "failed",
        state,
        at,
      );
      this.#syncIncident(
        agentId,
        "connection_lost",
        state.disconnectedAt !== undefined &&
          at - state.disconnectedAt >= this.#connectionGraceMs,
        state,
        at,
      );
    }
  }

  state(agentId: string): {
    readonly state: KoeExecutionState;
    readonly lastProgressAt: string;
  } | undefined {
    const state = this.#states.get(agentId);
    return state === undefined
      ? undefined
      : {
          state: state.state,
          lastProgressAt: new Date(state.lastProgressAt).toISOString(),
        };
  }

  snapshot(): WorkStoppageMonitorSnapshot {
    return {
      version: 1,
      incidents: [...this.#incidents.values()]
        .sort((left, right) => incidentKey(left.agentId, left.reason)
          .localeCompare(incidentKey(right.agentId, right.reason)))
        .slice(-MAX_PERSISTED_INCIDENTS)
        .map((incident) => ({
          agentId: incident.agentId,
          ...(incident.sourceChannelId === undefined
            ? {}
            : { sourceChannelId: incident.sourceChannelId }),
          ...(incident.sourceRootThreadTs === undefined
            ? {}
            : { sourceRootThreadTs: incident.sourceRootThreadTs }),
          reason: incident.reason,
          occurrence: incident.occurrence,
          active: incident.active,
          openedAt: new Date(incident.openedAt).toISOString(),
          lastProgressAt: new Date(incident.lastProgressAt).toISOString(),
          notificationAttempted: incident.notificationAttempted,
        })),
    };
  }

  #state(agentId: string, at: number): KoeRuntimeState {
    assertIdentity(agentId, "agentId");
    let state = this.#states.get(agentId);
    if (state === undefined) {
      state = {
        state: "unknown",
        stateSince: at,
        lastProgressAt: at,
        activeTools: new Set(),
        pendingInputs: new Map(),
      };
      this.#states.set(agentId, state);
    }
    return state;
  }

  #observeAgentStatus(state: KoeRuntimeState, status: AgentStatus, at: number): void {
    switch (status) {
      case "starting":
      case "running":
        if (state.pendingInputs.size > 0) this.#clearAllPendingInputs(state);
        this.#progress(
          state,
          state.activeTools.size > 0 ? "tool_running" : "running",
          at,
        );
        break;
      case "waiting_for_approval":
      case "waiting_for_input":
        this.#setState(state, "waiting_for_input", at, true);
        break;
      case "failed":
        this.#setState(state, "failed", at, true);
        break;
      case "idle":
      case "interrupted":
        this.#clearAllPendingInputs(state);
        state.activeTools.clear();
        this.#setState(state, "terminal", at, true);
        break;
    }
  }

  #recordPendingInput(
    state: KoeRuntimeState,
    requestId: string,
    kind: PendingInput["kind"],
    at: number,
  ): void {
    const key = monitorRequestKey(requestId);
    if (!state.pendingInputs.has(key)) {
      state.pendingInputs.set(key, {
        requestId: key,
        kind,
        startedAt: at,
        visible: false,
      });
    }
    this.#setState(state, "waiting_for_input", at, true);
  }

  #markInputVisible(state: KoeRuntimeState, requestId: string, at: number): void {
    const key = monitorRequestKey(requestId);
    const pending = state.pendingInputs.get(key);
    if (pending === undefined) {
      state.pendingInputs.set(key, {
        requestId: key,
        kind: "input",
        startedAt: at,
        visible: true,
      });
    } else {
      pending.visible = true;
    }
    this.#setState(state, "waiting_for_input", at, true);
  }

  #clearPendingInput(state: KoeRuntimeState, requestId: string, at: number): void {
    if (!state.pendingInputs.delete(monitorRequestKey(requestId))) return;
    if (state.pendingInputs.size === 0 && state.state === "waiting_for_input") {
      this.#progress(
        state,
        state.activeTools.size > 0 ? "tool_running" : "running",
        at,
      );
    }
  }

  #clearAllPendingInputs(state: KoeRuntimeState): void {
    for (const requestId of state.pendingInputs.keys()) {
      this.#agentIdByRequestId.delete(requestId);
    }
    state.pendingInputs.clear();
  }

  #progress(state: KoeRuntimeState, next: KoeExecutionState, at: number): void {
    state.lastProgressAt = at;
    this.#setState(state, next, at, false);
  }

  #setState(
    state: KoeRuntimeState,
    next: KoeExecutionState,
    at: number,
    progress: boolean,
  ): void {
    if (state.state !== next) {
      state.state = next;
      state.stateSince = at;
    }
    if (progress) state.lastProgressAt = at;
  }

  #syncIncident(
    agentId: string,
    reason: WorkAttentionReason,
    shouldBeActive: boolean,
    state: KoeRuntimeState,
    at: number,
  ): void {
    const key = incidentKey(agentId, reason);
    const existing = this.#incidents.get(key);
    if (!shouldBeActive) {
      if (existing?.active !== true) return;
      existing.active = false;
      existing.lastProgressAt = state.lastProgressAt;
      this.#emit(existing, "recovered", state.state, at);
      this.#snapshotChanged();
      return;
    }
    if (existing?.active === true) return;
    const incident: IncidentState = {
      agentId,
      ...(state.sourceChannelId === undefined
        ? {}
        : { sourceChannelId: state.sourceChannelId }),
      ...(state.sourceRootThreadTs === undefined
        ? {}
        : { sourceRootThreadTs: state.sourceRootThreadTs }),
      reason,
      occurrence: (existing?.occurrence ?? 0) + 1,
      active: true,
      openedAt: at,
      lastProgressAt: state.lastProgressAt,
      notificationAttempted: false,
    };
    this.#incidents.set(key, incident);
    this.#emit(incident, "attention_required", state.state, at);
    this.#snapshotChanged();
  }

  #emit(
    incident: IncidentState,
    event: WorkAttentionNotification["event"],
    state: KoeExecutionState,
    at: number,
  ): void {
    const incidentRef = incidentReference(incident);
    const notification: WorkAttentionNotification = {
      component: "showtalk.work_attention",
      version: 1,
      event,
      incidentRef,
      occurrence: incident.occurrence,
      agentId: incident.agentId,
      ...(incident.sourceChannelId === undefined
        ? {}
        : { sourceChannelId: incident.sourceChannelId }),
      ...(incident.sourceRootThreadTs === undefined
        ? {}
        : { sourceRootThreadTs: incident.sourceRootThreadTs }),
      state,
      reason: incident.reason,
      lastProgressAt: new Date(incident.lastProgressAt).toISOString(),
      detectedAt: new Date(at).toISOString(),
      nextAction: event === "recovered"
        ? "no_action_recovered"
        : nextActionForReason(incident.reason),
    };
    incident.notificationAttempted = true;
    try {
      const result = this.#notify(notification);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {
          this.#reportDeliveryFailure(incident, incidentRef, at);
        });
      }
    } catch {
      this.#reportDeliveryFailure(incident, incidentRef, at);
    }
  }

  #reportDeliveryFailure(
    incident: IncidentState,
    incidentRef: string,
    at: number,
  ): void {
    try {
      this.#observeDeliveryFailure({
        component: "showtalk.work_attention",
        version: 1,
        event: "notification_delivery_failed",
        incidentRef,
        agentId: incident.agentId,
        reason: incident.reason,
        detectedAt: new Date(at).toISOString(),
      });
    } catch {
      // This fixed local observer is the last safe boundary. Notification
      // failures must never alter or retry the monitored Agent turn.
    }
    this.#snapshotChanged();
  }

  #snapshotChanged(): void {
    this.#onSnapshotChanged(this.snapshot());
  }

  #recordSource(
    state: KoeRuntimeState,
    channelId: string | undefined,
    rootThreadTs: string | undefined,
  ): void {
    if (channelId === undefined || rootThreadTs === undefined) return;
    if (!/^[CDG][A-Z0-9]{1,127}$/u.test(channelId)) return;
    if (!/^\d{1,20}\.\d{1,20}$/u.test(rootThreadTs)) return;
    state.sourceChannelId = channelId;
    state.sourceRootThreadTs = rootThreadTs;
  }

  #replaceSource(
    state: KoeRuntimeState,
    channelId: string | undefined,
    rootThreadTs: string | undefined,
  ): void {
    delete state.sourceChannelId;
    delete state.sourceRootThreadTs;
    this.#recordSource(state, channelId, rootThreadTs);
  }
}

/** Observes adapter events without changing approval or execution behavior. */
export class WorkMonitoringAgentAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities;
  readonly #agentId: string;
  readonly #delegate: AgentAdapter;
  readonly #monitor: WorkStoppageMonitor;

  constructor(
    agentId: string,
    delegate: AgentAdapter,
    monitor: WorkStoppageMonitor,
  ) {
    this.#agentId = agentId;
    this.#delegate = delegate;
    this.#monitor = monitor;
    this.kind = delegate.kind;
    this.capabilities = delegate.capabilities;
  }

  createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    return this.#delegate.createSession(request);
  }

  resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    if (this.#delegate.resumeSession === undefined) {
      throw new Error(`Adapter ${this.kind} does not support session resume`);
    }
    return this.#delegate.resumeSession(request);
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    const channelId = request.metadata?.showtalkChannelId;
    const rootThreadTs = request.metadata?.showtalkRootThreadTs;
    this.#monitor.observeTurnStarted(this.#agentId, session.id, {
      ...(typeof channelId === "string" ? { channelId } : {}),
      ...(typeof rootThreadTs === "string" ? { rootThreadTs } : {}),
    });
    let failed = false;
    try {
      for await (const event of this.#delegate.sendMessage(session, request)) {
        if (event.type === "error" || event.type === "git_automation.blocked") {
          failed = true;
        }
        this.#monitor.observeAgentEvent(this.#agentId, session.id, event);
        yield event;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.#monitor.observeTurnTerminal(this.#agentId, failed);
    }
  }

  interrupt(session: AdapterSession): Promise<void> {
    if (this.#delegate.interrupt === undefined) {
      throw new Error(`Adapter ${this.kind} does not support interrupt`);
    }
    return this.#delegate.interrupt(session);
  }

  approve(session: AdapterSession, approval: AgentApproval): Promise<void> {
    if (this.#delegate.approve === undefined) {
      throw new Error(`Adapter ${this.kind} does not support approval`);
    }
    return this.#delegate.approve(session, approval);
  }

  respondToUserInput(
    session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void> {
    if (this.#delegate.respondToUserInput === undefined) {
      throw new Error(`Adapter ${this.kind} does not support structured input`);
    }
    return this.#delegate.respondToUserInput(session, response);
  }

  status(session: AdapterSession): Promise<AgentStatus> {
    return this.#delegate.status === undefined
      ? Promise.resolve("idle")
      : this.#delegate.status(session);
  }
}

export function emptyWorkStoppageMonitorSnapshot(): WorkStoppageMonitorSnapshot {
  return { version: 1, incidents: [] };
}

export function validateWorkStoppageMonitorSnapshot(
  value: unknown,
): WorkStoppageMonitorSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { incidents?: unknown }).incidents) ||
    (value as { incidents: unknown[] }).incidents.length > MAX_PERSISTED_INCIDENTS
  ) {
    throw new Error("Invalid work stoppage monitor snapshot");
  }
  const incidents = (value as { incidents: unknown[] }).incidents;
  const keys = new Set<string>();
  for (const item of incidents) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Invalid work stoppage monitor incident");
    }
    const incident = item as Record<string, unknown>;
    if (
      !isBoundedIdentity(incident.agentId) ||
      !isAttentionReason(incident.reason) ||
      !Number.isSafeInteger(incident.occurrence) ||
      Number(incident.occurrence) < 1 ||
      typeof incident.active !== "boolean" ||
      !validTimestamp(incident.openedAt) ||
      !validTimestamp(incident.lastProgressAt) ||
      typeof incident.notificationAttempted !== "boolean"
    ) {
      throw new Error("Invalid work stoppage monitor incident");
    }
    const hasChannel = incident.sourceChannelId !== undefined;
    const hasThread = incident.sourceRootThreadTs !== undefined;
    if (
      hasChannel !== hasThread ||
      (hasChannel && !/^[CDG][A-Z0-9]{1,127}$/u.test(String(incident.sourceChannelId))) ||
      (hasThread && !/^\d{1,20}\.\d{1,20}$/u.test(String(incident.sourceRootThreadTs)))
    ) {
      throw new Error("Invalid work stoppage monitor incident source");
    }
    const key = incidentKey(
      incident.agentId as string,
      incident.reason as WorkAttentionReason,
    );
    if (keys.has(key)) throw new Error("Duplicate work stoppage monitor incident");
    keys.add(key);
  }
  return structuredClone(value) as WorkStoppageMonitorSnapshot;
}

export function createWorkAttentionAudit(
  write: (line: string) => void = console.info,
): {
  readonly notify: (notification: WorkAttentionNotification) => void;
  readonly observeDeliveryFailure: (event: WorkAttentionDeliveryFailure) => void;
} {
  return {
    notify: (notification) => write(JSON.stringify(notification)),
    observeDeliveryFailure: (event) => write(JSON.stringify(event)),
  };
}

function incidentKey(agentId: string, reason: WorkAttentionReason): string {
  return `${agentId}\u0000${reason}`;
}

function monitorRequestKey(value: string): string {
  return value.replace(/^codex-(?:choice|input):/u, "");
}

function incidentReference(incident: IncidentState): string {
  return createHash("sha256")
    .update("showtalk-work-attention-v1\0")
    .update(incident.agentId)
    .update("\0")
    .update(incident.reason)
    .update("\0")
    .update(String(incident.occurrence))
    .digest("hex")
    .slice(0, 16);
}

function nextActionForReason(reason: WorkAttentionReason): WorkAttentionNextAction {
  switch (reason) {
    case "hidden_approval_wait": return "check_slack_controls";
    case "visible_approval_wait": return "respond_in_slack";
    case "queued_progress_stall_suspected": return "inspect_queue";
    case "running_progress_stall_suspected": return "inspect_progress";
    case "tool_progress_stall_suspected": return "inspect_tool";
    case "execution_failed": return "inspect_failure";
    case "connection_lost": return "check_connection";
  }
}

function boundedDuration(
  configured: number | undefined,
  fallback: number,
  name: string,
): number {
  const value = configured ?? fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > 7 * 24 * 60 * 60_000) {
    throw new TypeError(`${name} must be an integer from 0 to seven days`);
  }
  return value;
}

function assertIdentity(value: string, name: string): void {
  if (!isBoundedIdentity(value)) throw new TypeError(`${name} is invalid`);
}

function isBoundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isAttentionReason(value: unknown): value is WorkAttentionReason {
  return [
    "hidden_approval_wait",
    "visible_approval_wait",
    "queued_progress_stall_suspected",
    "running_progress_stall_suspected",
    "tool_progress_stall_suspected",
    "execution_failed",
    "connection_lost",
  ].includes(String(value));
}

