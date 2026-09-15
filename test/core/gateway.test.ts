import assert from "node:assert/strict";
import test from "node:test";

import {
  AdapterSessionUnavailableError,
  CoreError,
  Gateway,
  InMemoryAgentRegistry,
  type AdapterSession,
  type AgentAdapter,
  type AgentEvent,
  type AgentStatus,
  type AgentUserInputResponse,
  type CreateSessionRequest,
  type ResumeSessionRequest,
  type SendMessageRequest,
} from "../../src/core/index.js";

class GatewayAdapter implements AgentAdapter {
  readonly kind = "fake";
  readonly capabilities = {
    streaming: true,
    approval: true,
    interrupt: true,
    resume: true,
    toolEvents: true,
    structuredInput: true,
    imageInput: true,
    audioFileInput: true,
  };
  created = 0;
  resumed = 0;
  readonly sent: Array<{ session: AdapterSession; request: SendMessageRequest }> = [];
  readonly userInputs: Array<{
    session: AdapterSession;
    response: AgentUserInputResponse;
  }> = [];
  readonly interrupted: AdapterSession[] = [];
  readonly approved: AdapterSession[] = [];

  async createSession(_request: CreateSessionRequest): Promise<AdapterSession> {
    this.created += 1;
    return { id: `backend-thread-${this.created}` };
  }

  async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    this.resumed += 1;
    return { id: request.adapterSessionId };
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sent.push({ session, request });
    yield { type: "message.delta", text: "done" };
    yield { type: "status.changed", status: "idle" };
  }

  async interrupt(session: AdapterSession): Promise<void> {
    this.interrupted.push(session);
  }
  async approve(session: AdapterSession): Promise<void> {
    this.approved.push(session);
  }
  async respondToUserInput(
    session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void> {
    this.userInputs.push({ session, response });
  }
  async status(): Promise<AgentStatus> {
    return "idle";
  }
}

class MissingSessionAdapter extends GatewayAdapter {
  readonly missingSessionIds = new Set<string>();

  override async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    this.resumed += 1;
    if (this.missingSessionIds.has(request.adapterSessionId)) {
      throw new AdapterSessionUnavailableError(request.adapterSessionId);
    }
    return { id: request.adapterSessionId };
  }
}

class DeadlineAdvancingResumeAdapter extends GatewayAdapter {
  readonly #advance: () => void;

  constructor(advance: () => void) {
    super();
    this.#advance = advance;
  }

  override async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    this.#advance();
    return super.resumeSession(request);
  }
}

class BlockingTurnAdapter extends GatewayAdapter {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  readonly #released: Promise<void>;

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#released = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sent.push({ session, request });
    if (request.text === "First") {
      this.#markEntered();
      await this.#released;
    }
    yield { type: "message.delta", text: "done" };
    yield { type: "status.changed", status: "idle" };
  }

  release(): void {
    this.#release();
  }

  override async status(): Promise<AgentStatus> {
    return "running";
  }
}

class MissingTerminalStatusAdapter extends GatewayAdapter {
  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sent.push({ session, request });
    yield { type: "message.completed", text: "done without status" };
  }
}

class ImmediateFailureAdapter extends GatewayAdapter {
  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sent.push({ session, request });
    throw new Error("adapter failed before its first event");
  }
}

class CapacityFailureOnceAdapter extends GatewayAdapter {
  #failed = false;

  override async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sent.push({ session, request });
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("Selected model is at capacity. Please try a different model.");
    }
    yield { type: "message.delta", text: "continued" };
    yield { type: "status.changed", status: "idle" };
  }
}

test("keeps one session across every Slack thread in a channel and resumes it", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new GatewayAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });

  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      text: "Fix it",
    }),
  );
  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "200.2",
      text: "Continue",
    }),
  );
  assert.equal(adapter.created, 1);
  assert.equal(adapter.resumed, 0);
  assert.equal(adapter.sent[0]?.session.id, adapter.sent[1]?.session.id);
  assert.equal(
    registry.getConversation("C123", "100.1")?.sessionId,
    registry.getConversation("C123", "200.2")?.sessionId,
  );

  const restoredRegistry = new InMemoryAgentRegistry(registry.snapshot());
  const restoredAdapter = new GatewayAdapter();
  const restoredGateway = new Gateway(restoredRegistry, [restoredAdapter]);
  await collect(
    restoredGateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "300.3",
      text: "After restart",
    }),
  );
  assert.equal(restoredAdapter.created, 0);
  assert.equal(restoredAdapter.resumed, 1);
});

