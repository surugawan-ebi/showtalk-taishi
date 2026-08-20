import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  AuthenticatedMcpHttpServer,
  MCP_SERVER_INSTRUCTIONS,
  McpServiceError,
  type AgentMcpCredential,
  type McpCallerContext,
  type McpSlackAttachmentInput,
  type SwitchboardMcpService,
} from "../../src/mcp/index.js";

function service(
  overrides: Partial<SwitchboardMcpService> = {},
): SwitchboardMcpService {
  const base: SwitchboardMcpService = {
    isKnownAgent: (agentId) => agentId === "implementer" || agentId === "reviewer",
    agentList: () => ({
      agents: [
        { id: "implementer", adapter: "codex", channel: "C01", status: "running" },
        { id: "reviewer", adapter: "codex", channel: "C02", status: "idle" },
      ],
    }),
    agentStatus: (_context, target) => ({ agent_id: target, status: "idle" }),
    agentSend: (_context, target) => ({ target, status: "completed" }),
    gatewayRestart: () => ({ status: "scheduled" }),
    slackPost: (_context, channel) => ({ channel, ts: "1710000000.000001" }),
    slackReply: (_context, channel, threadTs) => ({
      channel,
      ts: "1710000000.000002",
      thread_ts: threadTs,
    }),
  };
  return { ...base, ...overrides };
}

async function runningBoundary(
  t: TestContext,
  implementation: SwitchboardMcpService = service(),
  options: ConstructorParameters<typeof AuthenticatedMcpHttpServer>[1] = {},
): Promise<AuthenticatedMcpHttpServer> {
  const boundary = new AuthenticatedMcpHttpServer(implementation, options);
  await boundary.start();
  t.after(async () => boundary.close());
  return boundary;
}

async function connectedClient(
  t: TestContext,
  credential: AgentMcpCredential,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(credential.url), {
    requestInit: {
      headers: { Authorization: `Bearer ${credential.token}` },
    },
  });
  const client = new Client({ name: "showtalk-taishi-test", version: "1.0.0" });
  await client.connect(transport as unknown as Transport);
  t.after(async () => client.close());
  return client;
}

test("binds only to loopback on an ephemeral port and reuses an immutable credential", async (t) => {
  const boundary = await runningBoundary(t);
  const endpoint = boundary.endpoint;
  assert.ok(endpoint);
  assert.equal(endpoint.host, "127.0.0.1");
  assert.ok(endpoint.port > 0);
  assert.equal(endpoint.path, "/mcp");
  assert.equal(endpoint.url, `http://127.0.0.1:${endpoint.port}/mcp`);

  const first = await boundary.provisionAgent("implementer");
  const second = await boundary.provisionAgent("implementer");
  const reviewer = await boundary.provisionAgent("reviewer");
  assert.strictEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first.token, reviewer.token);
  assert.equal(first.url, endpoint.url);

  await assert.rejects(boundary.provisionAgent("missing"), /unknown Agent/u);
  await assert.rejects(boundary.provisionAgent(" caller "));
});

