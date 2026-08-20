import { randomUUID } from "node:crypto";

import { CoreError } from "../../core/errors.js";
import type {
  AdapterSession,
  AgentAdapter,
  AgentApproval,
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentStatus,
  AgentUserInputResponse,
  CreateSessionRequest,
  JsonValue,
  ResumeSessionRequest,
  SendMessageRequest,
} from "../../core/index.js";
import type {
  ApprovalsReviewer,
  CodexThread,
  CodexTurn,
  CommandApprovalDecision,
  FileChangeApprovalDecision,
  PermissionsApprovalResponse,
  RpcError,
  RpcId,
  ToolRequestUserInputResponse,
  ThreadResumeParams,
  ThreadStartParams,
  TurnStartParams,
} from "./protocol.js";
import type { ServerRequestEvent } from "./app-server-client.js";
import {
  captureWorkspaceGitPlan,
  toolRequestUserInputParams,
  validateWorkspaceGitPlanQuestion,
} from "./workspace-git-approval.js";
import type { WorkspaceGitApprovalPlan } from "../../core/index.js";

const MAX_AGENT_MESSAGE_CHARS = 128_000;
const MAX_EVENT_JSON_CHARS = 64_000;
const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_DELTA_CHARS = 128_000;
const MAX_COALESCED_DELTA_CHARS = 32_000;
const SHOWTALK_SLACK_PERSONA_CONTEXT_KEY = "showtalk_taishi.slack_persona";
const SHOWTALK_KOE_CONSULTATION_INSTRUCTIONS = [
  "ShowTalk Taishi Koe consultation rules:",
  "- Codex internal subagents run inside the current Codex task. They are not Slack channels or ShowTalk Koe.",
  "- agent.send starts a visible conversation with another persistent Koe assigned to another Slack channel. It is not an internal subagent tool and never satisfies AGENTS.md subagent-delegation requirements.",
  "- Use agent.send only for targets explicitly listed in this Koe's configured consultations and only for work inside that target's stated scope.",
  "- Operator-facing call names returned by agent.list are exact aliases for their Koe IDs. Use them only as listed; never infer a Koe from similar prose.",
  "- For a user-requested sequence across multiple Koe, send one bounded step at a time, continue from each returned result, and stop with a clear blocker if a bounded review/fix cycle does not converge.",
  "- Never choose an unrelated Koe because it is idle, available, or appears in a directory. If no configured consultation matches, continue locally or use Codex internal subagents.",
].join("\n");
const SHOWTALK_GIT_APPROVAL_INSTRUCTIONS = [
  "ShowTalk Taishi Git approval routing rules:",
  "- A Git approval belongs to the Koe that called workspace-git prepare_* and to the Slack thread that started that same turn.",
  "- When workspace-git returns awaiting_human_approval, immediately call request_user_input in that same turn with exactly two options named `承認して実行` and `拒否・保留`.",
  "- Never use agent.send, slack.post, or slack.reply to ask another Koe or channel to display, relay, approve, or reconstruct a Git approval.",
  "- If the exact plan is unbound, expired, or invalidated by a Gateway restart, inspect status and re-run the matching workspace-git prepare_* operation in this Koe's current turn before requesting approval. Never reconstruct authority from IDs or prose.",
  "- get_git_operation_status never binds an approval plan, even when it reports awaiting_human_approval. Only a fresh prepare_* completion observed in this same turn can be approved.",
  "- If request_user_input reports REPREPARE_REQUIRED, do not call request_user_input again in that turn. Do not claim that approval is still available. End the turn so Slack can offer the human a safe fresh-plan recovery action.",
  "- Never claim that approval controls were displayed unless request_user_input is currently waiting for the human response. If a prepared plan is still awaiting approval, do not finish the turn with prose instead of opening that structured request.",
].join("\n");

export interface CodexAppServer {
  startThread(params: ThreadStartParams): Promise<CodexThread>;
  resumeThread(params: ThreadResumeParams): Promise<CodexThread>;
  readThread(threadId: string): Promise<CodexThread>;
  unsubscribeThread(threadId: string): Promise<void>;
  startTurn(params: TurnStartParams): Promise<CodexTurn>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  close(): Promise<void>;
  respondToCommandApproval(id: RpcId, decision: CommandApprovalDecision): void;
  respondToFileChangeApproval(id: RpcId, decision: FileChangeApprovalDecision): void;
  respondToPermissionsApproval(id: RpcId, response: PermissionsApprovalResponse): void;
  respondToUserInput(id: RpcId, response: ToolRequestUserInputResponse): void;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onServerRequest(listener: (event: ServerRequestEvent) => void): () => void;
  onProtocolError(listener: (error: Error) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  respondError(id: RpcId, error: RpcError): void;
}

interface PendingApproval {
  readonly rpcId: RpcId;
  readonly method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval";
  readonly sessionId: string;
  readonly requestedPermissions?: Readonly<Record<string, JsonValue>>;
  readonly expiresAt: number;
  readonly expirationTimer: NodeJS.Timeout;
}

interface PendingUserInput {
  readonly rpcId: RpcId;
  readonly sessionId: string;
  readonly questionId: string;
  readonly approveLabel: "承認して実行";
  readonly rejectLabel: "拒否・保留";
  readonly plan: WorkspaceGitApprovalPlan;
  readonly expiresAt: number;
  readonly expirationTimer: NodeJS.Timeout;
}

interface PendingUserInputBinding {
  readonly rpcId: RpcId;
  readonly serverRequest: ServerRequestEvent;
  readonly sessionId: string;
  readonly turnId: string;
  readonly queue: AsyncEventQueue;
  readonly expirationTimer: NodeJS.Timeout;
}

export interface CodexAdapterOptions {
  kind?: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  /** Override who reviews approvals; omit to inherit Codex App Server configuration. */
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalTimeoutMs?: number;
  /** Same-turn transport-ordering grace for requestUserInput before prepare completion. */
  gitPlanBindingGraceMs?: number;
  terminalWatchdogMs?: number;
  ambiguousStartRetryMs?: number;
  externalTurnPollMs?: number;
  externalTurnWaitMs?: number;
  /** Per-thread Codex config overrides, used to attach the authenticated Taishi MCP. */
  threadConfig?: Readonly<Record<string, JsonValue>>;
}

export interface CodexRuntimeModelSettings {
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

export class CodexAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    approval: true,
    interrupt: true,
    resume: true,
    toolEvents: true,
    structuredInput: true,
    imageInput: true,
    audioFileInput: true,
  };