test("isolates and resumes one backend session per Slack root for a thread-scoped Koe", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "external-reviewer",
    adapter: "fake",
    channelId: "C-REVIEW",
    conversationScope: "slack_thread",
  });
  const adapter = new GatewayAdapter();
  let nextId = 0;
  const gateway = new Gateway(registry, [adapter], {
    idFactory: () => `session-${++nextId}`,
  });

  await collect(gateway.handleHumanMessage({
    channelId: "C-REVIEW",
    rootThreadTs: "100.1",
    text: "Review product A",
  }));
  await collect(gateway.handleHumanMessage({
    channelId: "C-REVIEW",
    rootThreadTs: "100.1",
    text: "Follow up on product A",
  }));
  await collect(gateway.handleHumanMessage({
    channelId: "C-REVIEW",
    rootThreadTs: "200.2",
    text: "Review product B",
  }));

  assert.equal(adapter.created, 2);
  assert.equal(adapter.sent[0]?.session.id, adapter.sent[1]?.session.id);
  assert.notEqual(adapter.sent[0]?.session.id, adapter.sent[2]?.session.id);
  assert.notEqual(
    registry.getConversation("C-REVIEW", "100.1")?.sessionId,
    registry.getConversation("C-REVIEW", "200.2")?.sessionId,
  );
  assert.equal(registry.getPrimarySession("external-reviewer"), undefined);
  assert.deepEqual(await gateway.status("C-REVIEW", "999.9"), {
    agentId: "external-reviewer",
    status: "not_started",
  });
  await gateway.resolveUserInput("C-REVIEW", "100.1", {
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    optionId: "reject",
  });
  await gateway.resolveApproval("C-REVIEW", "200.2", {
    requestId: "approval-1",
    decision: "deny",
  });
  await gateway.interrupt("C-REVIEW", "200.2");
  assert.equal(adapter.userInputs[0]?.session.id, "backend-thread-1");
  assert.equal(adapter.approved[0]?.id, "backend-thread-2");
  assert.equal(adapter.interrupted[0]?.id, "backend-thread-2");

  const restoredRegistry = new InMemoryAgentRegistry(registry.snapshot());
  const restoredAdapter = new GatewayAdapter();
  const restoredGateway = new Gateway(restoredRegistry, [restoredAdapter]);
  await collect(restoredGateway.handleHumanMessage({
    channelId: "C-REVIEW",
    rootThreadTs: "100.1",
    text: "Continue product A after restart",
  }));
  assert.equal(restoredAdapter.created, 0);
  assert.equal(restoredAdapter.resumed, 1);
  assert.equal(restoredAdapter.sent[0]?.session.id, "backend-thread-1");
});

test("keeps the same Slack conversation binding after a model capacity failure", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "implementer",
    adapter: "fake",
    channelId: "C123",
    conversationScope: "slack_thread",
  });
  const adapter = new CapacityFailureOnceAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  const message = {
    channelId: "C123",
    rootThreadTs: "100.1",
  } as const;

  await assert.rejects(
    () => collect(gateway.handleHumanMessage({
      ...message,
      text: "Use the selected model",
    })),
    /Selected model is at capacity/u,
  );
  const bindingAfterFailure = registry.getConversation(
    message.channelId,
    message.rootThreadTs,
  );
  assert.equal(bindingAfterFailure?.sessionId, "session-1");
  assert.equal(
    registry.requireSession("session-1").adapterSession.id,
    "backend-thread-1",
  );

  await collect(gateway.handleHumanMessage({
    ...message,
    text: "Continue in the same Slack thread",
  }));

  assert.equal(adapter.created, 1);
  assert.equal(adapter.sent.length, 2);
  assert.equal(adapter.sent[0]?.session.id, "backend-thread-1");
  assert.equal(adapter.sent[1]?.session.id, "backend-thread-1");
  assert.deepEqual(
    registry.getConversation(message.channelId, message.rootThreadTs),
    bindingAfterFailure,
  );
  assert.equal(registry.requireSession("session-1").status, "idle");
});

