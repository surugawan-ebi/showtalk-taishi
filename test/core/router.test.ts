import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentRouter,
  CoreError,
  Gateway,
  InMemoryAgentRegistry,
} from "../../src/core/index.js";
import type {
  AdapterSession,
  AgentAdapter,
  AgentEvent,
  CreateSessionRequest,
  DelegationActivity,
  SendMessageRequest,
} from "../../src/core/index.js";

class FakeAdapter implements AgentAdapter {
  readonly kind = "fake";
  readonly capabilities = {
    streaming: true,
    approval: false,
    interrupt: false,
    resume: true,
    toolEvents: false,
  };
  readonly created: CreateSessionRequest[] = [];
  resumed = 0;
  readonly sent: Array<{
    session: AdapterSession;
    request: SendMessageRequest;
  }> = [];

  async createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    this.created.push(request);
    return { id: `adapter-session-${this.created.length}` };
  }

  async resumeSession(): Promise<AdapterSession> {
    this.resumed += 1;
    return { id: "adapter-session-1" };
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.sent.push({ session, request });
    yield { type: "message.delta", text: "reviewing" };
    yield { type: "message.completed", text: "done" };
  }
}

function setup(options: { allowSelfDelegation?: boolean } = {}) {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "implementer",
    adapter: "fake",
    channelId: "C-IMPLEMENTER",
    ...(options.allowSelfDelegation === undefined
      ? {}
      : { allowSelfDelegation: options.allowSelfDelegation }),
  });
  registry.registerAgent({
    id: "reviewer",
    adapter: "fake",
    channelId: "C-REVIEWER",
  });
  const adapter = new FakeAdapter();
  let nextId = 0;
  const router = new AgentRouter(registry, [adapter], {
    maxDelegationDepth: 2,
    idFactory: () => `id-${++nextId}`,
    now: () => new Date("2026-08-12T00:00:00.000Z"),
    authorizeDelegation: () => "allow",
  });
  return { adapter, registry, router };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

test("agent.send directly creates and invokes the target adapter session", async () => {
  const { adapter, registry, router } = setup();

  const activity = await collect(
    router.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Review this change",
      sourceRootThreadTs: "1710000000.000001",
    }),
  );

  assert.equal(adapter.created.length, 1);
  assert.equal(adapter.created[0]?.agent.id, "reviewer");
  assert.equal(adapter.created[0]?.reason, "delegation");
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]?.request.text, "Review this change");
  assert.deepEqual(
    activity.map((event) => event.type),
    [
      "delegation.started",
      "delegation.agent_event",
      "delegation.agent_event",
      "delegation.completed",
    ],
  );
  assert.ok(
    activity.every((event) => event.targetChannelId === "C-REVIEWER"),
  );
  assert.ok(
    activity.every(
      (event) =>
        event.sourceChannelId === "C-IMPLEMENTER" &&
        event.sourceRootThreadTs === "1710000000.000001",
    ),
  );
  assert.equal(registry.getPrimarySession("reviewer")?.agentId, "reviewer");
  assert.equal(registry.getPrimarySession("reviewer")?.status, "idle");
  assert.equal(registry.getPrimarySession("reviewer")?.activeTurn, undefined);

  await collect(
    router.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Review the follow-up",
    }),
  );
  assert.equal(adapter.created.length, 1, "primary session should be reused");
  assert.equal(adapter.sent.length, 2);
});

test("creates a fresh unbound session for every visit to a thread-scoped Koe", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "leader",
    adapter: "fake",
    channelId: "C-LEADER",
    metadata: { workspacePath: "/workspace/product-a" },
  });
  registry.registerAgent({
    id: "external-reviewer",
    adapter: "fake",
    channelId: "C-REVIEW",
    conversationScope: "slack_thread",
    metadata: { workspacePath: "/workspace/reviewer-hub" },
  });
  const adapter = new FakeAdapter();
  let nextId = 0;
  const router = new AgentRouter(registry, [adapter], {
    idFactory: () => `session-${++nextId}`,
    authorizeDelegation: () => "allow",
  });

  const first = await collect(router.send({
    sourceAgentId: "leader",
    targetAgentId: "external-reviewer",
    message: "Review product A",
  }));
  const second = await collect(router.send({
    sourceAgentId: "leader",
    targetAgentId: "external-reviewer",
    message: "Review product B",
  }));

  assert.equal(adapter.created.length, 2);
  assert.equal(
    adapter.created[0]?.agent.metadata?.workspacePath,
    "/workspace/reviewer-hub",
  );
  assert.notEqual(first[0]?.targetSessionId, second[0]?.targetSessionId);
  assert.notEqual(adapter.sent[0]?.session.id, adapter.sent[1]?.session.id);
  assert.equal(registry.getPrimarySession("external-reviewer"), undefined);
});

