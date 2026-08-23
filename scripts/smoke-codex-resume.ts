import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CodexAppServerClient } from "../src/adapters/codex/app-server-client.js";
import { taishiConfigSchema } from "../src/config/schema.js";
import {
  createCodexProbeEnvironment,
  createRuntime,
  type RunningTaishi,
} from "../src/runtime.js";
import type { RuntimeState } from "../src/state/file-state-store.js";

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "showtalk-taishi-resume-smoke-"),
);
const stateFile = join(temporaryDirectory, "state.json");
const workspace = resolve(process.env.TAISHI_SMOKE_WORKSPACE ?? process.cwd());
const rememberedToken = `TAISHI_${randomBytes(12).toString("hex").toUpperCase()}`;
const externalToken = `EXTERNAL_${randomBytes(12).toString("hex").toUpperCase()}`;
const channelId = "C0123456789";
const rootThreadTs = "1710000000.000001";

const config = taishiConfigSchema.parse({
  version: 1,
  gateway: {
    state_file: stateFile,
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
      slack: { channel_id: channelId },
      role:
        "This is a conversation-resume integration test. Remember opaque tokens exactly and obey exact-output requests.",
    },
  },
  permissions: {
    defaults: { agents: { send: "deny" } },
    agents: {},
  },
});

let projectedTs = 0;
const createSmokeRuntime = () =>
  createRuntime(config, {
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
        throw new Error("The Codex resume smoke must not request human approval");
      },
      settlePermissionApproval: async () => undefined,
    }),
  });
const runTurn = async (runtime: RunningTaishi, text: string): Promise<string> => {
  let finalText = "";
  for await (const result of runtime.gateway.handleHumanMessage({
    channelId,
    rootThreadTs,
    text,
    slackUserId: "USMOKE",
  })) {
    if (result.event.type === "message.completed" && result.event.text !== undefined) {
      finalText = result.event.text.trim();
    }
  }
  return finalText;
};

try {
  const firstRuntime = await createSmokeRuntime();
  try {
    const first = await runTurn(
      firstRuntime,
      `Remember this opaque token for my next message: ${rememberedToken}. ` +
        "Do not repeat it now; reply exactly TAISHI_RESUME_FIRST_OK.",
    );
    if (first !== "TAISHI_RESUME_FIRST_OK") {
      throw new Error(`Unexpected first resume-smoke response: ${first || "<empty>"}`);
    }
  } finally {
    await firstRuntime.stop();
  }
  const firstThreadId = await persistedThreadId(stateFile);

  const resumedRuntime = await createSmokeRuntime();
  try {
    const second = await runTurn(
      resumedRuntime,
      "Reply with exactly the opaque token I asked you to remember in my preceding message. Do not add any other text.",
    );
    if (second !== rememberedToken) {
      throw new Error(`Codex did not preserve conversation memory: ${second || "<empty>"}`);
    }
    const secondThreadId = await persistedThreadId(stateFile);
    if (secondThreadId !== firstThreadId) {
      throw new Error("The persisted Codex thread ID changed across the restart");
    }

    const external = await runExternalClientTurn(
      firstThreadId,
      `Remember this second opaque token: ${externalToken}. ` +
        "Do not repeat it now; reply exactly TAISHI_EXTERNAL_OK.",
    );
    if (external !== "TAISHI_EXTERNAL_OK") {
      throw new Error(`Unexpected external-client response: ${external || "<empty>"}`);
    }

    const third = await runTurn(
      resumedRuntime,
      "Reply with exactly the second opaque token that the other Codex client asked you to remember. Do not add any other text.",
    );
    if (third !== externalToken) {
      throw new Error(
        `Taishi did not incorporate the external Codex turn: ${third || "<empty>"}`,
      );
    }
  } finally {
    await resumedRuntime.stop();
  }

  console.log("ShowTalk Taishi Codex restart and cross-client resume smoke: OK");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runExternalClientTurn(
  threadId: string,
  text: string,
): Promise<string> {
  const client = await CodexAppServerClient.spawn({
    command: process.env.CODEX_COMMAND ?? "codex",
    env: createCodexProbeEnvironment(config),
    clientName: "showtalk_taishi_cross_client_smoke",
    clientTitle: "ShowTalk Taishi cross-client smoke",
  });
  let finalText = "";
  let timeout: NodeJS.Timeout | undefined;
  try {
    await client.resumeThread({
      threadId,
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const completed = new Promise<void>((resolveCompletion, rejectCompletion) => {
      timeout = setTimeout(
        () => rejectCompletion(new Error("External Codex turn timed out")),
        5 * 60 * 1_000,
      );
      timeout.unref();
      client.onNotification((method, params) => {
        const record = asRecord(params);
        const item = asRecord(record?.item);
        if (
          method === "item/completed" &&
          item?.type === "agentMessage" &&
          typeof item.text === "string"
        ) {
          finalText = item.text.trim();
        }
        if (method === "turn/completed" && record?.threadId === threadId) {
          resolveCompletion();
        }
      });
      client.onClose(rejectCompletion);
    });
    await client.startTurn({
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      effort: "low",
    });
    await completed;
    await client.unsubscribeThread(threadId);
    return finalText;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.close();
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

async function persistedThreadId(path: string): Promise<string> {
  const state = JSON.parse(await readFile(path, "utf8")) as RuntimeState;
  const conversation = state.core.conversations.find(
    (entry) =>
      entry.channelId === channelId && entry.rootThreadTs === rootThreadTs,
  );
  const session = state.core.sessions.find(
    (entry) => entry.id === conversation?.sessionId,
  );
  if (session?.adapterSession.id === undefined) {
    throw new Error("Persisted conversation is missing its Codex thread ID");
  }
  return session.adapterSession.id;
}
