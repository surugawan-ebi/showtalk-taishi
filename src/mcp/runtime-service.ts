import { createHash, randomUUID } from "node:crypto";

import {
  CoreError,
  type AgentRouter,
  type DelegationActivity,
  type DelegationResultMessage,
  type Gateway,
  type GatewayAgentEvent,
  type InMemoryAgentRegistry,
  type QueuedDelegationJob,
  type QueuedDelegationOutcome,
  type QueuedDelegationSource,
} from "../core/index.js";
import type { PermissionApprovalCoordinator } from "../permissions/approval-coordinator.js";
import type { PermissionEngine } from "../permissions/engine.js";
import type { AppOpsApprovalProofBroker } from "../approvals/appops-approval-proof.js";
import type { GatewayRestartReplayGuard } from "../state/gateway-restart-replay-guard.js";
import { formatAgentTextForSlack } from "../slack/text-format.js";
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
  readonly onStateChanged?: () => Promise<void>;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly delegationQueueTtlMs?: number;
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
  restoreDelegationProjection?(
    activity: Extract<DelegationActivity, { readonly type: "delegation.started" }>,
    rootThreadTs: string,
  ): Promise<{ readonly channelId: string; readonly rootThreadTs: string }> |
    { readonly channelId: string; readonly rootThreadTs: string };
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
const DEFAULT_DELEGATION_QUEUE_TTL_MS = 30 * 60 * 1_000;
const QUEUE_RETRY_DELAY_MS = 100;

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
  readonly #onStateChanged: () => Promise<void>;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #delegationQueueTtlMs: number;
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #queueWorkers = new Map<string, Promise<void>>();
  readonly #queueBlockedTargetIds = new Set<string>();
  readonly #deliveryWorkers = new Map<string, Promise<void>>();
  readonly #deliveryBlockedJobIds = new Set<string>();
  readonly #shutdown = new AbortController();
  readonly #idleWaiters = new Set<() => void>();
  #activeExecutions = 0;
  #queueMutationTail: Promise<void> = Promise.resolve();
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
    this.#onStateChanged = options.onStateChanged ?? (async () => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#delegationQueueTtlMs =
      options.delegationQueueTtlMs ?? DEFAULT_DELEGATION_QUEUE_TTL_MS;
    if (
      !Number.isSafeInteger(this.#delegationQueueTtlMs) ||
      this.#delegationQueueTtlMs < 1_000
    ) {
      throw new TypeError("delegationQueueTtlMs must be at least one second");
    }
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
    void this.#trackExecution(() => this.#recoverDelegationQueue()).catch(
      this.#onProjectionError,
    );
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
    return (
      this.#activeExecutions === 0 &&
      this.#queueWorkers.size === 0 &&
      this.#deliveryWorkers.size === 0
    );
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
    const queuedJobs = this.#registry.listQueuedDelegations(resolvedTarget.id);
    const pendingDeliveries = queuedJobs.filter(
      (job) => job.state === "result_pending" || job.state === "delivering",
    ).length;
    const queueBlocked =
      this.#queueBlockedTargetIds.has(resolvedTarget.id) ||
      queuedJobs.some((job) => this.#deliveryBlockedJobIds.has(job.id));
    return {
      agent_id: resolvedTarget.id,
      status: session?.status ?? "not_started",
      ...(session === undefined ? {} : { session_id: session.id }),
      ...(queuedJobs.length === 0 && !queueBlocked
        ? {}
        : {
            queue_status: queueBlocked ? "blocked" as const : "active" as const,
            queued_delegations: queuedJobs.length,
            pending_deliveries: pendingDeliveries,
          }),
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
    const targetAgent = this.#registry.requireAgent(target);
    if (caller.id === targetAgent.id && caller.allowSelfDelegation !== true) {
      throw new McpServiceError(
        "SELF_DELEGATION_DENIED",
        `Koe ${caller.id} is not allowed to send to itself`,
      );
    }
    const consultationScope = this.#permissions.consultationScope(
      caller.id,
      targetAgent.id,
    );
    if (consultationScope === undefined) {
      throw new McpServiceError(
        "PERMISSION_DENIED",
        `Koe ${targetAgent.id} is not a configured consultation target for ${caller.id}`,
      );
    }
    const source = this.#captureQueuedDelegationSource(caller.id, caller.channelId);
    // Tests and administrative callers without a live Gateway-owned turn keep
    // the legacy synchronous path. A real Koe call always has an exact source.
    if (source === undefined) {
      return this.#executeAgentSendSynchronously(context, target, message);
    }
    const policy = this.#permissions.agentSend(caller.id, targetAgent.id);
    if (policy === "deny") {
      throw new McpServiceError(
        "PERMISSION_DENIED",
        `Koe ${caller.id} may not send to ${targetAgent.id}`,
      );
    }
    if (policy === "approval" && source.type !== "slack") {
      throw new McpServiceError(
        "PERMISSION_APPROVAL_REQUIRED",
        "A nested queued delegation cannot open approval controls outside its exact Slack turn",
      );
    }
    const authorization = await this.#approvals.authorize(
      policy,
      {
        sourceAgentId: caller.id,
        sourceChannelId: caller.channelId,
        operation: "agent.send",
        summary: `Send work from ${caller.id} to ${targetAgent.id}`,
        grantKey: JSON.stringify(["agent.send", caller.id, targetAgent.id]),
        ...(source.type !== "slack"
          ? {}
          : {
              slackContext: {
                rootThreadTs: source.rootThreadTs,
                ...(source.slackUserId === undefined
                  ? {}
                  : { slackUserId: source.slackUserId }),
              },
            }),
      },
      context.signal,
    );
    this.#throwIfCancelled(context);
    if (authorization !== "allow") {
      throw new McpServiceError(
        "PERMISSION_DENIED",
        `Koe ${caller.id} may not send to ${targetAgent.id}`,
      );
    }

    const router = this.#requireRouter();
    const derived = router.deriveDelegationContext(caller.id);
    const requestKey = digest([
      caller.id,
      context.requestId,
      this.#activeTurnIdempotencyScope(caller.id) ?? source.turnStartedAt,
      targetAgent.id,
      message,
    ]);
    const now = this.#now();
    const delegationId = this.#idFactory();
    const workspacePath = targetAgent.metadata?.workspacePath;
    const job: QueuedDelegationJob = {
      version: 1,
      id: delegationId,
      requestKey,
      source,
      targetAgentId: targetAgent.id,
      targetAdapter: targetAgent.adapter,
      targetChannelId: targetAgent.channelId,
      targetConversationScope: targetAgent.conversationScope ?? "channel",
      ...(typeof workspacePath === "string" ? { targetWorkspacePath: workspacePath } : {}),
      consultationScope,
      permissionDecision: policy,
      message,
      metadata: { origin: "mcp.agent.send" },
      depth: derived.context.depth,
      ...(derived.context.parentDelegationId === undefined
        ? {}
        : { causationParentId: derived.context.parentDelegationId }),
      state: "queued",
      pendingChildIds: [],
      childOutcomes: [],
      createdAt: now.toISOString(),
      queueExpiresAt: new Date(
        now.getTime() + this.#delegationQueueTtlMs,
      ).toISOString(),
      updatedAt: now.toISOString(),
    };
    const continuationId = derived.continuationDelegationId;
    let acceptedJob = job;
    let recordedContinuation = false;
    await this.#mutateQueuedDelegations((jobs) => {
      const existing = jobs.find((candidate) => candidate.requestKey === requestKey);
      if (existing !== undefined) {
        acceptedJob = existing;
        return jobs;
      }
      if (continuationId !== undefined) {
        if (this.#registry.hasUsedContinuationDelegation(continuationId)) {
          throw new McpServiceError(
            "DELEGATION_CONTINUATION_ALREADY_USED",
            `Delayed delegation result ${continuationId} already started its next Koe step`,
          );
        }
        this.#registry.recordUsedContinuationDelegation(continuationId);
        recordedContinuation = true;
      }
      const parentUpdated = source.type === "job"
        ? jobs.map((candidate) =>
            candidate.id === source.ownerJobId
              ? {
                  ...candidate,
                  pendingChildIds: [...candidate.pendingChildIds, delegationId],
                  updatedAt: now.toISOString(),
                }
              : candidate,
          )
        : jobs;
      const next = [...parentUpdated, job];
      this.#registry.assertQueuedDelegationAdmission(next);
      return next;
    }, () => {
      if (continuationId !== undefined && recordedContinuation) {
        this.#registry.removeUsedContinuationDelegation(continuationId);
      }
    });
    this.#scheduleTargetQueue(acceptedJob.targetAgentId);
    return {
      target: acceptedJob.targetAgentId,
      status: "queued",
      message: queuedAcknowledgement(acceptedJob),
      delegation_id: acceptedJob.id,
    };
  }

  async #executeAgentSendSynchronously(
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
          : {
              sourceRootThreadTs: sourceTurn.rootThreadTs,
              ...(sourceTurn.slackUserId === undefined
                ? {}
                : { sourceSlackUserId: sourceTurn.slackUserId }),
            }),
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

  #captureQueuedDelegationSource(
    agentId: string,
    channelId: string,
  ): QueuedDelegationSource | undefined {
    if (!this.#registry.hasActiveAgentTurn(agentId)) return undefined;
    const session = this.#registry.getActiveSession(agentId);
    const turn = session?.activeTurn;
    if (session === undefined || turn === undefined) return undefined;
    if (turn.type === "slack") {
      if (turn.channelId !== channelId) return undefined;
      return {
        type: "slack",
        agentId,
        channelId: turn.channelId,
        rootThreadTs: turn.rootThreadTs,
        messageTs: turn.messageTs,
        ...(turn.slackUserId === undefined ? {} : { slackUserId: turn.slackUserId }),
        sessionId: session.id,
        adapterSessionId: session.adapterSession.id,
        turnStartedAt: turn.startedAt,
      };
    }
    const owner = this.#registry.getQueuedDelegation(turn.delegationId);
    if (
      owner === undefined ||
      owner.targetAgentId !== agentId ||
      owner.targetSessionId !== session.id ||
      owner.targetAdapterSessionId !== session.adapterSession.id
    ) {
      return undefined;
    }
    return {
      type: "job",
      agentId,
      ownerJobId: owner.id,
      sessionId: session.id,
      adapterSessionId: session.adapterSession.id,
      turnStartedAt: turn.startedAt,
    };
  }

  /** Resolves the authenticated human origin through a bounded parent-job chain. */
  #originSlackUserId(job: QueuedDelegationJob): string | undefined {
    let source = job.source;
    const visited = new Set<string>();
    while (source.type === "job") {
      if (visited.has(source.ownerJobId)) return undefined;
      visited.add(source.ownerJobId);
      const owner = this.#registry.getQueuedDelegation(source.ownerJobId);
      if (owner === undefined) return undefined;
      source = owner.source;
    }
    return source.slackUserId;
  }

  async #mutateQueuedDelegations(
    transform: (jobs: readonly QueuedDelegationJob[]) => readonly QueuedDelegationJob[],
    rollbackSideEffect?: () => void,
  ): Promise<void> {
    const operation = this.#queueMutationTail.then(async () => {
      const previous = this.#registry.listQueuedDelegations();
      try {
        const next = transform(previous);
        this.#registry.replaceQueuedDelegations(next);
        await this.#onStateChanged();
      } catch (error) {
        this.#registry.replaceQueuedDelegations(previous);
        rollbackSideEffect?.();
        throw error;
      }
    });
    this.#queueMutationTail = operation.catch(() => undefined);
    return operation;
  }

  #scheduleTargetQueue(targetAgentId: string): void {
    if (
      this.#draining ||
      this.#shutdown.signal.aborted ||
      this.#queueWorkers.has(targetAgentId) ||
      this.#queueBlockedTargetIds.has(targetAgentId)
    ) {
      return;
    }
    const worker = this.#trackExecution(() => this.#runTargetQueue(targetAgentId))
      .catch((error: unknown) => {
        this.#queueBlockedTargetIds.add(targetAgentId);
        this.#onProjectionError(error);
      })
      .finally(() => {
        if (this.#queueWorkers.get(targetAgentId) !== worker) return;
        this.#queueWorkers.delete(targetAgentId);
        if (
          !this.#shutdown.signal.aborted &&
          !this.#draining &&
          !this.#queueBlockedTargetIds.has(targetAgentId) &&
          this.#registry.listQueuedDelegations(targetAgentId).some(
            (job) => job.state === "queued",
          )
        ) {
          this.#scheduleTargetQueue(targetAgentId);
        } else {
          this.#resolveIdleWaitersIfIdle();
        }
      });
    this.#queueWorkers.set(targetAgentId, worker);
  }

  #scheduleQueuedDelivery(jobId: string): void {
    if (
      this.#shutdown.signal.aborted ||
      this.#draining ||
      this.#deliveryWorkers.has(jobId) ||
      this.#deliveryBlockedJobIds.has(jobId)
    ) {
      return;
    }
    const worker = this.#trackExecution(() => this.#deliverQueuedDelegation(jobId))
      .then((delivered) => {
        if (!delivered) this.#deliveryBlockedJobIds.add(jobId);
      })
      .catch((error: unknown) => {
        this.#deliveryBlockedJobIds.add(jobId);
        this.#onProjectionError(error);
      })
      .finally(() => {
        if (this.#deliveryWorkers.get(jobId) !== worker) return;
        this.#deliveryWorkers.delete(jobId);
        this.#resolveIdleWaitersIfIdle();
      });
    this.#deliveryWorkers.set(jobId, worker);
  }

  #scheduleTerminalProjection(activity: DelegationActivity): void {
    void this.#trackExecution(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.#requireSlack().projectDelegation(activity);
          return;
        } catch (error) {
          this.#onProjectionError(error);
          if (attempt === 0) await delay(QUEUE_RETRY_DELAY_MS);
        }
      }
    }).catch(this.#onProjectionError);
  }

  async #recoverDelegationQueue(): Promise<void> {
    const jobs = this.#registry.listQueuedDelegations();
    if (jobs.length === 0) return;
    const now = this.#now().toISOString();
    await this.#mutateQueuedDelegations((current) =>
      current.map((job) => {
        if (job.state === "running" && job.pendingChildIds.length > 0) {
          return withoutQueuedResumeMessage(
            { ...job, turnFailure: gatewayReplacementOutcome(job.id) },
            now,
          );
        }
        if (job.state === "running") {
          return resultPendingQueuedJob(job, gatewayReplacementOutcome(job.id), now);
        }
        return job.state === "delivering"
          ? {
              ...job,
              state: "result_pending" as const,
              sourceContinuationStarted: true,
              updatedAt: now,
            }
          : job;
      }),
    );
    const recovered = this.#registry.listQueuedDelegations();
    for (const targetAgentId of new Set(recovered.map((job) => job.targetAgentId))) {
      this.#scheduleTargetQueue(targetAgentId);
    }
    for (const job of recovered) {
      if (job.state === "result_pending") this.#scheduleQueuedDelivery(job.id);
    }
  }

  async #runTargetQueue(targetAgentId: string): Promise<void> {
    while (!this.#shutdown.signal.aborted && !this.#draining) {
      const job = this.#registry
        .listQueuedDelegations(targetAgentId)
        .filter((candidate) => candidate.state === "queued")
        .sort(compareQueuedJobs)[0];
      if (job === undefined) return;
      const bindingError = this.#queuedDelegationBindingError(job);
      if (bindingError !== undefined) {
        await this.#recordQueuedOutcome(job.id, {
          status: "failed",
          text: bindingError,
        });
        continue;
      }
      if (
        job.targetSessionId === undefined &&
        this.#now().getTime() >= Date.parse(job.queueExpiresAt)
      ) {
        await this.#recordQueuedOutcome(job.id, {
          status: "expired",
          text: `Delegation ${job.id} expired before Koe ${job.targetAgentId} became available.`,
        });
        continue;
      }
      const outcome = await this.#runQueuedDelegationTurn(job.id);
      if (outcome === "busy") {
        await delay(QUEUE_RETRY_DELAY_MS);
      }
    }
  }

  #queuedDelegationBindingError(job: QueuedDelegationJob): string | undefined {
    const sourceAgent = this.#registry.getAgent(job.source.agentId);
    const targetAgent = this.#registry.getAgent(job.targetAgentId);
    const sourceSession = this.#registry.getSession(job.source.sessionId);
    const targetSession = job.targetSessionId === undefined
      ? undefined
      : this.#registry.getSession(job.targetSessionId);
    if (
      sourceAgent === undefined ||
      sourceSession === undefined ||
      sourceSession.agentId !== job.source.agentId ||
      sourceSession.adapterSession.id !== job.source.adapterSessionId
    ) {
      return `Delegation ${job.id} source binding changed before execution.`;
    }
    if (
      job.source.type === "slack" &&
      (sourceAgent.channelId !== job.source.channelId ||
        this.#registry.getConversation(
          job.source.channelId,
          job.source.rootThreadTs,
        )?.sessionId !== job.source.sessionId)
    ) {
      return `Delegation ${job.id} source Slack conversation changed before execution.`;
    }
    const workspacePath = targetAgent?.metadata?.workspacePath;
    if (
      targetAgent === undefined ||
      targetAgent.adapter !== job.targetAdapter ||
      targetAgent.channelId !== job.targetChannelId ||
      (targetAgent.conversationScope ?? "channel") !== job.targetConversationScope ||
      (typeof workspacePath === "string" ? workspacePath : undefined) !==
        job.targetWorkspacePath
    ) {
      return `Delegation ${job.id} target binding changed before execution.`;
    }
    if (
      job.targetSessionId !== undefined &&
      (targetSession === undefined ||
        targetSession.agentId !== job.targetAgentId ||
        targetSession.adapter !== job.targetAdapter ||
        targetSession.adapterSession.id !== job.targetAdapterSessionId)
    ) {
      return `Delegation ${job.id} target session binding changed before execution.`;
    }
    if (
      this.#permissions.consultationScope(job.source.agentId, job.targetAgentId) !==
        job.consultationScope ||
      this.#permissions.agentSend(job.source.agentId, job.targetAgentId) !==
        job.permissionDecision
    ) {
      return `Delegation ${job.id} permission changed before execution.`;
    }
    if (job.source.type === "job") {
      const parent = this.#registry.getQueuedDelegation(job.source.ownerJobId);
      if (
        parent === undefined ||
        parent.targetAgentId !== job.source.agentId ||
        !parent.pendingChildIds.includes(job.id)
      ) {
        return `Delegation ${job.id} parent binding changed before execution.`;
      }
    }
    return undefined;
  }

  async #runQueuedDelegationTurn(
    jobId: string,
  ): Promise<"completed" | "busy"> {
    const initial = this.#registry.getQueuedDelegation(jobId);
    if (initial === undefined || initial.state !== "queued") return "completed";
    const router = this.#requireRouter();
    const slack = this.#requireSlack();
    const remaining = Date.parse(initial.queueExpiresAt) - this.#now().getTime();
    if (remaining <= 0) {
      await this.#recordQueuedOutcome(jobId, {
        status: "expired",
        text: `Delegation ${jobId} expired before Koe ${initial.targetAgentId} became available.`,
      });
      return "completed";
    }
    let releaseTurn: (() => void) | undefined;
    try {
      releaseTurn = await this.#registry.waitForAgentTurn(
        initial.targetAgentId,
        AbortSignal.any([
          this.#shutdown.signal,
          AbortSignal.timeout(Math.min(remaining, 2_147_483_647)),
        ]),
      );
    } catch (error) {
      await this.#recordQueuedOutcome(jobId, {
        status: this.#shutdown.signal.aborted ? "unknown" : "expired",
        text: this.#shutdown.signal.aborted
          ? `Delegation ${jobId} stopped before execution during shutdown.`
          : `Delegation ${jobId} expired before Koe ${initial.targetAgentId} became available.`,
      });
      return "completed";
    }
    const currentAfterLease = this.#registry.getQueuedDelegation(jobId);
    if (currentAfterLease === undefined || currentAfterLease.state !== "queued") {
      releaseTurn();
      return "completed";
    }
    if (this.#now().getTime() >= Date.parse(currentAfterLease.queueExpiresAt)) {
      releaseTurn();
      await this.#recordQueuedOutcome(jobId, {
        status: "expired",
        text: `Delegation ${jobId} expired while waiting for Koe ${initial.targetAgentId}.`,
      });
      return "completed";
    }
    const bindingErrorAfterLease = this.#queuedDelegationBindingError(currentAfterLease);
    if (bindingErrorAfterLease !== undefined) {
      releaseTurn();
      await this.#recordQueuedOutcome(jobId, {
        status: "failed",
        text: bindingErrorAfterLease,
      });
      return "completed";
    }
    let started:
      | Extract<DelegationActivity, { readonly type: "delegation.started" }>
      | undefined;
    let completed:
      | Extract<DelegationActivity, { readonly type: "delegation.completed" }>
      | undefined;
    let routedFailure:
      | Extract<DelegationActivity, { readonly type: "delegation.failed" }>
      | undefined;
    let terminalOutcome: QueuedDelegationOutcome | undefined;
    let response = "";
    const originSlackUserId = this.#originSlackUserId(initial);
    try {
      for await (const activity of router.send(
        {
          sourceAgentId: initial.source.agentId,
          targetAgentId: initial.targetAgentId,
          message: initial.resumeMessage ?? initial.message,
          ...(initial.source.type === "slack"
            ? { sourceRootThreadTs: initial.source.rootThreadTs }
            : {}),
          ...(originSlackUserId === undefined
            ? {}
            : { sourceSlackUserId: originSlackUserId }),
          ...(initial.metadata === undefined ? {} : { metadata: initial.metadata }),
          ...(initial.targetSessionId === undefined
            ? {}
            : {
                targetSessionId: initial.targetSessionId,
                targetAdapterSessionId: initial.targetAdapterSessionId!,
              }),
          signal: this.#shutdown.signal,
        },
        {
          depth: initial.depth,
          ...(initial.causationParentId === undefined
            ? {}
            : { parentDelegationId: initial.causationParentId }),
          delegationId: initial.id,
          preauthorized: true,
          reservedTurnRelease: releaseTurn,
        },
      )) {
        if (activity.type === "delegation.started") {
          const startedSession = this.#registry.requireSession(
            activity.targetSessionId,
          );
          if (
            initial.targetSessionId !== undefined &&
            (activity.targetSessionId !== initial.targetSessionId ||
              startedSession.adapterSession.id !==
                initial.targetAdapterSessionId)
          ) {
            throw new Error(
              `Delegation ${jobId} target session binding changed during resume.`,
            );
          }
          started = activity;
          await this.#mutateQueuedDelegations((jobs) =>
            jobs.map((job) =>
              job.id === jobId
                ? runningQueuedJob(
                    job,
                    activity.targetSessionId,
                    startedSession.adapterSession.id,
                    this.#now().toISOString(),
                  )
                : job,
            ),
          );
          const current = this.#registry.getQueuedDelegation(jobId)!;
          const destination = current.targetRootThreadTs === undefined
            ? await slack.projectDelegation(activity)
            : slack.restoreDelegationProjection === undefined
              ? (() => {
                  throw new Error("Slack cannot restore a queued delegation projection");
                })()
              : await slack.restoreDelegationProjection(
                  activity,
                  current.targetRootThreadTs,
                );
          if (
            destination === undefined ||
            destination.channelId !== activity.targetChannelId
          ) {
            throw new Error("Slack did not return the exact queued delegation destination");
          }
          if (current.targetRootThreadTs === undefined) {
            await this.#mutateQueuedDelegations((jobs) =>
              jobs.map((job) =>
                job.id === jobId
                  ? {
                      ...job,
                      targetRootThreadTs: destination.rootThreadTs,
                      updatedAt: this.#now().toISOString(),
                    }
                  : job,
              ),
            );
            if (current.targetConversationScope === "slack_thread") {
              await this.#requireGateway().bindDelegationConversation(
                destination.channelId,
                destination.rootThreadTs,
                activity.targetAgentId,
                activity.targetSessionId,
              );
            }
          }
          continue;
        }
        if (activity.type === "delegation.agent_event") {
          if (activity.event.type === "message.delta") {
            response = appendBounded(
              response,
              activity.event.text,
              MAX_RESULT_MESSAGE_LENGTH,
            );
          }
          if (
            activity.event.type === "message.completed" &&
            activity.event.text !== undefined
          ) {
            response = truncateResult(activity.event.text);
          }
          if (activity.event.type === "error") {
            terminalOutcome = {
              status: "failed",
              text: `Delegation ${jobId} failed: ${activity.event.message}`,
            };
          }
          if (activity.event.type === "status.changed") {
            if (activity.event.status === "interrupted") {
              terminalOutcome = {
                status: "cancelled",
                text: `Delegation ${jobId} was interrupted before completion.`,
              };
            } else if (activity.event.status === "failed") {
              terminalOutcome ??= {
                status: "failed",
                text: `Delegation ${jobId} ended with a failed target turn.`,
              };
            }
          }
          try {
            await slack.projectDelegation(activity);
          } catch (error) {
            if (isBlockingDelegationProjectionEvent(activity.event.type)) {
              this.#onProjectionError(error);
              await this.#cancelUnprojectedDelegationInput(activity);
              throw error;
            }
            this.#onProjectionError(error);
          }
          continue;
        }
        if (activity.type === "delegation.failed") {
          routedFailure = activity;
          continue;
        }
        completed = activity;
      }
    } catch (error) {
      releaseTurn?.();
      if (
        started === undefined &&
        error instanceof CoreError &&
        error.code === "AGENT_BUSY"
      ) {
        return "busy";
      }
      const outcome: QueuedDelegationOutcome = {
        status: this.#shutdown.signal.aborted ? "unknown" : "failed",
        text: this.#shutdown.signal.aborted
          ? `Delegation ${jobId} was interrupted during shutdown; its outcome is unknown.`
          : `Delegation ${jobId} failed: ${normalizeQueuedError(error).message}`,
      };
      await this.#settleQueuedTurnFailure(jobId, outcome);
      const settled = this.#registry.getQueuedDelegation(jobId);
      if (started !== undefined && settled?.state === "result_pending") {
        this.#scheduleTerminalProjection(
          routedFailure ?? {
            ...started,
            type: "delegation.failed",
            error: normalizeQueuedError(error),
            timestamp: this.#now().toISOString(),
          },
        );
      }
      return "completed";
    }

    if (terminalOutcome !== undefined) {
      await this.#settleQueuedTurnFailure(jobId, terminalOutcome);
      const settled = this.#registry.getQueuedDelegation(jobId);
      if (started !== undefined && settled?.state === "result_pending") {
        this.#scheduleTerminalProjection({
          ...started,
          type: "delegation.failed",
          error: {
            name: terminalOutcome.status === "cancelled" ? "Interrupted" : "Error",
            message: terminalOutcome.text,
          },
          timestamp: this.#now().toISOString(),
        });
      }
      return "completed";
    }

    const now = this.#now();
    await this.#mutateQueuedDelegations((jobs) =>
      jobs.map((job) => {
        if (job.id !== jobId) return job;
        if (job.pendingChildIds.length > 0) {
          return withoutQueuedResumeMessage(job, now.toISOString());
        }
        if (job.childOutcomes.length > 0) {
          return settleParentAfterChildren(job, now, this.#delegationQueueTtlMs);
        }
        return resultPendingQueuedJob(job, {
          status: "completed",
          text:
            response.length === 0
              ? `${job.targetAgentId}のKoeはテキストの返答なしで作業を完了しました。`
              : response,
        }, now.toISOString());
      }),
    );
    const settled = this.#registry.getQueuedDelegation(jobId);
    if (settled?.state === "queued") {
      this.#scheduleTargetQueue(settled.targetAgentId);
    } else if (settled?.state === "result_pending") {
      this.#scheduleQueuedDelivery(jobId);
      if (completed !== undefined) this.#scheduleTerminalProjection(completed);
    }
    return "completed";
  }

  async #settleQueuedTurnFailure(
    jobId: string,
    outcome: QueuedDelegationOutcome,
  ): Promise<void> {
    const now = this.#now();
    await this.#mutateQueuedDelegations((jobs) =>
      jobs.map((job) => {
        if (job.id !== jobId) return job;
        if (job.pendingChildIds.length === 0 && job.childOutcomes.length === 0) {
          return resultPendingQueuedJob(job, outcome, now.toISOString());
        }
        const failedParent = { ...job, turnFailure: outcome };
        return failedParent.pendingChildIds.length > 0
          ? withoutQueuedResumeMessage(failedParent, now.toISOString())
          : settleParentAfterChildren(
              failedParent,
              now,
              this.#delegationQueueTtlMs,
            );
      }),
    );
    const settled = this.#registry.getQueuedDelegation(jobId);
    if (settled?.state === "queued") {
      this.#scheduleTargetQueue(settled.targetAgentId);
    } else if (settled?.state === "result_pending") {
      this.#scheduleQueuedDelivery(jobId);
    }
  }

  async #recordQueuedOutcome(
    jobId: string,
    outcome: QueuedDelegationOutcome,
  ): Promise<void> {
    await this.#mutateQueuedDelegations((jobs) =>
      jobs.map((job) =>
        job.id === jobId
          ? resultPendingQueuedJob(job, outcome, this.#now().toISOString())
          : job,
      ),
    );
    this.#scheduleQueuedDelivery(jobId);
  }

  async #deliverQueuedDelegation(jobId: string): Promise<boolean> {
    const pending = this.#registry.getQueuedDelegation(jobId);
    if (
      pending === undefined ||
      pending.state !== "result_pending" ||
      pending.outcome === undefined
    ) {
      return true;
    }
    if (pending.source.type === "job") {
      const ownerJobId = pending.source.ownerJobId;
      let settledParentId: string | undefined;
      await this.#mutateQueuedDelegations((jobs) => {
        const child = jobs.find((job) => job.id === jobId);
        const parent = jobs.find((job) => job.id === ownerJobId);
        if (child === undefined || parent === undefined || child.outcome === undefined) {
          return jobs;
        }
        const pendingChildIds = parent.pendingChildIds.filter((id) => id !== child.id);
        const updatedParent: QueuedDelegationJob = {
          ...parent,
          pendingChildIds,
          childOutcomes: [
            ...parent.childOutcomes,
            {
              childJobId: child.id,
              targetAgentId: child.targetAgentId,
              depth: child.depth,
              outcome: child.outcome,
            },
          ],
          updatedAt: this.#now().toISOString(),
        };
        const finalParent =
          pendingChildIds.length === 0 && parent.state === "waiting_for_children"
            ? settleParentAfterChildren(
                updatedParent,
                this.#now(),
                this.#delegationQueueTtlMs,
              )
            : updatedParent;
        settledParentId = finalParent.id;
        return jobs
          .filter((job) => job.id !== child.id)
          .map((job) => (job.id === finalParent.id ? finalParent : job));
      });
      const settledParent = settledParentId === undefined
        ? undefined
        : this.#registry.getQueuedDelegation(settledParentId);
      if (settledParent?.state === "queued") {
        this.#scheduleTargetQueue(settledParent.targetAgentId);
      } else if (settledParent?.state === "result_pending") {
        this.#scheduleQueuedDelivery(settledParent.id);
      }
      return true;
    }

    const sourceContinuationAlreadyStarted =
      pending.sourceContinuationStarted === true;
    await this.#mutateQueuedDelegations((jobs) =>
      jobs.map((job) =>
        job.id === jobId
          ? {
              ...job,
              state: "delivering" as const,
              sourceContinuationStarted: true,
              updatedAt: this.#now().toISOString(),
            }
          : job,
      ),
    );
    const delivering = this.#registry.getQueuedDelegation(jobId);
    if (delivering?.source.type !== "slack" || delivering.outcome === undefined) {
      return false;
    }
    const request: DelegationResultMessage = {
      delegationId: delivering.id,
      sourceAgentId: delivering.source.agentId,
      sourceChannelId: delivering.source.channelId,
      sourceRootThreadTs: delivering.source.rootThreadTs,
      sourceMessageTs: delivering.source.messageTs,
      ...(delivering.source.slackUserId === undefined
        ? {}
        : { sourceSlackUserId: delivering.source.slackUserId }),
      sourceSessionId: delivering.source.sessionId,
      sourceAdapterSessionId: delivering.source.adapterSessionId,
      targetAgentId: delivering.targetAgentId,
      depth: delivering.depth,
      result: queuedOutcomePrompt(delivering),
    };
    if (!sourceContinuationAlreadyStarted) {
      try {
        await this.#requireSlack().projectDelegationContinuation(
          request,
          this.#requireGateway().handleDelegationResult(request),
        );
        await this.#removeDeliveredQueuedDelegation(jobId);
        return true;
      } catch (error) {
        this.#onProjectionError(error);
        if (delegationResultWasPublished(error)) {
          await this.#removeDeliveredQueuedDelegation(jobId);
          return true;
        }
      }
    }

    try {
      await this.#requireSlack().reply(
        delivering.source.channelId,
        delivering.source.rootThreadTs,
        queuedRawResultFallback(delivering),
      );
      await this.#removeDeliveredQueuedDelegation(jobId);
      return true;
    } catch (error) {
      this.#onProjectionError(error);
      await this.#mutateQueuedDelegations((jobs) =>
        jobs.map((job) =>
          job.id === jobId
            ? {
                ...job,
                state: "result_pending" as const,
                sourceContinuationStarted: true,
                updatedAt: this.#now().toISOString(),
              }
            : job,
        ),
      );
      return false;
    }
  }

  async #removeDeliveredQueuedDelegation(jobId: string): Promise<void> {
    await this.#mutateQueuedDelegations((jobs) =>
      jobs.filter((job) => job.id !== jobId),
    );
    this.#deliveryBlockedJobIds.delete(jobId);
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
      this.#resolveIdleWaitersIfIdle();
    }
  }

  #resolveIdleWaitersIfIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
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