test("drains accepted MCP responses before becoming idle and rejects new HTTP work", async (t) => {
  let entered!: () => void;
  const requestEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const requestRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const boundary = await runningBoundary(
    t,
    service({
      gatewayRestart: async () => {
        entered();
        await requestRelease;
        return { status: "scheduled" };
      },
    }),
  );
  const credential = await boundary.provisionAgent("implementer");
  const client = await connectedClient(t, credential);

  const accepted = client.callTool({ name: "gateway.restart", arguments: {} });
  await requestEntered;
  boundary.beginDrain();
  assert.equal(boundary.isIdle(), false);
  let becameIdle = false;
  const idle = boundary.waitForIdle().then(() => {
    becameIdle = true;
  });

  const rejected = await fetch(credential.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(rejected.status, 503);
  assert.equal(becameIdle, false);

  release();
  assert.deepEqual((await accepted).structuredContent, { status: "scheduled" });
  await idle;
  assert.equal(boundary.isIdle(), true);
});

test("rejects the wrong path, method, host origin, and bearer credential before MCP handling", async (t) => {
  const boundary = await runningBoundary(t);
  const credential = await boundary.provisionAgent("implementer");
  const headers = { Authorization: `Bearer ${credential.token}` };

  const missingPath = await fetch(new URL("/not-mcp", credential.url), { headers });
  assert.equal(missingPath.status, 404);

  const queryPath = await fetch(`${credential.url}?caller=reviewer`, { headers });
  assert.equal(queryPath.status, 404);

  const wrongMethod = await fetch(credential.url, { method: "GET", headers });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const missingAuth = await fetch(credential.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingAuth.status, 401);
  assert.match(missingAuth.headers.get("www-authenticate") ?? "", /^Bearer /u);

  const wrongAuth = await fetch(credential.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${"a".repeat(43)}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(wrongAuth.status, 401);

  const browserOrigin = await fetch(credential.url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
    },
    body: "{}",
  });
  assert.equal(browserOrigin.status, 403);
});

test("bounds and validates authenticated HTTP request bodies", async (t) => {
  const boundary = await runningBoundary(t, service(), { maxBodyBytes: 1_024 });
  const credential = await boundary.provisionAgent("implementer");
  const authorization = `Bearer ${credential.token}`;

  const wrongType = await fetch(credential.url, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);

  const malformed = await fetch(credential.url, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const oversized = await fetch(credential.url, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(2_000) }),
  });
  assert.equal(oversized.status, 413);
});

test("serves stateless MCP with the six switchboard tools and explicit routing instructions", async (t) => {
  const calls: Array<{ method: string; caller: string; values: readonly unknown[] }> = [];
  const implementation = service({
    agentList: (context) => {
      calls.push({ method: "agent.list", caller: context.agentId, values: [] });
      return {
        agents: [
          {
            id: "reviewer",
            call_name: "レビュー係",
            status: "idle",
            consultation_scope: "Review implementation changes",
          },
        ],
      };
    },
    agentStatus: (context, target) => {
      calls.push({ method: "agent.status", caller: context.agentId, values: [target] });
      return { agent_id: target, status: "idle", session_id: "session-1" };
    },
    agentSend: (context, target, message) => {
      calls.push({ method: "agent.send", caller: context.agentId, values: [target, message] });
      return {
        target,
        status: "completed",
        message: "Looks good",
        delegation_id: "delegation-1",
      };
    },
    gatewayRestart: (context) => {
      calls.push({ method: "gateway.restart", caller: context.agentId, values: [] });
      return { status: "scheduled" };
    },
    slackPost: (context, channel, message) => {
      calls.push({ method: "slack.post", caller: context.agentId, values: [channel, message] });
      return { channel, ts: "1710000000.000001" };
    },
    slackReply: (context, channel, threadTs, message) => {
      calls.push({
        method: "slack.reply",
        caller: context.agentId,
        values: [channel, threadTs, message],
      });
      return { channel, ts: "1710000000.000002", thread_ts: threadTs };
    },
  });
  const boundary = await runningBoundary(t, implementation);
  const credential = await boundary.provisionAgent("implementer");
  const client = await connectedClient(t, credential);

  assert.equal(client.getInstructions(), MCP_SERVER_INSTRUCTIONS);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    [
      "agent.list",
      "agent.send",
      "agent.status",
      "gateway.restart",
      "slack.post",
      "slack.reply",
    ],
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "agent.send")?.description ?? "",
    /configured consultation target.*visible visit.*not a Codex internal subagent/iu,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "agent.send")?.description ?? "",
    /Never use.*Git approval.*caller Koe/iu,
  );
  assert.match(
    client.getInstructions() ?? "",
    /Git approval UI belongs.*originating Slack turn.*never use agent\.send/iu,
  );
  assert.match(
    client.getInstructions() ?? "",
    /not a Codex internal subagent.*agent\.list.*consultation_scope/iu,
  );
  assert.match(
    client.getInstructions() ?? "",
    /call_name.*one bounded step.*delayed results.*bounded/iu,
  );
  assert.match(client.getInstructions() ?? "", /workspace.*images.*audio/iu);
  assert.match(
    tools.tools.find((tool) => tool.name === "slack.post")?.description ?? "",
    /workspace-relative image or audio/u,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "slack.reply")?.description ?? "",
    /workspace-relative image or audio/u,
  );
  assert.match(
    tools.tools.find((tool) => tool.name === "gateway.restart")?.description ?? "",
    /only safe way.*Never use kill or signal.*human explicitly requests/iu,
  );

  const listed = await client.callTool({ name: "agent.list", arguments: {} });
  assert.deepEqual(listed.structuredContent, {
    agents: [
      {
        id: "reviewer",
        call_name: "レビュー係",
        status: "idle",
        consultation_scope: "Review implementation changes",
      },
    ],
  });
  const status = await client.callTool({
    name: "agent.status",
    arguments: { target: "reviewer" },
  });
  assert.deepEqual(status.structuredContent, {
    agent_id: "reviewer",
    status: "idle",
    session_id: "session-1",
  });
  const sent = await client.callTool({
    name: "agent.send",
    arguments: { target: "reviewer", message: "Review this change" },
  });
  assert.equal(sent.isError, undefined);
  assert.deepEqual(sent.structuredContent, {
    target: "reviewer",
    status: "completed",
    message: "Looks good",
    delegation_id: "delegation-1",
  });
  const restarted = await client.callTool({
    name: "gateway.restart",
    arguments: {},
  });
  assert.equal(restarted.isError, undefined);
  assert.deepEqual(restarted.structuredContent, { status: "scheduled" });
  await client.callTool({
    name: "slack.post",
    arguments: { channel: "C02", message: "Review started" },
  });
  await client.callTool({
    name: "slack.reply",
    arguments: {
      channel: "C02",
      thread_ts: "1710000000.000001",
      message: "Review completed",
    },
  });

  assert.deepEqual(
    calls.map(({ method, caller }) => ({ method, caller })),
    [
      { method: "agent.list", caller: "implementer" },
      { method: "agent.status", caller: "implementer" },
      { method: "agent.send", caller: "implementer" },
      { method: "gateway.restart", caller: "implementer" },
      { method: "slack.post", caller: "implementer" },
      { method: "slack.reply", caller: "implementer" },
    ],
  );
});