  readonly #client: CodexAppServer;
  readonly #options: {
    model?: string;
    reasoningEffort?: string;
    approvalPolicy?: "untrusted" | "on-request" | "never";
    approvalsReviewer?: ApprovalsReviewer;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalTimeoutMs: number;
    gitPlanBindingGraceMs: number;
    terminalWatchdogMs: number;
    ambiguousStartRetryMs: number;
    externalTurnPollMs: number;
    externalTurnWaitMs: number;
    threadConfig?: Readonly<Record<string, JsonValue>>;
  };
  readonly #activeTurns = new Map<string, string>();
  readonly #runningSessions = new Set<string>();
  readonly #statuses = new Map<string, AgentStatus>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #pendingUserInputs = new Map<string, PendingUserInput>();
  readonly #pendingUserInputBindings = new Map<string, PendingUserInputBinding>();
  readonly #workspaceGitPlansByTurn = new Map<
    string,
    readonly WorkspaceGitApprovalPlan[]
  >();
  readonly #gitApprovalRecoveryTurns = new Set<string>();
  readonly #activeQueues = new Map<string, AsyncEventQueue>();
  readonly #startedItems = new Map<string, Record<string, unknown>>();
  readonly #loadedSessions = new Set<string>();
  readonly #resumeParamsBySession = new Map<string, ThreadResumeParams>();
  readonly #slackPersonasBySession = new Map<string, string>();
  #transportFailed = false;

  constructor(client: CodexAppServer, options: CodexAdapterOptions = {}) {
    this.#client = client;
    this.kind = options.kind ?? "codex";
    this.#options = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
      ...(options.threadConfig === undefined
        ? {}
        : { threadConfig: structuredClone(options.threadConfig) }),
      ...(options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: options.approvalPolicy }),
      ...(options.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: options.approvalsReviewer }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      approvalTimeoutMs: options.approvalTimeoutMs ?? 30 * 60 * 1_000,
      gitPlanBindingGraceMs: options.gitPlanBindingGraceMs ?? 2_000,
      terminalWatchdogMs: options.terminalWatchdogMs ?? 5 * 60 * 1_000,
      ambiguousStartRetryMs: options.ambiguousStartRetryMs ?? 100,
      externalTurnPollMs: options.externalTurnPollMs ?? 1_000,
      externalTurnWaitMs: options.externalTurnWaitMs ?? 30 * 60 * 1_000,
    };
    if (
      this.#options.approvalTimeoutMs < 1 ||
      this.#options.gitPlanBindingGraceMs < 1 ||
      this.#options.terminalWatchdogMs < 1 ||
      this.#options.ambiguousStartRetryMs < 1 ||
      this.#options.externalTurnPollMs < 1 ||
      this.#options.externalTurnWaitMs < 1
    ) {
      throw new Error("Codex adapter timeouts must be positive");
    }
    this.#client.onServerRequest((request) => this.#handleServerRequest(request));
    this.#client.onClose((error) => this.#failActiveStreams(error));
  }

  /**
   * Replace only the turn-level model controls. An active turn keeps the
   * values captured when it started; subsequent turns read these settings.
   */
  updateModelSettings(settings: CodexRuntimeModelSettings): void {
    const model = settings.model?.trim();
    const reasoningEffort = settings.reasoningEffort?.trim();
    if (model === undefined || model.length === 0) delete this.#options.model;
    else this.#options.model = model;
    if (reasoningEffort === undefined || reasoningEffort.length === 0) {
      delete this.#options.reasoningEffort;
    } else {
      this.#options.reasoningEffort = reasoningEffort;
    }
  }

  async createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    const workspacePath = getWorkspacePath(request);
    const thread = await this.#client.startThread({
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      ...(workspacePath === undefined ? {} : { cwd: workspacePath }),
      ...(this.#options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: this.#options.approvalPolicy }),
      ...(this.#options.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: this.#options.approvalsReviewer }),
      ...(this.#options.sandbox === undefined
        ? {}
        : { sandbox: this.#options.sandbox }),
      ...(this.#options.threadConfig === undefined
        ? {}
        : { config: this.#options.threadConfig }),
      developerInstructions: codexDeveloperInstructions(request.agent.role),
      serviceName: "showtalk_taishi",
    });
    this.#statuses.set(thread.id, "idle");
    this.#loadedSessions.add(thread.id);
    this.#resumeParamsBySession.set(
      thread.id,
      this.#buildResumeParams(request.agent, thread.id),
    );
    this.#rememberSlackPersona(thread.id, request.agent.slackPersona);
    return toAdapterSession(thread);
  }

  async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    const params = this.#buildResumeParams(request.agent, request.adapterSessionId);
    const thread = await this.#client.resumeThread(params);
    this.#statuses.set(thread.id, "idle");
    this.#loadedSessions.add(thread.id);
    this.#resumeParamsBySession.set(thread.id, params);
    this.#rememberSlackPersona(thread.id, request.agent.slackPersona);
    return toAdapterSession(thread);
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (this.#transportFailed) {
      throw new Error("Codex app-server transport is unavailable");
    }
    if (this.#runningSessions.has(session.id)) {
      throw new Error(`Codex session ${session.id} already has an active turn`);
    }
    this.#runningSessions.add(session.id);
    try {
      await this.#prepareSessionForTurn(session.id);
    } catch (error) {
      this.#runningSessions.delete(session.id);
      await this.#unsubscribeSession(session.id);
      throw error;
    }

    const queue = new AsyncEventQueue();
    this.#activeQueues.set(session.id, queue);
    let terminal = false;
    let failed = false;
    let reconciliationFailures = 0;
    let terminalWatchdog: NodeJS.Timeout | undefined;
    const clearTerminalWatchdog = () => {
      if (terminalWatchdog !== undefined) clearTimeout(terminalWatchdog);
      terminalWatchdog = undefined;
    };
    const scheduleTerminalWatchdog = (delayMs = this.#options.terminalWatchdogMs) => {
      clearTerminalWatchdog();
      terminalWatchdog = setTimeout(() => {
        void this.#reconcileTurnStatus(session.id, queue).then((result) => {
          if (result === "terminal") {
            this.#rejectPendingUserInputBindings(
              session.id,
              queue,
              "The Codex turn ended before its workspace-git plan could be bound",
            );
            terminal = true;
            this.#runningSessions.delete(session.id);
            this.#removePendingApprovals(session.id);
            this.#removePendingUserInputs(session.id);
            this.#removeWorkspaceGitPlans(session.id);
            this.#removeStartedItems(session.id);
          } else if (!terminal && result === "retry") {
            reconciliationFailures += 1;
            scheduleTerminalWatchdog(
              Math.min(
                this.#options.terminalWatchdogMs * 2 ** reconciliationFailures,
                this.#options.terminalWatchdogMs * 8,
              ),
            );
          } else if (!terminal) {
            reconciliationFailures = 0;
            scheduleTerminalWatchdog();
          }
        });
      }, delayMs);
    };
    const unsubscribeNotification = this.#client.onNotification((method, params) => {
      if (!belongsToThread(params, session.id)) return;
      const notification = asRecord(params);
      if (
        method === "serverRequest/resolved" &&
        (typeof notification?.requestId === "string" ||
          typeof notification?.requestId === "number")
      ) {
        this.#removePendingServerRequestByRpcId(notification.requestId);
      }
      const item = asRecord(notification?.item);
      if (method === "item/started" && typeof item?.id === "string") {
        this.#startedItems.set(itemKey(session.id, item.id), item);
      } else if (method === "item/completed" && typeof item?.id === "string") {
        const startedItem = this.#startedItems.get(itemKey(session.id, item.id));
        try {
          const capture = captureWorkspaceGitPlan(params, startedItem);
          if (capture !== undefined) {
            this.#rememberWorkspaceGitPlan(session.id, capture.turnId, capture.plan);
            // Let adjacent App Server completion notifications settle before
            // deciding that exactly one plan exists. This preserves the
            // fail-closed rule when parallel prepares complete together.
            setImmediate(() => {
              this.#retryPendingUserInputBindings(session.id, capture.turnId);
            });
          }
        } catch (error) {
          queue.push({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "workspace-git returned an invalid pending plan",
            code: "INVALID_GIT_APPROVAL_PLAN",
          });
        }
        this.#startedItems.delete(itemKey(session.id, item.id));
      }
      const turn = asRecord(notification?.turn);
      if (method === "turn/started" && typeof turn?.id === "string") {
        this.#activeTurns.set(session.id, turn.id);
      }
      const event = normalizeNotification(method, params);
      if (event !== undefined) queue.push(event);
      if (method === "turn/completed") {
        this.#rejectPendingUserInputBindings(
          session.id,
          queue,
          "The Codex turn completed before its workspace-git plan could be bound",
        );
        terminal = true;
        clearTerminalWatchdog();
        this.#activeTurns.delete(session.id);
        this.#runningSessions.delete(session.id);
        const status = turnStatus(params);
        this.#statuses.set(session.id, status);
        this.#removePendingApprovals(session.id);
        this.#removePendingUserInputs(session.id);
        this.#removeWorkspaceGitPlans(session.id);
        this.#removeGitApprovalRecoveryTurns(session.id);
        this.#removeStartedItems(session.id);
        queue.close();
      }
    });

    try {
      this.#statuses.set(session.id, "starting");
      queue.push({ type: "status.changed", status: "starting" });
      const turn = await this.#client.startTurn({
        threadId: session.id,
        input: buildTurnInput(request),
        ...slackPersonaAdditionalContext(
          this.#slackPersonasBySession.get(session.id),
        ),
        ...(this.#options.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: this.#options.approvalPolicy }),
        ...(this.#options.approvalsReviewer === undefined
          ? {}
          : { approvalsReviewer: this.#options.approvalsReviewer }),
        ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
        ...(this.#options.reasoningEffort === undefined
          ? {}
          : { effort: this.#options.reasoningEffort }),
      });
      if (!terminal) {
        this.#activeTurns.set(session.id, turn.id);
        this.#statuses.set(session.id, "running");
        queue.push({ type: "status.changed", status: "running" });
        scheduleTerminalWatchdog();
      }
      for await (const event of queue) yield event;
    } catch (error) {
      const safelyStopped =
        this.#transportFailed ||
        (await this.#reconcileAndInterruptAmbiguousTurn(session.id));
      if (!safelyStopped) {
        await this.#client.close().catch(() => undefined);
      }
      failed = true;
      this.#activeTurns.delete(session.id);
      this.#runningSessions.delete(session.id);
      this.#statuses.set(session.id, "failed");
      queue.fail(error);
      throw error;
    } finally {
      if (!terminal && !failed) {
        const safelyStopped =
          this.#transportFailed ||
          (await this.#reconcileAndInterruptAmbiguousTurn(session.id));
        if (!safelyStopped) {
          this.#transportFailed = true;
          await this.#client.close().catch(() => undefined);
        }
        this.#activeTurns.delete(session.id);
        this.#statuses.set(session.id, safelyStopped ? "interrupted" : "failed");
      }
      this.#runningSessions.delete(session.id);
      this.#activeQueues.delete(session.id);
      this.#removePendingApprovals(session.id);
      this.#removePendingUserInputs(session.id);
      this.#rejectPendingUserInputBindings(
        session.id,
        queue,
        "The Slack turn ended before its workspace-git plan could be bound",
      );
      this.#removeWorkspaceGitPlans(session.id);
      this.#removeStartedItems(session.id);
      clearTerminalWatchdog();
      unsubscribeNotification();
      await this.#unsubscribeSession(session.id);
    }
  }

  async interrupt(session: AdapterSession): Promise<void> {
    const turnId = this.#activeTurns.get(session.id);
    if (turnId === undefined) {
      await this.#unsubscribeSession(session.id);
      throw new Error(`Codex session ${session.id} has no active turn`);
    }
    await this.#client.interruptTurn(session.id, turnId);
  }

  async approve(session: AdapterSession, approval: AgentApproval): Promise<void> {
    const pending = this.#pendingApprovals.get(approval.requestId);
    if (pending === undefined || pending.sessionId !== session.id) {
      throw new Error(`Unknown approval request: ${approval.requestId}`);
    }
    if (Date.now() > pending.expiresAt) {
      try {
        this.#respondToPendingApproval(pending, "cancel");
      } finally {
        clearTimeout(pending.expirationTimer);
        this.#pendingApprovals.delete(approval.requestId);
      }
      throw new Error(`Approval request expired: ${approval.requestId}`);
    }
    const decision = mapApprovalDecision(approval.decision);
    try {
      this.#respondToPendingApproval(pending, decision);
    } finally {
      clearTimeout(pending.expirationTimer);
      this.#pendingApprovals.delete(approval.requestId);
    }
    this.#statuses.set(session.id, "running");
    this.#activeQueues.get(session.id)?.push({
      type: "status.changed",
      status: "running",
    });
  }

  async respondToUserInput(
    session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void> {
    const pending = this.#pendingUserInputs.get(response.requestId);
    if (pending === undefined || pending.sessionId !== session.id) {
      throw new Error(`Unknown structured input request: ${response.requestId}`);
    }
    if (Date.now() >= pending.expiresAt) {
      this.#settleUserInput(response.requestId, pending, "reject");
      throw new Error(`Structured input request expired: ${response.requestId}`);
    }
    this.#settleUserInput(response.requestId, pending, response.optionId);
    this.#statuses.set(session.id, "running");
    this.#activeQueues.get(session.id)?.push({
      type: "status.changed",
      status: "running",
    });
  }

  async status(session: AdapterSession): Promise<AgentStatus> {
    try {
      const thread = await this.#client.readThread(session.id);
      const type = threadStatusType(thread);
      const status: AgentStatus =
        type === "active"
          ? "running"
          : type === "systemError"
            ? "failed"
            : type === "idle" || type === "notLoaded"
              ? "idle"
              : this.#statuses.get(session.id) ?? "idle";
      this.#statuses.set(session.id, status);
      return status;
    } catch {
      return this.#statuses.get(session.id) ?? "idle";
    } finally {
      if (!this.#runningSessions.has(session.id)) {
        await this.#unsubscribeSession(session.id);
      }
    }
  }

  async #prepareSessionForTurn(sessionId: string): Promise<void> {
    const deadline = Date.now() + this.#options.externalTurnWaitMs;
    while (true) {
      const stored = await this.#client.readThread(sessionId);
      const storedStatus = threadStatusType(stored);
      if (storedStatus === "systemError") {
        this.#statuses.set(sessionId, "failed");
        throw new Error(`Codex thread ${sessionId} is unavailable`);
      }
      if (storedStatus !== "active") {
        if (this.#loadedSessions.has(sessionId)) return;
        const thread = await this.#client.resumeThread(
          this.#resumeParamsBySession.get(sessionId) ?? { threadId: sessionId },
        );
        this.#loadedSessions.add(sessionId);
        if (threadStatusType(thread) !== "active") return;
      }

      this.#statuses.set(sessionId, "running");
      await this.#unsubscribeSession(sessionId);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.#statuses.set(sessionId, "running");
        throw new CoreError(
          "AGENT_BUSY",
          "This Codex thread stayed active in another client for too long; the queued Slack turn was not started",
        );
      }
      await delay(Math.min(this.#options.externalTurnPollMs, remaining));
    }
  }

  async #unsubscribeSession(sessionId: string): Promise<void> {
    if (this.#transportFailed || !this.#loadedSessions.has(sessionId)) return;
    try {
      await this.#client.unsubscribeThread(sessionId);
    } catch {
      // The next turn will resume from persisted storage even if the server did
      // not acknowledge this best-effort release.
    } finally {
      this.#loadedSessions.delete(sessionId);
    }
  }

  #buildResumeParams(
    agent: AgentDefinition,
    threadId: string,
  ): ThreadResumeParams {
    const workspacePath = getWorkspacePath({ agent });
    return {
      threadId,
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      ...(workspacePath === undefined ? {} : { cwd: workspacePath }),
      ...(this.#options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: this.#options.approvalPolicy }),
      ...(this.#options.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: this.#options.approvalsReviewer }),
      ...(this.#options.sandbox === undefined
        ? {}
        : { sandbox: this.#options.sandbox }),
      ...(this.#options.threadConfig === undefined
        ? {}
        : { config: this.#options.threadConfig }),
      developerInstructions: codexDeveloperInstructions(agent.role),
    };
  }

  #rememberSlackPersona(sessionId: string, persona: string | undefined): void {
    const configured = persona?.trim();
    if (configured === undefined || configured.length === 0) {
      this.#slackPersonasBySession.delete(sessionId);
      return;
    }
    this.#slackPersonasBySession.set(sessionId, configured);
  }

  #handleServerRequest(serverRequest: ServerRequestEvent): void {
    const params = asRecord(serverRequest.params);
    const sessionId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const queue = sessionId === undefined ? undefined : this.#activeQueues.get(sessionId);
    if (sessionId === undefined || queue === undefined) {
      this.#client.respondError(serverRequest.id, {
        code: -32601,
        message: "ShowTalk Taishi cannot handle this server request outside an active turn",
      });
      return;
    }
    if (serverRequest.method === "item/tool/requestUserInput") {
      this.#handleUserInputRequest(serverRequest, sessionId, queue);
      return;
    }
    if (!isApprovalMethod(serverRequest.method)) {
      this.#client.respondError(serverRequest.id, {
        code: -32601,
        message: `Unsupported Codex server request: ${serverRequest.method}`,
      });
      queue.push({
        type: "error",
        message: `Codex requested unsupported interaction: ${serverRequest.method}`,
        code: "UNSUPPORTED_SERVER_REQUEST",
      });
      return;
    }

    const requestId = `codex:${randomUUID()}`;
    const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
    const item =
      itemId === undefined ? undefined : this.#startedItems.get(itemKey(sessionId, itemId));
    const expirationTimer = setTimeout(() => {
      const current = this.#pendingApprovals.get(requestId);
      if (current === undefined) return;
      try {
        this.#respondToPendingApproval(current, "cancel");
      } catch (error) {
        queue.fail(error);
      } finally {
        this.#pendingApprovals.delete(requestId);
      }
      queue.push({
        type: "error",
        message: "Approval request expired and was cancelled",
        code: "APPROVAL_EXPIRED",
      });
    }, this.#options.approvalTimeoutMs);
    expirationTimer.unref();
    this.#pendingApprovals.set(requestId, {
      rpcId: serverRequest.id,
      method: serverRequest.method,
      sessionId,
      ...(serverRequest.method === "item/permissions/requestApproval"
        ? { requestedPermissions: requestedPermissions(serverRequest.params) }
        : {}),
      expiresAt: Date.now() + this.#options.approvalTimeoutMs,
      expirationTimer,
    });
    this.#statuses.set(sessionId, "waiting_for_approval");
    queue.push({
      type: "status.changed",
      status: "waiting_for_approval",
    });
    queue.push({
      type: "approval.requested",
      requestId,
      summary:
        serverRequest.method === "item/commandExecution/requestApproval"
          ? commandSummary(serverRequest.params, item)
          : serverRequest.method === "item/fileChange/requestApproval"
            ? fileChangeSummary(serverRequest.params, item)
            : permissionsSummary(serverRequest.params),
      details: toJsonValue({ request: serverRequest.params, item: item ?? null }),
    });
  }

  #handleUserInputRequest(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    queue: AsyncEventQueue,
    allowBindingWait = true,
  ): void {
    let requestTurnId: string | undefined;
    try {
      const params = toolRequestUserInputParams(serverRequest.params);
      requestTurnId = params.turnId;
      if (params.threadId !== sessionId) {
        throw new Error("Structured input thread does not match the active session");
      }
      const question = validateWorkspaceGitPlanQuestion(serverRequest.params);
      const planKey = turnKey(sessionId, params.turnId);
      const plans = this.#workspaceGitPlansByTurn.get(planKey) ?? [];
      if (plans.length === 0 && allowBindingWait) {
        this.#waitForWorkspaceGitPlan(serverRequest, sessionId, params.turnId, queue);
        return;
      }
      if (plans.length !== 1) {
        throw new Error(
          plans.length === 0
            ? "No exact workspace-git plan is bound to this structured request"
            : "More than one workspace-git plan is pending in this turn",
        );
      }
      const plan = plans[0]!;
      const planExpiry = Date.parse(plan.expiresAt);
      const now = Date.now();
      const timeoutMs = Math.min(
        this.#options.approvalTimeoutMs,
        planExpiry - now,
        question.autoResolutionMs ?? Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(planExpiry) || timeoutMs <= 0) {
        throw new Error("The workspace-git plan has already expired");
      }
      this.#workspaceGitPlansByTurn.delete(planKey);
      const requestId = `codex-input:${randomUUID()}`;
      const expirationTimer = setTimeout(() => {
        const pending = this.#pendingUserInputs.get(requestId);
        if (pending === undefined) return;
        try {
          this.#settleUserInput(requestId, pending, "reject");
        } catch (error) {
          queue.fail(error);
          return;
        }
        this.#statuses.set(sessionId, "running");
        queue.push({ type: "status.changed", status: "running" });
        queue.push({
          type: "error",
          message: "Git plan approval expired and was rejected",
          code: "STRUCTURED_INPUT_EXPIRED",
        });
      }, timeoutMs);
      expirationTimer.unref();
      this.#pendingUserInputs.set(requestId, {
        rpcId: serverRequest.id,
        sessionId,
        questionId: question.questionId,
        approveLabel: question.approveLabel,
        rejectLabel: question.rejectLabel,
        plan,
        expiresAt: now + timeoutMs,
        expirationTimer,
      });
      this.#statuses.set(sessionId, "waiting_for_approval");
      queue.push({ type: "status.changed", status: "waiting_for_approval" });
      queue.push({
        type: "user_input.requested",
        requestId,
        prompt: question.prompt,
        options: [
          { id: "approve", label: "承認して実行" },
          { id: "reject", label: "拒否・保留" },
        ],
        plan,
      });
    } catch (error) {
      this.#rejectUnboundGitApproval(
        serverRequest,
        sessionId,
        requestTurnId,
        queue,
        error,
      );
    }
  }

  #waitForWorkspaceGitPlan(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue,
  ): void {
    const key = rpcKey(serverRequest.id);
    if (this.#pendingUserInputBindings.has(key)) {
      throw new Error("Structured input request is already waiting for a Git plan");
    }
    const expirationTimer = setTimeout(() => {
      const pending = this.#pendingUserInputBindings.get(key);
      if (pending === undefined) return;
      this.#pendingUserInputBindings.delete(key);
      this.#rejectUserInputBinding(
        pending.serverRequest,
        pending.sessionId,
        pending.turnId,
        pending.queue,
        new Error("No exact workspace-git plan arrived for this structured request"),
      );
    }, this.#options.gitPlanBindingGraceMs);
    expirationTimer.unref();
    this.#pendingUserInputBindings.set(key, {
      rpcId: serverRequest.id,
      serverRequest,
      sessionId,
      turnId,
      queue,
      expirationTimer,
    });
  }

  #retryPendingUserInputBindings(sessionId: string, turnId: string): void {
    for (const [key, pending] of this.#pendingUserInputBindings) {
      if (pending.sessionId !== sessionId || pending.turnId !== turnId) continue;
      clearTimeout(pending.expirationTimer);
      this.#pendingUserInputBindings.delete(key);
      this.#handleUserInputRequest(
        pending.serverRequest,
        pending.sessionId,
        pending.queue,
        false,
      );
    }
  }

  #rejectPendingUserInputBindings(
    sessionId: string,
    queue: AsyncEventQueue,
    reason: string,
  ): void {
    for (const [key, pending] of this.#pendingUserInputBindings) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.expirationTimer);
      this.#pendingUserInputBindings.delete(key);
      this.#rejectUserInputBinding(
        pending.serverRequest,
        pending.sessionId,
        pending.turnId,
        queue,
        new Error(reason),
      );
    }
  }

  #rejectUserInputBinding(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue,
    error: Error,
  ): void {
    this.#rejectUnboundGitApproval(
      serverRequest,
      sessionId,
      turnId,
      queue,
      error,
    );
  }

  #rejectUnboundGitApproval(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string | undefined,
    queue: AsyncEventQueue,
    error: unknown,
  ): void {
    const message = gitApprovalBindingErrorMessage(error);
    this.#client.respondError(serverRequest.id, {
      code: -32602,
      message,
      data: { recovery: "fresh_workspace_git_prepare_required" },
    });
    if (turnId === undefined) {
      queue.push({
        type: "error",
        message,
        code: "UNBOUND_GIT_APPROVAL",
      });
      return;
    }
    const recoveryKey = turnKey(sessionId, turnId);
    if (this.#gitApprovalRecoveryTurns.has(recoveryKey)) return;
    this.#gitApprovalRecoveryTurns.add(recoveryKey);
    queue.push({
      type: "git_approval.reprepare_required",
      message:
        "このGit計画は現在のターンに紐づいていないか、すでに期限切れです。" +
        "古い計画を承認せず、最新状態から承認画面を安全に再作成できます。",
    });
  }

  #failActiveStreams(error: Error): void {
    this.#transportFailed = true;
    for (const [sessionId, queue] of this.#activeQueues) {
      this.#statuses.set(sessionId, "failed");
      queue.fail(error);
    }
    this.#activeQueues.clear();
    this.#activeTurns.clear();
    this.#runningSessions.clear();
    this.#loadedSessions.clear();
    for (const pending of this.#pendingApprovals.values()) {
      clearTimeout(pending.expirationTimer);
    }
    this.#pendingApprovals.clear();
    for (const pending of this.#pendingUserInputs.values()) {
      clearTimeout(pending.expirationTimer);
    }
    this.#pendingUserInputs.clear();
    for (const pending of this.#pendingUserInputBindings.values()) {
      clearTimeout(pending.expirationTimer);
    }
    this.#pendingUserInputBindings.clear();
    this.#workspaceGitPlansByTurn.clear();
    this.#gitApprovalRecoveryTurns.clear();
    this.#startedItems.clear();
  }

  #removePendingApprovals(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingApprovals.delete(requestId);
      }
    }
  }

  #removePendingServerRequestByRpcId(rpcId: RpcId): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.rpcId === rpcId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingApprovals.delete(requestId);
      }
    }
    for (const [requestId, pending] of this.#pendingUserInputs) {
      if (pending.rpcId === rpcId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingUserInputs.delete(requestId);
      }
    }
    const bindingKey = rpcKey(rpcId);
    const binding = this.#pendingUserInputBindings.get(bindingKey);
    if (binding !== undefined) {
      clearTimeout(binding.expirationTimer);
      this.#pendingUserInputBindings.delete(bindingKey);
    }
  }

  #removePendingUserInputs(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingUserInputs) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingUserInputs.delete(requestId);
      }
    }
  }

  #settleUserInput(
    requestId: string,
    pending: PendingUserInput,
    optionId: AgentUserInputResponse["optionId"],
  ): void {
    clearTimeout(pending.expirationTimer);
    this.#pendingUserInputs.delete(requestId);
    const label = optionId === "approve" ? pending.approveLabel : pending.rejectLabel;
    this.#client.respondToUserInput(pending.rpcId, {
      answers: { [pending.questionId]: { answers: [label] } },
    });
  }

  #rememberWorkspaceGitPlan(
    sessionId: string,
    turnId: string,
    plan: WorkspaceGitApprovalPlan,
  ): void {
    const key = turnKey(sessionId, turnId);
    const current = this.#workspaceGitPlansByTurn.get(key) ?? [];
    const duplicate = current.find(
      (candidate) => candidate.operationId === plan.operationId,
    );
    if (duplicate !== undefined) {
      if (duplicate.planHash !== plan.planHash) {
        this.#workspaceGitPlansByTurn.set(key, Object.freeze([...current, plan]));
      }
      return;
    }
    if (current.length >= 2) return;
    this.#workspaceGitPlansByTurn.set(key, Object.freeze([...current, plan]));
  }

  #removeWorkspaceGitPlans(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#workspaceGitPlansByTurn.keys()) {
      if (key.startsWith(prefix)) this.#workspaceGitPlansByTurn.delete(key);
    }
  }

  #removeGitApprovalRecoveryTurns(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#gitApprovalRecoveryTurns) {
      if (key.startsWith(prefix)) this.#gitApprovalRecoveryTurns.delete(key);
    }
  }

  #respondToPendingApproval(
    pending: PendingApproval,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ): void {
    if (pending.method === "item/commandExecution/requestApproval") {
      this.#client.respondToCommandApproval(pending.rpcId, decision);
    } else if (pending.method === "item/fileChange/requestApproval") {
      this.#client.respondToFileChangeApproval(pending.rpcId, decision);
    } else {
      const granted =
        decision === "accept" || decision === "acceptForSession"
          ? pending.requestedPermissions ?? {}
          : {};
      this.#client.respondToPermissionsApproval(pending.rpcId, {
        permissions: granted,
        scope: decision === "acceptForSession" ? "session" : "turn",
      });
    }
  }

  #removeStartedItems(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#startedItems.keys()) {
      if (key.startsWith(prefix)) this.#startedItems.delete(key);
    }
  }

  async #reconcileTurnStatus(
    sessionId: string,
    queue: AsyncEventQueue,
  ): Promise<"active" | "terminal" | "retry"> {
    try {
      const thread = await this.#client.readThread(sessionId);
      const status = asRecord(thread.status);
      if (status?.type === "active") {
        return "active";
      }
      if (status?.type === "idle") {
        this.#activeTurns.delete(sessionId);
        this.#statuses.set(sessionId, "idle");
        queue.push({ type: "status.changed", status: "idle" });
        queue.close();
        return "terminal";
      }
      if (status?.type === "notLoaded" || status?.type === "systemError") {
        queue.fail(
          new Error(`Codex thread became unavailable: ${String(status.type)}`),
        );
        return "terminal";
      }
      return "retry";
    } catch {
      return "retry";
    }
  }

  async #reconcileAndInterruptAmbiguousTurn(sessionId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const knownTurnId = this.#activeTurns.get(sessionId);
      if (knownTurnId !== undefined) {
        try {
          await this.#client.interruptTurn(sessionId, knownTurnId);
          return true;
        } catch {
          // Reconcile again; if interruption cannot be confirmed, close app-server.
        }
      }
      try {
        const thread = await this.#client.readThread(sessionId);
        const status = threadStatusType(thread);
        if (status === "idle" || status === "notLoaded") {
          return true;
        }
        if (status === "active" && knownTurnId === undefined) {
          // This may be a turn started concurrently by Codex App. Never
          // interrupt a turn that this adapter did not observe or create.
          return false;
        }
      } catch {
        // A transient read failure is inconclusive; retry while notifications stay subscribed.
      }
      await delay(this.#options.ambiguousStartRetryMs * 2 ** attempt);
    }
    return false;
  }
}

