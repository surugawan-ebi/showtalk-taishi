import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentRouter,
  Gateway,
  InMemoryAgentRegistry,
  type AdapterSession,
  type AgentAdapter,
  type AgentApproval,
  type AgentCapabilities,
  type AgentEvent,
  type AgentUserInputResponse,
  type QueuedDelegationJob,
  type SendMessageRequest,
} from "../../src/core/index.js";
import { RuntimeMcpService, McpServiceError } from "../../src/mcp/index.js";
import { PermissionApprovalCoordinator } from "../../src/permissions/approval-coordinator.js";
import { PermissionEngine } from "../../src/permissions/engine.js";
import {
  GatewayRestartReplayGuard,
  type RecentGatewayRestartReceipt,
} from "../../src/state/gateway-restart-replay-guard.js";
import { AppOpsApprovalProofBroker } from
  "../../src/approvals/appops-approval-proof.js";

class FakeAdapter implements AgentAdapter {
  readonly kind = "fake";
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    approval: false,
    interrupt: true,
    resume: true,
    toolEvents: false,
  };
  sendCalls = 0;
  readonly sentTexts: string[] = [];
  interruptCalls = 0;

  async createSession(): Promise<AdapterSession> {
    return { id: `backend-${Math.random()}` };
  }

  async resumeSession(request: { adapterSessionId: string }): Promise<AdapterSession> {
    return { id: request.adapterSessionId };
  }

  async *sendMessage(
    _session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sendCalls += 1;
    this.sentTexts.push(request.text);
    yield { type: "message.delta", text: "Looks " };
    yield { type: "message.completed", text: "Looks good" };
    yield { type: "status.changed", status: "idle" };
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
}

class SlowFakeAdapter extends FakeAdapter {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #finish!: () => void;
  readonly #finished: Promise<void>;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#finished = new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (request.text !== "Slow review") {
      yield* super.sendMessage(session, request);
      return;
    }
    this.sendCalls += 1;
    this.sentTexts.push(request.text);
    this.#markEntered();
    await this.#finished;
    yield { type: "message.completed", text: "Slow review completed" };
    yield { type: "status.changed", status: "idle" };
  }

  finish(): void {
    this.#finish();
  }
}

class MentionResultFakeAdapter extends FakeAdapter {
  override async *sendMessage(
    _session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sendCalls += 1;
    this.sentTexts.push(request.text);
    yield {
      type: "message.completed",
      text: "Unsafe <!channel> and <@U123> must stay inert",
    };
    yield { type: "status.changed", status: "idle" };
  }
}

class NestedQueueFakeAdapter extends FakeAdapter {
  requestChild: (() => Promise<void>) | undefined;

  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (request.text === "Parent review") {
      this.sendCalls += 1;
      this.sentTexts.push(request.text);
      await this.requestChild?.();
      yield { type: "message.completed", text: "Child consultation accepted" };
      yield { type: "status.changed", status: "idle" };
      return;
    }
    if (request.text.includes("子Koeの遅延結果")) {
      this.sendCalls += 1;
      this.sentTexts.push(request.text);
      yield { type: "message.completed", text: "Integrated child result" };
      yield { type: "status.changed", status: "idle" };
      return;
    }
    yield* super.sendMessage(session, request);
  }
}

class FailingParentQueueFakeAdapter extends NestedQueueFakeAdapter {
  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (request.text === "Failing parent review") {
      this.sendCalls += 1;
      this.sentTexts.push(request.text);
      await this.requestChild?.();
      throw new Error("parent turn failed after accepting child");
    }
    yield* super.sendMessage(session, request);
  }
}

class InterruptedParentQueueFakeAdapter extends NestedQueueFakeAdapter {
  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (request.text === "Interrupted parent review") {
      this.sendCalls += 1;
      this.sentTexts.push(request.text);
      await this.requestChild?.();
      yield { type: "status.changed", status: "interrupted" };
      return;
    }
    yield* super.sendMessage(session, request);
  }
}

class ChildCompletionRaceFakeAdapter extends NestedQueueFakeAdapter {
  waitForChildDelivery: (() => Promise<void>) | undefined;

  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (request.text === "Race parent review") {
      this.sendCalls += 1;
      this.sentTexts.push(request.text);
      await this.requestChild?.();
      await this.waitForChildDelivery?.();
      yield { type: "message.completed", text: "Parent observed delivered child" };
      yield { type: "status.changed", status: "idle" };
      return;
    }
    yield* super.sendMessage(session, request);
  }
}

class StructuredInputFakeAdapter extends FakeAdapter {
  override readonly capabilities: AgentCapabilities = {
    streaming: true,
    approval: false,
    interrupt: true,
    resume: true,
    toolEvents: false,
    structuredInput: true,
  };
  readonly responses: AgentUserInputResponse[] = [];
  #resolveInput!: () => void;
  readonly #inputResolved = new Promise<void>((resolve) => {
    this.#resolveInput = resolve;
  });

  override async *sendMessage(): AsyncIterable<AgentEvent> {
    this.sendCalls += 1;
    yield {
      type: "user_input.requested",
      requestId: "codex-input:11111111-1111-4111-8111-111111111111",
      expiresAt: "2099-08-14T11:00:00.000Z",
      prompt: "Approve?",
      options: [
        { id: "approve", label: "承認して実行" },
        { id: "reject", label: "拒否・保留" },
      ],
      plan: {
        operationId: "22222222-2222-4222-8222-222222222222",
        planHash: "a".repeat(64),
        approvalTarget: "primary",
        operation: "git_publication",
        repoId: "reviewer",
        mode: "commit_only",
        branch: "codex/review",
        paths: ["review.md"],
        expectedHead: "b".repeat(40),
        expectedSnapshotId: "c".repeat(64),
        worktreeId: "primary",
        expiresAt: "2026-08-14T20:00:00+09:00",
      },
    };
    await this.#inputResolved;
    yield { type: "message.completed", text: "Rejected safely" };
  }

  async respondToUserInput(
    _session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void> {
    this.responses.push(response);
    this.#resolveInput();
  }
}

class NativeApprovalFakeAdapter extends FakeAdapter {
  override readonly capabilities: AgentCapabilities = {
    streaming: true,
    approval: true,
    interrupt: true,
    resume: true,
    toolEvents: false,
  };
  readonly approvals: AgentApproval[] = [];
  #resolveApproval!: () => void;
  readonly #approvalResolved = new Promise<void>((resolve) => {
    this.#resolveApproval = resolve;
  });

  override async *sendMessage(): AsyncIterable<AgentEvent> {
    this.sendCalls += 1;
    yield {
      type: "approval.requested",
      requestId: "codex:11111111-1111-4111-8111-111111111111",
      summary: "Run a command",
    };
    await this.#approvalResolved;
    yield { type: "message.completed", text: "Cancelled safely" };
  }

  async approve(_session: AdapterSession, approval: AgentApproval): Promise<void> {
    this.approvals.push(approval);
    this.#resolveApproval();
  }
}