test("forwards multiple Slack attachments and supports attachment-only replies", async (t) => {
  const calls: Array<{
    readonly method: "slack.post" | "slack.reply";
    readonly channel: string;
    readonly threadTs?: string;
    readonly message?: string | undefined;
    readonly attachments?: readonly McpSlackAttachmentInput[] | undefined;
  }> = [];
  const boundary = await runningBoundary(
    t,
    service({
      slackPost: (context, channel, message, attachments) => {
        assert.equal(context.agentId, "implementer");
        calls.push({ method: "slack.post", channel, message, attachments });
        return {
          channel,
          ts: "1710000000.000010",
          file_ids: ["FIMAGE1", "FAUDIO1"],
        };
      },
      slackReply: (context, channel, threadTs, message, attachments) => {
        assert.equal(context.agentId, "implementer");
        calls.push({
          method: "slack.reply",
          channel,
          threadTs,
          message,
          attachments,
        });
        return {
          channel,
          ts: "1710000000.000011",
          thread_ts: threadTs,
          file_ids: ["FAUDIO2"],
        };
      },
    }),
  );
  const credential = await boundary.provisionAgent("implementer");
  const client = await connectedClient(t, credential);

  const posted = await client.callTool({
    name: "slack.post",
    arguments: {
      channel: "C02",
      message: "Review these files",
      attachments: [
        {
          path: "artifacts/screenshots/result.png",
          title: "Rendered result",
          alt_text: "A rendered application screen",
        },
        { path: "artifacts/audio/summary.m4a", title: "Spoken summary" },
      ],
    },
  });
  assert.equal(posted.isError, undefined);
  assert.deepEqual(posted.structuredContent, {
    channel: "C02",
    ts: "1710000000.000010",
    file_ids: ["FIMAGE1", "FAUDIO1"],
  });

  const replied = await client.callTool({
    name: "slack.reply",
    arguments: {
      channel: "C02",
      thread_ts: "1710000000.000010",
      attachments: [{ path: "artifacts/audio/follow-up.wav", alt_text: "Follow-up audio" }],
    },
  });
  assert.equal(replied.isError, undefined);
  assert.deepEqual(replied.structuredContent, {
    channel: "C02",
    ts: "1710000000.000011",
    thread_ts: "1710000000.000010",
    file_ids: ["FAUDIO2"],
  });

  assert.deepEqual(calls, [
    {
      method: "slack.post",
      channel: "C02",
      message: "Review these files",
      attachments: [
        {
          path: "artifacts/screenshots/result.png",
          title: "Rendered result",
          alt_text: "A rendered application screen",
        },
        { path: "artifacts/audio/summary.m4a", title: "Spoken summary" },
      ],
    },
    {
      method: "slack.reply",
      channel: "C02",
      threadTs: "1710000000.000010",
      message: undefined,
      attachments: [
        { path: "artifacts/audio/follow-up.wav", alt_text: "Follow-up audio" },
      ],
    },
  ]);
});