test("reuses a Slack-created channel session for later agent.send calls", async () => {
  const { adapter, registry, router } = setup();
  const gateway = new Gateway(registry, [adapter]);

  await collect(
    gateway.handleHumanMessage({
      channelId: "C-REVIEWER",
      rootThreadTs: "1710000000.000001",
      text: "Human context",
    }),
  );
  const slackSession = registry.getPrimarySession("reviewer");
  await collect(
    router.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Review with the same context",
    }),
  );

  assert.equal(adapter.created.length, 1);
  assert.equal(registry.getPrimarySession("reviewer")?.id, slackSession?.id);
  assert.equal(adapter.sent[0]?.session.id, adapter.sent[1]?.session.id);
});

test("reuses an agent.send-created session for later Slack messages", async () => {
  const { adapter, registry, router } = setup();
  await collect(
    router.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Create shared context",
    }),
  );
  const delegatedSession = registry.getPrimarySession("reviewer");
  const gateway = new Gateway(registry, [adapter]);
  await collect(
    gateway.handleHumanMessage({
      channelId: "C-REVIEWER",
      rootThreadTs: "1710000000.000002",
      text: "Continue from Slack",
    }),
  );

  assert.equal(adapter.created.length, 1);
  assert.equal(registry.getPrimarySession("reviewer")?.id, delegatedSession?.id);
  assert.equal(adapter.sent[0]?.session.id, adapter.sent[1]?.session.id);
});

test("rejects unknown targets before invoking an adapter", async () => {
  const { adapter, router } = setup();

  await assert.rejects(
    () =>
      collect(
        router.send({
          sourceAgentId: "implementer",
          targetAgentId: "missing",
          message: "hello",
        }),
      ),
    (error) => error instanceof CoreError && error.code === "UNKNOWN_AGENT",
  );
  assert.equal(adapter.created.length, 0);
  assert.equal(adapter.sent.length, 0);
});

test("rejects self-delegation unless the Agent explicitly allows it", async () => {
  const denied = setup();
  await assert.rejects(
    () =>
      collect(
        denied.router.send({
          sourceAgentId: "implementer",
          targetAgentId: "implementer",
          message: "loop",
        }),
      ),
    (error) =>
      error instanceof CoreError && error.code === "SELF_DELEGATION_DENIED",
  );

  const allowed = setup({ allowSelfDelegation: true });
  const activity = await collect(
    allowed.router.send({
      sourceAgentId: "implementer",
      targetAgentId: "implementer",
      message: "continue explicitly",
    }),
  );
  assert.equal(activity.at(-1)?.type, "delegation.completed");
});

test("enforces delegation depth while permitting the configured boundary", async () => {
  const { router } = setup();

  const atBoundary = await collect(
    router.send(
      {
        sourceAgentId: "implementer",
        targetAgentId: "reviewer",
        message: "second hop",
      },
      { depth: 2, parentDelegationId: "parent-1" },
    ),
  );
  assert.equal(atBoundary[0]?.depth, 2);
  assert.equal(atBoundary[0]?.parentDelegationId, "parent-1");

  await assert.rejects(
    () =>
      collect(
        router.send(
          {
            sourceAgentId: "implementer",
            targetAgentId: "reviewer",
            message: "third hop",
          },
          { depth: 3 },
        ),
      ),
    (error) =>
      error instanceof CoreError &&
      error.code === "DELEGATION_DEPTH_EXCEEDED",
  );
});

