import { resolve } from "node:path";

import { CodexAdapter } from "../src/adapters/codex/adapter.js";
import { CodexAppServerClient } from
  "../src/adapters/codex/app-server-client.js";
import {
  APPOPS_APPROVAL_HOOK_MCP_URL_ENV,
  APPOPS_APPROVAL_HOOK_PATH_ENV,
  buildAppOpsApprovalHookConfig,
  buildCodexMcpThreadConfig,
} from
  "../src/adapters/codex/mcp-config.js";
import {
  AppOpsApprovalProofBroker,
  createEphemeralAppOpsApprovalProofSigner,
} from "../src/approvals/appops-approval-proof.js";
import {
  InMemoryAgentRegistry,
  type AgentEvent,
} from "../src/core/index.js";
import {
  AuthenticatedMcpHttpServer,
  RuntimeMcpService,
} from "../src/mcp/index.js";
import { PermissionApprovalCoordinator } from
  "../src/permissions/approval-coordinator.js";
import { PermissionEngine } from "../src/permissions/engine.js";

const broker = new AppOpsApprovalProofBroker();
const repositoryRoot = resolve(process.cwd());
if (
  JSON.stringify(buildAppOpsApprovalHookConfig()) !==
    JSON.stringify((await import("../.codex/hooks.json", {
      with: { type: "json" },
    })).default)
) {
  throw new Error("The installed project hook differs from the runtime hook contract");
}
const signer = createEphemeralAppOpsApprovalProofSigner();
let issuedProof: string | undefined;
const observingSigner = {
  keyId: signer.keyId,
  publicKeyPem: signer.publicKeyPem,
  issue: (...args: Parameters<typeof signer.issue>) => {
    const proof = signer.issue(...args);
    issuedProof = proof;
    return proof;
  },
};

