import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taishiConfigSchema } from "../src/config/schema.js";
import { createRuntime } from "../src/runtime.js";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "showtalk-taishi-smoke-"));
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
      role: "This is an integration smoke test. Follow the user's exact output request.",
    },
  },
  permissions: {
    defaults: { agents: { send: "deny" } },
    agents: {},
  },
});

let projectedTs = 0;
const runtime = await createRuntime(config, {
  frontendFactory: () => ({
    start: async () => undefined,
    beginRestart: () => undefined,
    isIdle: () => true,
    waitForIdle: async () => undefined,
    stop: async () => undefined,
    postMessage: async () => `${++projectedTs}.000001`,
    reply: async () => `${++projectedTs}.000001`,
    projectDelegation: async () => undefined,
    projectDelegationContinuation: async (_request, events) => {
      for await (const _event of events) {
        // This smoke does not call agent.send.
      }
    },
    presentPermissionApproval: async () => {
      throw new Error("The Codex MCP smoke must not request human approval");
    },
    settlePermissionApproval: async () => undefined,
  }),
});
let sawAgentList = false;
let finalText = "";
try {
  for await (const result of runtime.gateway.handleHumanMessage({
    channelId: "C0123456789",
    rootThreadTs: "1710000000.000001",
    text:
      "Call the showtalk_taishi MCP tool agent.list exactly once. " +
      "If its structured result includes the implementer Koe, reply exactly TAISHI_MCP_OK.",
    slackUserId: "USMOKE",
  })) {
    if (
      result.event.type === "tool.started" &&
      result.event.name === "showtalk_taishi.agent.list"
    ) {
      sawAgentList = true;
    }
    if (result.event.type === "message.completed" && result.event.text !== undefined) {
      finalText = result.event.text.trim();
    }
  }
  if (!sawAgentList) throw new Error("Codex did not call showtalk_taishi.agent.list");
  if (finalText !== "TAISHI_MCP_OK") {
    throw new Error(`Unexpected Codex smoke response: ${finalText || "<empty>"}`);
  }
  console.log("ShowTalk Taishi Codex MCP smoke: OK");
} finally {
  await runtime.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