function setup(
  options: {
    projectionFails?: boolean;
    projectionFailsOnceOn?: string;
    ownChannelWrite?: "allow" | "deny" | "approval";
    agentChannelWrite?: "allow" | "deny" | "approval";
    workspacePath?: string;
    onRestartRequested?: () => void;
    adapter?: FakeAdapter;
    allowReviewerConsultation?: boolean;
    allowSecurityConsultationFromReviewer?: boolean;
    implementerConversationScope?: "channel" | "slack_thread";
    reviewerConversationScope?: "channel" | "slack_thread";
    abortOnStartedProjection?: AbortController;
    gatewayRestartReplayGuard?: {
      has(keyHash: string): boolean;
      record(keyHash: string, originInstanceId: string): Promise<void>;
      consume(keyHash: string): Promise<boolean>;
    };
    runtimeInstanceId?: string;
    appOpsApprovalProofBroker?: AppOpsApprovalProofBroker;
    prepareRegistry?: (registry: InMemoryAgentRegistry) => void;
    onStateChanged?: () => Promise<void>;
    continuationFails?: boolean;
    replyFails?: boolean;
  } = {},
) {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "implementer",
    adapter: "fake",
    channelId: "C1",
    ...(options.implementerConversationScope === undefined
      ? {}
      : { conversationScope: options.implementerConversationScope }),
    ...(options.workspacePath === undefined
      ? {}
      : { metadata: { workspacePath: options.workspacePath } }),
  });
  registry.registerAgent({
    id: "reviewer",
    callName: "レビュー係",
    adapter: "fake",
    channelId: "C2",
    ...(options.reviewerConversationScope === undefined
      ? {}
      : { conversationScope: options.reviewerConversationScope }),
  });
  registry.registerAgent({
    id: "security",
    callName: "監査役",
    adapter: "fake",
    channelId: "C3",
  });
  options.prepareRegistry?.(registry);
  const adapter = options.adapter ?? new FakeAdapter();
  const router = new AgentRouter(registry, [adapter], {
    authorizeDelegation: () => "allow",
  });
  const gateway = new Gateway(registry, [adapter]);
  const permissions = new PermissionEngine(
    {
      defaults: {
        agents: { send: "allow" },
        slack: {
          own_channel: { write: options.ownChannelWrite ?? "allow" },
          agent_channels: { write: options.agentChannelWrite ?? "allow" },
          other_channels: { write: "deny" },
        },
      },
      agents: {},
    },
    {
      implementer: {
        slack: { channel_id: "C1" },
        consultations:
          options.allowReviewerConsultation === false
            ? {}
            : { reviewer: { scope: "Review implementation changes" } },
      },
      reviewer: {
        slack: { channel_id: "C2" },
        consultations: options.allowSecurityConsultationFromReviewer
          ? { security: { scope: "Request a bounded security review" } }
          : {},
      },
      security: { slack: { channel_id: "C3" } },
    },
  );
  const approvals = new PermissionApprovalCoordinator();
  const projectionErrors: unknown[] = [];
  const restartRequests: string[] = [];
  const service = new RuntimeMcpService(registry, permissions, approvals, {
    onProjectionError: (error) => projectionErrors.push(error),
    onRestartRequested: () => {
      restartRequests.push("requested");
      options.onRestartRequested?.();
    },
    ...(options.gatewayRestartReplayGuard === undefined
      ? {}
      : {
          gatewayRestartReplayGuard: options.gatewayRestartReplayGuard,
          runtimeInstanceId:
            options.runtimeInstanceId ??
            "11111111-1111-4111-8111-111111111111",
        }),
    ...(options.appOpsApprovalProofBroker === undefined
      ? {}
      : { appOpsApprovalProofBroker: options.appOpsApprovalProofBroker }),
    ...(options.onStateChanged === undefined
      ? {}
      : { onStateChanged: options.onStateChanged }),
  });
  const posts: unknown[][] = [];
  const projected: unknown[] = [];
  const projectionAttempts: unknown[] = [];
  const continuations: unknown[] = [];
  const continuationEvents: unknown[] = [];
  let continuationAttempts = 0;
  let replyAttempts = 0;
  let projectionFailedOnce = false;
  service.attach(router, gateway, {
    postMessage: async (...values) => {
      posts.push(values);
      return "1710000000.000001";
    },
    reply: async (...values) => {
      replyAttempts += 1;
      if (options.replyFails) throw new Error("Slack raw reply unavailable");
      posts.push(values);
      return "1710000000.000002";
    },
    projectDelegation: async (activity) => {
      projectionAttempts.push(activity);
      if (options.projectionFails) throw new Error("Slack unavailable");
      if (
        !projectionFailedOnce &&
        options.projectionFailsOnceOn === activity.type
      ) {
        projectionFailedOnce = true;
        throw new Error("Slack projection interrupted");
      }
      projected.push(activity);
      if (activity.type === "delegation.started") {
        options.abortOnStartedProjection?.abort();
        return {
          channelId: activity.targetChannelId,
          rootThreadTs: "1720000000.000001",
        };
      }
      return undefined;
    },
    restoreDelegationProjection: (activity, rootThreadTs) => ({
      channelId: activity.targetChannelId,
      rootThreadTs,
    }),
    projectDelegationContinuation: async (request, events) => {
      continuationAttempts += 1;
      if (options.continuationFails) {
        throw new Error("Source continuation unavailable");
      }
      continuations.push(request);
      for await (const event of events) continuationEvents.push(event);
    },
  });
  return {
    service,
    registry,
    adapter,
    posts,
    projected,
    projectionAttempts,
    continuations,
    continuationEvents,
    get continuationAttempts() {
      return continuationAttempts;
    },
    get replyAttempts() {
      return replyAttempts;
    },
    projectionErrors,
    restartRequests,
    approvals,
  };
}

let requestSequence = 0;
function context(agentId = "implementer", requestId?: string) {
  return {
    agentId,
    signal: new AbortController().signal,
    requestId: requestId ?? `test:${++requestSequence}`,
  } as const;
}

function bindActiveSource(
  registry: InMemoryAgentRegistry,
  options: {
    continuationDelegationId?: string;
    continuationDepth?: number;
    slackUserId?: string;
  } = {},
): () => void {
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1790000000.000001",
      messageTs: "1790000000.000002",
      ...(options.slackUserId === undefined
        ? {}
        : { slackUserId: options.slackUserId }),
      ...(options.continuationDelegationId === undefined
        ? {}
        : {
            continuationDelegationId: options.continuationDelegationId,
            continuationDepth: options.continuationDepth ?? 1,
          }),
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1790000000.000001",
    agentId: "implementer",
    sessionId: "source-session",
  });
  return registry.reserveAgentTurn("implementer");
}

function queuedSlackJob(
  id: string,
  message: string,
  createdAt = "2026-08-13T00:00:00.000Z",
): QueuedDelegationJob {
  return {
    version: 1,
    id,
    requestKey: `request-${id}`,
    source: {
      type: "slack",
      agentId: "implementer",
      channelId: "C1",
      rootThreadTs: "1790000000.000001",
      messageTs: "1790000000.000002",
      sessionId: "source-session",
      adapterSessionId: "source-thread",
      turnStartedAt: createdAt,
    },
    targetAgentId: "reviewer",
    targetAdapter: "fake",
    targetChannelId: "C2",
    targetConversationScope: "channel",
    consultationScope: "Review implementation changes",
    permissionDecision: "allow",
    message,
    depth: 1,
    state: "queued",
    pendingChildIds: [],
    childOutcomes: [],
    createdAt,
    queueExpiresAt: "2099-08-13T00:30:00.000Z",
    updatedAt: createdAt,
  };
}

test("deduplicates one AppOps tool-use hook and blocks a new replay", () => {
  const broker = new AppOpsApprovalProofBroker();
  const operationId = "11111111-1111-4111-8111-111111111111";
  broker.register({
    agentId: "implementer",
    sessionId: "thr_1",
    turnId: "turn_1",
    plan: {
      operationId,
      planHash: "a".repeat(64),
      appId: "app07",
      approvalScope: "build_upload",
      executeTool: "execute_approved_app_store_build_upload",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    proof: "opaque-hook-proof",
  });
  const { service } = setup({ appOpsApprovalProofBroker: broker });
  const input = {
    session_id: "thr_1",
    turn_id: "turn_1",
    tool_name: "mcp__appops__execute_approved_app_store_build_upload",
    tool_use_id: "tool-use-1",
    tool_input: { app_id: "app07", operation_id: operationId },
  };

  const allowed = service.appOpsPreToolUse(context(), input);
  assert.equal(
    allowed.hookSpecificOutput.permissionDecision,
    "allow",
  );
  const duplicateHook = service.appOpsPreToolUse(context(), input);
  assert.equal(
    duplicateHook.hookSpecificOutput.permissionDecision,
    "allow",
  );
  const replay = service.appOpsPreToolUse(context(), {
    ...input,
    tool_use_id: "tool-use-2",
  });
  assert.equal(replay.hookSpecificOutput.permissionDecision, "deny");
  assert.doesNotMatch(JSON.stringify(replay), /opaque-hook-proof/u);
});

test("accepts agent.send durably and continues the final result", async () => {
  const { service, registry, projected, continuations } = setup();
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1710000000.000001",
      messageTs: "1710000000.000002",
      slackUserId: "U123",
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1710000000.000001",
    agentId: "implementer",
    sessionId: "source-session",
  });
  const releaseTurn = registry.reserveAgentTurn("implementer");
  const result = await service.agentSend(context(), "reviewer", "Review this");
  assert.equal(result.target, "reviewer");
  assert.equal(result.status, "queued");
  assert.match(result.message ?? "", /再送は不要/u);
  assert.ok(result.delegation_id);
  releaseTurn();
  await service.waitForIdle();
  assert.deepEqual(
    projected.map((value) => (value as { type: string }).type),
    [
      "delegation.started",
      "delegation.agent_event",
      "delegation.agent_event",
      "delegation.agent_event",
      "delegation.completed",
    ],
  );
  assert.ok(
    projected.every(
      (value) =>
        (value as { sourceChannelId?: string }).sourceChannelId === "C1" &&
        (value as { sourceRootThreadTs?: string }).sourceRootThreadTs ===
          "1710000000.000001" &&
        (value as { sourceSlackUserId?: string }).sourceSlackUserId === "U123",
    ),
  );
  assert.equal(continuations.length, 1);
  assert.match(
    String((continuations[0] as { result?: string }).result),
    /Looks good/u,
  );
});

