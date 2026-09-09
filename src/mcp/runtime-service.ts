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
import type { AppOpsApprovalProofBroker } from "../approvals/appops-approval-proof.js";
import type { GatewayRestartReplayGuard } from "../state/gateway-restart-replay-guard.js";
import { MAX_LISTED_AGENTS, MAX_RESULT_MESSAGE_LENGTH } from "./schemas.js";
import {
  withResolvedWorkspaceAttachments,
  type RuntimeSlackAttachment,
} from "./workspace-attachments.js";
import {
  McpServiceError,
  type McpAgentListResult,
  type McpAgentSendResult,
  type McpAgentStatusResult,
  type McpAppOpsPreToolUseInput,
  type McpAppOpsPreToolUseResult,
  type McpCallerContext,
  type McpGatewayRestartResult,
  type McpSlackAttachmentInput,
  type McpSlackWriteResult,
  type SwitchboardMcpService,
} from "./types.js";

export interface RuntimeMcpServiceOptions {
  readonly onProjectionError?: (error: unknown) => void;
  readonly onRestartRequested?: () => void;
  readonly gatewayRestartReplayGuard?: Pick<
    GatewayRestartReplayGuard,
    "record" | "consume"
  >;
  readonly runtimeInstanceId?: string;
  readonly appOpsApprovalProofBroker?: AppOpsApprovalProofBroker;
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
  readonly #gatewayRestartReplayGuard:
    | Pick<GatewayRestartReplayGuard, "record" | "consume">
    | undefined;
  readonly #runtimeInstanceId: string | undefined;
  readonly #appOpsApprovalProofBroker: AppOpsApprovalProofBroker | undefined;
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
    this.#gatewayRestartReplayGuard = options.gatewayRestartReplayGuard;
    this.#runtimeInstanceId = options.runtimeInstanceId;
    this.#appOpsApprovalProofBroker = options.appOpsApprovalProofBroker;
    if (
      this.#gatewayRestartReplayGuard !== undefined &&
      this.#runtimeInstanceId === undefined
    ) {
      throw new TypeError(
        "A runtime instance ID is required for durable Gateway restart receipts",
      );
    }
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