test("falls back from a missing declared thread to Slack-thread mode", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "legacy",
    adapter: "fake",
    channelId: "C-LEGACY",
    configuredAdapterSessionId: "declared-thread",
  });
  registry.addSession({
    id: "session-declared",
    agentId: "legacy",
    adapter: "fake",
    adapterSession: { id: "declared-thread" },
    status: "idle",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("legacy", "session-declared");
  const adapter = new MissingSessionAdapter();
  adapter.missingSessionIds.add("declared-thread");
  let nextId = 0;
  const gateway = new Gateway(registry, [adapter], {
    idFactory: () => `session-${++nextId}`,
  });

  await collect(gateway.handleHumanMessage({
    channelId: "C-LEGACY",
    rootThreadTs: "100.1",
    text: "Recover this conversation",
  }));
  await collect(gateway.handleHumanMessage({
    channelId: "C-LEGACY",
    rootThreadTs: "200.1",
    text: "Start another thread",
  }));

  assert.equal(adapter.resumed, 1);
  assert.equal(adapter.created, 2);
  assert.equal(adapter.sent[0]?.session.id, "backend-thread-1");
  assert.equal(adapter.sent[1]?.session.id, "backend-thread-2");
  assert.equal(registry.requireAgent("legacy").conversationScope, "slack_thread");
  assert.equal(registry.getPrimarySession("legacy")?.id, "session-declared");
  assert.notEqual(
    registry.getConversation("C-LEGACY", "100.1")?.sessionId,
    registry.getConversation("C-LEGACY", "200.1")?.sessionId,
  );

  const restoredRegistry = new InMemoryAgentRegistry(registry.snapshot());
  const restoredAdapter = new MissingSessionAdapter();
  restoredAdapter.missingSessionIds.add("declared-thread");
  const restoredGateway = new Gateway(restoredRegistry, [restoredAdapter]);
  await collect(restoredGateway.handleHumanMessage({
    channelId: "C-LEGACY",
    rootThreadTs: "100.1",
    text: "Continue after restart",
  }));
  assert.equal(restoredAdapter.resumed, 1);
  assert.equal(restoredAdapter.created, 0);
  assert.equal(restoredAdapter.sent[0]?.session.id, "backend-thread-1");
});

test("does not recreate a missing Codex thread for a project Slack root", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "project",
    adapter: "fake",
    channelId: "C-PROJECT",
    conversationScope: "slack_thread",
  });
  const adapter = new MissingSessionAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  await collect(gateway.handleHumanMessage({
    channelId: "C-PROJECT",
    rootThreadTs: "100.1",
    text: "Create project thread",
  }));

  const restoredRegistry = new InMemoryAgentRegistry(registry.snapshot());
  const restoredAdapter = new MissingSessionAdapter();
  restoredAdapter.missingSessionIds.add("backend-thread-1");
  const restoredGateway = new Gateway(restoredRegistry, [restoredAdapter]);

  await assert.rejects(
    () => collect(restoredGateway.handleHumanMessage({
      channelId: "C-PROJECT",
      rootThreadTs: "100.1",
      text: "Resume deleted project thread",
    })),
    (error) => error instanceof AdapterSessionUnavailableError,
  );
  assert.equal(restoredAdapter.created, 0);
  assert.equal(restoredAdapter.resumed, 1);
  assert.equal(
    restoredRegistry.getConversation("C-PROJECT", "100.1")?.sessionId,
    "session-1",
  );
});

test("does not recreate a deleted thread created by the legacy fallback", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "legacy",
    adapter: "fake",
    channelId: "C-LEGACY-FALLBACK",
    configuredAdapterSessionId: "declared-thread",
  });
  registry.addSession({
    id: "session-declared",
    agentId: "legacy",
    adapter: "fake",
    adapterSession: { id: "declared-thread" },
    status: "idle",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("legacy", "session-declared");
  const adapter = new MissingSessionAdapter();
  adapter.missingSessionIds.add("declared-thread");
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  await collect(gateway.handleHumanMessage({
    channelId: "C-LEGACY-FALLBACK",
    rootThreadTs: "100.1",
    text: "Recover this legacy thread",
  }));

  const restoredRegistry = new InMemoryAgentRegistry(registry.snapshot());
  const restoredAdapter = new MissingSessionAdapter();
  restoredAdapter.missingSessionIds.add("backend-thread-1");
  const restoredGateway = new Gateway(restoredRegistry, [restoredAdapter]);

  await assert.rejects(
    () => collect(restoredGateway.handleHumanMessage({
      channelId: "C-LEGACY-FALLBACK",
      rootThreadTs: "100.1",
      text: "Do not replace this deleted thread",
    })),
    (error) => error instanceof AdapterSessionUnavailableError,
  );
  assert.equal(restoredAdapter.created, 0);
  assert.equal(restoredAdapter.resumed, 1);
});