test("rejects unsafe or excessive Slack attachment inputs before service dispatch", async (t) => {
  let slackCalls = 0;
  const boundary = await runningBoundary(
    t,
    service({
      slackPost: (_context, channel) => {
        slackCalls += 1;
        return { channel, ts: "1710000000.000020" };
      },
    }),
  );
  const credential = await boundary.provisionAgent("implementer");
  const client = await connectedClient(t, credential);

  const invalidPaths = [
    "/tmp/result.png",
    "C:\\temp\\result.png",
    "..\\secret.wav",
    "artifacts/../secret.wav",
    "artifacts//result.png",
    "https://example.com/result.png",
    "data:audio/wav;base64,UklGRg==",
  ];
  for (const path of invalidPaths) {
    const result = await client.callTool({
      name: "slack.post",
      arguments: { channel: "C02", attachments: [{ path }] },
    });
    assert.equal(result.isError, true, `expected rejection for ${path}`);
  }

  const excessive = await client.callTool({
    name: "slack.post",
    arguments: {
      channel: "C02",
      attachments: Array.from({ length: 11 }, (_, index) => ({
        path: `artifacts/image-${index}.png`,
      })),
    },
  });
  assert.equal(excessive.isError, true);

  const empty = await client.callTool({
    name: "slack.post",
    arguments: { channel: "C02" },
  });
  assert.equal(empty.isError, true);

  const emptyAttachments = await client.callTool({
    name: "slack.post",
    arguments: { channel: "C02", attachments: [] },
  });
  assert.equal(emptyAttachments.isError, true);
  assert.equal(slackCalls, 0);
});

test("caller identity is not a tool argument and strict schemas reject spoofing or unbounded input", async (t) => {
  let sendCalls = 0;
  let restartCalls = 0;
  let slackCalls = 0;
  const boundary = await runningBoundary(
    t,
    service({
      agentSend: (_context, target) => {
        sendCalls += 1;
        return { target, status: "completed" };
      },
      gatewayRestart: () => {
        restartCalls += 1;
        return { status: "scheduled" };
      },
      slackPost: (_context, channel) => {
        slackCalls += 1;
        return { channel, ts: "1710000000.000030" };
      },
    }),
  );
  const credential = await boundary.provisionAgent("implementer");
  const client = await connectedClient(t, credential);

  const spoofed = await client.callTool({
    name: "agent.send",
    arguments: {
      target: "reviewer",
      message: "Review",
      caller: "reviewer",
    },
  });
  assert.equal(spoofed.isError, true);

  const oversized = await client.callTool({
    name: "agent.send",
    arguments: { target: "reviewer", message: "x".repeat(32_001) },
  });
  assert.equal(oversized.isError, true);

  const spoofedSlackCall = await client.callTool({
    name: "slack.post",
    arguments: {
      channel: "C02",
      message: "Review",
      caller: "reviewer",
    },
  });
  assert.equal(spoofedSlackCall.isError, true);

  const spoofedRestart = await client.callTool({
    name: "gateway.restart",
    arguments: { caller: "reviewer" },
  });
  assert.equal(spoofedRestart.isError, true);

  const spoofedAttachment = await client.callTool({
    name: "slack.post",
    arguments: {
      channel: "C02",
      attachments: [{ path: "artifacts/result.png", caller: "reviewer" }],
    },
  });
  assert.equal(spoofedAttachment.isError, true);
  assert.equal(sendCalls, 0);
  assert.equal(restartCalls, 0);
  assert.equal(slackCalls, 0);
});

