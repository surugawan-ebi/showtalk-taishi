import { createHash } from "node:crypto";

import {
  CoreError,
  type AgentRouter,
  type DelegationActivity,
  type DelegationResultMessage,
  type Gateway,
  type GatewayAgentEvent,
  type InMemoryAgentRegistry,
} from "../core/index.js";
import type { PermissionApprovalCoordinator } from "../permissions/approval-coordinator.js";
import type { PermissionEngine } from "../permissions/engine.js";
import { MAX_LISTED_AGENTS, MAX_RESULT_MESSAGE_LENGTH } from "./schemas.js";
import {
  resolveWorkspaceAttachments,
  type RuntimeSlackAttachment,
} from "./workspace-attachments.js";
import {
  McpServiceError,
  type McpAgentListResult,
  type McpAgentSendResult,
  type McpAgentStatusResult,
  type McpCallerContext,
  type McpGatewayRestartResult,
  type McpSlackAttachmentInput,
  type McpSlackWriteResult,
  type SwitchboardMcpService,
} from "./types.js";

export interface RuntimeMcpServiceOptions {
  readonly onProjectionError?: (error: unknown) => void;
  readonly onRestartRequested?: () => void;
}

export interface RuntimeSlackPort {
  postMessage(
    channelId: string,
    text: string | undefined,
    attachments?: readonly RuntimeSlackAttachment[],
  ): Promise<string>;
  reply(
    channelId: string,
    rootThreadTs: string,
    text: string | undefined,
    attachments?: readonly RuntimeSlackAttachment[],
  ): Promise<string>;
  projectDelegation(activity: DelegationActivity): Promise<
    | { readonly channelId: string; readonly rootThreadTs: string }
    | undefined
  >;
  projectDelegationContinuation(
    request: DelegationResultMessage,
    events: AsyncIterable<GatewayAgentEvent>,
  ): Promise<void>;
}

interface SourceSlackTurn {
  readonly sessionId: string;
  readonly adapterSessionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly slackUserId?: string;
  readonly startedAt: string;
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly promise: Promise<unknown>;
  settledAt?: number;
}

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1_000;
const MAX_IDEMPOTENCY_ENTRIES = 256;

/** Wires the transport-neutral MCP contract to the live Gateway components. */
export class RuntimeMcpService implements SwitchboardMcpService {
  readonly #registry: InMemoryAgentRegistry;
  readonly #permissions: PermissionEngine;
  readonly #approvals: PermissionApprovalCoordinator;
  readonly #onProjectionError: (error: unknown) => void;
  readonly #onRestartRequested: (() => void) | undefined;
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #shutdown = new AbortController();
  readonly #idleWaiters = new Set<() => void>();
  #activeExecutions = 0;
  #draining = false;
  #restartRequested = false;
  #router: AgentRouter | undefined;
  #gateway: Gateway | undefined;
  #slack: RuntimeSlackPort | undefined;

  constructor(
    registry: InMemoryAgentRegistry,
    permissions: PermissionEngine,
    approvals: PermissionApprovalCoordinator,
    options: RuntimeMcpServiceOptions = {},
  ) {
    this.#registry = registry;
    this.#permissions = permissions;
    this.#approvals = approvals;
    this.#onProjectionError = options.onProjectionError ?? (() => undefined);
    this.#onRestartRequested = options.onRestartRequested;
  }

  attach(router: AgentRouter, gateway: Gateway, slack: RuntimeSlackPort): void {
    if (
      this.#router !== undefined ||
      this.#gateway !== undefined ||
      this.#slack !== undefined
    ) {
      throw new Error("Runtime MCP service is already attached");
    }
    this.#router = router;
    this.#gateway = gateway;
    this.#slack = slack;
  }

