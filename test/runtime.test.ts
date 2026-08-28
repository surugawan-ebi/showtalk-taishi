import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexChildEnvironment,
  createCodexProbeEnvironment,
  createRegistry,
  configuredKoeRole,
  startFrontendWithStateRollback,
  validateConfiguredAdapterSession,
  validateRuntimePrerequisites,
} from "../src/runtime.js";
import { taishiConfigSchema, type TaishiConfig } from "../src/config/schema.js";
import type { RuntimeState } from "../src/state/file-state-store.js";

test("injects only configured Koe consultation targets into the role", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
      source: {
        adapter: "codex",
        workspace: { path: "/workspace/source" },
        slack: {
          channel_id: "C1",
          persona: "Respond as the engineering lead on ShowTalk turns.",
        },
        role: "Source role",
        consultations: {
          reviewer: { scope: "Adversarial review only" },
        },
      },
      reviewer: {
        adapter: "codex",
        workspace: { path: "/workspace/reviewer" },
        slack: { channel_id: "C2", call_name: "レビュー係" },
        role: "Reviewer role",
      },
      unrelated: {
        adapter: "codex",
        workspace: { path: "/workspace/unrelated" },
        slack: { channel_id: "C3" },
        role: "Unrelated role",
      },
    },
    permissions: { defaults: { agents: { send: "allow" } }, agents: {} },
  });

  const role = configuredKoeRole("source", config);
  assert.match(
    role,
    /レビュー係 \[reviewer\].*Slack channel C2.*Adversarial review only/su,
  );
  assert.match(role, /ordered multi-Koe request.*one step at a time/su);
  assert.doesNotMatch(role, /unrelated/u);
  assert.match(configuredKoeRole("unrelated", config), /consultations: none/u);

  const registry = createRegistry(config, {
    version: 1,
    core: {
      version: 1,
      agents: [],
      sessions: [],
      conversations: [],
      primarySessions: [],
    },
  });
  assert.equal(
    registry.requireAgent("source").slackPersona,
    "Respond as the engineering lead on ShowTalk turns.",
  );
  assert.equal(registry.requireAgent("reviewer").callName, "レビュー係");
});

test("does not leak Slack credentials into isolated Codex Agent processes", () => {
  const config = {
    slack: {
      app_token: "xapp-secret",
      bot_token: "xoxb-secret",
    },
  } as TaishiConfig;
  const environment = createCodexChildEnvironment(config, "agent-mcp-secret", {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "auth-fixture",
    SLACK_APP_TOKEN: "xapp-secret",
    RENAMED_BOT_CREDENTIAL: "xoxb-secret",
    SLACK_UNRELATED_TOKEN: "other-slack-secret",
    SHOWTALK_TAISHI_MCP_TOKEN: "old-agent-token",
    SHOWTALK_WORKSPACE_GIT_APPROVAL_CLI: "/private/approval-cli.js",
    WORKSPACE_GIT_STATE_ROOT: "/private/workspace-git-state",
    GITHUB_TOKEN: "not-forwarded",
    DATABASE_URL: "not-forwarded",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    OPENAI_API_KEY: "auth-fixture",
    SHOWTALK_TAISHI_MCP_TOKEN: "agent-mcp-secret",
  });
});

test("sanitizes Gateway credentials from Codex doctor probes", () => {
  const config = {
    slack: {
      app_token: "xapp-secret",
      bot_token: "xoxb-secret",
    },
  } as TaishiConfig;
  assert.deepEqual(
    createCodexProbeEnvironment(config, {
      PATH: "/usr/bin",
      SLACK_APP_TOKEN: "xapp-secret",
      RENAMED_BOT_CREDENTIAL: "xoxb-secret",
      SHOWTALK_TAISHI_MCP_TOKEN: "old-agent-token",
      OPENAI_API_KEY: "auth-fixture",
      AWS_SECRET_ACCESS_KEY: "not-forwarded",
    }),
    {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "auth-fixture",
    },
  );
});

test("passes only explicitly requested additional Agent environment variables", () => {
  const config = {
    slack: {
      app_token: "xapp-secret",
      bot_token: "xoxb-secret",
    },
  } as TaishiConfig;
  assert.deepEqual(
    createCodexChildEnvironment(
      config,
      "agent-token",
      {
        PATH: "/usr/bin",
        JAVA_HOME: "/opt/java",
        GITHUB_TOKEN: "explicit-risk",
        DATABASE_URL: "not-requested",
      },
      ["JAVA_HOME", "GITHUB_TOKEN"],
    ),
    {
      PATH: "/usr/bin",
      JAVA_HOME: "/opt/java",
      GITHUB_TOKEN: "explicit-risk",
      SHOWTALK_TAISHI_MCP_TOKEN: "agent-token",
    },
  );
});

