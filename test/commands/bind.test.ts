import assert from "node:assert/strict";
import test from "node:test";

import {
  bindCodexThread,
  bindCodexThreadState,
} from "../../src/commands/bind.js";
import { taishiConfigSchema } from "../../src/config/schema.js";
import { createRegistry } from "../../src/runtime.js";
import { emptyRuntimeState, type RuntimeState } from "../../src/state/file-state-store.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const config = taishiConfigSchema.parse({
  version: 1,
  gateway: { state_file: "/tmp/taishi-bind-test.json" },
  slack: {
    socket_mode: true,
    app_token: "xapp-test",
    bot_token: "xoxb-test",
    approver_user_ids: ["U1"],
  },
  adapters: {
    codex: {
      type: "codex-app-server",
      command: "codex",
      transport: "stdio",
    },
  },
  agents: {
    implementer: {
      adapter: "codex",
      workspace: { path: "/workspace/implementer" },
      slack: { channel_id: "C-IMPLEMENTER" },
      role: "Implement",
    },
    reviewer: {
      adapter: "codex",
      workspace: { path: "/workspace/reviewer" },
      slack: { channel_id: "C-REVIEWER" },
      role: "Review",
    },
  },
  permissions: { defaults: {}, agents: {} },
});

function bind(
  state: RuntimeState,
  threadId: string,
  replace = false,
  coreSessionId = `core-${threadId}`,
) {
  return bindCodexThreadState(
    config,
    state,
    {
      channelId: "C-IMPLEMENTER",
      codexThreadId: threadId,
      ...(replace ? { replace: true } : {}),
    },
    { now: () => now, idFactory: () => coreSessionId },
  );
}

test("binds a configured channel to an existing Codex task", () => {
  const bound = bind(emptyRuntimeState(), "thread-1");
  assert.equal(bound.result.outcome, "created");
  assert.equal(bound.result.stateChanged, true);
  assert.deepEqual(bound.state.core.primarySessions, [
    { agentId: "implementer", sessionId: "core-thread-1" },
  ]);
  assert.equal(bound.state.core.sessions[0]?.adapterSession.id, "thread-1");
  assert.deepEqual(
    bound.state.core.agents.map(({ id, channelId }) => ({ id, channelId })),
    [
      { id: "implementer", channelId: "C-IMPLEMENTER" },
      { id: "reviewer", channelId: "C-REVIEWER" },
    ],
  );
});

test("rejects a single canonical binding for a Slack-thread-scoped Koe", () => {
  const threadConfig = taishiConfigSchema.parse({
    ...config,
    agents: {
      ...config.agents,
      implementer: {
        ...config.agents.implementer!,
        slack: {
          ...config.agents.implementer!.slack,
          conversation_scope: "slack_thread",
        },
      },
    },
  });

  assert.throws(
    () => bindCodexThreadState(threadConfig, emptyRuntimeState(), {
      channelId: "C-IMPLEMENTER",
      codexThreadId: "thread-1",
    }),
    /slack_thread.*taishi bind only supports/u,
  );
});

test("repeating the same binding is idempotent", () => {
  const first = bind(emptyRuntimeState(), "thread-1");
  const second = bind(first.state, "thread-1", false, "must-not-be-used");
  assert.equal(second.result.outcome, "unchanged");
  assert.equal(second.result.stateChanged, false);
  assert.deepEqual(second.state, first.state);
});

test("rejects replacing a canonical task unless replace is explicit", () => {
  const first = bind(emptyRuntimeState(), "thread-old");
  assert.throws(
    () => bind(first.state, "thread-new"),
    /already has a different or ambiguous Codex task.*--replace/,
  );
});

test("replace preserves old sessions and repoints all Slack reply locations", () => {
  const first = bind(emptyRuntimeState(), "thread-old");
  const withConversation: RuntimeState = {
    ...first.state,
    core: {
      ...first.state.core,
      conversations: [
        {
          channelId: "C-IMPLEMENTER",
          rootThreadTs: "100.1",
          agentId: "implementer",
          sessionId: "core-thread-old",
        },
        {
          channelId: "C-IMPLEMENTER",
          rootThreadTs: "200.2",
          agentId: "implementer",
          sessionId: "core-thread-old",
        },
      ],
    },
  };
  const replaced = bind(withConversation, "thread-new", true);

  assert.equal(replaced.result.outcome, "replaced");
  assert.deepEqual(
    replaced.state.core.sessions.map((session) => session.adapterSession.id),
    ["thread-old", "thread-new"],
  );
  assert.ok(
    replaced.state.core.conversations.every(
      (binding) => binding.sessionId === "core-thread-new",
    ),
  );
  assert.deepEqual(replaced.state.core.primarySessions, [
    { agentId: "implementer", sessionId: "core-thread-new" },
  ]);
});