function compareQueuedJobs(
  left: QueuedDelegationJob,
  right: QueuedDelegationJob,
): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function queuedAcknowledgement(job: QueuedDelegationJob): string {
  return (
    `Koe ${job.targetAgentId}への依頼を受け付けました ` +
    `(delegation_id: ${job.id})。再送は不要です。` +
    "順番に実行し、成功または失敗の結果を元の会話へ後続turnとして返します。"
  );
}

function normalizeQueuedError(error: unknown): {
  readonly name: string;
  readonly message: string;
} {
  const normalized = normalizeProjectionError(error);
  return {
    name: truncatePublicError(normalized.name),
    message: truncatePublicError(normalized.message),
  };
}

function queuedParentContinuation(
  job: QueuedDelegationJob,
  now: Date,
  queueTtlMs: number,
): QueuedDelegationJob {
  if (job.pendingChildIds.length > 0 || job.childOutcomes.length === 0) return job;
  const latest = job.childOutcomes.at(-1)!;
  const turnFailure = job.turnFailure;
  const payload = JSON.stringify(
    job.childOutcomes.map((child) => ({
      delegation_id: child.childJobId,
      from_koe: child.targetAgentId,
      status: child.outcome.status,
      result: child.outcome.text,
    })),
    null,
    2,
  );
  const { turnFailure: _turnFailure, ...rest } = job;
  return {
    ...rest,
    state: "queued",
    depth: Math.max(...job.childOutcomes.map((child) => child.depth)),
    causationParentId: latest.childJobId,
    childOutcomes: [],
    resumeMessage:
      "ShowTalk Taishiから、あなたがこのdelegation job内で依頼した子Koeの遅延結果です。\n" +
      (turnFailure === undefined
        ? ""
        : `直前のあなたのturnは ${turnFailure.status} で終了しました: ${turnFailure.text}\n`) +
      "元の依頼を続け、必要なら許可済みの次工程を一工程だけ進め、完了時は最終結論を返してください。\n" +
      "同じdelegation_idを再送しないでください。\n\n" +
      payload,
    queueExpiresAt: new Date(now.getTime() + queueTtlMs).toISOString(),
    updatedAt: now.toISOString(),
  };
}