test("delivers a late Koe result only to its exact thread-scoped source session", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "leader",
    adapter: "fake",
    channelId: "C-LEADER",
    conversationScope: "slack_thread",
  });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C-REVIEW" });
  const adapter = new GatewayAdapter();
  let nextId = 0;
  const gateway = new Gateway(registry, [adapter], {
    idFactory: () => `session-${++nextId}`,
  });
  await collect(gateway.handleHumanMessage({
    channelId: "C-LEADER",
    rootThreadTs: "100.1",
    messageTs: "100.2",
    text: "Product A",
  }));
  await collect(gateway.handleHumanMessage({
    channelId: "C-LEADER",
    rootThreadTs: "200.1",
    messageTs: "200.2",
    text: "Product B",
  }));
  const source = registry.getConversation("C-LEADER", "100.1")!;
  const sourceSession = registry.requireSession(source.sessionId);

  await collect(gateway.handleDelegationResult({
    delegationId: "review-a",
    sourceAgentId: "leader",
    sourceChannelId: "C-LEADER",
    sourceRootThreadTs: "100.1",
    sourceMessageTs: "100.2",
    sourceSessionId: sourceSession.id,
    sourceAdapterSessionId: sourceSession.adapterSession.id,
    targetAgentId: "reviewer",
    depth: 1,
    result: "Product A review",
  }));

  assert.equal(adapter.created, 2);
  assert.equal(adapter.sent[2]?.session.id, adapter.sent[0]?.session.id);
  assert.notEqual(adapter.sent[2]?.session.id, adapter.sent[1]?.session.id);
});

test("continues a delayed Koe result on the same persistent source session", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C456" });
  const adapter = new GatewayAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });

  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      messageTs: "100.2",
      text: "レビューを依頼して",
      slackUserId: "U123",
      slackTeamId: "T123",
      slackAppId: "A123",
    }),
  );
  await collect(
    gateway.handleDelegationResult({
      delegationId: "delegation-1",
      sourceAgentId: "implementer",
      sourceChannelId: "C123",
      sourceRootThreadTs: "100.1",
      sourceMessageTs: "100.2",
      sourceSlackUserId: "U123",
      sourceSessionId: "session-1",
      sourceAdapterSessionId: "backend-thread-1",
      targetAgentId: "reviewer",
      depth: 1,
      result: "レビュー完了。問題ありません。",
    }),
  );

  assert.equal(adapter.created, 1);
  assert.equal(adapter.sent.length, 2);
  assert.equal(adapter.sent[0]?.session.id, adapter.sent[1]?.session.id);
  assert.deepEqual(adapter.sent[0]?.request.metadata, {
    showtalkAgentId: "implementer",
    showtalkChannelId: "C123",
    showtalkRootThreadTs: "100.1",
    showtalkMessageTs: "100.2",
    showtalkSlackUserId: "U123",
    showtalkSlackTeamId: "T123",
    showtalkSlackAppId: "A123",
  });
  assert.deepEqual(adapter.sent[1]?.request.source, {
    type: "agent",
    agentId: "reviewer",
    delegationId: "delegation-1",
    depth: 1,
  });
  assert.equal(adapter.sent[1]?.request.metadata?.origin, "delegation.result");
  assert.match(adapter.sent[1]?.request.text ?? "", /レビュー完了。問題ありません。/u);
  assert.equal(
    registry.getConversation("C123", "100.1")?.sessionId,
    "session-1",
  );
  await assert.rejects(
    () =>
      collect(
        gateway.handleDelegationResult({
          delegationId: "delegation-1",
          sourceAgentId: "implementer",
          sourceChannelId: "C123",
          sourceRootThreadTs: "100.1",
          sourceMessageTs: "100.2",
          sourceSlackUserId: "U123",
          sourceSessionId: "session-1",
          sourceAdapterSessionId: "backend-thread-1",
          targetAgentId: "reviewer",
          depth: 1,
          result: "レビュー完了。問題ありません。",
        }),
      ),
    (error) =>
      error instanceof CoreError &&
      error.code === "DELEGATION_RESULT_ALREADY_HANDLED",
  );
  assert.equal(adapter.sent.length, 2);
});