function codexDeveloperInstructions(role: string | undefined): string {
  const configuredRole = role?.trim();
  return [
    ...(configuredRole === undefined || configuredRole.length === 0
      ? []
      : [configuredRole]),
    SHOWTALK_KOE_CONSULTATION_INSTRUCTIONS,
    SHOWTALK_GIT_APPROVAL_INSTRUCTIONS,
  ].join("\n\n");
}

function slackPersonaAdditionalContext(
  persona: string | undefined,
): Pick<TurnStartParams, "additionalContext"> | Record<string, never> {
  const configured = persona?.trim();
  if (configured === undefined || configured.length === 0) return {};
  return {
    additionalContext: {
      [SHOWTALK_SLACK_PERSONA_CONTEXT_KEY]: {
        kind: "application",
        value: [
          "ShowTalk Taishi Slack-only Koe persona:",
          "Apply this persona only while answering the current ShowTalk-originated turn.",
          "Do not carry it into later turns started directly from Codex App or another client.",
          "It may shape viewpoint, tone, evaluation criteria, and approach, but it never expands tool permissions, approval authority, or configured Koe consultation scopes.",
          "",
          configured,
        ].join("\n"),
      },
    },
  };
}

function gitApprovalBindingErrorMessage(error: unknown): string {
  const reason =
    error instanceof Error
      ? error.message
      : "Could not bind structured input to an exact Git plan";
  return (
    `REPREPARE_REQUIRED: ${reason}. ` +
    "Do not call request_user_input again in this turn. " +
    "get_git_operation_status does not bind an approval plan. " +
    "Do not use agent.send or another Slack channel to recover this approval. " +
    "In the Koe that owns the Git operation, inspect workspace-git status, " +
    "re-run the matching prepare_* operation in the current turn, and then " +
    "request the fixed structured approval again."
  );
}