test("validates that a declared backend session is persistent and exact", async () => {
  await validateConfiguredAdapterSession(
    { readThread: async (threadId: string) => ({ id: threadId }) },
    "implementer",
    "thread-declared",
  );
  await assert.rejects(
    validateConfiguredAdapterSession(
      { readThread: async () => ({ id: "thread-other" }) },
      "implementer",
      "thread-declared",
    ),
    /resolved a different configured adapter session/,
  );
  await assert.rejects(
    validateConfiguredAdapterSession(
      {
        readThread: async (threadId: string) => ({
          id: threadId,
          ephemeral: true,
        }),
      },
      "implementer",
      "thread-declared",
    ),
    /cannot bind an ephemeral configured adapter session/,
  );
});

test("can skip workspace checks for Gateway startup while doctor keeps them", async () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-missing-workspace-test.json" },
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
      project: {
        adapter: "codex",
        workspace: { path: "/dev/null" },
        slack: { channel_id: "C1" },
        role: "Project",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });

  await assert.rejects(
    validateRuntimePrerequisites(config),
    /Koe project workspace is not a directory/u,
  );
  const checks = await validateRuntimePrerequisites(config, { checkWorkspaces: false });
  assert.ok(checks.includes("gateway:state-directory"));
  assert.ok(!checks.includes("agent:project:workspace"));
});

test("restores the previous runtime state when Slack startup fails", async () => {
  const previousState: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [],
      sessions: [],
      conversations: [],
      primarySessions: [],
    },
  };
  const saved: RuntimeState[] = [];
  let flushed = false;
  const startupError = new Error("Slack unavailable");

  await assert.rejects(
    startFrontendWithStateRollback(
      { start: async () => Promise.reject(startupError) },
      {
        save: async (state) => {
          saved.push(state);
        },
        flush: async () => {
          flushed = true;
        },
      },
      previousState,
    ),
    (error: unknown) => error === startupError,
  );
  assert.deepEqual(saved, [previousState]);
  assert.equal(flushed, true);

  await assert.rejects(
    startFrontendWithStateRollback(
      { start: async () => Promise.reject(startupError) },
      {
        save: async () => Promise.reject(new Error("rollback failed")),
        flush: async () => undefined,
      },
      previousState,
    ),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors[0] === startupError &&
      error.errors[1] instanceof Error &&
      error.errors[1].message === "rollback failed",
  );
});

test("marks process-local active sessions interrupted after a restart", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
        workspace: { path: "/workspace" },
        slack: { channel_id: "C1" },
        role: "Implement",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [
        { id: "implementer", adapter: "codex", channelId: "C1" },
      ],
      sessions: [
        {
          id: "session-running",
          agentId: "implementer",
          adapter: "codex",
          adapterSession: { id: "thread-running" },
          status: "running",
          activeTurn: {
            type: "slack",
            channelId: "C1",
            rootThreadTs: "100.1",
            messageTs: "100.2",
            startedAt: "2026-08-11T00:01:00.000Z",
          },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:01:00.000Z",
        },
        {
          id: "session-idle",
          agentId: "implementer",
          adapter: "codex",
          adapterSession: { id: "thread-idle" },
          status: "idle",
          activeTurn: {
            type: "agent",
            sourceAgentId: "stale-source",
            delegationId: "stale-delegation",
            startedAt: "2026-08-11T00:02:00.000Z",
          },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:02:00.000Z",
        },
        {
          id: "session-waiting-input",
          agentId: "implementer",
          adapter: "codex",
          adapterSession: { id: "thread-waiting-input" },
          status: "waiting_for_input",
          activeTurn: {
            type: "slack",
            channelId: "C1",
            rootThreadTs: "100.3",
            messageTs: "100.4",
            startedAt: "2026-08-11T00:03:00.000Z",
          },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:03:00.000Z",
        },
      ],
      conversations: [],
      primarySessions: [
        { agentId: "implementer", sessionId: "session-idle" },
      ],
    },
  };

  const registry = createRegistry(
    config,
    state,
    () => new Date("2026-08-12T00:00:00.000Z"),
  );
  assert.deepEqual(
    registry.listSessions().map(({ id, status, activeTurn, updatedAt }) => ({
      id,
      status,
      activeTurn,
      updatedAt,
    })),
    [
      {
        id: "session-running",
        status: "interrupted",
        activeTurn: undefined,
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
      {
        id: "session-idle",
        status: "idle",
        activeTurn: undefined,
        updatedAt: "2026-08-11T00:02:00.000Z",
      },
      {
        id: "session-waiting-input",
        status: "interrupted",
        activeTurn: undefined,
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    ],
  );
  assert.equal(registry.getPrimarySession("implementer")?.id, "session-idle");

  const legacy: RuntimeState = {
    ...state,
    core: {
      ...state.core,
      conversations: [
        {
          channelId: "C1",
          rootThreadTs: "100.1",
          agentId: "implementer",
          sessionId: "session-running",
        },
      ],
      primarySessions: [],
    },
  };
  const migrated = createRegistry(config, legacy);
  assert.equal(migrated.getPrimarySession("implementer")?.id, "session-running");

  const ambiguous: RuntimeState = {
    ...state,
    core: {
      ...state.core,
      conversations: [
        {
          channelId: "C1",
          rootThreadTs: "100.1",
          agentId: "implementer",
          sessionId: "session-running",
        },
        {
          channelId: "C1",
          rootThreadTs: "200.2",
          agentId: "implementer",
          sessionId: "session-idle",
        },
      ],
      primarySessions: [],
    },
  };
  assert.throws(
    () => createRegistry(config, ambiguous),
    /multiple Codex threads.*select one canonical primary session/,
  );
});

