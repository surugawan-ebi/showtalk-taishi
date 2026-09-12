import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import { CodexAppServerClient } from "../src/adapters/codex/app-server-client.js";
import { taishiConfigSchema } from "../src/config/schema.js";
import {
  createCodexProbeEnvironment,
  createRuntime,
  type CreateRuntimeOptions,
} from "../src/runtime.js";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "showtalk-taishi-input-smoke-"));
const channelId = "C0123456789";
const rootThreadTs = "1710000000.000001";
const config = taishiConfigSchema.parse({
  version: 1,
  gateway: { state_file: join(temporaryDirectory, "state.json"), agent_message_max_hops: 2 },
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
      workspace: { path: resolve(process.env.TAISHI_SMOKE_WORKSPACE ?? process.cwd()) },
      slack: { channel_id: channelId },
      role: "This is a request_user_input transport integration smoke. Obey exact output requests and perform no external write.",
    },
  },
  permissions: { defaults: { agents: { send: "deny" } }, agents: {} },
});

let projectedTs = 0;
const runtimeOptions: CreateRuntimeOptions = {
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
      for await (const _event of events) { /* not used */ }
    },
    presentPermissionApproval: async () => {
      throw new Error("The user-input smoke must not request native approval");
    },
    settlePermissionApproval: async () => undefined,
  }),
};

let sawChoice = false;
let finalText = "";
const initialRuntime = await createRuntime(config, runtimeOptions);
let resumedRuntime: Awaited<ReturnType<typeof createRuntime>> | undefined;
try {
  let seedText = "";
  for await (const result of initialRuntime.gateway.handleHumanMessage({
    channelId,
    rootThreadTs,
    slackUserId: "USMOKE",
    text: "Reply with only this token: TAISHI_USER_INPUT_SEEDED",
  })) {
    if (result.event.type === "message.completed" && result.event.text !== undefined) {
      seedText = result.event.text.trim();
    }
  }
  if (seedText !== "TAISHI_USER_INPUT_SEEDED") {
    throw new Error(`Could not seed resumable Codex thread: ${seedText || "<empty>"}`);
  }
  await initialRuntime.stop();
  resumedRuntime = await createRuntime(config, runtimeOptions);

  for await (const result of resumedRuntime.gateway.handleHumanMessage({
    channelId,
    rootThreadTs,
    slackUserId: "USMOKE",
    text: [
      "Ask for the required final confirmation for this non-Git external operation.",
      "The exact operation details are:",
      "Target: isolated request_user_input smoke",
      "Scope: observe the selected label only; perform no external write",
      "Impact: no external state change",
      "After the answer, if and only if it is 承認して実行, reply exactly TAISHI_USER_INPUT_OK.",
      "If the answers object is empty or anything differs, reply exactly TAISHI_USER_INPUT_EMPTY.",
    ].join("\n"),
  })) {
    if (result.event.type === "choice.requested") {
      if (sawChoice) throw new Error("Codex requested the smoke confirmation more than once");
      sawChoice = true;
      // An immediate response can hide a request that loses its blocking
      // lifetime. Leave time for App Server notifications before answering.
      await delay(1_500);
      await resumedRuntime.gateway.resolveSessionUserInput(result.sessionId, {
        requestId: result.event.requestId,
        answer: { questionId: result.event.question.id, optionId: "option_1" },
      });
    }
    if (result.event.type === "message.completed" && result.event.text !== undefined) {
      finalText = result.event.text.trim();
    }
  }
  if (!sawChoice) throw new Error("Codex did not expose request_user_input to the Gateway");
  if (finalText !== "TAISHI_USER_INPUT_OK") {
    throw new Error(`Codex observed the wrong request_user_input result: ${finalText || "<empty>"}`);
  }
  await runMcpElicitationProbe();
  console.log("ShowTalk Taishi resumed Codex interaction approval smoke: OK");
} finally {
  await resumedRuntime?.stop();
  await initialRuntime.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runMcpElicitationProbe(): Promise<void> {
  const workspace = resolve(process.env.TAISHI_SMOKE_WORKSPACE ?? process.cwd());
  const fixture = fileURLToPath(
    new URL("./fixtures/smoke-mcp-elicitation.mjs", import.meta.url),
  );
  const client = await CodexAppServerClient.spawn({
    command: process.env.CODEX_COMMAND ?? "codex",
    cwd: workspace,
    env: createCodexProbeEnvironment(config),
    clientName: "showtalk_taishi_mcp_elicitation_smoke",
    clientTitle: "ShowTalk Taishi MCP elicitation smoke",
  });
  const adapter = new CodexAdapter(client, {
    reasoningEffort: "low",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "read-only",
    threadConfig: {
      mcp_servers: {
        showtalk_approval_probe: {
          command: process.execPath,
          args: [fixture],
          enabled: true,
          required: true,
          startup_timeout_sec: 10,
          tool_timeout_sec: 60,
          default_tools_approval_mode: "prompt",
        },
      },
    },
  });
  let sawApproval = false;
  let sawProbe = false;
  let finalText = "";
  const observedEvents: string[] = [];
  try {
    const session = await adapter.createSession({
      reason: "slack_conversation",
      agent: {
        id: "interaction-smoke",
        adapter: "codex",
        channelId,
        role:
          "This is an isolated read-only MCP elicitation transport smoke. Call only the requested probe tool and obey the exact output request.",
        metadata: { workspacePath: workspace },
      },
    });
    for await (const event of adapter.sendMessage(session, {
      source: { type: "human" },
      text: [
        "Call the showtalk_approval_probe MCP tool approval_probe exactly once.",
        "If it returns MCP_ELICITATION_ACCEPTED, reply exactly TAISHI_MCP_ELICITATION_OK.",
      ].join("\n"),
    })) {
      observedEvents.push(
        event.type === "error" ? `${event.type}:${event.code ?? event.message}` : event.type,
      );
      if (event.type === "approval.requested") {
        if (sawApproval) throw new Error("MCP elicitation approval was requested more than once");
        if (!event.summary.includes("MCP tool:")) {
          throw new Error(`Unexpected native approval: ${event.summary}`);
        }
        if (!event.availableDecisions?.includes("allow_once")) {
          throw new Error("MCP elicitation approval did not offer allow_once");
        }
        sawApproval = true;
        await adapter.approve(session, {
          requestId: event.requestId,
          decision: "allow_once",
        });
      }
      if (event.type === "tool.started" && event.name.endsWith("approval_probe")) {
        sawProbe = true;
      }
      if (event.type === "message.completed" && event.text !== undefined) {
        finalText = event.text.trim();
      }
    }
  } finally {
    adapter.shutdown();
    await client.close({ reportAsFailure: false });
  }
  if (!sawApproval) {
    throw new Error(
      `Codex did not expose MCP elicitation approval to the adapter; events=${observedEvents.join(",")}; final=${finalText || "<empty>"}`,
    );
  }
  if (!sawProbe) throw new Error("Codex did not call the MCP elicitation probe");
  if (finalText !== "TAISHI_MCP_ELICITATION_OK") {
    throw new Error(`Unexpected MCP elicitation smoke response: ${finalText || "<empty>"}`);
  }
}