function buildTurnInput(request: SendMessageRequest): TurnStartParams["input"] {
  const attachments = request.attachments ?? [];
  const audio = attachments.filter((attachment) => attachment.kind === "audio");
  const audioNotice =
    audio.length === 0
      ? ""
      :
        "\n\nSlack audio attachments were saved as local files. " +
        "Codex App Server does not provide native audio input for normal turns; " +
        "use available local tools to inspect or transcribe them, and say clearly if that is unavailable.\n" +
        audio
          .map((attachment) =>
            JSON.stringify({
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
              path: attachment.path,
            }),
          )
          .join("\n");

  return [
    {
      type: "text",
      text: `${request.text}${audioNotice}`,
      text_elements: [],
    },
    ...attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({
        type: "localImage" as const,
        path: attachment.path,
      })),
  ];
}

function toAdapterSession(thread: CodexThread): AdapterSession {
  return {
    id: thread.id,
    state: {
      backendThreadId: thread.id,
      ...(thread.sessionId === undefined ? {} : { sessionId: thread.sessionId }),
    },
  };
}

function getWorkspacePath(
  request: { readonly agent: AgentDefinition },
): string | undefined {
  const value = request.agent.metadata?.workspacePath;
  return typeof value === "string" ? value : undefined;
}

function belongsToThread(params: unknown, threadId: string): boolean {
  if (params === null || typeof params !== "object") return false;
  if ("threadId" in params) return params.threadId === threadId;
  if ("thread" in params && params.thread !== null && typeof params.thread === "object") {
    return "id" in params.thread && params.thread.id === threadId;
  }
  return false;
}