test("queues behind a busy Koe and runs exactly once after it becomes idle", async () => {
  const { service, registry, adapter, continuations } = setup();
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1710000000.000010",
      messageTs: "1710000000.000011",
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1710000000.000010",
    agentId: "implementer",
    sessionId: "source-session",
  });
  const releaseSource = registry.reserveAgentTurn("implementer");
  const releaseTarget = registry.reserveAgentTurn("reviewer");

  const accepted = await service.agentSend(
    context("implementer", "busy-queue-1"),
    "reviewer",
    "Review after busy",
  );
  assert.equal(accepted.status, "queued");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(adapter.sentTexts.includes("Review after busy"), false);

  releaseTarget();
  releaseSource();
  await service.waitForIdle();
  assert.equal(
    adapter.sentTexts.filter((text) => text === "Review after busy").length,
    1,
  );
  assert.equal(continuations.length, 1);
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("preserves insertion-order FIFO when accepted jobs share one timestamp", async () => {
  const now = "2026-08-13T00:00:00.000Z";
  const { service, adapter } = setup({
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-thread" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1790000000.000001",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.replaceQueuedDelegations([
        queuedSlackJob("z-first", "First at same timestamp", now),
        queuedSlackJob("a-second", "Second at same timestamp", now),
      ]);
    },
  });

  await service.waitForIdle();
  assert.ok(
    adapter.sentTexts.indexOf("First at same timestamp") <
      adapter.sentTexts.indexOf("Second at same timestamp"),
  );
});