const registry = new InMemoryAgentRegistry();
registry.registerAgent({
  id: "implementer",
  adapter: "codex",
  channelId: "C0123456789",
  metadata: { workspacePath: repositoryRoot },
});
const permissions = new PermissionEngine(
  {
    defaults: {
      agents: { send: "deny" },
      slack: {
        own_channel: { write: "deny" },
        agent_channels: { write: "deny" },
        other_channels: { write: "deny" },
      },
    },
    agents: {},
  },
  {
    implementer: { slack: { channel_id: "C0123456789" } },
  },
);
const service = new RuntimeMcpService(
  registry,
  permissions,
  new PermissionApprovalCoordinator(),
  { appOpsApprovalProofBroker: broker },
);
const boundary = new AuthenticatedMcpHttpServer(service);
let client: CodexAppServerClient | undefined;
const hookNotifications: Array<{
  readonly method: string;
  readonly status?: string;
  readonly handlerType?: string;
  readonly source?: string;
}> = [];
try {
  await boundary.start();
  const credential = await boundary.provisionAgent("implementer");
  const baseConfig = buildCodexMcpThreadConfig(
    {
      url: credential.url,
      bearerTokenEnvVar: "SHOWTALK_TAISHI_MCP_TOKEN",
    },
    {
      publicKeyPem: signer.publicKeyPem,
      keyId: signer.keyId,
    },
  );
  const baseServers = baseConfig.mcp_servers as Record<string, unknown>;
  const appOpsServer = {
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          resolve(repositoryRoot, "scripts/fixtures/fake-appops-mcp.ts"),
        ],
        env: {
          APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY: signer.publicKeyPem,
          APP_OPS_SHOWTALK_APPROVAL_KEY_ID: signer.keyId,
        },
        enabled: true,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 30,
        default_tools_approval_mode: "approve",
        tools: {
          prepare_app_store_version_setup: { approval_mode: "approve" },
          execute_approved_app_store_version_setup: {
            approval_mode: "approve",
          },
        },
  };
  client = await CodexAppServerClient.spawn({
    command: process.env.CODEX_COMMAND ?? "codex",
    env: {
      ...process.env,
      SHOWTALK_TAISHI_MCP_TOKEN: credential.token,
      APP_OPS_SHOWTALK_APPROVAL_KEY_ID: signer.keyId,
      APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY: signer.publicKeyPem,
      [APPOPS_APPROVAL_HOOK_MCP_URL_ENV]: credential.url,
      [APPOPS_APPROVAL_HOOK_PATH_ENV]: resolve(
        repositoryRoot,
        "dist/hooks/appops-approval-pre-tool-use.js",
      ),
    },
  });
  client.onNotification((method, params) => {
    if (method !== "hook/started" && method !== "hook/completed") return;
    const outer = asRecord(params);
    const run = asRecord(outer?.run);
    hookNotifications.push({
      method,
      ...(typeof run?.status === "string" ? { status: run.status } : {}),
      ...(typeof run?.handlerType === "string"
        ? { handlerType: run.handlerType }
        : {}),
      ...(typeof run?.source === "string" ? { source: run.source } : {}),
    });
  });
  const hookListing = await client.request<unknown>("hooks/list", {
    cwds: [repositoryRoot],
  });
  const hookStates = selectAppOpsHookStates(hookListing, repositoryRoot);
  const threadConfig = {
    ...baseConfig,
    hooks: {
      state: hookStates,
    },
    mcp_servers: {
      ...baseServers,
      appops: appOpsServer,
    },
  };
  const adapter = new CodexAdapter(client, {
    koeId: "implementer",
    reasoningEffort: "low",
    approvalPolicy: "never",
    sandbox: "read-only",
    threadConfig,
    appOpsApprovalProofSigner: observingSigner,
    appOpsApprovalProofBroker: broker,
  });
  const session = await adapter.createSession({
    reason: "manual",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C0123456789",
      role:
        "This is an isolated AppOps approval-proof transport smoke. " +
        "Use only the synthetic appops MCP and direct request_user_input. " +
        "Never print or describe approval_proof.",
      metadata: { workspacePath: repositoryRoot },
    },
  });
  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage(session, {
    source: { type: "human", slackUserId: "USMOKE" },
    text: [
      "Call appops.prepare_app_store_version_setup once with app_id app07-smoke.",
      "Copy its approval_prompt exactly into one direct blocking request_user_input question with ID external_action_approval and the required fixed two choices.",
      "After approval, call appops.execute_approved_app_store_version_setup with the exact app_id and operation_id, omitting approval_proof because the runtime hook supplies it.",
      "Then repeat that same execute call once; it must be denied as a replay.",
      "Never print, quote, summarize, or otherwise expose approval_proof.",
      "Finish with exactly TAISHI_APPOPS_HOOK_OK if the first execute completed and the replay was denied; otherwise TAISHI_APPOPS_HOOK_FAILED.",
    ].join("\n"),
  })) {
    events.push(event);
    if (event.type === "choice.requested") {
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        answer: { questionId: event.question.id, optionId: "option_1" },
      });
    }
  }

  const finalText = [...events].reverse().find(
    (event) => event.type === "message.completed" && event.text !== undefined,
  );
  const completedExecute = events.find(
    (event) =>
      event.type === "tool.completed" &&
      event.isError !== true &&
      containsSyntheticExecuteSuccess(event.output),
  );
  const executeStartIds = new Set(events.flatMap((event) =>
    event.type === "tool.started" &&
      event.name === "appops.execute_approved_app_store_version_setup"
      ? [event.toolCallId]
      : []
  ));
  const blockedReplay = hookNotifications.some(
    (notification) =>
      notification.method === "hook/completed" &&
      notification.handlerType === "command" &&
      notification.status === "blocked",
  );
  if (
    completedExecute === undefined ||
    executeStartIds.size !== 1 ||
    !blockedReplay
  ) {
    const startedTools = events.flatMap((event) =>
      event.type === "tool.started" ? [event.name] : []
    );
    const choiceCount = events.filter(
      (event) => event.type === "choice.requested",
    ).length;
    const errorCodes = events.flatMap((event) =>
      event.type === "error" && event.code !== undefined ? [event.code] : []
    );
    const completionSummary = events.flatMap((event) =>
      event.type === "tool.completed"
        ? [{
            error: event.isError === true,
            categories: classifyFailure(event.output),
          }]
        : []
    );
    throw new Error(
      "Synthetic AppOps did not receive exactly one valid proof; " +
      `started_tools=${JSON.stringify(startedTools)} ` +
      `execute_start_count=${executeStartIds.size} ` +
      `execute_success=${completedExecute !== undefined} ` +
      `replay_blocked=${blockedReplay} ` +
      `choice_count=${choiceCount} ` +
      `error_codes=${JSON.stringify(errorCodes)} ` +
      `completion_summary=${JSON.stringify(completionSummary)} ` +
      `hook_notifications=${JSON.stringify(hookNotifications)}`,
    );
  }
  if (
    finalText?.type !== "message.completed" ||
    !finalText.text?.includes("TAISHI_APPOPS_HOOK_OK") ||
    finalText.text.includes("TAISHI_APPOPS_HOOK_FAILED")
  ) {
    throw new Error("Codex did not observe the expected one-shot hook outcome");
  }
  if (
    issuedProof === undefined ||
    JSON.stringify(events).includes(issuedProof) ||
    finalText.text.includes(issuedProof)
  ) {
    throw new Error("The AppOps proof was absent or leaked into an Agent event");
  }
  console.log("ShowTalk Taishi Codex AppOps PreToolUse smoke: OK");
} finally {
  await client?.close({ reportAsFailure: false }).catch(() => undefined);
  await boundary.close().catch(() => undefined);
}