test("activity is independent of Slack ingestion and is projection-ready", async () => {
  const { router } = setup();
  const activity: DelegationActivity[] = await collect(
    router.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Review",
      metadata: { origin: "agent.send" },
    }),
  );

  const started = activity[0];
  assert.equal(started?.type, "delegation.started");
  assert.equal(started?.targetAgentId, "reviewer");
  assert.equal(started?.targetChannelId, "C-REVIEWER");
  assert.match(started?.targetSessionId ?? "", /^id-/);
});

test("derives nested MCP delegation causation from host-owned active state", async () => {
  const { router } = setup();
  const outer = router.send({
    sourceAgentId: "implementer",
    targetAgentId: "reviewer",
    message: "Review",
  })[Symbol.asyncIterator]();
  const outerStarted = await outer.next();
  assert.equal(outerStarted.value?.type, "delegation.started");

  const nested = router.sendFromAgent({
    sourceAgentId: "reviewer",
    targetAgentId: "implementer",
    message: "Please clarify",
  })[Symbol.asyncIterator]();
  const nestedStarted = await nested.next();
  assert.equal(nestedStarted.value?.type, "delegation.started");
  assert.equal(nestedStarted.value?.depth, 2);
  assert.equal(
    nestedStarted.value?.parentDelegationId,
    outerStarted.value?.delegationId,
  );

  await nested.return?.();
  await outer.return?.();
});