  beginShutdown(): void {
    this.#draining = true;
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("ShowTalk Taishi is shutting down"));
    }
  }

  /** Rejects new MCP methods without cancelling requests already in progress. */
  beginDrain(): void {
    this.#draining = true;
  }

  isIdle(): boolean {
    return this.#activeExecutions === 0;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  isKnownAgent(agentId: string): boolean {
    return this.#registry.getAgent(agentId) !== undefined;
  }

  agentList(context: McpCallerContext): McpAgentListResult {
    context = this.#liveContext(context);
    const caller = this.#requireCaller(context);
    const consultationScopes = new Map(
      this.#permissions
        .consultationTargets(caller.id)
        .map(({ targetAgentId, scope }) => [targetAgentId, scope]),
    );
    return {
      agents: this.#registry
        .listAgents()
        .filter((agent) => consultationScopes.has(agent.id))
        .slice(0, MAX_LISTED_AGENTS)
        .map((agent) => {
          const session = latestSession(this.#registry, agent.id);
          return {
            id: agent.id,
            ...(agent.callName === undefined ? {} : { call_name: agent.callName }),
            adapter: agent.adapter,
            channel: agent.channelId,
            status: session?.status ?? "not_started",
            consultation_scope: consultationScopes.get(agent.id)!,
          };
        }),
    };
  }

  agentStatus(
    context: McpCallerContext,
    target: string,
  ): McpAgentStatusResult {
    context = this.#liveContext(context);
    this.#requireCaller(context);
    const resolvedTarget = this.#requireAgentAddress(target);
    const session = latestSession(this.#registry, resolvedTarget.id);
    return {
      agent_id: resolvedTarget.id,
      status: session?.status ?? "not_started",
      ...(session === undefined ? {} : { session_id: session.id }),
    };
  }

  async agentSend(
    context: McpCallerContext,
    target: string,
    message: string,
  ): Promise<McpAgentSendResult> {
    context = this.#liveContext(context);
    this.#requireCaller(context);
    const targetAgentId = this.#requireAgentAddress(target).id;
    return this.#once(
      context,
      "agent.send",
      [targetAgentId, message],
      () => this.#executeAgentSend(context, targetAgentId, message),
    );
  }

  async gatewayRestart(
    context: McpCallerContext,
  ): Promise<McpGatewayRestartResult> {
    context = this.#liveContext(context);
    return this.#once(
      context,
      "gateway.restart",
      [],
      () => this.#executeGatewayRestart(context),
    );
  }

  async #executeGatewayRestart(
    context: McpCallerContext,
  ): Promise<McpGatewayRestartResult> {
    if (this.#onRestartRequested === undefined) {
      throw new McpServiceError(
        "SERVICE_UNAVAILABLE",
        "The Gateway restart supervisor is unavailable",
      );
    }
    const caller = this.#requireCaller(context);
    const result = await this.#approvals.authorize(
      "approval",
      {
        sourceAgentId: caller.id,
        sourceChannelId: caller.channelId,
        operation: "gateway.restart",
        summary: "Gateway Worker restart",
        grantKey: JSON.stringify(["gateway.restart", caller.id]),
        allowSessionGrant: false,
      },
      context.signal,
    );
    this.#throwIfCancelled(context);
    if (result !== "allow") {
      throw new McpServiceError(
        "PERMISSION_DENIED",
        "Human approval denied the Gateway Worker restart",
      );
    }

    if (!this.#restartRequested) {
      this.#restartRequested = true;
      try {
        this.#onRestartRequested();
      } catch (error) {
        this.#restartRequested = false;
        throw error;
      }
    }
    return { status: "scheduled" };
  }

  async #executeAgentSend(
    context: McpCallerContext,
    target: string,
    message: string,
  ): Promise<McpAgentSendResult> {
    const caller = this.#requireCaller(context);
    const targetAgentId = target;
    const targetAgent = this.#registry.requireAgent(targetAgentId);
    const targetUsesSlackThreads =
      (targetAgent.conversationScope ?? "channel") === "slack_thread";
    if (
      this.#permissions.consultationScope(caller.id, targetAgentId) === undefined
    ) {
      throw new McpServiceError(
        "PERMISSION_DENIED",
        `Koe ${targetAgentId} is not a configured consultation target for ${caller.id}`,
      );
    }
    const router = this.#requireRouter();
    if (context.signal.aborted) {
      throw new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled");
    }

    let delegationId: string | undefined;
    let streamed = "";
    let completed: string | undefined;
    let depth = 1;
    let projectionStartFailed = false;
    let projectedStart:
      | Extract<DelegationActivity, { readonly type: "delegation.started" }>
      | undefined;
    const sourceTurn = this.#captureSourceSlackTurn(caller.id, caller.channelId);
    const routing = new AbortController();
    let accepted = false;
    let sourceDetached = false;
    const abortBeforeAcceptance = () => {
      if (accepted) {
        sourceDetached = true;
        return;
      }
      routing.abort(new Error("The source MCP request was cancelled before acceptance"));
    };
    const abortForShutdown = () => {
      routing.abort(new Error("ShowTalk Taishi is shutting down"));
      if (delegationId !== undefined) {
        void router
          .interruptDelegation(targetAgentId, delegationId)
          .catch(() => undefined);
      }
    };
    context.signal.addEventListener("abort", abortBeforeAcceptance, { once: true });
    this.#shutdown.signal.addEventListener("abort", abortForShutdown, { once: true });
    // Close the check/listener race without interrupting unrelated target work.
    if (context.signal.aborted) abortBeforeAcceptance();
    if (this.#shutdown.signal.aborted) abortForShutdown();
    try {
      for await (const activity of router.sendFromAgent({
        sourceAgentId: context.agentId,
        targetAgentId,
        message,
        ...(sourceTurn === undefined
          ? {}
          : { sourceRootThreadTs: sourceTurn.rootThreadTs }),
        metadata: { origin: "mcp.agent.send" },
        signal: routing.signal,
      })) {
        delegationId ??= activity.delegationId;
        depth = activity.depth;
        if (activity.type === "delegation.agent_event") {
          if (activity.event.type === "message.delta") {
            streamed = appendBounded(
              streamed,
              activity.event.text,
              MAX_RESULT_MESSAGE_LENGTH,
            );
          }
          if (
            activity.event.type === "message.completed" &&
            activity.event.text !== undefined
          ) {
            completed = truncateResult(activity.event.text);
          }
        }
        if (!projectionStartFailed) {
          let destination:
            | { readonly channelId: string; readonly rootThreadTs: string }
            | undefined;
          try {
            destination = await this.#requireSlack().projectDelegation(activity);
            if (activity.type === "delegation.started" && targetUsesSlackThreads) {
              if (
                destination === undefined ||
                destination.channelId !== activity.targetChannelId
              ) {
                throw new Error(
                  "Slack did not return the exact destination for a thread-scoped Koe visit",
                );
              }
              await this.#requireGateway().bindDelegationConversation(
                destination.channelId,
                destination.rootThreadTs,
                activity.targetAgentId,
                activity.targetSessionId,
              );
            }
            if (activity.type === "delegation.started") {
              projectedStart = activity;
            }
          } catch (error) {
            this.#onProjectionError(error);
            if (
              activity.type === "delegation.agent_event" &&
              activity.event.type === "user_input.requested"
            ) {
              try {
                await this.#requireGateway().resolveSessionUserInput(
                  activity.targetSessionId,
                  {
                    requestId: activity.event.requestId,
                    optionId: "reject",
                  },
                );
              } catch (resolutionError) {
                this.#onProjectionError(resolutionError);
                // An invisible structured request must never remain live. By
                // failing routing here, adapter cleanup interrupts the target.
                throw resolutionError;
              }
            }
            if (activity.type === "delegation.started") {
              if (targetUsesSlackThreads) {
                if (destination !== undefined) {
                  await this.#closeProjectedDelegation(activity, error);
                }
                throw error;
              }
              projectionStartFailed = true;
            }
          } finally {
            if (
              activity.type === "delegation.completed" ||
              activity.type === "delegation.failed"
            ) {
              projectedStart = undefined;
            }
          }
        }
        if (activity.type === "delegation.started") accepted = true;
        if (routing.signal.aborted) {
          throw new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled");
        }
      }
    } catch (error) {
      if (projectedStart !== undefined) {
        await this.#closeProjectedDelegation(projectedStart, error);
        projectedStart = undefined;
      }
      throw toPublicServiceError(error);
    } finally {
      context.signal.removeEventListener("abort", abortBeforeAcceptance);
      this.#shutdown.signal.removeEventListener("abort", abortForShutdown);
    }

    const response = truncateResult(completed ?? streamed);
    if (
      delegationId !== undefined &&
      sourceTurn !== undefined &&
      (sourceDetached || !this.#isSourceTurnStillLive(caller.id, sourceTurn))
    ) {
      const request: DelegationResultMessage = {
        delegationId,
        sourceAgentId: caller.id,
        sourceChannelId: sourceTurn.channelId,
        sourceRootThreadTs: sourceTurn.rootThreadTs,
        sourceMessageTs: sourceTurn.messageTs,
        ...(sourceTurn.slackUserId === undefined
          ? {}
          : { sourceSlackUserId: sourceTurn.slackUserId }),
        sourceSessionId: sourceTurn.sessionId,
        sourceAdapterSessionId: sourceTurn.adapterSessionId,
        targetAgentId,
        depth,
        result:
          response.length === 0
            ? `${targetAgentId}のKoeはテキストの返答なしで作業を完了しました。`
            : response,
      };
      try {
        await this.#requireSlack().projectDelegationContinuation(
          request,
          this.#requireGateway().handleDelegationResult(request),
        );
      } catch (error) {
        // The target work succeeded. A delayed source delivery failure must be
        // visible operationally without rewriting the successful tool result.
        this.#onProjectionError(error);
      }
    }
    return {
      target: targetAgentId,
      status: "completed",
      ...(response.length === 0 ? {} : { message: response }),
      ...(delegationId === undefined ? {} : { delegation_id: delegationId }),
    };
  }

  async slackPost(
    context: McpCallerContext,
    channel: string,
    message?: string,
    attachments: readonly McpSlackAttachmentInput[] = [],
  ): Promise<McpSlackWriteResult> {
    context = this.#liveContext(context);
    this.#requireCaller(context);
    const channelId = this.#resolveChannel(channel);
    return this.#once(
      context,
      "slack.post",
      [channelId, message ?? null, attachments],
      () => this.#executeSlackPost(context, channelId, message, attachments),
    );
  }

  async #executeSlackPost(
    context: McpCallerContext,
    channelId: string,
    message: string | undefined,
    attachments: readonly McpSlackAttachmentInput[],
  ): Promise<McpSlackWriteResult> {
    const caller = this.#requireCaller(context);
    await this.#authorizeSlackWrite(
      context,
      caller.channelId,
      channelId,
      slackWriteSummary(message, attachments),
    );
    const files = attachments.length === 0
      ? []
      : await resolveWorkspaceAttachments(
          requireWorkspacePath(caller),
          attachments,
        );
    this.#throwIfCancelled(context);
    const ts = await (files.length === 0
      ? this.#requireSlack().postMessage(channelId, message)
      : this.#requireSlack().postMessage(channelId, message, files));
    return { channel: channelId, ts };
  }

  async slackReply(
    context: McpCallerContext,
    channel: string,
    threadTs: string,
    message?: string,
    attachments: readonly McpSlackAttachmentInput[] = [],
  ): Promise<McpSlackWriteResult> {
    context = this.#liveContext(context);
    this.#requireCaller(context);
    const channelId = this.#resolveChannel(channel);
    return this.#once(
      context,
      "slack.reply",
      [channelId, threadTs, message ?? null, attachments],
      () => this.#executeSlackReply(context, channelId, threadTs, message, attachments),
    );
  }

  async #executeSlackReply(
    context: McpCallerContext,
    channelId: string,
    threadTs: string,
    message: string | undefined,
    attachments: readonly McpSlackAttachmentInput[],
  ): Promise<McpSlackWriteResult> {
    const caller = this.#requireCaller(context);
    await this.#authorizeSlackWrite(
      context,
      caller.channelId,
      channelId,
      slackWriteSummary(message, attachments),
    );
    const files = attachments.length === 0
      ? []
      : await resolveWorkspaceAttachments(
          requireWorkspacePath(caller),
          attachments,
        );
    this.#throwIfCancelled(context);
    const ts = await (files.length === 0
      ? this.#requireSlack().reply(channelId, threadTs, message)
      : this.#requireSlack().reply(channelId, threadTs, message, files));
    return { channel: channelId, ts, thread_ts: threadTs };
  }

  async #authorizeSlackWrite(
    context: McpCallerContext,
    sourceChannelId: string,
    targetChannelId: string,
    message: string,
  ): Promise<void> {
    const sourceAgentId = context.agentId;
    const policy = this.#permissions.slackAccess(
      sourceAgentId,
      "write",
      targetChannelId,
    );
    const result = await this.#approvals.authorize(policy, {
      sourceAgentId,
      sourceChannelId,
      operation: "slack.write",
      summary: `Post to ${targetChannelId}: ${truncateSummary(message)}`,
      grantKey: JSON.stringify(["slack.write", sourceAgentId, targetChannelId]),
    }, context.signal);
    this.#throwIfCancelled(context);
    if (result !== "allow") {
      throw new McpServiceError(
        "PERMISSION_DENIED",
        `Koe ${sourceAgentId} may not write to Slack channel ${targetChannelId}`,
      );
    }
  }

  #resolveChannel(channel: string): string {
    return this.#registry.getAgentByAddress(channel)?.channelId ?? channel;
  }

  #requireCaller(context: McpCallerContext) {
    this.#throwIfCancelled(context);
    const agent = this.#registry.getAgent(context.agentId);
    if (agent === undefined) {
      throw new McpServiceError("UNKNOWN_AGENT", "The authenticated Koe no longer exists");
    }
    return agent;
  }

  #throwIfCancelled(context: McpCallerContext): void {
    if (context.signal.aborted) {
      throw new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled");
    }
  }

  #liveContext(context: McpCallerContext): McpCallerContext {
    if (this.#shutdown.signal.aborted) {
      throw new McpServiceError(
        "SERVICE_UNAVAILABLE",
        "ShowTalk Taishi is shutting down",
      );
    }
    if (this.#draining) {
      throw new McpServiceError(
        "SERVICE_UNAVAILABLE",
        "ShowTalk Taishi is preparing to restart",
      );
    }
    return Object.freeze({
      ...context,
      signal: AbortSignal.any([context.signal, this.#shutdown.signal]),
    });
  }

  async #once<T>(
    context: McpCallerContext,
    operation: string,
    fingerprintInput: readonly unknown[],
    execute: () => Promise<T>,
  ): Promise<T> {
    this.#throwIfCancelled(context);
    this.#pruneIdempotencyEntries();
    const key = digest([context.agentId, operation, context.requestId]);
    const fingerprint = digest(fingerprintInput);
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new McpServiceError(
          "IDEMPOTENCY_CONFLICT",
          "The MCP request identity was reused with different arguments",
        );
      }
      return awaitWithSignal(existing.promise as Promise<T>, context.signal);
    }

    this.#reserveIdempotencyCapacity();
    const promise = this.#trackExecution(execute);
    const entry: IdempotencyEntry = { fingerprint, promise };
    this.#idempotency.set(key, entry);
    void promise.then(
      () => {
        entry.settledAt = Date.now();
      },
      () => {
        entry.settledAt = Date.now();
      },
    );
    return awaitWithSignal(promise, context.signal);
  }

  #pruneIdempotencyEntries(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, entry] of this.#idempotency) {
      if (entry.settledAt !== undefined && entry.settledAt <= cutoff) {
        this.#idempotency.delete(key);
      }
    }
  }

  #reserveIdempotencyCapacity(): void {
    if (this.#idempotency.size < MAX_IDEMPOTENCY_ENTRIES) return;
    for (const [key, entry] of this.#idempotency) {
      if (entry.settledAt !== undefined) {
        this.#idempotency.delete(key);
        if (this.#idempotency.size < MAX_IDEMPOTENCY_ENTRIES) return;
      }
    }
    throw new McpServiceError(
      "SERVICE_BUSY",
      "Too many Koe operations are already in progress",
    );
  }

  async #trackExecution<T>(execute: () => Promise<T>): Promise<T> {
    this.#activeExecutions += 1;
    try {
      return await execute();
    } finally {
      this.#activeExecutions -= 1;
      if (this.#activeExecutions === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  #requireAgentAddress(address: string) {
    const agent = this.#registry.getAgentByAddress(address);
    if (agent === undefined) {
      throw new McpServiceError(
        "UNKNOWN_AGENT",
        `Unknown Koe ID or call name: ${address}`,
      );
    }
    return agent;
  }

  #requireRouter(): AgentRouter {
    if (this.#router === undefined) {
      throw new McpServiceError("SERVICE_UNAVAILABLE", "Koe routing is not ready");
    }
    return this.#router;
  }

  #requireSlack(): RuntimeSlackPort {
    if (this.#slack === undefined) {
      throw new McpServiceError("SERVICE_UNAVAILABLE", "Slack is not ready");
    }
    return this.#slack;
  }

  #requireGateway(): Gateway {
    if (this.#gateway === undefined) {
      throw new McpServiceError(
        "SERVICE_UNAVAILABLE",
        "Gateway is not attached",
      );
    }
    return this.#gateway;
  }

  async #closeProjectedDelegation(
    started: Extract<DelegationActivity, { readonly type: "delegation.started" }>,
    error: unknown,
  ): Promise<void> {
    const { type: _type, message: _message, ...base } = started;
    try {
      await this.#requireSlack().projectDelegation({
        ...base,
        type: "delegation.failed",
        error: normalizeProjectionError(error),
      });
    } catch (cleanupError) {
      this.#onProjectionError(cleanupError);
    }
  }

  #captureSourceSlackTurn(
    agentId: string,
    channelId: string,
  ): SourceSlackTurn | undefined {
    if (!this.#registry.hasActiveAgentTurn(agentId)) return undefined;
    const session = this.#registry.getActiveSession(agentId);
    const turn = session?.activeTurn;
    if (
      session === undefined ||
      turn?.type !== "slack" ||
      turn.channelId !== channelId
    ) {
      return undefined;
    }
    return {
      sessionId: session.id,
      adapterSessionId: session.adapterSession.id,
      channelId: turn.channelId,
      rootThreadTs: turn.rootThreadTs,
      messageTs: turn.messageTs,
      ...(turn.slackUserId === undefined
        ? {}
        : { slackUserId: turn.slackUserId }),
      startedAt: turn.startedAt,
    };
  }

  #isSourceTurnStillLive(agentId: string, expected: SourceSlackTurn): boolean {
    if (!this.#registry.hasActiveAgentTurn(agentId)) return false;
    const session = this.#registry.getActiveSession(agentId);
    const turn = session?.activeTurn;
    return (
      session?.id === expected.sessionId &&
      turn?.type === "slack" &&
      turn.channelId === expected.channelId &&
      turn.rootThreadTs === expected.rootThreadTs &&
      turn.messageTs === expected.messageTs &&
      turn.startedAt === expected.startedAt
    );
  }
}

