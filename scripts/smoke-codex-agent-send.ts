import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DelegationActivity } from "../src/core/index.js";
import { taishiConfigSchema } from "../src/config/schema.js";
import { createRuntime } from "../src/runtime.js";

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "showtalk-taishi-agent-send-smoke-"),
);
const workspace = resolve(process.env.TAISHI_SMOKE_WORKSPACE ?? process.cwd());
const config = taishiConfigSchema.parse({
  version: 1,
  gateway: {
    state_file: join(temporaryDirectory, "state.json"),
    agent_message_max_hops: 2,
  },
  slack: {
    socket_mode: true,
    app_token: "xapp-smoke-not-connected",
    bot_token: "xoxb-smoke-not-connected",
    approver_user_ids: ["USMOKE"],
  },
  adapters: {
    codex: {
      type: "codex-app-server",
      command: process.env.CODEX_COMMAND ?? "codex",
      transport: "stdio",
      reasoning_effort: "low",
      approval_policy: "never",
      sandbox: "read-only",
    },
  },
  agents: {
    implementer: {
      adapter: "codex",
      workspace: { path: workspace },
      slack: { channel_id: "C0123456789" },
      role:
        "This is an integration smoke test. Use ShowTalk Taishi MCP tools exactly as requested.",
    },
    reviewer: {
      adapter: "codex",
      workspace: { path: workspace },
      slack: { channel_id: "C9876543210" },
      role:
        "This is an integration smoke test. When asked for the reviewer token, reply exactly TAISHI_REVIEWER_OK and nothing else.",
    },
  },
  permissions: {
    defaults: { agents: { send: "allow" } },
    agents: {},
  },
});

let projectedTs = 0;
const projected: DelegationActivity[] = [];
const runtime = await createRuntime(config, {
  frontendFactory: () => ({
    start: async () => undefined,
    beginRestart: () => undefined,
    isIdle: () => true,
    waitForIdle: async () => undefined,
    stop: async () => undefined,
    postMessage: async () => `${++projectedTs}.000001`,
    reply: async () => `${++projectedTs}.000001`,
    projectDelegation: async (activity) => {
      projected.push(activity);
    },
    projectDelegationContinuation: async (_request, events) => {
      for await (const _event of events) {
        // Smoke calls normally complete in the originating Slack turn.
      }
    },
    presentPermissionApproval: async () => {
      throw new Error("The Codex agent.send smoke must not request human approval");
    },
  }),
});

let sawAgentSend = false;
let finalText = "";
try {
  for await (const result of runtime.gateway.handleHumanMessage({
    channelId: "C0123456789",
    rootThreadTs: "1710000000.000001",
    text:
      "Call the showtalk_taishi MCP tool agent.send exactly once with target reviewer. " +
      "Ask it to return its reviewer token. If the tool result message is exactly " +
      "TAISHI_REVIEWER_OK, reply exactly TAISHI_AGENT_SEND_OK.",
    slackUserId: "USMOKE",
  })) {
    if (
      result.event.type === "tool.started" &&
      result.event.name === "showtalk_taishi.agent.send"
    ) {
      sawAgentSend = true;
    }
    if (result.event.type === "message.completed" && result.event.text !== undefined) {
      finalText = result.event.text.trim();
    }
  }

  if (!sawAgentSend) throw new Error("Implementer did not call agent.send");
  if (finalText !== "TAISHI_AGENT_SEND_OK") {
    throw new Error(`Unexpected implementer response: ${finalText || "<empty>"}`);
  }
  const started = projected.find(
    (activity) => activity.type === "delegation.started",
  );
  const completed = projected.find(
    (activity) => activity.type === "delegation.completed",
  );
  if (
    started?.sourceAgentId !== "implementer" ||
    started.targetAgentId !== "reviewer" ||
    completed?.delegationId !== started.delegationId
  ) {
    throw new Error("Direct Agent Router activity did not complete as expected");
  }

  console.log("ShowTalk Taishi Codex agent.send smoke: OK");
} finally {
  await runtime.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