function normalizeNotification(method: string, params: unknown): AgentEvent | undefined {
  const record = asRecord(params);
  switch (method) {
    case "item/agentMessage/delta":
      return typeof record?.delta === "string"
        ? {
            type: "message.delta",
            text: truncateText(record.delta, MAX_AGENT_MESSAGE_CHARS),
          }
        : undefined;
    case "item/started": {
      const item = asRecord(record?.item);
      if (item === undefined || typeof item.id !== "string" || typeof item.type !== "string") {
        return undefined;
      }
      if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "mcpToolCall"
      ) {
        return {
          type: "tool.started",
          toolCallId: item.id,
          name: toolEventName(item),
          input: toJsonValue(item.arguments ?? item),
        };
      }
      return undefined;
    }
    case "item/completed": {
      const item = asRecord(record?.item);
      if (item === undefined) return undefined;
      if (item.type === "agentMessage") {
        return {
          type: "message.completed",
          ...(typeof item.text === "string"
            ? { text: truncateText(item.text, MAX_AGENT_MESSAGE_CHARS) }
            : {}),
        };
      }
      if (
        typeof item.id === "string" &&
        (item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "mcpToolCall")
      ) {
        return {
          type: "tool.completed",
          toolCallId: item.id,
          output: toJsonValue(item.result ?? item.error ?? item),
          ...(item.status === "failed" || item.status === "declined"
            ? { isError: true }
            : {}),
        };
      }
      return undefined;
    }
    case "turn/completed":
      return { type: "status.changed", status: turnStatus(params) };
    case "error": {
      const error = asRecord(record?.error);
      return {
        type: "error",
        message:
          typeof error?.message === "string"
            ? truncateText(error.message, 4_000)
            : "Codex turn failed",
      };
    }
    default:
      return undefined;
  }
}