test("concurrent requests keep bearer-bound caller identities isolated", async (t) => {
  const contexts: McpCallerContext[] = [];
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  const implementation = service({
    agentSend: async (context, target) => {
      contexts.push(context);
      arrivals += 1;
      if (arrivals === 2) release();
      await bothArrived;
      return { target, status: "completed", message: context.agentId };
    },
  });
  const boundary = await runningBoundary(t, implementation);
  const implementerCredential = await boundary.provisionAgent("implementer");
  const reviewerCredential = await boundary.provisionAgent("reviewer");
  const implementer = await connectedClient(t, implementerCredential);
  const reviewer = await connectedClient(t, reviewerCredential);

  const [fromImplementer, fromReviewer] = await Promise.all([
    implementer.callTool({
      name: "agent.send",
      arguments: { target: "reviewer", message: "First" },
    }),
    reviewer.callTool({
      name: "agent.send",
      arguments: { target: "implementer", message: "Second" },
    }),
  ]);

  assert.equal(
    (fromImplementer.structuredContent as { message: string }).message,
    "implementer",
  );
  assert.equal(
    (fromReviewer.structuredContent as { message: string }).message,
    "reviewer",
  );
  assert.deepEqual(
    contexts.map((context) => context.agentId).sort(),
    ["implementer", "reviewer"],
  );
  assert.ok(contexts.every((context) => Object.isFrozen(context)));
  assert.notStrictEqual(contexts[0]?.signal, contexts[1]?.signal);
});

test("sanitizes unknown service errors while preserving explicit bounded service errors", async (t) => {
  let exposePublicError = false;
  const boundary = await runningBoundary(
    t,
    service({
      agentStatus: () => {
        if (exposePublicError) throw new McpServiceError("PERMISSION_DENIED", "Human approval denied this request");
        throw new Error("secret diagnostic detail");
      },
    }),
  );
  const credential = await boundary.provisionAgent("implementer");
  const client = await connectedClient(t, credential);

  const internal = await client.callTool({
    name: "agent.status",
    arguments: { target: "reviewer" },
  });
  assert.equal(internal.isError, true);
  const internalJson = JSON.stringify(internal);
  assert.match(internalJson, /SERVICE_ERROR/u);
  assert.doesNotMatch(internalJson, /secret diagnostic/u);

  exposePublicError = true;
  const publicResult = await client.callTool({
    name: "agent.status",
    arguments: { target: "reviewer" },
  });
  assert.equal(publicResult.isError, true);
  assert.match(JSON.stringify(publicResult), /PERMISSION_DENIED.*Human approval denied/u);
});

test("closes idempotently, clears credentials, and stops accepting connections", async () => {
  const boundary = new AuthenticatedMcpHttpServer(service());
  await boundary.start();
  const credential = await boundary.provisionAgent("implementer");

  const firstClose = boundary.close();
  const secondClose = boundary.close();
  assert.strictEqual(firstClose, secondClose);
  await firstClose;
  assert.equal(boundary.endpoint, undefined);
  await assert.rejects(boundary.provisionAgent("implementer"), /must be listening/u);
  await assert.rejects(fetch(credential.url));
});
