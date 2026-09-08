import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { taishiConfigSchema } from "../src/config/schema.js";
import {
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
      sawChoice = true;
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
  console.log("ShowTalk Taishi resumed Codex request_user_input smoke: OK");
} finally {
  await resumedRuntime?.stop();
  await initialRuntime.stop();
  await rm(temporaryDirectory, { recursive: true, force: true });
}