function toolEventName(item: Record<string, unknown>): string {
  if (
    item.type === "mcpToolCall" &&
    typeof item.server === "string" &&
    typeof item.tool === "string"
  ) {
    return `${item.server}.${item.tool}`;
  }
  return typeof item.type === "string" ? item.type : "tool";
}

function threadStatusType(thread: CodexThread): string | undefined {
  return typeof asRecord(thread.status)?.type === "string"
    ? (asRecord(thread.status)?.type as string)
    : undefined;
}

function turnStatus(params: unknown): AgentStatus {
  const turn = asRecord(asRecord(params)?.turn);
  switch (turn?.status) {
    case "completed":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

function isApprovalMethod(
  method: string,
): method is PendingApproval["method"] {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval"
  );
}

function commandSummary(
  params: unknown,
  item?: Record<string, unknown>,
): string {
  const record = asRecord(params);
  const network = asRecord(record?.networkApprovalContext);
  if (typeof network?.host === "string") {
    const protocol = typeof network.protocol === "string" ? `${network.protocol}://` : "";
    return `Codex requests network access to: ${protocol}${network.host}`;
  }
  const command =
    typeof record?.command === "string"
      ? record.command
      : typeof item?.command === "string"
        ? item.command
        : "command";
  return `Codex requests permission to run: ${command}`;
}

function fileChangeSummary(
  params: unknown,
  item?: Record<string, unknown>,
): string {
  const record = asRecord(params);
  const reason = typeof record?.reason === "string" ? ` (${record.reason})` : "";
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change) => asRecord(change)?.path)
    .filter((path): path is string => typeof path === "string")
    .slice(0, 5);
  const files = paths.length === 0 ? "" : `\nFiles: ${paths.join(", ")}`;
  return `Codex requests permission to modify files${reason}${files}`;
}