function settleParentAfterChildren(
  job: QueuedDelegationJob,
  now: Date,
  queueTtlMs: number,
): QueuedDelegationJob {
  if (job.pendingChildIds.length > 0 || job.childOutcomes.length === 0) return job;
  if (
    job.turnFailure?.status === "unknown" ||
    job.turnFailure?.status === "cancelled" ||
    job.turnFailure?.status === "expired"
  ) {
    const childSummary = JSON.stringify(
      job.childOutcomes.map((child) => ({
        delegation_id: child.childJobId,
        from_koe: child.targetAgentId,
        status: child.outcome.status,
        result: child.outcome.text,
      })),
    );
    const { turnFailure: _turnFailure, childOutcomes: _childOutcomes, ...rest } = job;
    return resultPendingQueuedJob(
      { ...rest, childOutcomes: [] },
      {
        status: job.turnFailure.status,
        text: `${job.turnFailure.text} Child Koe results were preserved: ${childSummary}`,
      },
      now.toISOString(),
    );
  }
  return queuedParentContinuation(job, now, queueTtlMs);
}

function withoutQueuedResumeMessage(
  job: QueuedDelegationJob,
  updatedAt: string,
): QueuedDelegationJob {
  const { resumeMessage: _resumeMessage, ...rest } = job;
  return {
    ...rest,
    state: "waiting_for_children",
    updatedAt,
  };
}

