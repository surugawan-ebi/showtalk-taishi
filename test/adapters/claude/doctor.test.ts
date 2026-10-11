import assert from "node:assert/strict";
import test from "node:test";

import { doctorClaudeAdapter } from "../../../src/adapters/claude/doctor.js";
import type { ClaudeAdapterConfig, TaishiConfig } from "../../../src/config/schema.js";

function configWith(agents: Record<string, Record<string, unknown>>): TaishiConfig {
  return { agents } as unknown as TaishiConfig;
}

const adapter = { type: "claude-code" } as ClaudeAdapterConfig;

test("reports the SDK check and skips executable and session checks when not configured", async () => {
  const checks = await doctorClaudeAdapter(
    configWith({ koe: { adapter: "claude", workspace: { path: "/tmp/synthetic" } } }),
    "claude",
    adapter,
    { loadSdk: async () => ({ getSessionInfo: async () => undefined }) },
  );
  assert.deepEqual(checks, ["adapter:claude:claude-agent-sdk"]);
});

test("fails with a helpful error when the SDK cannot be loaded", async () => {
  await assert.rejects(
    doctorClaudeAdapter(configWith({}), "claude", adapter, {
      loadSdk: async () => {
        throw new Error("module missing");
      },
    }),
    /Claude Agent SDK is unavailable for adapter claude; run npm ci/u,
  );
});

test("runs the configured executable and reports a failure", async () => {
  const commands: string[] = [];
  const checks = await doctorClaudeAdapter(
    configWith({}),
    "claude",
    { ...adapter, command: "/opt/synthetic/claude" } as ClaudeAdapterConfig,
    {
      loadSdk: async () => ({ getSessionInfo: async () => undefined }),
      runVersion: async (command) => {
        commands.push(command);
        return "1.0.0";
      },
    },
  );
  assert.deepEqual(commands, ["/opt/synthetic/claude"]);
  assert.deepEqual(checks, ["adapter:claude:claude-agent-sdk", "adapter:claude:claude-executable"]);

  await assert.rejects(
    doctorClaudeAdapter(
      configWith({}),
      "claude",
      { ...adapter, command: "/opt/synthetic/claude" } as ClaudeAdapterConfig,
      {
        loadSdk: async () => ({ getSessionInfo: async () => undefined }),
        runVersion: async () => {
          throw new Error("ENOENT");
        },
      },
    ),
    /Claude Code executable is unavailable for adapter claude/u,
  );
});

test("validates configured sessions only for agents bound to this adapter", async () => {
  const lookups: Array<[string, string | undefined]> = [];
  const checks = await doctorClaudeAdapter(
    configWith({
      mine: {
        adapter: "claude",
        adapter_session_id: "33333333-3333-4333-8333-333333333333",
        workspace: { path: "/tmp/synthetic-a" },
      },
      other: {
        adapter: "codex",
        adapter_session_id: "44444444-4444-4444-8444-444444444444",
        workspace: { path: "/tmp/synthetic-b" },
      },
      unbound: { adapter: "claude", workspace: { path: "/tmp/synthetic-c" } },
    }),
    "claude",
    adapter,
    {
      loadSdk: async () => ({
        getSessionInfo: async (id, options) => {
          lookups.push([id, options?.dir]);
          return { sessionId: id };
        },
      }),
    },
  );
  assert.deepEqual(lookups, [["33333333-3333-4333-8333-333333333333", "/tmp/synthetic-a"]]);
  assert.deepEqual(checks, ["adapter:claude:claude-agent-sdk", "agent:mine:configured-session"]);
});

test("falls back to a project-wide lookup and fails when the session is absent", async () => {
  const lookups: Array<string | undefined> = [];
  const agents = {
    mine: {
      adapter: "claude",
      adapter_session_id: "33333333-3333-4333-8333-333333333333",
      workspace: { path: "/tmp/synthetic-a" },
    },
  };
  const checks = await doctorClaudeAdapter(configWith(agents), "claude", adapter, {
    loadSdk: async () => ({
      getSessionInfo: async (_id, options) => {
        lookups.push(options?.dir);
        return options?.dir === undefined ? { found: true } : undefined;
      },
    }),
  });
  assert.deepEqual(lookups, ["/tmp/synthetic-a", undefined]);
  assert.ok(checks.includes("agent:mine:configured-session"));

  await assert.rejects(
    doctorClaudeAdapter(configWith(agents), "claude", adapter, {
      loadSdk: async () => ({ getSessionInfo: async () => undefined }),
    }),
    /Koe mine Claude session was not found/u,
  );
});