function permissionsSummary(params: unknown): string {
  const record = asRecord(params);
  const reason =
    typeof record?.reason === "string" && record.reason.trim().length > 0
      ? `: ${truncateText(record.reason, 1_000)}`
      : "";
  const requested = requestedPermissions(params);
  const kinds = Object.keys(requested);
  return `Codex requests additional ${kinds.length === 0 ? "permissions" : kinds.join(" and ")} permissions${reason}`;
}

function requestedPermissions(
  params: unknown,
): Readonly<Record<string, JsonValue>> {
  const permissions = asRecord(asRecord(params)?.permissions);
  if (permissions === undefined) return {};
  const granted: Record<string, JsonValue> = {};
  for (const key of ["network", "fileSystem"] as const) {
    const value = permissions[key];
    if (value === undefined || value === null) continue;
    granted[key] = toJsonValue(value);
  }
  return granted;
}

function itemKey(sessionId: string, itemId: string): string {
  return `${sessionId}\u0000${itemId}`;
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function rpcKey(rpcId: RpcId): string {
  return `${typeof rpcId}:${String(rpcId)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mapApprovalDecision(
  decision: AgentApproval["decision"],
): "accept" | "acceptForSession" | "decline" | "cancel" {
  switch (decision) {
    case "allow_once":
      return "accept";
    case "allow_session":
      return "acceptForSession";
    case "deny":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  if (serialized.length <= MAX_EVENT_JSON_CHARS) {
    return JSON.parse(serialized) as JsonValue;
  }
  return {
    truncated: true,
    preview: truncateText(serialized, MAX_EVENT_JSON_CHARS - 64),
  };
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  readonly #values: AgentEvent[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<AgentEvent>): void;
    reject(error: unknown): void;
  }> = [];
  #queuedDeltaChars = 0;
  #closed = false;
  #error: unknown;

  push(value: AgentEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }

    if (value.type === "message.delta") {
      const previous = this.#values.at(-1);
      if (
        previous?.type === "message.delta" &&
        previous.text.length + value.text.length <= MAX_COALESCED_DELTA_CHARS
      ) {
        this.#values[this.#values.length - 1] = {
          type: "message.delta",
          text: previous.text + value.text,
        };
      } else {
        this.#values.push(value);
      }
      this.#queuedDeltaChars += value.text.length;
    } else {
      this.#values.push(value);
    }

    if (
      this.#values.length > MAX_QUEUED_EVENTS ||
      this.#queuedDeltaChars > MAX_QUEUED_DELTA_CHARS
    ) {
      this.fail(new Error("Codex event queue exceeded its memory safety limit"));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#values.length = 0;
    this.#queuedDeltaChars = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async (): Promise<IteratorResult<AgentEvent>> => {
        const value = this.#values.shift();
        if (value !== undefined) {
          if (value.type === "message.delta") {
            this.#queuedDeltaChars -= value.text.length;
          }
          return { done: false, value };
        }
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<AgentEvent>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}