test("keeps accepted delegation results consumed across a Gateway restart", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C456" });
  const adapter = new GatewayAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      messageTs: "100.2",
      text: "レビューを依頼して",
    }),
  );
  const result = {
    delegationId: "delegation-restart",
    sourceAgentId: "implementer",
    sourceChannelId: "C123",
    sourceRootThreadTs: "100.1",
    sourceMessageTs: "100.2",
    sourceSessionId: "session-1",
    sourceAdapterSessionId: "backend-thread-1",
    targetAgentId: "reviewer",
    depth: 1,
    result: "レビュー完了。問題ありません。",
  } as const;
  await collect(gateway.handleDelegationResult(result));

  const restoredRegistry = new InMemoryAgentRegistry(registry.snapshot());
  const restoredAdapter = new GatewayAdapter();
  const restoredGateway = new Gateway(restoredRegistry, [restoredAdapter]);
  await assert.rejects(
    () => collect(restoredGateway.handleDelegationResult(result)),
    (error) =>
      error instanceof CoreError &&
      error.code === "DELEGATION_RESULT_ALREADY_HANDLED",
  );
  assert.equal(restoredAdapter.sent.length, 0);
});

test("does not replay an accepted delegation result after an immediate adapter failure", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C456" });
  registry.addSession({
    id: "session-1",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "backend-thread-1" },
    status: "idle",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "session-1");
  const adapter = new ImmediateFailureAdapter();
  const gateway = new Gateway(registry, [adapter]);
  const result = {
    delegationId: "delegation-immediate-failure",
    sourceAgentId: "implementer",
    sourceChannelId: "C123",
    sourceRootThreadTs: "100.1",
    sourceMessageTs: "100.2",
    sourceSessionId: "session-1",
    sourceAdapterSessionId: "backend-thread-1",
    targetAgentId: "reviewer",
    depth: 1,
    result: "遅延結果",
  } as const;

  await assert.rejects(
    () => collect(gateway.handleDelegationResult(result)),
    /adapter failed before its first event/u,
  );
  await assert.rejects(
    () => collect(gateway.handleDelegationResult(result)),
    (error) =>
      error instanceof CoreError &&
      error.code === "DELEGATION_RESULT_ALREADY_HANDLED",
  );
  assert.equal(adapter.sent.length, 1);
  assert.deepEqual(registry.snapshot().handledDelegationResults, [
    "delegation-immediate-failure",
  ]);
});

test("does not inject a delayed result after the source canonical session changes", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C456" });
  registry.addSession({
    id: "session-new",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "backend-new" },
    status: "idle",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "session-new");
  const adapter = new GatewayAdapter();
  const gateway = new Gateway(registry, [adapter]);

  await assert.rejects(
    () =>
      collect(
        gateway.handleDelegationResult({
          delegationId: "delegation-old",
          sourceAgentId: "implementer",
          sourceChannelId: "C123",
          sourceRootThreadTs: "100.1",
          sourceMessageTs: "100.2",
          sourceSessionId: "session-old",
          sourceAdapterSessionId: "backend-old",
          targetAgentId: "reviewer",
          depth: 1,
          result: "古い会話向けの結果",
        }),
      ),
    (error) =>
      error instanceof Error && /changed its canonical session/u.test(error.message),
  );
  assert.equal(adapter.sent.length, 0);
});

test("routes a Slack structured choice through the channel-owned live session", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new GatewayAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      text: "Prepare the publication",
    }),
  );

  await gateway.resolveUserInput("C123", "100.1", {
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    optionId: "approve",
  });
  assert.deepEqual(adapter.userInputs, [
    {
      session: { id: "backend-thread-1" },
      response: {
        requestId: "codex-input:11111111-1111-4111-8111-111111111111",
        optionId: "approve",
      },
    },
  ]);
});

