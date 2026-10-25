import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServerClient,
  type AppServerTransport,
  type CodexAppServerClientOptions,
} from "../src/adapters/codex/app-server-client.js";
import { LocalAdminServer, type AdminConfigPort } from "../src/admin/server.js";
import type { AdminConfigSnapshot, AdminConfigUpdate } from "../src/admin/config-repository.js";
import { taishiConfigSchema } from "../src/config/schema.js";
import { createRuntime, type TaishiFrontend } from "../src/runtime.js";

class RecordingTransport implements AppServerTransport {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  readonly requests: Array<{ id?: number; method: string; params?: unknown }> = [];

  drain(): Array<{ id?: number; method: string; params?: unknown }> {
    const raw = String(this.output.read()?.toString("utf8") ?? "");
    const messages = raw.trim().split("\n").filter(Boolean).map((line) =>
      JSON.parse(line) as { id?: number; method: string; params?: unknown }
    );
    this.requests.push(...messages);
    return messages;
  }

  async close(): Promise<void> {
    this.input.end();
    this.output.end();
  }
}

async function createObservedClient(
  options: CodexAppServerClientOptions,
  workspace: string,
  existingStatus: boolean,
): Promise<{ client: CodexAppServerClient; transport: RecordingTransport }> {
  const transport = new RecordingTransport();
  const client = new CodexAppServerClient(transport, options);
  const starting = client.start();
  await tick();
  const initialize = transport.drain().at(-1);
  transport.input.write(`${JSON.stringify({ id: initialize?.id, result: {} })}\n`);
  await starting;
  transport.drain();

  const threadStart = client.startThread({ cwd: workspace });
  await tick();
  const startRequest = transport.drain().at(-1);
  transport.input.write(`${JSON.stringify({
    id: startRequest?.id,
    result: { thread: { id: "private-thread-id" } },
  })}\n`);
  await threadStart;
  await tick();
  assert.deepEqual(transport.drain(), [], "lifecycle issued a diagnostic RPC");
  if (!existingStatus) return { client, transport };
  const statusPending = client.request("mcpServerStatus/list", {
    limit: 1_000, detail: "toolsAndAuthOnly", threadId: "private-thread-id",
  });
  await tick();
  const statusRequest = transport.drain().at(-1);
  assert.equal(statusRequest?.method, "mcpServerStatus/list");
  transport.input.write(`${JSON.stringify({
    id: statusRequest?.id,
    result: {
      data: [{
        name: "workspace-git",
        runtimeStatus: "connected",
        pluginId: "private-plugin-id",
        serverInfo: { token: "private-token" },
        tools: { list_repositories: { description: "private-description" } },
        resources: [],
        resourceTemplates: [],
        authStatus: "bearerToken",
      }],
      nextCursor: null,
    },
  })}\n`);
  await statusPending;
  await tick();
  return { client, transport };
}

async function assertRuntimeSnapshot(existingStatus: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "showtalk-local-mcp-correlation-"));
  const localChannel = "C0LOCALMCP";
  const accessToken = "a".repeat(43);
  const clients: CodexAppServerClient[] = [];
  const transports: RecordingTransport[] = [];
  const config = taishiConfigSchema.parse({
    version: 1,
    gateway: { state_file: join(root, "state.json") },
    slack: {
      socket_mode: true,
      app_token: "xapp-test",
      bot_token: "xoxb-test",
      approver_user_ids: ["U1"],
    },
    adapters: {
      codex: { type: "codex-app-server", command: "unused", transport: "stdio" },
    },
    agents: {
      "local-mcp": {
        adapter: "codex",
        workspace: { path: root },
        slack: { channel_id: localChannel },
        role: "Local MCP",
      },
      other: {
        adapter: "codex",
        workspace: { path: root },
        slack: { channel_id: "C0OTHER" },
        role: "Other",
      },
    },
    permissions: { defaults: {}, agents: {} },
  });
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  let admin: LocalAdminServer | undefined;
  try {
    runtime = await createRuntime(config, {
      appServerClientFactory: async (options) => {
        const observed = await createObservedClient(options, root, existingStatus);
        clients.push(observed.client);
        transports.push(observed.transport);
        return observed.client;
      },
      frontendFactory: () => inertFrontend(),
    });
    admin = new LocalAdminServer({
      port: 0,
      accessToken,
      repository: memoryRepository(),
      localMcpCorrelation: {
        read: (request) => runtime!.readLocalMcpCorrelationSnapshot(request),
      },
      onRestartRequested: () => undefined,
    });
    const baseUrl = await admin.start();
    const route = (agentId: string, channelId: string) =>
      `${baseUrl}api/agents/${agentId}/channels/${channelId}/diagnostics/local-mcp-correlation`;
    const rpcCount = transports.reduce((total, transport) => total + transport.requests.length, 0);

    const unauthenticated = await fetch(route("local-mcp", localChannel));
    assert.equal(unauthenticated.status, 401);
    for (const [agentId, channelId] of [
      ["local-mcp", "C0WRONG"],
      ["other", "C0OTHER"],
    ]) {
      const denied = await fetch(route(agentId!, channelId!), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: "Insufficient diagnostic evidence." });
    }

    const accepted = await fetch(route("local-mcp", localChannel), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(accepted.status, 200);
    const report = await accepted.json();
    assert.deepEqual(report, {
      entries: [
        ...(existingStatus ? [{
          registered_name: "workspace-git",
          runtime_status: "connected",
          classification: "success",
          target_match: "yes",
        }] : []),
        {
          registered_name: "workspace-git",
          runtime_status: existingStatus ? "connected" : null,
          classification: "caller_callable",
          target_match: "insufficient_evidence",
        },
      ],
    });
    const serialized = JSON.stringify(report);
    for (const secret of [
      localChannel,
      "private-thread-id",
      "private-plugin-id",
      "private-token",
      "private-description",
      accessToken,
    ]) assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);

    const cached = await fetch(route("local-mcp", localChannel), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(cached.status, 200);
    assert.deepEqual(await cached.json(), report);
    assert.equal(
      transports.reduce((total, transport) => total + transport.requests.length, 0),
      rpcCount,
      "admin reads must not issue App Server RPCs",
    );
  } finally {
    await admin?.stop();
    await runtime?.stop();
    await Promise.all(clients.map((client) => client.close({ reportAsFailure: false })));
    await rm(root, { recursive: true, force: true });
  }
}

for (const existingStatus of [false, true]) {
  test(`runtime snapshot preserves ${existingStatus ? "received status" : "unobserved status"} without diagnostic RPCs`, async () => {
    await assertRuntimeSnapshot(existingStatus);
  });
}

function inertFrontend(): TaishiFrontend {
  return {
    start: async () => undefined,
    beginRestart: () => undefined,
    isIdle: () => true,
    waitForIdle: async () => undefined,
    stop: async () => undefined,
    postMessage: async () => "1.0",
    reply: async () => "1.0",
    projectDelegation: async () => undefined,
    projectDelegationContinuation: async () => undefined,
    presentPermissionApproval: async () => undefined,
    settlePermissionApproval: async () => undefined,
  };
}

function memoryRepository(): AdminConfigPort {
  const snapshot: AdminConfigSnapshot = {
    revision: "b".repeat(64),
    available_adapters: ["codex"],
    agents: [],
  };
  return {
    read: async () => snapshot,
    save: async (_update: AdminConfigUpdate) => snapshot,
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