test("uses a declared adapter session as the canonical restart binding", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
        adapter_session_id: "thread-declared",
        workspace: { path: "/workspace" },
        slack: { channel_id: "C1" },
        role: "Implement",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [{ id: "implementer", adapter: "codex", channelId: "C1" }],
      sessions: [
        {
          id: "session-old",
          agentId: "implementer",
          adapter: "codex",
          adapterSession: { id: "thread-old" },
          status: "idle",
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
        },
      ],
      conversations: [
        {
          channelId: "C1",
          rootThreadTs: "100.1",
          agentId: "implementer",
          sessionId: "session-old",
        },
      ],
      primarySessions: [{ agentId: "implementer", sessionId: "session-old" }],
    },
  };

  const registry = createRegistry(
    config,
    state,
    () => new Date("2026-08-12T00:00:00.000Z"),
    () => "session-declared",
  );

  assert.equal(
    registry.getPrimarySession("implementer")?.adapterSession.id,
    "thread-declared",
  );
  assert.equal(registry.listSessions("implementer").length, 2);
  assert.equal(
    registry.getConversation("C1", "100.1")?.sessionId,
    "session-declared",
  );

  const fallbackRegistry = createRegistry(config, {
    ...state,
    core: {
      ...state.core,
      agents: [
        {
          id: "implementer",
          adapter: "codex",
          channelId: "C1",
          conversationScope: "slack_thread",
          configuredAdapterSessionId: "thread-declared",
        },
      ],
      primarySessions: [],
    },
  });
  assert.equal(
    fallbackRegistry.requireAgent("implementer").conversationScope,
    "slack_thread",
  );
  assert.equal(fallbackRegistry.getPrimarySession("implementer"), undefined);
  assert.equal(
    fallbackRegistry.getConversation("C1", "100.1")?.sessionId,
    "session-old",
  );
});

test("preserves thread-scoped Slack bindings without selecting a canonical session", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
      reviewer: {
        adapter: "codex",
        workspace: { path: "/workspace/external-reviewer" },
        slack: {
          channel_id: "CREVIEW",
          conversation_scope: "slack_thread",
        },
        role: "Review only the supplied evidence",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const sessions = ["a", "b"].map((suffix) => ({
    id: `session-${suffix}`,
    agentId: "reviewer",
    adapter: "codex",
    adapterSession: { id: `thread-${suffix}` },
    status: "idle" as const,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  }));
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [{
        id: "reviewer",
        adapter: "codex",
        channelId: "CREVIEW",
        conversationScope: "slack_thread",
      }],
      sessions,
      conversations: [
        {
          channelId: "CREVIEW",
          rootThreadTs: "100.1",
          agentId: "reviewer",
          sessionId: "session-a",
        },
        {
          channelId: "CREVIEW",
          rootThreadTs: "200.2",
          agentId: "reviewer",
          sessionId: "session-b",
        },
      ],
      primarySessions: [{ agentId: "reviewer", sessionId: "session-a" }],
    },
  };

  const registry = createRegistry(config, state);

  assert.equal(registry.getAgent("reviewer")?.conversationScope, "slack_thread");
  assert.equal(registry.getPrimarySession("reviewer"), undefined);
  assert.equal(
    registry.getConversation("CREVIEW", "100.1")?.sessionId,
    "session-a",
  );
  assert.equal(
    registry.getConversation("CREVIEW", "200.2")?.sessionId,
    "session-b",
  );
});