test("preserves delegation depth in a delayed continuation turn", async () => {
  const { registry, router } = setup();
  registry.addSession({
    id: "source-session",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C-IMPLEMENTER",
      rootThreadTs: "100.1",
      messageTs: "100.2",
      continuationDelegationId: "parent-late",
      continuationDepth: 2,
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session");
  const release = registry.reserveAgentTurn("implementer");
  try {
    await assert.rejects(
      () =>
        collect(
          router.sendFromAgent({
            sourceAgentId: "implementer",
            targetAgentId: "reviewer",
            message: "Do not reset the hop limit",
          }),
        ),
      (error) =>
        error instanceof CoreError &&
        error.code === "DELEGATION_DEPTH_EXCEEDED",
    );
  } finally {
    release();
  }
});

test("allows only one next Koe step from one delayed continuation turn", async () => {
  const { adapter, registry, router } = setup();
  registry.addSession({
    id: "source-session-once",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread-once" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C-IMPLEMENTER",
      rootThreadTs: "200.1",
      messageTs: "200.2",
      continuationDelegationId: "parent-once",
      continuationDepth: 1,
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  registry.setPrimarySession("implementer", "source-session-once");
  const release = registry.reserveAgentTurn("implementer");
  try {
    const first = router.sendFromAgent({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "First and only next step",
    })[Symbol.asyncIterator]();
    const started = await first.next();
    assert.equal(started.value?.type, "delegation.started");
    await assert.rejects(
      () =>
        collect(
          router.sendFromAgent({
            sourceAgentId: "implementer",
            targetAgentId: "reviewer",
            message: "Forbidden sibling step",
          }),
        ),
      (error) =>
        error instanceof CoreError &&
        error.code === "DELEGATION_CONTINUATION_ALREADY_USED",
    );
    while (!(await first.next()).done) {
      // Drain the admitted first visit after proving a concurrent sibling is denied.
    }
    assert.equal(adapter.sent.length, 1);
  } finally {
    release();
  }
});

test("keeps a delayed continuation's next-step guard across a restart", async () => {
  const first = setup();
  first.registry.addSession({
    id: "source-session-restart",
    agentId: "implementer",
    adapter: "fake",
    adapterSession: { id: "source-thread-restart" },
    status: "running",
    activeTurn: {
      type: "slack",
      channelId: "C-IMPLEMENTER",
      rootThreadTs: "300.1",
      messageTs: "300.2",
      continuationDelegationId: "parent-restart",
      continuationDepth: 1,
      startedAt: "2026-08-13T00:00:00.000Z",
    },
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  });
  first.registry.setPrimarySession("implementer", "source-session-restart");
  const releaseFirst = first.registry.reserveAgentTurn("implementer");
  try {
    await collect(
      first.router.sendFromAgent({
        sourceAgentId: "implementer",
        targetAgentId: "reviewer",
        message: "Start the one permitted next step",
      }),
    );
  } finally {
    releaseFirst();
  }

  const restoredRegistry = new InMemoryAgentRegistry(first.registry.snapshot());
  const restoredAdapter = new FakeAdapter();
  const restoredRouter = new AgentRouter(restoredRegistry, [restoredAdapter], {
    maxDelegationDepth: 2,
    authorizeDelegation: () => "allow",
  });
  const releaseRestored = restoredRegistry.reserveAgentTurn("implementer");
  try {
    await assert.rejects(
      () =>
        collect(
          restoredRouter.sendFromAgent({
            sourceAgentId: "implementer",
            targetAgentId: "reviewer",
            message: "Do not replay after restart",
          }),
        ),
      (error) =>
        error instanceof CoreError &&
        error.code === "DELEGATION_CONTINUATION_ALREADY_USED",
    );
    assert.equal(restoredAdapter.sent.length, 0);
  } finally {
    releaseRestored();
  }
});

test("fails closed instead of mixing two delegated turns for one target", async () => {
  const { router } = setup();
  const first = router.send({
    sourceAgentId: "implementer",
    targetAgentId: "reviewer",
    message: "First",
  })[Symbol.asyncIterator]();
  await first.next();
  await assert.rejects(
    () =>
      collect(
        router.send({
          sourceAgentId: "implementer",
          targetAgentId: "reviewer",
          message: "Second",
        }),
      ),
    (error) => error instanceof CoreError && error.code === "AGENT_BUSY",
  );
  await first.return?.();
});

test("does not interrupt a delegated target without the exact delegation id", async () => {
  const { router } = setup();
  const active = router.send({
    sourceAgentId: "implementer",
    targetAgentId: "reviewer",
    message: "First",
  })[Symbol.asyncIterator]();
  const started = await active.next();
  assert.equal(started.value?.type, "delegation.started");

  assert.equal(
    await router.interruptDelegation("reviewer", "unrelated-delegation"),
    false,
  );
  await active.return?.();
});

test("queues a human turn behind an active delegated turn", async () => {
  const { adapter, registry, router } = setup();
  const gateway = new Gateway(registry, [adapter]);
  const delegation = router.send({
    sourceAgentId: "implementer",
    targetAgentId: "reviewer",
    message: "Hold during projection",
  })[Symbol.asyncIterator]();
  assert.equal((await delegation.next()).value?.type, "delegation.started");

  const human = collect(
    gateway.handleHumanMessage({
      channelId: "C-REVIEWER",
      rootThreadTs: "1710000000.000001",
      text: "Queued human turn",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.sent.length, 0);
  await delegation.return?.();
  await human;
  assert.equal(adapter.sent[0]?.request.text, "Queued human turn");
});

test("resumes and persists a primary delegation session after restart", async () => {
  const first = setup();
  await collect(
    first.router.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Initial review",
    }),
  );

  const restoredRegistry = new InMemoryAgentRegistry(first.registry.snapshot());
  const restoredAdapter = new FakeAdapter();
  let persisted = 0;
  const restoredRouter = new AgentRouter(restoredRegistry, [restoredAdapter], {
    authorizeDelegation: () => "allow",
    onStateChanged: async () => {
      persisted += 1;
    },
  });
  await collect(
    restoredRouter.send({
      sourceAgentId: "implementer",
      targetAgentId: "reviewer",
      message: "Review after restart",
    }),
  );

  assert.equal(restoredAdapter.created.length, 0);
  assert.equal(restoredAdapter.resumed, 1);
  assert.ok(persisted >= 1);
});

test("denies agent.send before invoking the target adapter", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "fake", channelId: "C1" });
  registry.registerAgent({ id: "reviewer", adapter: "fake", channelId: "C2" });
  const adapter = new FakeAdapter();
  const router = new AgentRouter(registry, [adapter], {
    authorizeDelegation: () => "deny",
  });
  await assert.rejects(
    collect(
      router.send({
        sourceAgentId: "implementer",
        targetAgentId: "reviewer",
        message: "Review",
      }),
    ),
    (error) => error instanceof CoreError && error.code === "PERMISSION_DENIED",
  );
  assert.equal(adapter.created.length, 0);
});
