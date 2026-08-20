import assert from "node:assert/strict";
import test from "node:test";

import { CoreError, InMemoryAgentRegistry } from "../../src/core/index.js";
import type { AgentSessionRecord } from "../../src/core/index.js";

const now = "2026-08-12T00:00:00.000Z";

function session(
  id: string,
  agentId: string,
  adapter = "fake",
): AgentSessionRecord {
  return {
    id,
    agentId,
    adapter,
    adapterSession: { id: `adapter-${id}` },
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

test("maps multiple Slack reply locations to one channel-wide session", () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "implementer",
    adapter: "fake",
    channelId: "C-IMPLEMENTER",
  });
  registry.addSession(session("session-1", "implementer"));
  registry.setPrimarySession("implementer", "session-1");
  registry.bindConversation({
    channelId: "C-IMPLEMENTER",
    rootThreadTs: "1000.001",
    agentId: "implementer",
    sessionId: "session-1",
  });
  registry.bindConversation({
    channelId: "C-IMPLEMENTER",
    rootThreadTs: "2000.002",
    agentId: "implementer",
    sessionId: "session-1",
  });

  assert.equal(
    registry.getAgentByChannel("C-IMPLEMENTER")?.id,
    "implementer",
  );
  assert.equal(
    registry.getConversation("C-IMPLEMENTER", "1000.001")?.sessionId,
    "session-1",
  );
  assert.deepEqual(
    registry
      .listConversationsForSession("session-1")
      .map(({ rootThreadTs }) => rootThreadTs),
    ["1000.001", "2000.002"],
  );
});

test("rejects sharing one session across roots for a Slack-thread-scoped Koe", () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "reviewer",
    adapter: "fake",
    channelId: "C-REVIEWER",
    conversationScope: "slack_thread",
  });
  registry.addSession(session("session-1", "reviewer"));
  registry.bindConversation({
    channelId: "C-REVIEWER",
    rootThreadTs: "1000.001",
    agentId: "reviewer",
    sessionId: "session-1",
  });

  assert.throws(
    () => registry.bindConversation({
      channelId: "C-REVIEWER",
      rootThreadTs: "2000.002",
      agentId: "reviewer",
      sessionId: "session-1",
    }),
    (error) =>
      error instanceof CoreError && error.code === "SESSION_ALREADY_BOUND",
  );
});

test("snapshot round-trips without storage-specific types", () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "reviewer",
    callName: "レビュー係",
    adapter: "fake",
    channelId: "C-REVIEWER",
    role: "Review changes",
    slackPersona: "Be strict on ShowTalk turns.",
  });
  registry.addSession(session("session-review", "reviewer"));
  registry.setPrimarySession("reviewer", "session-review");
  registry.bindConversation({
    channelId: "C-REVIEWER",
    rootThreadTs: "2000.001",
    agentId: "reviewer",
    sessionId: "session-review",
  });

  const json = JSON.stringify(registry.snapshot());
  const restored = new InMemoryAgentRegistry(JSON.parse(json));

  assert.deepEqual(restored.snapshot(), registry.snapshot());
  assert.equal(restored.requireAgentByAddress("レビュー係").id, "reviewer");
});

test("durably retains delegation replay guards beyond the former memory bound", () => {
  const registry = new InMemoryAgentRegistry();
  for (let index = 0; index < 1_100; index += 1) {
    registry.recordHandledDelegationResult(`handled-${index}`);
    registry.recordUsedContinuationDelegation(`continued-${index}`);
  }

  const restored = new InMemoryAgentRegistry(
    JSON.parse(JSON.stringify(registry.snapshot())),
  );
  assert.equal(restored.hasHandledDelegationResult("handled-0"), true);
  assert.equal(restored.hasHandledDelegationResult("handled-1099"), true);
  assert.equal(restored.hasUsedContinuationDelegation("continued-0"), true);
  assert.equal(restored.hasUsedContinuationDelegation("continued-1099"), true);
});

test("hydrates legacy state that predates durable delegation replay guards", () => {
  const restored = new InMemoryAgentRegistry({
    version: 1,
    agents: [],
    sessions: [],
    conversations: [],
    primarySessions: [],
  });

  assert.deepEqual(restored.snapshot().handledDelegationResults, []);
  assert.deepEqual(restored.snapshot().usedContinuationDelegations, []);
});

test("resolves normalized call names and rejects address collisions", () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "model-specialist",
    callName: "ＭＯＤＥＬＥＲ",
    adapter: "fake",
    channelId: "C-MODELER",
  });

  assert.equal(
    registry.requireAgentByAddress("model-specialist").id,
    "model-specialist",
  );
  assert.equal(
    registry.requireAgentByAddress("ｍｏｄｅｌｅｒ").id,
    "model-specialist",
  );
  assert.throws(
    () =>
      registry.registerAgent({
        id: "reviewer",
        callName: "Modeler",
        adapter: "fake",
        channelId: "C-REVIEWER",
      }),
    (error) =>
      error instanceof CoreError &&
      error.code === "AGENT_ADDRESS_ALREADY_REGISTERED",
  );
  assert.throws(
    () =>
      registry.registerAgent({
        id: "modeler",
        adapter: "fake",
        channelId: "C-MODELER-2",
      }),
    (error) =>
      error instanceof CoreError &&
      error.code === "AGENT_ADDRESS_ALREADY_REGISTERED",
  );
});

test("rejects a thread binding when channel, agent, and session disagree", () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({
    id: "implementer",
    adapter: "fake",
    channelId: "C-IMPLEMENTER",
  });
  registry.registerAgent({
    id: "reviewer",
    adapter: "fake",
    channelId: "C-REVIEWER",
  });
  registry.addSession(session("session-review", "reviewer"));

  assert.throws(
    () =>
      registry.bindConversation({
        channelId: "C-IMPLEMENTER",
        rootThreadTs: "3000.001",
        agentId: "implementer",
        sessionId: "session-review",
      }),
    (error) =>
      error instanceof CoreError && error.code === "SESSION_AGENT_MISMATCH",
  );
});

test("shares one process-local active-turn lease per Agent", () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "codex", channelId: "C1" });
  const release = registry.reserveAgentTurn("implementer");
  assert.throws(
    () => registry.reserveAgentTurn("implementer"),
    (error) => error instanceof CoreError && error.code === "AGENT_BUSY",
  );
  release();
  release();
  assert.doesNotThrow(() => registry.reserveAgentTurn("implementer")());
});

test("waits until active and FIFO-queued turns are all released", async () => {
  const registry = new InMemoryAgentRegistry();
  registry.registerAgent({ id: "implementer", adapter: "codex", channelId: "C1" });
  const releaseFirst = registry.reserveAgentTurn("implementer");
  const secondLease = registry.waitForAgentTurn("implementer");
  let becameIdle = false;
  const idle = registry.waitForTurnQueueIdle().then(() => {
    becameIdle = true;
  });

  releaseFirst();
  const releaseSecond = await secondLease;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(becameIdle, false);
  assert.equal(registry.isTurnQueueIdle(), false);

  releaseSecond();
  await idle;
  assert.equal(becameIdle, true);
  assert.equal(registry.isTurnQueueIdle(), true);
});