test("waits for nested queued children before returning the parent result", async () => {
  const adapter = new NestedQueueFakeAdapter();
  const { service, registry, continuations, projected } = setup({
    adapter,
    allowSecurityConsultationFromReviewer: true,
    reviewerConversationScope: "slack_thread",
  });
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1710000000.000020",
      messageTs: "1710000000.000021",
      slackUserId: "U123",
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1710000000.000020",
    agentId: "implementer",
    sessionId: "source-session",
  });
  const releaseSource = registry.reserveAgentTurn("implementer");
  adapter.requestChild = async () => {
    const child = await service.agentSend(
      context("reviewer", "nested-child-1"),
      "security",
      "Child review",
    );
    assert.equal(child.status, "queued");
  };

  const parent = await service.agentSend(
    context("implementer", "nested-parent-1"),
    "reviewer",
    "Parent review",
  );
  assert.equal(parent.status, "queued");
  releaseSource();
  await service.waitForIdle();

  assert.equal(continuations.length, 1);
  assert.equal(
    (continuations[0] as { delegationId?: string }).delegationId,
    parent.delegation_id,
  );
  assert.match(
    String((continuations[0] as { result?: string }).result),
    /Integrated child result/u,
  );
  assert.doesNotMatch(
    String((continuations[0] as { result?: string }).result),
    /Child consultation accepted/u,
  );
  assert.equal(adapter.sentTexts.filter((text) => text === "Child review").length, 1);
  assert.ok(adapter.sentTexts.some((text) => text.includes("子Koeの遅延結果")));
  assert.ok(
    projected
      .filter((value) => (value as { type?: string }).type === "delegation.started")
      .every(
        (value) =>
          (value as { sourceSlackUserId?: string }).sourceSlackUserId === "U123",
      ),
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("atomically continues a parent when its child finishes before the parent turn", async () => {
  const adapter = new ChildCompletionRaceFakeAdapter();
  const { service, registry, continuations } = setup({
    adapter,
    allowSecurityConsultationFromReviewer: true,
    reviewerConversationScope: "slack_thread",
  });
  const releaseSource = bindActiveSource(registry);
  adapter.requestChild = async () => {
    await service.agentSend(
      context("reviewer", "race-child"),
      "security",
      "Child review",
    );
  };
  adapter.waitForChildDelivery = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const parent = registry.listQueuedDelegations("reviewer")[0];
      if ((parent?.childOutcomes.length ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("child outcome was not delivered to the running parent");
  };

  await service.agentSend(
    context("implementer", "race-parent"),
    "reviewer",
    "Race parent review",
  );
  releaseSource();
  await service.waitForIdle();

  assert.equal(continuations.length, 1);
  assert.ok(adapter.sentTexts.some((text) => text.includes("子Koeの遅延結果")));
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("retains children and resumes safely when a parent turn fails", async () => {
  const adapter = new FailingParentQueueFakeAdapter();
  const { service, registry, continuations } = setup({
    adapter,
    allowSecurityConsultationFromReviewer: true,
    reviewerConversationScope: "slack_thread",
  });
  const releaseSource = bindActiveSource(registry);
  adapter.requestChild = async () => {
    await service.agentSend(
      context("reviewer", "failing-parent-child"),
      "security",
      "Child review",
    );
  };

  await service.agentSend(
    context("implementer", "failing-parent"),
    "reviewer",
    "Failing parent review",
  );
  releaseSource();
  await service.waitForIdle();

  assert.equal(continuations.length, 1);
  assert.ok(
    adapter.sentTexts.some(
      (text) =>
        text.includes("子Koeの遅延結果") &&
        text.includes("parent turn failed after accepting child"),
    ),
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("does not report an interrupted parent with a pending child as completed", async () => {
  const adapter = new InterruptedParentQueueFakeAdapter();
  const { service, registry, continuations } = setup({
    adapter,
    allowSecurityConsultationFromReviewer: true,
    reviewerConversationScope: "slack_thread",
  });
  const releaseSource = bindActiveSource(registry);
  adapter.requestChild = async () => {
    await service.agentSend(
      context("reviewer", "interrupted-parent-child"),
      "security",
      "Child review",
    );
  };

  await service.agentSend(
    context("implementer", "interrupted-parent"),
    "reviewer",
    "Interrupted parent review",
  );
  releaseSource();
  await service.waitForIdle();

  assert.equal(continuations.length, 1);
  assert.match(
    String((continuations[0] as { result?: string }).result),
    /cancelled.*interrupted.*Child Koe results were preserved/ui,
  );
  assert.equal(
    adapter.sentTexts.filter((text) => text.includes("子Koeの遅延結果")).length,
    0,
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("allows target work to continue while source-result delivery is waiting", async () => {
  const { service, registry, adapter } = setup();
  const releaseSource = bindActiveSource(registry);

  await service.agentSend(
    context("implementer", "head-of-line-first"),
    "reviewer",
    "First independent review",
  );
  await service.agentSend(
    context("implementer", "head-of-line-second"),
    "reviewer",
    "Second independent review",
  );
  for (let attempt = 0; attempt < 100 && adapter.sentTexts.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(adapter.sentTexts.slice(0, 2), [
    "First independent review",
    "Second independent review",
  ]);
  releaseSource();
  await service.waitForIdle();
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("consumes one delayed continuation atomically under parallel sends", async () => {
  const { service, registry } = setup();
  const releaseSource = bindActiveSource(registry, {
    continuationDelegationId: "prior-result",
    continuationDepth: 1,
  });

  const results = await Promise.allSettled([
    service.agentSend(
      context("implementer", "parallel-continuation-a"),
      "reviewer",
      "First next step",
    ),
    service.agentSend(
      context("implementer", "parallel-continuation-b"),
      "reviewer",
      "Second next step",
    ),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejection = results.find((result) => result.status === "rejected");
  assert.ok(rejection?.status === "rejected");
  assert.ok(
    rejection.reason instanceof McpServiceError &&
      rejection.reason.code === "DELEGATION_CONTINUATION_ALREADY_USED",
  );
  assert.equal(registry.listQueuedDelegations().length, 1);

  releaseSource();
  await service.waitForIdle();
});

test("bounds failed source delivery without blocking later target work", async () => {
  const harness = setup({ continuationFails: true, replyFails: true });
  const releaseSource = bindActiveSource(harness.registry);

  await harness.service.agentSend(
    context("implementer", "delivery-failure-first"),
    "reviewer",
    "First delivery failure",
  );
  await harness.service.waitForIdle();
  assert.equal(harness.continuationAttempts, 1);
  assert.equal(harness.replyAttempts, 1);
  assert.equal(harness.registry.listQueuedDelegations()[0]?.state, "result_pending");

  await harness.service.agentSend(
    context("implementer", "delivery-failure-second"),
    "reviewer",
    "Second still executes",
  );
  await harness.service.waitForIdle();
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(
    harness.adapter.sentTexts.filter((text) => text === "Second still executes").length,
    1,
  );
  assert.equal(harness.continuationAttempts, 2);
  assert.equal(harness.replyAttempts, 2);
  assert.equal(harness.registry.listQueuedDelegations().length, 2);
  assert.deepEqual(harness.service.agentStatus(context(), "reviewer"), {
    agent_id: "reviewer",
    status: "idle",
    session_id: harness.registry.getPrimarySession("reviewer")?.id,
    queue_status: "blocked",
    queued_delegations: 2,
    pending_deliveries: 2,
  });
  releaseSource();
});

test("escapes Slack mentions in the raw saved-result fallback", async () => {
  const harness = setup({
    adapter: new MentionResultFakeAdapter(),
    continuationFails: true,
  });
  const releaseSource = bindActiveSource(harness.registry);

  await harness.service.agentSend(
    context("implementer", "raw-mention-fallback"),
    "reviewer",
    "Return mention-like text",
  );
  releaseSource();
  await harness.service.waitForIdle();

  const rawReply = String(harness.posts.at(-1)?.[2]);
  assert.doesNotMatch(rawReply, /<!channel>|<@U123>/u);
  assert.match(rawReply, /&lt;!channel&gt;.*&lt;@U123&gt;/u);
  assert.deepEqual(harness.registry.listQueuedDelegations(), []);
});

test("revalidates the source binding after waiting for the target lease", async () => {
  const { service, registry, adapter, posts } = setup();
  const releaseSource = bindActiveSource(registry);
  const releaseTarget = registry.reserveAgentTurn("reviewer");

  await service.agentSend(
    context("implementer", "binding-changed-while-waiting"),
    "reviewer",
    "Must not run after source rebind",
  );
  registry.addSession({
    id: "replacement-source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "replacement-source-thread" },
    status: "idle",
    createdAt: "2026-08-13T00:01:00.000Z",
    updatedAt: "2026-08-13T00:01:00.000Z",
  });
  registry.replaceConversation({
    channelId: "C1",
    rootThreadTs: "1790000000.000001",
    agentId: "implementer",
    sessionId: "replacement-source-session",
  });
  registry.setPrimarySession("implementer", "replacement-source-session");
  releaseTarget();
  releaseSource();
  await service.waitForIdle();

  assert.equal(adapter.sentTexts.includes("Must not run after source rebind"), false);
  assert.match(String(posts.at(-1)?.[2]), /source Slack conversation changed/u);
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("rejects a recovered queued continuation after its target backend changes", async () => {
  const now = "2026-08-13T00:00:00.000Z";
  const { service, registry, adapter, continuations } = setup({
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-backend" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1710000000.000070",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.addSession({
        id: "target-session",
        agentId: "reviewer",
        adapter: "fake",
        adapterSession: { id: "replacement-backend" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("reviewer", "target-session");
      prepared.replaceQueuedDelegations([{
        version: 1,
        id: "recovered-target-rebind",
        requestKey: "recovered-target-rebind-request",
        source: {
          type: "slack",
          agentId: "implementer",
          channelId: "C1",
          rootThreadTs: "1710000000.000070",
          messageTs: "1710000000.000071",
          sessionId: "source-session",
          adapterSessionId: "source-backend",
          turnStartedAt: now,
        },
        targetAgentId: "reviewer",
        targetAdapter: "fake",
        targetChannelId: "C2",
        targetConversationScope: "channel",
        consultationScope: "Review implementation changes",
        permissionDecision: "allow",
        message: "saved sensitive child result",
        depth: 1,
        state: "queued",
        pendingChildIds: [],
        childOutcomes: [],
        targetSessionId: "target-session",
        targetAdapterSessionId: "original-backend",
        createdAt: now,
        queueExpiresAt: "2099-08-13T00:30:00.000Z",
        updatedAt: now,
      }]);
    },
  });

  await service.waitForIdle();

  assert.equal(adapter.sentTexts.includes("saved sensitive child result"), false);
  assert.match(
    String((continuations.at(-1) as { result?: string } | undefined)?.result),
    /target session binding changed/u,
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("persists a completed outcome before a transient terminal projection failure", async () => {
  const { service, registry, adapter, continuations } = setup({
    projectionFailsOnceOn: "delegation.completed",
  });
  const releaseSource = bindActiveSource(registry);

  await service.agentSend(
    context("implementer", "terminal-projection-failure"),
    "reviewer",
    "Finish despite terminal projection failure",
  );
  releaseSource();
  await service.waitForIdle();

  assert.equal(adapter.sendCalls, 2);
  assert.equal(continuations.length, 1);
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("does not acknowledge or execute a queue entry when persistence fails", async () => {
  let persistCalls = 0;
  const { service, registry, adapter } = setup({
    onStateChanged: async () => {
      persistCalls += 1;
      throw new Error("state unavailable");
    },
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-thread" },
        status: "running",
        activeTurn: {
          type: "slack",
          channelId: "C1",
          rootThreadTs: "1710000000.000030",
          messageTs: "1710000000.000031",
          startedAt: "2026-08-13T00:00:00.000Z",
        },
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1710000000.000030",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.reserveAgentTurn("implementer");
    },
  });

  await assert.rejects(
    () => service.agentSend(
      context("implementer", "persist-failure-1"),
      "reviewer",
      "Must not run",
    ),
    /state unavailable/u,
  );
  assert.equal(persistCalls, 1);
  assert.equal(adapter.sentTexts.includes("Must not run"), false);
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("does not hot-loop a target worker after post-acceptance persistence failure", async () => {
  let failWrites = false;
  let writeAttempts = 0;
  const { service, registry, adapter, projectionErrors } = setup({
    onStateChanged: async () => {
      writeAttempts += 1;
      if (failWrites) throw new Error("persistent queue storage unavailable");
    },
  });
  const releaseSource = bindActiveSource(registry);
  const releaseTarget = registry.reserveAgentTurn("reviewer");

  await service.agentSend(
    context("implementer", "worker-persistence-failure"),
    "reviewer",
    "Remain queued after persistence failure",
  );
  failWrites = true;
  releaseTarget();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const attemptsAfterFailure = writeAttempts;
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(writeAttempts, attemptsAfterFailure);
  assert.equal(adapter.sentTexts.length, 0);
  assert.equal(registry.listQueuedDelegations()[0]?.state, "queued");
  assert.equal(projectionErrors.length, 1);
  releaseSource();
});

test("reports a recovered running job as unknown without re-executing it", async () => {
  const now = "2026-08-13T00:00:00.000Z";
  const { service, registry, adapter, continuations } = setup({
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-thread" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1710000000.000040",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.replaceQueuedDelegations([{
        version: 1,
        id: "recovered-running-job",
        requestKey: "recovered-request",
        source: {
          type: "slack",
          agentId: "implementer",
          channelId: "C1",
          rootThreadTs: "1710000000.000040",
          messageTs: "1710000000.000041",
          sessionId: "source-session",
          adapterSessionId: "source-thread",
          turnStartedAt: now,
        },
        targetAgentId: "reviewer",
        targetAdapter: "fake",
        targetChannelId: "C2",
        targetConversationScope: "channel",
        consultationScope: "Review implementation changes",
        permissionDecision: "allow",
        message: "Potential side effect",
        depth: 1,
        state: "running",
        pendingChildIds: [],
        childOutcomes: [],
        createdAt: now,
        queueExpiresAt: "2099-08-13T00:30:00.000Z",
        updatedAt: now,
      }]);
    },
  });

  await service.waitForIdle();
  assert.equal(adapter.sentTexts.includes("Potential side effect"), false);
  assert.equal(continuations.length, 1);
  assert.match(
    String((continuations[0] as { result?: string }).result),
    /unknown/u,
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("does not re-execute a recovered running parent after its child completes", async () => {
  const now = "2026-08-13T00:00:00.000Z";
  const { service, registry, adapter, continuations } = setup({
    allowSecurityConsultationFromReviewer: true,
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-thread" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1710000000.000045",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.addSession({
        id: "parent-session",
        agentId: "reviewer",
        adapter: "fake",
        adapterSession: { id: "parent-thread" },
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("reviewer", "parent-session");
      prepared.replaceQueuedDelegations([
        {
          version: 1,
          id: "recovered-parent",
          requestKey: "recovered-parent-request",
          source: {
            type: "slack",
            agentId: "implementer",
            channelId: "C1",
            rootThreadTs: "1710000000.000045",
            messageTs: "1710000000.000046",
            sessionId: "source-session",
            adapterSessionId: "source-thread",
            turnStartedAt: now,
          },
          targetAgentId: "reviewer",
          targetAdapter: "fake",
          targetChannelId: "C2",
          targetConversationScope: "channel",
          consultationScope: "Review implementation changes",
          permissionDecision: "allow",
          message: "Parent may have side effects",
          depth: 1,
          state: "running",
          pendingChildIds: ["recovered-child"],
          childOutcomes: [],
          targetSessionId: "parent-session",
          targetAdapterSessionId: "parent-thread",
          createdAt: now,
          queueExpiresAt: "2099-08-13T00:30:00.000Z",
          updatedAt: now,
        },
        {
          version: 1,
          id: "recovered-child",
          requestKey: "recovered-child-request",
          source: {
            type: "job",
            agentId: "reviewer",
            ownerJobId: "recovered-parent",
            sessionId: "parent-session",
            adapterSessionId: "parent-thread",
            turnStartedAt: now,
          },
          targetAgentId: "security",
          targetAdapter: "fake",
          targetChannelId: "C3",
          targetConversationScope: "channel",
          consultationScope: "Request a bounded security review",
          permissionDecision: "allow",
          message: "Recovered child work",
          depth: 2,
          causationParentId: "recovered-parent",
          state: "queued",
          pendingChildIds: [],
          childOutcomes: [],
          createdAt: now,
          queueExpiresAt: "2099-08-13T00:30:00.000Z",
          updatedAt: now,
        },
      ]);
    },
  });

  await service.waitForIdle();
  assert.equal(adapter.sentTexts.includes("Parent may have side effects"), false);
  assert.equal(
    adapter.sentTexts.filter((text) => text === "Recovered child work").length,
    1,
  );
  assert.equal(continuations.length, 1);
  assert.match(
    String((continuations[0] as { result?: string }).result),
    /unknown.*Child Koe results were preserved/u,
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("recovers a started source delivery through raw Slack output only", async () => {
  const now = "2026-08-13T00:00:00.000Z";
  const { service, registry, adapter, continuations, posts } = setup({
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-thread" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1710000000.000047",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.replaceQueuedDelegations([{
        version: 1,
        id: "recovered-delivery",
        requestKey: "recovered-delivery-request",
        source: {
          type: "slack",
          agentId: "implementer",
          channelId: "C1",
          rootThreadTs: "1710000000.000047",
          messageTs: "1710000000.000048",
          sessionId: "source-session",
          adapterSessionId: "source-thread",
          turnStartedAt: now,
        },
        targetAgentId: "reviewer",
        targetAdapter: "fake",
        targetChannelId: "C2",
        targetConversationScope: "channel",
        consultationScope: "Review implementation changes",
        permissionDecision: "allow",
        message: "Already completed work",
        depth: 1,
        state: "delivering",
        pendingChildIds: [],
        childOutcomes: [],
        sourceContinuationStarted: true,
        outcome: { status: "completed", text: "Saved completed result" },
        createdAt: now,
        queueExpiresAt: "2099-08-13T00:30:00.000Z",
        updatedAt: now,
      }]);
    },
  });

  await service.waitForIdle();
  assert.equal(adapter.sendCalls, 0);
  assert.equal(continuations.length, 0);
  assert.equal(posts.length, 1);
  assert.match(String(posts[0]?.[2]), /Saved completed result/u);
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("executes a certainly-unstarted queued job after runtime recovery", async () => {
  const now = "2026-08-13T00:00:00.000Z";
  const { service, registry, adapter, continuations } = setup({
    prepareRegistry: (prepared) => {
      prepared.addSession({
        id: "source-session",
        agentId: "implementer",
        adapter: "fake",
        adapterSession: { id: "source-thread" },
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      prepared.setPrimarySession("implementer", "source-session");
      prepared.bindConversation({
        channelId: "C1",
        rootThreadTs: "1710000000.000050",
        agentId: "implementer",
        sessionId: "source-session",
      });
      prepared.replaceQueuedDelegations([{
        version: 1,
        id: "recovered-queued-job",
        requestKey: "recovered-queued-request",
        source: {
          type: "slack",
          agentId: "implementer",
          channelId: "C1",
          rootThreadTs: "1710000000.000050",
          messageTs: "1710000000.000051",
          sessionId: "source-session",
          adapterSessionId: "source-thread",
          turnStartedAt: now,
        },
        targetAgentId: "reviewer",
        targetAdapter: "fake",
        targetChannelId: "C2",
        targetConversationScope: "channel",
        consultationScope: "Review implementation changes",
        permissionDecision: "allow",
        message: "Recovered safe review",
        depth: 1,
        state: "queued",
        pendingChildIds: [],
        childOutcomes: [],
        createdAt: now,
        queueExpiresAt: "2099-08-13T00:30:00.000Z",
        updatedAt: now,
      }]);
    },
  });

  await service.waitForIdle();
  assert.equal(
    adapter.sentTexts.filter((text) => text === "Recovered safe review").length,
    1,
  );
  assert.equal(continuations.length, 1);
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("binds a thread-scoped Koe visit to its projected Slack root before execution", async () => {
  const { service, registry, adapter, projected } = setup({
    reviewerConversationScope: "slack_thread",
  });

  const result = await service.agentSend(
    context(),
    "reviewer",
    "Review product A without inheriting its workspace",
  );
  const started = projected.find(
    (value) => (value as { type?: string }).type === "delegation.started",
  ) as { targetSessionId: string } | undefined;

  assert.equal(result.status, "completed");
  assert.equal(adapter.sendCalls, 1);
  assert.equal(registry.getPrimarySession("reviewer"), undefined);
  assert.equal(
    registry.getConversation("C2", "1720000000.000001")?.sessionId,
    started?.targetSessionId,
  );
});

test("captures agent.send return routing from an active thread-scoped source session", async () => {
  const { service, registry, projected } = setup({
    implementerConversationScope: "slack_thread",
  });
  registry.addSession({
    id: "source-thread-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-backend-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1730000000.000001",
      messageTs: "1730000000.000002",
      startedAt: "2026-08-14T00:00:00.000Z",
    },
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  });
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1730000000.000001",
    agentId: "implementer",
    sessionId: "source-thread-session",
  });
  const release = registry.reserveAgentTurn("implementer");

  await service.agentSend(context(), "reviewer", "Review this request");
  release();
  await service.waitForIdle();

  assert.equal(registry.getPrimarySession("implementer"), undefined);
  assert.ok(
    projected.every(
      (value) =>
        (value as { sourceRootThreadTs?: string }).sourceRootThreadTs ===
        "1730000000.000001",
    ),
  );
});

test("does not start a thread-scoped Koe when its Slack root cannot be projected", async () => {
  const { service, registry, adapter } = setup({
    reviewerConversationScope: "slack_thread",
    projectionFails: true,
  });

  await assert.rejects(
    () => service.agentSend(context(), "reviewer", "Review product A"),
    (error) =>
      error instanceof McpServiceError && error.code === "AGENT_SEND_FAILED",
  );
  assert.equal(adapter.sendCalls, 0);
  assert.equal(registry.getPrimarySession("reviewer"), undefined);
  assert.equal(registry.listSessions("reviewer")[0]?.status, "failed");
});

test("closes a projected visit when its source is cancelled during acceptance", async () => {
  const controller = new AbortController();
  const { service, adapter, projected } = setup({
    reviewerConversationScope: "slack_thread",
    abortOnStartedProjection: controller,
  });

  await assert.rejects(
    () => service.agentSend({
      agentId: "implementer",
      signal: controller.signal,
      requestId: "cancel-during-projection",
    }, "reviewer", "Review product A"),
    (error) =>
      error instanceof McpServiceError && error.code === "REQUEST_CANCELLED",
  );
  await service.waitForIdle();

  assert.equal(adapter.sendCalls, 0);
  assert.deepEqual(
    projected.map((value) => (value as { type?: string }).type),
    ["delegation.started", "delegation.failed"],
  );
});

test("rejects an unconfigured target before a permissive Router can send", async () => {
  const { service, adapter, projected } = setup({
    allowReviewerConsultation: false,
  });

  await assert.rejects(
    () => service.agentSend(context(), "レビュー係", "Review this"),
    (error) =>
      error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(adapter.sendCalls, 0);
  assert.deepEqual(projected, []);
});

test("keeps an accepted queued delegation after the source request aborts", async () => {
  const adapter = new SlowFakeAdapter();
  const {
    service,
    registry,
    continuations,
    continuationEvents,
  } = setup({ adapter });
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1710000000.000001",
      messageTs: "1710000000.000002",
      slackUserId: "U123",
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1710000000.000001",
    agentId: "implementer",
    sessionId: "source-session",
  });
  const releaseSourceTurn = registry.reserveAgentTurn("implementer");
  const controller = new AbortController();
  const requestId = "agent.send:slow:1";
  const sendContext = {
    agentId: "implementer",
    signal: controller.signal,
    requestId,
  } as const;
  const accepted = await service.agentSend(sendContext, "reviewer", "Slow review");
  assert.equal(accepted.status, "queued");
  await adapter.entered;

  registry.updateSessionStatus(
    "source-session",
    "idle",
    "2026-08-13T00:01:00.000Z",
  );
  controller.abort();
  assert.equal(service.isIdle(), false);
  const idle = service.waitForIdle();
  adapter.finish();
  releaseSourceTurn();
  await idle;
  assert.equal(continuations.length, 1);
  const firstContinuation = continuations[0] as {
    readonly delegationId: string;
  };
  assert.equal(accepted.delegation_id, firstContinuation.delegationId);
  assert.deepEqual(continuations[0], {
    delegationId: firstContinuation.delegationId,
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    sourceRootThreadTs: "1710000000.000001",
    sourceMessageTs: "1710000000.000002",
    sourceSlackUserId: "U123",
    sourceSessionId: "source-session",
    sourceAdapterSessionId: "source-thread",
    targetAgentId: "reviewer",
    depth: 1,
    result: "Slow review completed",
  });
  assert.ok(
    continuationEvents.some(
      (value) =>
        (value as { agentId?: string }).agentId === "implementer",
    ),
  );
  assert.equal(registry.getPrimarySession("implementer")?.id, "source-session");
  assert.equal(continuations.length, 1);
  assert.equal(adapter.sendCalls, 2);
  assert.equal(adapter.interruptCalls, 0);
  assert.ok(
    adapter.sentTexts.some((text) =>
      /元依頼で明示された次のKoe工程.*一工程だけ/su.test(text),
    ),
  );
  assert.equal(service.isIdle(), true);
});

test("does not use a persisted Slack turn as a visit return route without a live lease", async () => {
  const { service, registry, projected } = setup();
  registry.addSession({
    id: "stale-source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "stale-source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C1",
      rootThreadTs: "1710000000.000099",
      messageTs: "1710000000.000100",
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "stale-source-session");

  await service.agentSend(context(), "reviewer", "Review this");

  assert.ok(
    projected.every(
      (value) =>
        (value as { sourceRootThreadTs?: string }).sourceRootThreadTs === undefined,
    ),
  );
});

test("keeps direct routing alive when Slack activity projection fails", async () => {
  const { service, projectionErrors } = setup({ projectionFails: true });
  const result = await service.agentSend(context(), "reviewer", "Review");
  assert.equal(result.message, "Looks good");
  assert.equal(projectionErrors.length, 1);
});

test("still attempts terminal projection after a streamed projection error", async () => {
  const { service, projectionAttempts, projectionErrors } = setup({
    projectionFailsOnceOn: "delegation.agent_event",
  });

  const result = await service.agentSend(context(), "reviewer", "Review");

  assert.equal(result.message, "Looks good");
  assert.equal(projectionErrors.length, 1);
  assert.equal(
    (projectionAttempts.at(-1) as { type: string }).type,
    "delegation.completed",
  );
});

test("rejects an invisible delegated Git approval instead of stranding the target turn", async () => {
  const adapter = new StructuredInputFakeAdapter();
  const { service, projectionErrors } = setup({
    adapter,
    projectionFailsOnceOn: "delegation.agent_event",
  });

  const result = await service.agentSend(context(), "reviewer", "Prepare safely");

  assert.equal(result.message, "Rejected safely");
  assert.deepEqual(adapter.responses, [
    {
      requestId: "codex-input:11111111-1111-4111-8111-111111111111",
      optionId: "reject",
    },
  ]);
  assert.equal(projectionErrors.length, 1);
});

test("rejects an invisible Git approval inside an accepted queued turn", async () => {
  const adapter = new StructuredInputFakeAdapter();
  const { service, registry, continuations, projectionErrors } = setup({
    adapter,
    projectionFailsOnceOn: "delegation.agent_event",
  });
  const releaseSource = bindActiveSource(registry);

  const accepted = await service.agentSend(
    context("implementer", "queued-invisible-git-input"),
    "reviewer",
    "Prepare safely in queue",
  );
  assert.equal(accepted.status, "queued");
  releaseSource();
  await service.waitForIdle();

  assert.deepEqual(adapter.responses, [
    {
      requestId: "codex-input:11111111-1111-4111-8111-111111111111",
      optionId: "reject",
    },
  ]);
  assert.equal(projectionErrors.length >= 1, true);
  assert.equal(continuations.length, 1);
  assert.match(
    String((continuations[0] as { result?: string }).result),
    /failed.*Slack projection interrupted/u,
  );
  assert.deepEqual(registry.listQueuedDelegations(), []);
});

test("cancels an invisible delegated native approval instead of stranding the target turn", async () => {
  const adapter = new NativeApprovalFakeAdapter();
  const { service, projectionErrors } = setup({
    adapter,
    projectionFailsOnceOn: "delegation.agent_event",
  });

  const result = await service.agentSend(context(), "reviewer", "Run safely");

  assert.equal(result.message, "Cancelled safely");
  assert.deepEqual(adapter.approvals, [
    {
      requestId: "codex:11111111-1111-4111-8111-111111111111",
      decision: "cancel",
    },
  ]);
  assert.equal(projectionErrors.length, 1);
});

test("rejects delegated Git approval after the start projection already failed", async () => {
  const adapter = new StructuredInputFakeAdapter();
  const { service, projectionErrors } = setup({
    adapter,
    projectionFailsOnceOn: "delegation.started",
  });

  const result = await service.agentSend(context(), "reviewer", "Prepare safely");

  assert.equal(result.message, "Rejected safely");
  assert.deepEqual(adapter.responses, [
    {
      requestId: "codex-input:11111111-1111-4111-8111-111111111111",
      optionId: "reject",
    },
  ]);
  assert.equal(projectionErrors.length, 1);
  assert.equal(service.isIdle(), true);
});

test("cancels delegated native approval after the start projection already failed", async () => {
  const adapter = new NativeApprovalFakeAdapter();
  const { service, projectionErrors } = setup({
    adapter,
    projectionFailsOnceOn: "delegation.started",
  });

  const result = await service.agentSend(context(), "reviewer", "Run safely");

  assert.equal(result.message, "Cancelled safely");
  assert.deepEqual(adapter.approvals, [
    {
      requestId: "codex:11111111-1111-4111-8111-111111111111",
      decision: "cancel",
    },
  ]);
  assert.equal(projectionErrors.length, 1);
  assert.equal(service.isIdle(), true);
});

test("enforces Slack write policy and resolves Koe IDs or call names to channels", async () => {
  const { service, posts } = setup();
  const posted = await service.slackPost(context(), "レビュー係", "Hello");
  assert.deepEqual(posted, { channel: "C2", ts: "1710000000.000001" });
  assert.deepEqual(posts[0], ["C2", "Hello"]);

  await assert.rejects(
    () => service.slackPost(context(), "CGENERAL", "No"),
    (error) => error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
  );
});

test("uploads only resolved image and audio files from the caller workspace", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "taishi-mcp-media-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, "result.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await writeFile(
    join(workspace, "voice.m4a"),
    Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]),
  );
  const { service, posts } = setup({ workspacePath: workspace });

  const posted = await service.slackPost(context(), "reviewer", undefined, [
    { path: "result.png", alt_text: "Rendered result" },
    { path: "voice.m4a", title: "Voice summary" },
  ]);

  assert.equal(posted.channel, "C2");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.[0], "C2");
  assert.equal(posts[0]?.[1], undefined);
  assert.deepEqual(
    (posts[0]?.[2] as Array<{ name: string; kind: string; payload: Blob }>).map(
      ({ name, kind, payload }) => ({ name, kind, size: payload.size }),
    ),
    [
      { name: "result.png", kind: "image", size: 8 },
      { name: "voice.m4a", kind: "audio", size: 8 },
    ],
  );
});

test("waits for a human decision when Slack policy requires approval", async () => {
  const { service, posts, approvals } = setup({ agentChannelWrite: "approval" });
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  const posting = service.slackPost(context(), "reviewer", "Approved message");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0);
  await approvals.resolve(requestId ?? "", "allow_once");
  assert.equal((await posting).channel, "C2");
  assert.equal(posts.length, 1);
});

test("does not post after an approval-backed MCP request is cancelled", async () => {
  const { service, posts, approvals } = setup({ agentChannelWrite: "approval" });
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  const controller = new AbortController();
  const posting = service.slackPost(
    {
      agentId: "implementer",
      signal: controller.signal,
      requestId: `test:${++requestSequence}`,
    },
    "reviewer",
    "Must not be posted",
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    () => posting,
    (error) =>
      error instanceof McpServiceError && error.code === "REQUEST_CANCELLED",
  );
  assert.equal(posts.length, 0);
  await assert.rejects(approvals.resolve(requestId ?? "", "allow_once"));
});

test("authorizes gateway.restart before scheduling it with the authenticated caller", async () => {
  let drain: () => void = () => undefined;
  const setupResult = setup({ onRestartRequested: () => drain() });
  const { service, approvals, restartRequests } = setupResult;
  drain = () => service.beginDrain();
  let presented:
    | {
        requestId: string;
        sourceAgentId: string;
        sourceChannelId: string;
        operation: string;
        summary: string;
      }
    | undefined;
  approvals.setPresenter(async (request) => {
    presented = request;
    assert.equal(restartRequests.length, 0);
  });

  const restarting = service.gatewayRestart(
    context("implementer", "gateway.restart:number:1"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    presented === undefined
      ? undefined
      : {
          sourceAgentId: presented.sourceAgentId,
          sourceChannelId: presented.sourceChannelId,
          operation: presented.operation,
          summary: presented.summary,
        },
    {
      sourceAgentId: "implementer",
      sourceChannelId: "C1",
      operation: "gateway.restart",
      summary: "Gateway Worker restart",
    },
  );
  assert.equal(restartRequests.length, 0);
  await approvals.resolve(presented?.requestId ?? "", "allow_once");

  assert.deepEqual(await restarting, { status: "scheduled" });
  assert.equal(restartRequests.length, 1);
  assert.throws(
    () => service.agentList(context()),
    (error) =>
      error instanceof McpServiceError && error.code === "SERVICE_UNAVAILABLE",
  );
});

test("does not schedule gateway.restart after deny, cancel, or abort", async () => {
  for (const decision of ["deny", "cancel"] as const) {
    const { service, approvals, restartRequests } = setup();
    let requestId: string | undefined;
    approvals.setPresenter(async (request) => {
      requestId = request.requestId;
    });
    const restarting = service.gatewayRestart(context());
    await new Promise((resolve) => setImmediate(resolve));
    await approvals.resolve(requestId ?? "", decision);
    await assert.rejects(
      () => restarting,
      (error) =>
        error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
    );
    assert.equal(restartRequests.length, 0);
  }

  const { service, approvals, restartRequests } = setup();
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  const controller = new AbortController();
  const restarting = service.gatewayRestart({
    agentId: "implementer",
    signal: controller.signal,
    requestId: "gateway.restart:number:aborted",
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    () => restarting,
    (error) =>
      error instanceof McpServiceError && error.code === "REQUEST_CANCELLED",
  );
  assert.equal(restartRequests.length, 0);
  await assert.rejects(approvals.resolve(requestId ?? "", "allow_once"));
});

test("deduplicates gateway.restart retries and scopes approval grants to the caller", async () => {
  const { service, approvals, restartRequests } = setup();
  const presentations: Array<{
    requestId: string;
    sourceAgentId: string;
    allowSessionGrant: boolean;
  }> = [];
  approvals.setPresenter(async (request) => {
    presentations.push({
      requestId: request.requestId,
      sourceAgentId: request.sourceAgentId,
      allowSessionGrant: request.allowSessionGrant !== false,
    });
  });
  const sameRequest = context("implementer", "gateway.restart:number:42");
  const first = service.gatewayRestart(sameRequest);
  const retried = service.gatewayRestart(sameRequest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentations.length, 1);
  assert.equal(presentations[0]?.allowSessionGrant, false);
  await approvals.resolve(presentations[0]?.requestId ?? "", "allow_once");
  assert.deepEqual(await first, { status: "scheduled" });
  assert.deepEqual(await retried, { status: "scheduled" });
  assert.deepEqual(await service.gatewayRestart(sameRequest), {
    status: "scheduled",
  });
  assert.equal(restartRequests.length, 1);
  assert.equal(presentations.length, 1);

  const nextRequest = service.gatewayRestart(
    context("implementer", "gateway.restart:number:43"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentations.length, 2);
  await approvals.resolve(presentations[1]?.requestId ?? "", "allow_once");
  assert.deepEqual(await nextRequest, { status: "scheduled" });
  assert.equal(restartRequests.length, 1);

  const otherCaller = service.gatewayRestart(
    context("reviewer", "gateway.restart:number:44"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentations.length, 3);
  assert.equal(presentations[2]?.sourceAgentId, "reviewer");
  await approvals.resolve(presentations[2]?.requestId ?? "", "deny");
  await assert.rejects(
    () => otherCaller,
    (error) =>
      error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(restartRequests.length, 1);
});

test("waits for permission settlement and the exact HTTP response before restarting", async () => {
  const { service, approvals, restartRequests } = setup();
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  let releaseSettlement!: () => void;
  const settlementBlocked = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  approvals.setSettlementPresenter(async () => settlementBlocked);
  const deferredEffects: Array<() => void> = [];
  const restarting = service.gatewayRestart({
    ...context("implementer", "gateway.restart:number:response-barrier"),
    deferUntilResponseFinished: (effect) => deferredEffects.push(effect),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const resolving = approvals.resolve(requestId ?? "", "allow_once");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restartRequests.length, 0);
  assert.equal(deferredEffects.length, 0);

  releaseSettlement();
  await resolving;
  assert.deepEqual(await restarting, { status: "scheduled" });
  assert.equal(restartRequests.length, 0);
  assert.equal(deferredEffects.length, 1);
  deferredEffects[0]?.();
  assert.equal(restartRequests.length, 1);
});

test("deduplicates an approved gateway.restart retry in a replacement worker", async () => {
  let persistedReceipts: readonly RecentGatewayRestartReceipt[] = [];
  const replayGuard = new GatewayRestartReplayGuard({
    persist: async (receipts) => {
      persistedReceipts = structuredClone(receipts);
    },
  });
  const request = context(
    "implementer",
    "gateway.restart:number:replacement-retry",
  );
  const first = setup({ gatewayRestartReplayGuard: replayGuard });
  let firstRequestId: string | undefined;
  first.approvals.setPresenter(async (approval) => {
    firstRequestId = approval.requestId;
  });
  const accepted = first.service.gatewayRestart(request);
  await new Promise((resolve) => setImmediate(resolve));
  await first.approvals.resolve(firstRequestId ?? "", "allow_once");
  assert.deepEqual(await accepted, { status: "scheduled" });
  assert.equal(first.restartRequests.length, 1);
  assert.equal(persistedReceipts.length, 1);

  const replacementReplayGuard = new GatewayRestartReplayGuard({
    initialReceipts: persistedReceipts,
    persist: async (receipts) => {
      persistedReceipts = structuredClone(receipts);
    },
  });

  const replacement = setup({
    gatewayRestartReplayGuard: replacementReplayGuard,
    runtimeInstanceId: "22222222-2222-4222-8222-222222222222",
  });
  let replacementPresentations = 0;
  replacement.approvals.setPresenter(async () => {
    replacementPresentations += 1;
  });
  assert.deepEqual(await replacement.service.gatewayRestart(request), {
    status: "scheduled",
  });
  assert.equal(replacementPresentations, 0);
  assert.equal(replacement.restartRequests.length, 0);
  assert.deepEqual(persistedReceipts, []);
});

test("does not restart when the durable restart receipt cannot be saved", async () => {
  const { service, approvals, restartRequests } = setup({
    gatewayRestartReplayGuard: {
      has: () => false,
      record: async () => Promise.reject(new Error("state unavailable")),
      consume: async () => false,
    },
  });
  let requestId: string | undefined;
  approvals.setPresenter(async (approval) => {
    requestId = approval.requestId;
  });
  const restarting = service.gatewayRestart(
    context("implementer", "gateway.restart:number:persist-failure"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await approvals.resolve(requestId ?? "", "allow_once");
  await assert.rejects(
    restarting,
    (error) =>
      error instanceof McpServiceError && error.code === "SERVICE_UNAVAILABLE",
  );
  assert.equal(restartRequests.length, 0);
});

test("deduplicates canonical-ID and call-name retries by host request identity", async () => {
  const { service, adapter, posts } = setup();
  const sendContext = context("implementer", "agent.send:number:42");
  const [first, retried] = await Promise.all([
    service.agentSend(sendContext, "レビュー係", "Review once"),
    service.agentSend(sendContext, "reviewer", "Review once"),
  ]);
  assert.deepEqual(retried, first);
  assert.equal(adapter.sendCalls, 1);

  const postContext = context("implementer", "slack.post:number:43");
  const firstPost = await service.slackPost(postContext, "reviewer", "Post once");
  const retriedPost = await service.slackPost(
    postContext,
    "reviewer",
    "Post once",
  );
  assert.deepEqual(retriedPost, firstPost);
  assert.equal(posts.length, 1);
});

test("deduplicates slack.post retries from a call name to its channel ID", async () => {
  const { service, posts } = setup();
  const postContext = context("implementer", "slack.post:channel-alias:1");

  const first = await service.slackPost(postContext, "レビュー係", "Post once");
  const retried = await service.slackPost(postContext, "C2", "Post once");

  assert.deepEqual(retried, first);
  assert.deepEqual(first, { channel: "C2", ts: "1710000000.000001" });
  assert.deepEqual(posts, [["C2", "Post once"]]);
});

test("deduplicates slack.reply retries from a call name to its channel ID", async () => {
  const { service, posts } = setup();
  const replyContext = context("implementer", "slack.reply:channel-alias:1");

  const first = await service.slackReply(
    replyContext,
    "レビュー係",
    "1710000000.000010",
    "Reply once",
  );
  const retried = await service.slackReply(
    replyContext,
    "C2",
    "1710000000.000010",
    "Reply once",
  );

  assert.deepEqual(retried, first);
  assert.deepEqual(first, {
    channel: "C2",
    ts: "1710000000.000002",
    thread_ts: "1710000000.000010",
  });
  assert.deepEqual(posts, [["C2", "1710000000.000010", "Reply once"]]);
});

test("binds a routing-free slack.reply to the caller's active originating thread", async () => {
  const { service, registry, posts } = setup();
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  const release = registry.reserveAgentTurn("implementer");
  registry.beginSessionTurn("source-session", {
    type: "slack",
    channelId: "C1",
    rootThreadTs: "1710000000.000020",
    messageTs: "1710000000.000021",
    startedAt: "2026-08-31T10:00:01.000Z",
  }, "2026-08-31T10:00:01.000Z");

  try {
    const result = await service.slackReply(
      context("implementer", "slack.reply:current-thread:1"),
      undefined,
      undefined,
      "Current-thread screenshot",
    );
    assert.deepEqual(result, {
      channel: "C1",
      ts: "1710000000.000002",
      thread_ts: "1710000000.000020",
    });
    assert.deepEqual(posts, [[
      "C1",
      "1710000000.000020",
      "Current-thread screenshot",
    ]]);
  } finally {
    release();
  }
});

test("applies allow-once approval to a routing-free message reply", async (t) => {
  const { service, registry, posts, approvals } = setup({
    ownChannelWrite: "approval",
  });
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  const release = bindActiveSource(registry);
  t.after(release);

  const replying = service.slackReply(
    context("implementer", "slack.reply:bound-message-allow-once:1"),
    undefined,
    undefined,
    "Approved current-thread reply",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0);

  await approvals.resolve(requestId ?? "", "allow_once");
  assert.deepEqual(await replying, {
    channel: "C1",
    ts: "1710000000.000002",
    thread_ts: "1790000000.000001",
  });
  assert.deepEqual(posts, [[
    "C1",
    "1790000000.000001",
    "Approved current-thread reply",
  ]]);
});

test("keeps a routing-free message reply unposted after approval cancellation", async (t) => {
  const { service, registry, posts, approvals } = setup({
    ownChannelWrite: "approval",
  });
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  const release = bindActiveSource(registry);
  t.after(release);

  const replying = service.slackReply(
    context("implementer", "slack.reply:bound-message-cancel:1"),
    undefined,
    undefined,
    "Cancelled current-thread reply",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0);

  await approvals.resolve(requestId ?? "", "cancel");
  await assert.rejects(
    replying,
    (error) =>
      error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(posts.length, 0);
});

test("does not require approval for an attachment reply bound to the active originating thread", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "taishi-mcp-bound-media-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(
    join(workspace, "screenshot.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const { service, registry, posts, approvals } = setup({
    workspacePath: workspace,
    ownChannelWrite: "approval",
  });
  let presentations = 0;
  approvals.setPresenter(async () => {
    presentations += 1;
  });
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  const release = registry.reserveAgentTurn("implementer");
  t.after(release);
  registry.beginSessionTurn("source-session", {
    type: "slack",
    channelId: "C1",
    rootThreadTs: "1710000000.000030",
    messageTs: "1710000000.000031",
    startedAt: "2026-09-05T10:00:01.000Z",
  }, "2026-09-05T10:00:01.000Z");

  const result = await service.slackReply(
    context("implementer", "slack.reply:bound-attachment:1"),
    undefined,
    undefined,
    undefined,
    [{ path: "screenshot.png", alt_text: "Requested screenshot" }],
  );

  assert.equal(presentations, 0);
  assert.deepEqual(result, {
    channel: "C1",
    ts: "1710000000.000002",
    thread_ts: "1710000000.000030",
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.[0], "C1");
  assert.equal(posts[0]?.[1], "1710000000.000030");
  assert.equal(posts[0]?.[2], undefined);
  assert.equal(
    (posts[0]?.[3] as Array<{ name: string }>)[0]?.name,
    "screenshot.png",
  );
});

test("keeps approval for a message-and-attachment reply bound to the active originating thread", async (t) => {
  const { service, registry, posts, approvals } = setup({
    ownChannelWrite: "approval",
  });
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  const release = registry.reserveAgentTurn("implementer");
  t.after(release);
  registry.beginSessionTurn("source-session", {
    type: "slack",
    channelId: "C1",
    rootThreadTs: "1710000000.000040",
    messageTs: "1710000000.000041",
    startedAt: "2026-09-05T10:00:01.000Z",
  }, "2026-09-05T10:00:01.000Z");

  const replying = service.slackReply(
    context("implementer", "slack.reply:bound-text:1"),
    undefined,
    undefined,
    "Text still follows policy",
    [{ path: "not-read-before-denial.png" }],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 0);
  await approvals.resolve(requestId ?? "", "deny");
  await assert.rejects(
    replying,
    (error) =>
      error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(posts.length, 0);
});

test("rejects a routing-free slack.reply without an active originating thread", async () => {
  const { service } = setup();
  await assert.rejects(
    service.slackReply(
      context("implementer", "slack.reply:no-current-thread:1"),
      undefined,
      undefined,
      "No target",
    ),
    (error) =>
      error instanceof McpServiceError && error.code === "NO_ACTIVE_SLACK_TURN",
  );
});

test("does not confuse reused client request IDs with different agent.send calls", async () => {
  const { service, adapter } = setup();
  const reused = context("implementer", "agent.send:number:99");
  await service.agentSend(reused, "reviewer", "First input");
  await service.agentSend(reused, "reviewer", "Changed input");
  assert.equal(adapter.sendCalls, 2);
  assert.deepEqual(
    adapter.sentTexts,
    ["First input", "Changed input"],
  );
});

test("namespaces transport retries to the active Slack turn", async () => {
  const { service, registry, adapter } = setup();
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "idle",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  registry.bindConversation({
    channelId: "C1",
    rootThreadTs: "1710000000.000001",
    agentId: "implementer",
    sessionId: "source-session",
  });

  const request = context("implementer", "agent.send:number:7");
  const firstRelease = registry.reserveAgentTurn("implementer");
  registry.beginSessionTurn("source-session", {
    type: "slack",
    channelId: "C1",
    rootThreadTs: "1710000000.000001",
    messageTs: "1710000000.000002",
    startedAt: "2026-08-21T00:00:01.000Z",
  }, "2026-08-21T00:00:01.000Z");
  await service.agentSend(request, "reviewer", "Review this");
  await service.agentSend(request, "レビュー係", "Review this");
  firstRelease();

  registry.updateSessionStatus(
    "source-session",
    "idle",
    "2026-08-21T00:01:00.000Z",
  );
  const secondRelease = registry.reserveAgentTurn("implementer");
  registry.beginSessionTurn("source-session", {
    type: "slack",
    channelId: "C1",
    rootThreadTs: "1710000000.000001",
    messageTs: "1710000000.000003",
    startedAt: "2026-08-21T00:01:01.000Z",
  }, "2026-08-21T00:01:01.000Z");
  await service.agentSend(request, "reviewer", "Review this");
  secondRelease();
  await service.waitForIdle();

  assert.equal(
    adapter.sentTexts.filter((text) => text === "Review this").length,
    2,
  );
});

test("lists and reports configured Agent state while rejecting unknown callers", () => {
  const { service } = setup();
  assert.deepEqual(service.agentList(context()).agents, [
    {
      id: "reviewer",
      call_name: "レビュー係",
      adapter: "fake",
      channel: "C2",
      status: "not_started",
      consultation_scope: "Review implementation changes",
    },
  ]);
  assert.deepEqual(service.agentStatus(context(), "レビュー係"), {
    agent_id: "reviewer",
    status: "not_started",
  });
  assert.throws(
    () => service.agentList(context("attacker")),
    (error) => error instanceof McpServiceError && error.code === "UNKNOWN_AGENT",
  );
});

test("resolves an allowed call name to its canonical Koe ID", async () => {
  const { service, adapter } = setup();
  const result = await service.agentSend(
    context("implementer", "agent.send:call-name:1"),
    "レビュー係",
    "Review through the configured name",
  );

  assert.equal(result.target, "reviewer");
  assert.equal(result.status, "completed");
  assert.equal(adapter.sendCalls, 1);
});

test("denies a known call name outside the source consultations", async () => {
  const { service, adapter } = setup();
  await assert.rejects(
    () =>
      service.agentSend(
        context("implementer", "agent.send:call-name:2"),
        "監査役",
        "Try an unconfigured consultation",
      ),
    (error) =>
      error instanceof McpServiceError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(adapter.sendCalls, 0);
});

test("reports only the canonical session when legacy orphan sessions remain", () => {
  const { service, registry } = setup();
  registry.addSession({
    id: "primary",
    agentId: "reviewer",
    adapter: "fake",
    adapterSession: { id: "backend-primary" },
    status: "idle",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:02:00.000Z",
  });
  registry.setPrimarySession("reviewer", "primary");
  registry.addSession({
    id: "slack-active",
    agentId: "reviewer",
    adapter: "fake",
    adapterSession: { id: "backend-slack-active" },
    status: "waiting_for_approval",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:01:00.000Z",
  });

  assert.deepEqual(service.agentStatus(context(), "reviewer"), {
    agent_id: "reviewer",
    status: "idle",
    session_id: "primary",
  });
});

test("rejects new MCP work after runtime shutdown begins", async () => {
  const { service } = setup();
  service.beginShutdown();
  assert.throws(
    () => service.agentList(context()),
    (error) =>
      error instanceof McpServiceError && error.code === "SERVICE_UNAVAILABLE",
  );
  await assert.rejects(
    () => service.slackPost(context(), "reviewer", "No longer accepted"),
    (error) =>
      error instanceof McpServiceError && error.code === "SERVICE_UNAVAILABLE",
  );
});

test("rejects new MCP methods while draining without aborting an active request", async () => {
  const { service, posts, approvals } = setup({ agentChannelWrite: "approval" });
  let requestId: string | undefined;
  approvals.setPresenter(async (request) => {
    requestId = request.requestId;
  });
  const active = service.slackPost(context(), "reviewer", "Finish before restart");
  await new Promise((resolve) => setImmediate(resolve));

  service.beginDrain();
  assert.throws(
    () => service.agentList(context()),
    (error) =>
      error instanceof McpServiceError && error.code === "SERVICE_UNAVAILABLE",
  );
  await assert.rejects(
    () => service.slackPost(context(), "reviewer", "Too late"),
    (error) =>
      error instanceof McpServiceError && error.code === "SERVICE_UNAVAILABLE",
  );

  await approvals.resolve(requestId ?? "", "allow_once");
  assert.deepEqual(await active, {
    channel: "C2",
    ts: "1710000000.000001",
  });
  assert.equal(posts.length, 1);
});