function containsSyntheticExecuteSuccess(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSyntheticExecuteSuccess);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (
    record.status === "completed" &&
    record.synthetic === true &&
    record.valid_proof === true &&
    record.execute_count === 1
  ) {
    return true;
  }
  return Object.values(record).some(containsSyntheticExecuteSuccess);
}

function classifyFailure(value: unknown): string[] {
  const text = JSON.stringify(value ?? "").toLowerCase();
  const patterns: ReadonlyArray<readonly [string, RegExp]> = [
    ["approval", /approval/u],
    ["hook", /hook/u],
    ["denied", /denied|declined/u],
    ["not_found", /not found/u],
    ["invalid", /invalid/u],
    ["timeout", /timeout/u],
    ["connection", /connection|closed/u],
    ["schema", /schema/u],
    ["permission", /permission/u],
    ["server", /server/u],
    ["mcp", /mcp/u],
    ["structured", /structured/u],
    ["sandbox", /sandbox|read-only/u],
    ["untrusted", /untrusted|trust/u],
    ["error", /error/u],
  ];
  return patterns.flatMap(([label, pattern]) => pattern.test(text) ? [label] : []);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function selectAppOpsHookStates(
  listing: unknown,
  cwd: string,
): Readonly<Record<string, {
  readonly enabled: boolean;
  readonly trusted_hash?: string;
}>> {
  const data = asRecord(listing)?.data;
  if (!Array.isArray(data)) throw new Error("Codex hooks/list returned no data");
  const matches = data.flatMap((entry) => {
    const record = asRecord(entry);
    if (record?.cwd !== cwd || !Array.isArray(record.hooks)) return [];
    return record.hooks.flatMap((hook) => {
      const metadata = asRecord(hook);
      return metadata?.handlerType === "command" &&
          metadata.command ===
            "node \"$SHOWTALK_TAISHI_APPOPS_HOOK_PATH\"" &&
          typeof metadata.key === "string" &&
          typeof metadata.currentHash === "string" &&
          (metadata.source === "project" || metadata.source === "user")
        ? [{
            key: metadata.key,
            currentHash: metadata.currentHash,
            source: metadata.source,
            trustStatus: metadata.trustStatus,
          }]
        : [];
    });
  });
  const trustedUserHooks = matches.filter(
    (hook) => hook.source === "user" && hook.trustStatus === "trusted",
  );
  const projectHooks = matches.filter((hook) => hook.source === "project");
  if (trustedUserHooks.length > 1 || projectHooks.length !== 1) {
    const summary = data.flatMap((entry) => {
      const record = asRecord(entry);
      if (!Array.isArray(record?.hooks)) return [];
      return record.hooks.flatMap((hook) => {
        const metadata = asRecord(hook);
        return metadata === undefined
          ? []
          : [{
              handlerType: metadata.handlerType,
              source: metadata.source,
              trustStatus: metadata.trustStatus,
              server: metadata.server,
              tool: metadata.tool,
            }];
      });
    });
    throw new Error(
      "Codex did not discover one unambiguous AppOps hook; " +
      `hook_summary=${JSON.stringify(summary)}`,
    );
  }
  const trustedUserHook = trustedUserHooks[0];
  if (trustedUserHook !== undefined) {
    return Object.fromEntries([
      [trustedUserHook.key, {
        enabled: true,
        trusted_hash: trustedUserHook.currentHash,
      }],
      ...projectHooks.map((hook) => [hook.key, {
        enabled: true,
        trusted_hash: hook.currentHash,
      }] as const),
    ]);
  }
  const projectHook = projectHooks[0]!;
  return {
    [projectHook.key]: {
      enabled: true,
      trusted_hash: projectHook.currentHash,
    },
  };
}