test("drops shared root mappings when a Koe migrates to Slack-thread scope", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
      reviewer: {
        adapter: "codex",
        workspace: { path: "/workspace/external-reviewer" },
        slack: {
          channel_id: "CREVIEW",
          conversation_scope: "slack_thread",
        },
        role: "Review only the supplied evidence",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [{ id: "reviewer", adapter: "codex", channelId: "CREVIEW" }],
      sessions: [{
        id: "shared-session",
        agentId: "reviewer",
        adapter: "codex",
        adapterSession: { id: "shared-thread" },
        status: "idle",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      }],
      conversations: ["100.1", "200.2"].map((rootThreadTs) => ({
        channelId: "CREVIEW",
        rootThreadTs,
        agentId: "reviewer",
        sessionId: "shared-session",
      })),
      primarySessions: [{ agentId: "reviewer", sessionId: "shared-session" }],
    },
  };

  const registry = createRegistry(config, state);

  assert.equal(registry.getPrimarySession("reviewer"), undefined);
  assert.equal(registry.getConversation("CREVIEW", "100.1"), undefined);
  assert.equal(registry.getConversation("CREVIEW", "200.2"), undefined);
  assert.equal(registry.listSessions("reviewer").length, 1);
});

test("moves a Koe to a new Slack channel without carrying old Slack reply roots", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
        workspace: { path: "/workspace" },
        slack: { channel_id: "CNEW", conversation_scope: "channel" },
        role: "Implement",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [{ id: "implementer", adapter: "codex", channelId: "C-OLD" }],
      sessions: [{
        id: "session-shared",
        agentId: "implementer",
        adapter: "codex",
        adapterSession: { id: "thread-shared" },
        status: "idle",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      }],
      conversations: [{
        channelId: "C-OLD",
        rootThreadTs: "100.1",
        agentId: "implementer",
        sessionId: "session-shared",
      }],
      primarySessions: [{ agentId: "implementer", sessionId: "session-shared" }],
    },
  };

  const registry = createRegistry(config, state);

  assert.equal(registry.getAgentByChannel("C-OLD"), undefined);
  assert.equal(registry.requireAgentByChannel("CNEW").id, "implementer");
  assert.equal(registry.getConversation("C-OLD", "100.1"), undefined);
  assert.equal(registry.getPrimarySession("implementer"), undefined);
  assert.equal(registry.listSessions("implementer")[0]?.id, "session-shared");
});

test("starts fresh after a configured workspace change without deleting old sessions", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
        workspace: { path: "/workspace/new-product" },
        slack: { channel_id: "C1", conversation_scope: "channel" },
        role: "Implement",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [{
        id: "implementer",
        adapter: "codex",
        channelId: "C1",
        metadata: { workspacePath: "/workspace/old-product" },
      }],
      sessions: [{
        id: "session-old",
        agentId: "implementer",
        adapter: "codex",
        adapterSession: { id: "thread-old" },
        status: "idle",
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      }],
      conversations: [{
        channelId: "C1",
        rootThreadTs: "100.1",
        agentId: "implementer",
        sessionId: "session-old",
      }],
      primarySessions: [{ agentId: "implementer", sessionId: "session-old" }],
    },
  };

  const registry = createRegistry(config, state);

  assert.equal(registry.getPrimarySession("implementer"), undefined);
  assert.equal(registry.getConversation("C1", "100.1"), undefined);
  assert.equal(registry.listSessions("implementer")[0]?.id, "session-old");
  assert.equal(
    registry.requireAgent("implementer").metadata?.workspacePath,
    "/workspace/new-product",
  );
});

test("rejects a declared adapter session already owned by another Koe", () => {
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: "/tmp/taishi-state.json" },
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
        adapter_session_id: "thread-shared",
        workspace: { path: "/workspace/implementer" },
        slack: { channel_id: "C1" },
        role: "Implement",
      },
      reviewer: {
        adapter: "codex",
        workspace: { path: "/workspace/reviewer" },
        slack: { channel_id: "C2" },
        role: "Review",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  const state: RuntimeState = {
    version: 1,
    core: {
      version: 1,
      agents: [{ id: "reviewer", adapter: "codex", channelId: "C2" }],
      sessions: [
        {
          id: "session-reviewer",
          agentId: "reviewer",
          adapter: "codex",
          adapterSession: { id: "thread-shared" },
          status: "idle",
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
        },
      ],
      conversations: [],
      primarySessions: [],
    },
  };

  assert.throws(
    () => createRegistry(config, state),
    /already recorded for Koe reviewer/,
  );
});