  appOpsPreToolUse(
    context: McpCallerContext,
    input: McpAppOpsPreToolUseInput,
  ): McpAppOpsPreToolUseResult {
    context = this.#liveContext(context);
    const caller = this.#requireCaller(context);
    const decision = this.#appOpsApprovalProofBroker?.consume(caller.id, {
      sessionId: input.session_id,
      turnId: input.turn_id,
      toolName: input.tool_name,
      toolUseId: input.tool_use_id,
      toolInput: input.tool_input,
    });
    if (decision?.kind === "allow") {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: decision.updatedInput,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          decision?.reason ??
          "The AppOps approval proof handoff is unavailable",
      },
    };
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
    const replayKey = restartReplayKey(caller.id, context.requestId);
    if (this.#gatewayRestartReplayGuard !== undefined) {
      let replayed: boolean;
      try {
        replayed = await this.#gatewayRestartReplayGuard.consume(replayKey);
      } catch {
        throw new McpServiceError(
          "SERVICE_UNAVAILABLE",
          "The Gateway restart replay receipt could not be consumed safely",
        );
      }
      if (replayed) return { status: "scheduled" };
    }
    const sourceTurn = this.#captureSourceSlackTurn(caller.id, caller.channelId);
    const result = await this.#approvals.authorize(
      "approval",
      {
        sourceAgentId: caller.id,
        sourceChannelId: caller.channelId,
        operation: "gateway.restart",
        summary: "Gateway Worker restart",
        grantKey: JSON.stringify(["gateway.restart", caller.id]),
        allowSessionGrant: false,
        ...(sourceTurn === undefined
          ? {}
          : {
              slackContext: {
                rootThreadTs: sourceTurn.rootThreadTs,
                ...(sourceTurn.slackUserId === undefined
                  ? {}
                  : { slackUserId: sourceTurn.slackUserId }),
              },
            }),
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

    if (this.#gatewayRestartReplayGuard !== undefined) {
      try {
        await this.#gatewayRestartReplayGuard.record(
          replayKey,
          this.#runtimeInstanceId!,
        );
      } catch (error) {
        throw new McpServiceError(
          "SERVICE_UNAVAILABLE",
          "The Gateway restart receipt could not be recorded safely",
        );
      }
    }
    const requestRestartOnce = () => {
      if (this.#restartRequested) return;
      this.#restartRequested = true;
      try {
        this.#onRestartRequested?.();
      } catch (error) {
        this.#restartRequested = false;
        throw error;
      }
    };
    if (context.deferUntilResponseFinished === undefined) {
      requestRestartOnce();
    } else {
      context.deferUntilResponseFinished(requestRestartOnce);
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
        if (projectionStartFailed) {
          await this.#cancelUnprojectedDelegationInput(activity);
        } else {
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
            await this.#cancelUnprojectedDelegationInput(activity);
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
    if (attachments.length === 0) {
      this.#throwIfCancelled(context);
      const ts = await this.#requireSlack().postMessage(channelId, message);
      return { channel: channelId, ts };
    }
    return withResolvedWorkspaceAttachments(
      requireWorkspacePath(caller),
      attachments,
      async (files) => {
        this.#throwIfCancelled(context);
        const ts = await this.#requireSlack().postMessage(channelId, message, files);
        return { channel: channelId, ts };
      },
      { signal: context.signal },
    );
  }

  async slackReply(
    context: McpCallerContext,
    channel?: string,
    threadTs?: string,
    message?: string,
    attachments: readonly McpSlackAttachmentInput[] = [],
  ): Promise<McpSlackWriteResult> {
    context = this.#liveContext(context);
    const caller = this.#requireCaller(context);
    if ((channel === undefined) !== (threadTs === undefined)) {
      throw new McpServiceError(
        "INVALID_SLACK_TARGET",
        "channel and thread_ts must either both be supplied or both be omitted",
      );
    }
    const sourceTurn = channel === undefined
      ? this.#captureSourceSlackTurn(caller.id, caller.channelId)
      : undefined;
    if (channel === undefined && sourceTurn === undefined) {
      throw new McpServiceError(
        "NO_ACTIVE_SLACK_TURN",
        "The authenticated Koe has no active originating Slack thread",
      );
    }
    const channelId = sourceTurn?.channelId ?? this.#resolveChannel(channel!);
    const rootThreadTs = sourceTurn?.rootThreadTs ?? threadTs!;
    return this.#once(
      context,
      "slack.reply",
      [channelId, rootThreadTs, message ?? null, attachments],
      () => this.#executeSlackReply(
        context,
        channelId,
        rootThreadTs,
        message,
        attachments,
        sourceTurn,
      ),
    );
  }

  async #executeSlackReply(
    context: McpCallerContext,
    channelId: string,
    threadTs: string,
    message: string | undefined,
    attachments: readonly McpSlackAttachmentInput[],
    sourceTurn?: SourceSlackTurn,
  ): Promise<McpSlackWriteResult> {
    const caller = this.#requireCaller(context);
    await this.#authorizeSlackWrite(
      context,
      caller.channelId,
      channelId,
      slackWriteSummary(message, attachments),
      {
        allowBoundSourceAttachmentOnlyWithoutApproval:
          sourceTurn !== undefined &&
          message === undefined &&
          attachments.length > 0,
      },
    );
    const assertSourceTurnStillLive = () => {
      if (
        sourceTurn !== undefined &&
        !this.#isSourceTurnStillLive(caller.id, sourceTurn)
      ) {
        throw new McpServiceError(
          "SOURCE_TURN_ENDED",
          "The originating Slack turn ended before its attachment reply was sent",
        );
      }
    };
    assertSourceTurnStillLive();
    if (attachments.length === 0) {
      this.#throwIfCancelled(context);
      assertSourceTurnStillLive();
      const ts = await this.#requireSlack().reply(channelId, threadTs, message);
      return { channel: channelId, ts, thread_ts: threadTs };
    }
    return withResolvedWorkspaceAttachments(
      requireWorkspacePath(caller),
      attachments,
      async (files) => {
        this.#throwIfCancelled(context);
        assertSourceTurnStillLive();
        const ts = await this.#requireSlack().reply(
          channelId,
          threadTs,
          message,
          files,
        );
        return { channel: channelId, ts, thread_ts: threadTs };
      },
      { signal: context.signal },
    );
  }

  async #authorizeSlackWrite(
    context: McpCallerContext,
    sourceChannelId: string,
    targetChannelId: string,
    message: string,
    options: {
      readonly allowBoundSourceAttachmentOnlyWithoutApproval?: boolean;
    } = {},
  ): Promise<void> {
    const sourceAgentId = context.agentId;
    const sourceAgent = this.#registry.requireAgent(sourceAgentId);
    const sourceTurn = this.#captureSourceSlackTurn(
      sourceAgentId,
      sourceAgent.channelId,
    );
    const configuredPolicy = this.#permissions.slackAccess(
      sourceAgentId,
      "write",
      targetChannelId,
    );
    // A routing-free, attachment-only reply is already constrained to the
    // caller's exact, process-owned active Slack turn. Do not add a second
    // human prompt when the configured policy is `approval`; an explicit
    // `deny` remains fail-closed, as do replies with text and explicit routes.
    const policy =
      options.allowBoundSourceAttachmentOnlyWithoutApproval === true &&
      configuredPolicy === "approval"
        ? "allow"
        : configuredPolicy;
    const result = await this.#approvals.authorize(policy, {
      sourceAgentId,
      sourceChannelId,
      operation: "slack.write",
      summary: `Post to ${targetChannelId}: ${truncateSummary(message)}`,
      grantKey: JSON.stringify(["slack.write", sourceAgentId, targetChannelId]),
      ...(sourceTurn === undefined
        ? {}
        : {
            slackContext: {
              rootThreadTs: sourceTurn.rootThreadTs,
              ...(sourceTurn.slackUserId === undefined
                ? {}
                : { slackUserId: sourceTurn.slackUserId }),
            },
          }),
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
    const fingerprint = digest(fingerprintInput);
    const turnScope = this.#activeTurnIdempotencyScope(context.agentId);
    // JSON-RPC request IDs are scoped to one MCP Client and commonly restart at
    // zero after a reconnect or backend-thread switch. They are therefore not
    // globally unique for a Koe. Canonical arguments prevent unrelated calls
    // from colliding, while the live Gateway turn keeps exact retries bounded
    // to the conversation that issued them.
    const key = digest([
      context.agentId,
      operation,
      turnScope ?? "unscoped",
      context.requestId,
      fingerprint,
    ]);
    const existing = this.#idempotency.get(key);
    if (existing !== undefined) {
      return awaitWithSignal(existing.promise as Promise<T>, context.signal);
    }

    this.#reserveIdempotencyCapacity();
    const promise = this.#trackExecution(execute);
    const entry: IdempotencyEntry = {
      promise,
    };
    this.#idempotency.set(key, entry);
    void promise.then(
      () => {
        this.#settleIdempotencyEntry(key, entry);
      },
      () => {
        this.#settleIdempotencyEntry(key, entry);
      },
    );
    return awaitWithSignal(promise, context.signal);
  }

  #activeTurnIdempotencyScope(agentId: string): string | undefined {
    if (!this.#registry.hasActiveAgentTurn(agentId)) return undefined;
    const session = this.#registry.getActiveSession(agentId);
    const turn = session?.activeTurn;
    if (session === undefined || turn === undefined) return undefined;
    return digest([
      session.id,
      session.adapterSession.id,
      turn.type,
      turn.startedAt,
      turn.type === "slack"
        ? [
            turn.channelId,
            turn.rootThreadTs,
            turn.messageTs,
            turn.continuationDelegationId ?? null,
          ]
        : [turn.sourceAgentId, turn.delegationId],
    ]);
  }

  #settleIdempotencyEntry(key: string, entry: IdempotencyEntry): void {
    if (this.#idempotency.get(key) !== entry) return;
    entry.settledAt = Date.now();
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

  async #cancelUnprojectedDelegationInput(
    activity: DelegationActivity,
  ): Promise<void> {
    if (activity.type !== "delegation.agent_event") return;
    try {
      if (activity.event.type === "approval.requested") {
        await this.#requireGateway().resolveSessionApproval(
          activity.targetSessionId,
          {
            requestId: activity.event.requestId,
            decision: "cancel",
          },
        );
      } else if (activity.event.type === "user_input.requested") {
        await this.#requireGateway().resolveSessionUserInput(
          activity.targetSessionId,
          {
            requestId: activity.event.requestId,
            optionId: "reject",
          },
        );
      } else if (activity.event.type === "choice.requested") {
        await this.#requireGateway().resolveSessionUserInput(
          activity.targetSessionId,
          {
            requestId: activity.event.requestId,
            cancelled: true,
          },
        );
      }
    } catch (resolutionError) {
      this.#onProjectionError(resolutionError);
      // An invisible approval or structured request must never remain live. By
      // failing routing here, adapter cleanup interrupts the target.
      throw resolutionError;
    }
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
      ["starting", "running", "waiting_for_approval", "waiting_for_input"].includes(
        session.status,
      ),
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

function restartReplayKey(agentId: string, requestId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([agentId, requestId]), "utf8")
    .digest("hex");
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