function latestSession(registry: InMemoryAgentRegistry, agentId: string) {
  const sessions = [...registry.listSessions(agentId)];
  const primary = registry.getPrimarySession(agentId);
  if (primary !== undefined) return primary;
  const active = sessions
    .filter((session) =>
      ["starting", "running", "waiting_for_approval"].includes(session.status),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (active !== undefined) return active;
  return sessions.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
}

function toPublicServiceError(error: unknown): McpServiceError {
  if (error instanceof McpServiceError) return error;
  if (error instanceof CoreError) {
    return new McpServiceError(error.code, truncatePublicError(error.message));
  }
  return new McpServiceError(
    "AGENT_SEND_FAILED",
    "The target Koe could not complete the request",
  );
}

function truncateResult(value: string): string {
  return value.length <= MAX_RESULT_MESSAGE_LENGTH
    ? value
    : `${value.slice(0, MAX_RESULT_MESSAGE_LENGTH - 1)}…`;
}

function appendBounded(current: string, addition: string, limit: number): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  if (addition.length <= remaining) return current + addition;
  if (remaining === 1) return `${current}…`;
  return `${current}${addition.slice(0, remaining - 1)}…`;
}

function truncateSummary(value: string): string {
  const normalized = value.replaceAll("\n", " ");
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 299)}…`;
}

function normalizeProjectionError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function requireWorkspacePath(agent: { readonly metadata?: Readonly<Record<string, unknown>> }): string {
  const workspacePath = agent.metadata?.workspacePath;
  if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
    throw new McpServiceError(
      "INVALID_ATTACHMENT",
      "The authenticated Koe has no usable workspace path",
    );
  }
  return workspacePath;
}

function slackWriteSummary(
  message: string | undefined,
  attachments: readonly McpSlackAttachmentInput[],
): string {
  const fileSummary = attachments.length === 0
    ? ""
    : ` [files: ${attachments.map((attachment) => attachment.path).join(", ")}]`;
  return `${message ?? "Upload Slack attachments"}${fileSummary}`;
}

function truncatePublicError(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 511)}…`;
}

function digest(values: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(values), "utf8")
    .digest("base64url");
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