test("requires replace to resolve ambiguous legacy sessions", () => {
  const first = bind(emptyRuntimeState(), "thread-1");
  const ambiguous = bind(first.state, "thread-2", true).state;
  const withoutPrimary: RuntimeState = {
    ...ambiguous,
    core: { ...ambiguous.core, primarySessions: [] },
  };
  assert.throws(
    () => bind(withoutPrimary, "thread-3"),
    /different or ambiguous Codex task.*--replace/,
  );
  assert.equal(bind(withoutPrimary, "thread-3", true).result.outcome, "replaced");
});

test("requires replace when primary and Slack mappings disagree", () => {
  const target = bind(emptyRuntimeState(), "thread-target");
  const oldSession = {
    id: "core-old",
    agentId: "implementer",
    adapter: "codex",
    adapterSession: { id: "thread-old" },
    status: "idle" as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  const ambiguous: RuntimeState = {
    ...target.state,
    core: {
      ...target.state.core,
      sessions: [...target.state.core.sessions, oldSession],
      conversations: [
        {
          channelId: "C-IMPLEMENTER",
          rootThreadTs: "100.1",
          agentId: "implementer",
          sessionId: oldSession.id,
        },
      ],
    },
  };
  assert.throws(
    () => bind(ambiguous, "thread-target"),
    /different or ambiguous Codex task.*--replace/,
  );
  const repaired = bind(ambiguous, "thread-target", true);
  assert.equal(repaired.state.core.conversations[0]?.sessionId, "core-thread-target");
});

test("rejects unknown channels and cross-Agent task reuse", () => {
  assert.throws(
    () =>
      bindCodexThreadState(config, emptyRuntimeState(), {
        channelId: "C-UNKNOWN",
        codexThreadId: "thread-1",
      }),
    /No configured Koe uses Slack channel/,
  );

  const reviewer = bindCodexThreadState(
    config,
    emptyRuntimeState(),
    { channelId: "C-REVIEWER", codexThreadId: "thread-shared" },
    { now: () => now, idFactory: () => "core-reviewer" },
  );
  assert.throws(
    () => bind(reviewer.state, "thread-shared", true),
    /already recorded for Koe reviewer/,
  );
});

test("does not let offline bind contradict a declared adapter session", () => {
  const declaredConfig = taishiConfigSchema.parse({
    ...config,
    agents: {
      ...config.agents,
      implementer: {
        ...config.agents.implementer,
        adapter_session_id: "thread-declared",
      },
    },
  });

  assert.throws(
    () =>
      bindCodexThreadState(declaredConfig, emptyRuntimeState(), {
        channelId: "C-IMPLEMENTER",
        codexThreadId: "thread-other",
      }),
    /update or remove adapter_session_id/,
  );
});

test("validates the Codex task before saving and always releases the lock", async () => {
  let saved = false;
  let released = false;
  const stateStore = {
    async acquireLock() {},
    async releaseLock() {
      released = true;
    },
    async load() {
      return emptyRuntimeState();
    },
    async save(_state: RuntimeState) {
      saved = true;
    },
  };

  await assert.rejects(
    () =>
      bindCodexThread(
        config,
        { channelId: "C-IMPLEMENTER", codexThreadId: "missing-thread" },
        {
          stateStoreFactory: () => stateStore,
          validateThread: async () => {
            throw new Error("not found");
          },
        },
      ),
    /not found/,
  );
  assert.equal(saved, false);
  assert.equal(released, true);
});

test("keeps the original state usable and releases the lock when save fails", async () => {
  const original = emptyRuntimeState();
  let released = false;
  await assert.rejects(
    () =>
      bindCodexThread(
        config,
        { channelId: "C-IMPLEMENTER", codexThreadId: "thread-1" },
        {
          stateStoreFactory: () => ({
            async acquireLock() {},
            async releaseLock() {
              released = true;
            },
            async load() {
              return original;
            },
            async save(_state: RuntimeState) {
              throw new Error("disk full");
            },
          }),
          validateThread: async () => undefined,
        },
      ),
    /disk full/,
  );
  assert.equal(released, true);
  assert.deepEqual(original, emptyRuntimeState());
});

test("bound state starts with the selected task as the runtime canonical session", () => {
  const bound = bind(emptyRuntimeState(), "thread-runtime");
  const registry = createRegistry(config, bound.state, () => now);
  assert.equal(
    registry.getPrimarySession("implementer")?.adapterSession.id,
    "thread-runtime",
  );
});

test("explains that the running service must be stopped before binding", async () => {
  await assert.rejects(
    () =>
      bindCodexThread(
        config,
        { channelId: "C-IMPLEMENTER", codexThreadId: "thread-1" },
        {
          stateStoreFactory: () => ({
            async acquireLock() {
              throw new Error(
                "Another ShowTalk Taishi process is using state file: hidden-path",
              );
            },
            async releaseLock() {},
            async load() {
              return emptyRuntimeState();
            },
            async save(_state: RuntimeState) {},
          }),
          validateThread: async () => undefined,
        },
      ),
    /Stop ShowTalk Taishi before changing a channel binding/,
  );
});