test("forwards multiple attachments and accepts an attachment-only Slack message", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new GatewayAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  const attachments = [
    {
      kind: "image" as const,
      path: "/private/attachments/one.png",
      name: "one.png",
      mimeType: "image/png",
      size: 100,
    },
    {
      kind: "audio" as const,
      path: "/private/attachments/note.m4a",
      name: "note.m4a",
      mimeType: "audio/mp4",
      size: 200,
    },
  ];

  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      text: "",
      attachments,
    }),
  );

  assert.equal(adapter.sent.length, 1);
  assert.match(adapter.sent[0]!.request.text, /attached files/u);
  assert.deepEqual(adapter.sent[0]!.request.attachments, attachments);
});

test("reports the channel-wide session status from any Slack reply location", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new GatewayAdapter();
  let id = 0;
  const gateway = new Gateway(registry, [adapter], {
    idFactory: () => `session-${++id}`,
  });

  assert.deepEqual(await gateway.status("C123", "100.1"), {
    agentId: "implementer",
    status: "not_started",
  });
  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      text: "First",
    }),
  );
  assert.deepEqual(await gateway.status("C123", "999.9"), {
    agentId: "implementer",
    sessionId: "session-1",
    status: "idle",
  });
  assert.equal(adapter.created, 1);
});

test("queues rapid human messages in FIFO order for the shared Agent", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new BlockingTurnAdapter();
  let id = 0;
  const gateway = new Gateway(registry, [adapter], {
    idFactory: () => `session-${++id}`,
  });
  const first = collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      text: "First",
    }),
  );
  await adapter.entered;
  const second = collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "200.2",
      text: "Second",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(adapter.sent.map(({ request }) => request.text), ["First"]);
  adapter.release();
  const [firstEvents, secondEvents] = await Promise.all([first, second]);
  assert.deepEqual(adapter.sent.map(({ request }) => request.text), ["First", "Second"]);
  assert.equal(firstEvents[0]?.conversation.rootThreadTs, "100.1");
  assert.equal(secondEvents[0]?.conversation.rootThreadTs, "200.2");
  assert.equal(adapter.created, 1);
});

test("revalidates a structured continuation deadline after the turn lease", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new BlockingTurnAdapter();
  let now = Date.parse("2026-09-09T00:00:00.000Z");
  const gateway = new Gateway(registry, [adapter], {
    idFactory: () => "session-1",
    now: () => new Date(now),
  });
  const active = collect(gateway.handleHumanMessage({
    channelId: "C123",
    rootThreadTs: "100.1",
    text: "First",
  }));
  await adapter.entered;
  const queued = collect(gateway.handleHumanMessage({
    channelId: "C123",
    rootThreadTs: "100.1",
    text: "Continuation",
    expectedSessionId: "session-1",
    notAfterMs: now + 1_000,
  }));
  await new Promise((resolve) => setImmediate(resolve));
  now += 2_000;
  adapter.release();
  await active;
  await assert.rejects(queued, /expired while waiting/u);
  assert.deepEqual(adapter.sent.map(({ request }) => request.text), ["First"]);
});

test("revalidates a structured continuation deadline after session restore", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.addSession({
    id: "session-1",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "backend-thread-1" },
    status: "idle",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "session-1");
  let now = Date.parse("2026-09-09T00:00:00.000Z");
  const adapter = new DeadlineAdvancingResumeAdapter(() => {
    now += 2_000;
  });
  const gateway = new Gateway(registry, [adapter], { now: () => new Date(now) });

  await assert.rejects(
    collect(gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      text: "Continuation",
      expectedSessionId: "session-1",
      notAfterMs: now + 1_000,
    })),
    /expired while restoring/u,
  );
  assert.deepEqual(adapter.sent, []);
});