function runningQueuedJob(
  job: QueuedDelegationJob,
  targetSessionId: string,
  targetAdapterSessionId: string,
  updatedAt: string,
): QueuedDelegationJob {
  const { resumeMessage: _resumeMessage, ...rest } = job;
  return {
    ...rest,
    state: "running",
    targetSessionId,
    targetAdapterSessionId,
    updatedAt,
  };
}

function resultPendingQueuedJob(
  job: QueuedDelegationJob,
  outcome: QueuedDelegationOutcome,
  updatedAt: string,
): QueuedDelegationJob {
  const { resumeMessage: _resumeMessage, ...rest } = job;
  return {
    ...rest,
    state: "result_pending",
    outcome,
    updatedAt,
  };
}

function gatewayReplacementOutcome(jobId: string): QueuedDelegationOutcome {
  return {
    status: "unknown",
    text:
      `Delegation ${jobId} was active during Gateway replacement; ` +
      "it was not re-executed because its external outcome is unknown.",
  };
}

function isBlockingDelegationProjectionEvent(type: string): boolean {
  return (
    type === "approval.requested" ||
    type === "user_input.requested" ||
    type === "choice.requested"
  );
}

function delegationResultWasPublished(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "delegationResultPublished" in error &&
    error.delegationResultPublished === true
  );
}

function queuedRawResultFallback(job: QueuedDelegationJob): string {
  const result = formatAgentTextForSlack(queuedOutcomePrompt(job), 3_000);
  return (
    `:warning: *${job.source.agentId}のKoeで返答を整理できなかったため、` +
    `${job.targetAgentId}のKoeの保存済み返答をそのまま表示します*\n\n${result}`
  );
}

function queuedOutcomePrompt(job: QueuedDelegationJob): string {
  const outcome = job.outcome!;
  return outcome.status === "completed"
    ? outcome.text
    : `[${outcome.status}] ${outcome.text}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