test("rejects a queued structured continuation after its canonical session changes", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new BlockingTurnAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  const active = collect(gateway.handleHumanMessage({
    channelId: "C123",
    rootThreadTs: "100.1",
    text: "First",
  }));
  await adapter.entered;
  const queued = collect(gateway.handleHumanMessage({
    channelId: "C123",
    rootThreadTs: "100.1",
    text: "Continuation",
    expectedSessionId: "session-1",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  registry.addSession({
    id: "session-2",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "backend-thread-2" },
    status: "idle",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "session-2");
  adapter.release();
  await active;
  await assert.rejects(queued, /changed its canonical session/u);
  assert.deepEqual(adapter.sent.map(({ request }) => request.text), ["First"]);
});

test("queues a delayed Koe result behind a newer active Slack turn", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C456" });
  const adapter = new BlockingTurnAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });

  const active = collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "200.1",
      messageTs: "200.2",
      text: "First",
    }),
  );
  await adapter.entered;
  const delayed = collect(
    gateway.handleDelegationResult({
      delegationId: "delegation-queued",
      sourceAgentId: "implementer",
      sourceChannelId: "C123",
      sourceRootThreadTs: "100.1",
      sourceMessageTs: "100.2",
      sourceSessionId: "session-1",
      sourceAdapterSessionId: "backend-thread-1",
      targetAgentId: "reviewer",
      depth: 1,
      result: "遅れて届いたレビュー",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.sent.length, 1);

  adapter.release();
  await Promise.all([active, delayed]);
  assert.equal(adapter.sent.length, 2);
  assert.equal(adapter.sent[0]?.request.text, "First");
  assert.match(adapter.sent[1]?.request.text ?? "", /遅れて届いたレビュー/u);
});

test("identifies whether a running turn belongs to this Slack thread", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new BlockingTurnAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });
  const active = collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      messageTs: "100.2",
      text: "First",
    }),
  );
  await adapter.entered;

  const exactRequest = await gateway.status("C123", "100.1", "100.2");
  assert.equal(exactRequest.status, "running");
  assert.equal(exactRequest.activeTurnRelation, "exact_request");
  assert.deepEqual(exactRequest.activeTurn, {
    type: "slack",
    channelId: "C123",
    rootThreadTs: "100.1",
    messageTs: "100.2",
    startedAt: exactRequest.activeTurn?.startedAt,
  });

  const sameThread = await gateway.status("C123", "100.1", "100.3");
  assert.equal(sameThread.activeTurnRelation, "same_slack_thread");

  const otherThread = await gateway.status("C123", "999.9");
  assert.equal(otherThread.activeTurnRelation, "other_slack_thread");

  adapter.release();
  await active;
  assert.equal(registry.getPrimarySession("implementer")?.status, "idle");
  assert.equal(registry.getPrimarySession("implementer")?.activeTurn, undefined);
});

test("classifies running Codex work without a live Gateway lease as external or unknown", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  registry.addSession({
    id: "session-1",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "backend-thread-1" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C123",
      rootThreadTs: "old-thread",
      messageTs: "old-message",
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "session-1");
  const gateway = new Gateway(registry, [new BlockingTurnAdapter()]);

  const status = await gateway.status("C123", "100.1", "100.2");
  assert.equal(status.status, "running");
  assert.equal(status.activeTurnRelation, "external_or_unknown");
  assert.equal(status.activeTurn, undefined);
});

test("clears running ownership when an adapter stream ends without a terminal status", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const adapter = new MissingTerminalStatusAdapter();
  const gateway = new Gateway(registry, [adapter], { idFactory: () => "session-1" });

  await collect(
    gateway.handleHumanMessage({
      channelId: "C123",
      rootThreadTs: "100.1",
      messageTs: "100.2",
      text: "Finish cleanly",
    }),
  );

  assert.equal(registry.getPrimarySession("implementer")?.status, "idle");
  assert.equal(registry.getPrimarySession("implementer")?.activeTurn, undefined);
});

test("clears running ownership when the Gateway consumer cancels its iterator", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C123" });
  const gateway = new Gateway(registry, [new GatewayAdapter()], {
    idFactory: () => "session-cancelled",
  });
  const iterator = gateway.handleHumanMessage({
    channelId: "C123",
    rootThreadTs: "100.1",
    messageTs: "100.2",
    text: "Stop projecting",
  })[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).done, false);
  await iterator.return?.();

  assert.equal(registry.getPrimarySession("implementer")?.status, "interrupted");
  assert.equal(registry.getPrimarySession("implementer")?.activeTurn, undefined);
  assert.equal(gateway.isIdle(), true);
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
