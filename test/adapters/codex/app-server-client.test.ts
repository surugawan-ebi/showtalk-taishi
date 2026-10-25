import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServerClient,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  resolveCodexAppServerArgs,
  type CodexAppServerDiagnosticEvent,
  type AppServerTransport,
} from "../../../src/adapters/codex/app-server-client.js";
import { CodexRpcError } from "../../../src/adapters/codex/protocol.js";

class TestTransport implements AppServerTransport {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  closed = false;

  async close(): Promise<void> {
    this.closed = true;
    this.input.end();
    this.output.end();
  }

  readOutput(): string[] {
    const data = this.output.read()?.toString("utf8") ?? "";
    return data.trim().split("\n").filter(Boolean);
  }
}

test("uses plain app-server args while thread config controls code mode", () => {
  assert.deepEqual(DEFAULT_CODEX_APP_SERVER_ARGS, ["app-server"]);
  assert.equal(Object.isFrozen(DEFAULT_CODEX_APP_SERVER_ARGS), true);
  assert.deepEqual(resolveCodexAppServerArgs(), ["app-server"]);

  const explicit = ["app-server", "--listen", "stdio://"];
  assert.deepEqual(resolveCodexAppServerArgs(explicit), explicit);
  assert.deepEqual(explicit, ["app-server", "--listen", "stdio://"]);
});

class DelayedCloseTransport extends TestTransport {
  readonly closeStarted: Promise<void>;
  #markCloseStarted!: () => void;
  #releaseClose!: () => void;
  readonly #closeReleased: Promise<void>;
  closeCalls = 0;

  constructor() {
    super();
    this.closeStarted = new Promise((resolve) => {
      this.#markCloseStarted = resolve;
    });
    this.#closeReleased = new Promise((resolve) => {
      this.#releaseClose = resolve;
    });
  }

  override async close(): Promise<void> {
    this.closeCalls += 1;
    this.#markCloseStarted();
    await this.#closeReleased;
    await super.close();
  }

  releaseClose(): void {
    this.#releaseClose();
  }
}

async function connectClient(): Promise<{
  client: CodexAppServerClient;
  transport: TestTransport;
}> {
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport);
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  return { client, transport };
}

test("performs initialize handshake before normal requests", async () => {
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport);
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));

  const [rawInitialize] = transport.readOutput();
  const initialize = JSON.parse(rawInitialize ?? "null") as {
    id: number;
    method: string;
    params: { clientInfo: { name: string } };
  };
  assert.equal(initialize.method, "initialize");
  assert.equal(initialize.params.clientInfo.name, "showtalk_taishi");
  assert.deepEqual(
    (initialize.params as unknown as Record<string, unknown>).capabilities,
    { experimentalApi: true, requestAttestation: false },
  );

  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;

  const [rawInitialized] = transport.readOutput();
  assert.deepEqual(JSON.parse(rawInitialized ?? "null"), {
    method: "initialized",
    params: {},
  });
  await client.close();
});

test("records thread/start without issuing a diagnostic status request", async () => {
  const diagnostics: CodexAppServerDiagnosticEvent[] = [];
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport, {
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  transport.readOutput();
  const pending = client.startThread({ cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  const requests = transport.readOutput();
  assert.equal(requests.length, 1);
  const request = JSON.parse(requests[0] ?? "null") as { id: number; method: string };
  assert.equal(request.method, "thread/start");
  transport.input.write(`${JSON.stringify({
    id: request.id,
    result: { thread: { id: "thread-secret" } },
  })}\n`);
  assert.equal((await pending).id, "thread-secret");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(transport.readOutput(), [], "diagnostics sent an extra RPC");
  assert.deepEqual(diagnostics.map((event) => [event.stage, event.outcome]), [
    ["initialize_sent", "sent"],
    ["initialize_response", "response"],
    ["initialized_notification", "sent"],
    ["thread_start_sent", "sent"],
    ["thread_start_response", "response"],
  ]);
  assert.deepEqual(client.getDiagnosticSnapshot(), {
    spawn: "not_observed",
    initialize: "responded",
    initializedNotification: "sent",
    threadStart: {
      state: "responded",
      cwd: "absolute",
      configKeyNames: [],
      configuredMcpRegistrationNames: [],
    },
  });
  assert.equal(JSON.stringify(diagnostics).includes("thread-secret"), false);
  await client.close();
});

test("records successful thread/resume using the existing request and hides identifiers", async () => {
  const diagnostics: CodexAppServerDiagnosticEvent[] = [];
  const diagnosticTransport = new TestTransport();
  const diagnosticClient = new CodexAppServerClient(diagnosticTransport, {
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const starting = diagnosticClient.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(diagnosticTransport.readOutput()[0] ?? "null") as { id: number };
  diagnosticTransport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  diagnosticTransport.readOutput();

  const pending = diagnosticClient.resumeThread({
    threadId: "thread-secret",
    cwd: "relative-workspace",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const requests = diagnosticTransport.readOutput();
  assert.equal(requests.length, 1);
  const request = JSON.parse(requests[0] ?? "null") as { id: number; method: string };
  assert.equal(request.method, "thread/resume");
  diagnosticTransport.input.write(
    `${JSON.stringify({ id: request.id, result: { thread: { id: "thread-secret" } } })}\n`,
  );
  await pending;

  assert.deepEqual(diagnosticTransport.readOutput(), [], "resume sent an extra RPC");

  const resumeDiagnostics = diagnostics.filter((event) =>
    event.stage.startsWith("thread_resume")
  );
  assert.deepEqual(resumeDiagnostics.map((event) => [event.stage, event.outcome]), [
    ["thread_resume_sent", "sent"],
    ["thread_resume_response", "response"],
  ]);
  assert.equal(JSON.stringify(resumeDiagnostics).includes("thread-secret"), false);
  assert.equal(diagnosticClient.getDiagnosticSnapshot().threadResume?.cwd, "relative");
  assert.equal(diagnosticClient.getDiagnosticSnapshot().mcpServerStatusList, undefined);
  await diagnosticClient.close();
});

test("records configured and effective MCP names but never secret fields", async () => {
  const diagnostics: CodexAppServerDiagnosticEvent[] = [];
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport, {
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  transport.readOutput();

  const pending = client.startThread({
    config: {
      features: { code_mode: { enabled: false } },
      mcp_servers: {
        safe_registration: {
          url: "https://secret.example.invalid/private",
          bearer_token_env_var: "SECRET_TOKEN_ENV",
          env: { SECRET_TOKEN_ENV: "secret-value" },
          command: "private-command --secret-argument",
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(
    `${JSON.stringify({ id: request.id, result: { thread: { id: "thread-secret" } } })}\n`,
  );
  await pending;
  assert.deepEqual(transport.readOutput(), []);
  const statusPending = client.request("mcpServerStatus/list", {
    limit: 1_000, detail: "toolsAndAuthOnly", threadId: "thread-secret",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const statusRequest = JSON.parse(transport.readOutput()[0] ?? "null") as {
    id: number;
    method: string;
  };
  assert.equal(statusRequest.method, "mcpServerStatus/list");
  transport.input.write(`${JSON.stringify({
    id: statusRequest.id,
    result: {
      data: [{
        name: "effective_registration",
        runtimeStatus: "failed",
        pluginId: "private-plugin-id",
        serverInfo: { title: "private-server-title" },
        tools: { private_tool: {} },
        resources: [{ uri: "https://private-resource.invalid" }],
        resourceTemplates: [],
        authStatus: "oAuth",
      }],
      nextCursor: null,
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  await statusPending;
  const serialized = JSON.stringify(diagnostics);
  assert.match(serialized, /safe_registration/u);
  assert.match(serialized, /effective_registration/u);
  assert.match(serialized, /features/u);
  assert.match(serialized, /mcp_servers/u);
  for (const secret of [
    "secret.example.invalid",
    "SECRET_TOKEN_ENV",
    "secret-value",
    "private-command",
    "secret-argument",
    "thread-secret",
    "private-plugin-id",
    "private-server-title",
    "private_tool",
    "private-resource.invalid",
    "oAuth",
  ]) {
    assert.equal(serialized.includes(secret), false, `diagnostics leaked ${secret}`);
  }
  assert.deepEqual(diagnostics.at(-1), {
    source: "codex_app_server",
    stage: "mcp_server_status_list_response",
    outcome: "response",
    effectiveMcpRegistrations: [
      { name: "effective_registration", status: "failed" },
    ],
    mcpStatusListClassification: "success",
  });
  await client.close();
});

for (const diagnosticCase of [
  {
    name: "classifies unsupported mcpServerStatus/list",
    error: { code: -32601, message: "secret unsupported detail" },
    classification: "api_unsupported",
  },
  {
    name: "classifies other mcpServerStatus/list RPC errors",
    error: { code: -32000, message: "secret RPC detail" },
    classification: "rpc_error",
  },
] as const) {
  test(diagnosticCase.name, async () => {
    const diagnostics: CodexAppServerDiagnosticEvent[] = [];
    const transport = new TestTransport();
    const client = new CodexAppServerClient(transport, {
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const starting = client.start();
    await new Promise((resolve) => setImmediate(resolve));
    const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
    transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
    await starting;
    transport.readOutput();

    const threadPending = client.startThread({ cwd: "/workspace" });
    await new Promise((resolve) => setImmediate(resolve));
    const threadRequest = JSON.parse(transport.readOutput()[0] ?? "null") as {
      id: number;
      method: string;
    };
    assert.equal(threadRequest.method, "thread/start");
    transport.input.write(`${JSON.stringify({
      id: threadRequest.id,
      result: { thread: { id: "private-thread-id" } },
    })}\n`);
    await threadPending;
    assert.deepEqual(transport.readOutput(), []);
    const statusPending = client.request("mcpServerStatus/list", {
      limit: 1_000, detail: "toolsAndAuthOnly", threadId: "private-thread-id",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const requests = transport.readOutput().map((line) =>
      JSON.parse(line) as { id: number; method: string }
    );
    assert.deepEqual(requests.map((request) => request.method), [
      "mcpServerStatus/list",
    ]);
    transport.input.write(`${JSON.stringify({
      id: requests[0]?.id,
      error: diagnosticCase.error,
    })}\n`);
    await assert.rejects(statusPending);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(client.getDiagnosticSnapshot().mcpServerStatusList, {
      classification: diagnosticCase.classification,
      registrations: [],
    });
    const statusDiagnostic = diagnostics.at(-1);
    assert.equal(statusDiagnostic?.mcpStatusListClassification, diagnosticCase.classification);
    assert.equal(JSON.stringify(statusDiagnostic).includes("secret"), false);
    assert.equal(JSON.stringify(statusDiagnostic).includes("private-thread-id"), false);
    await client.close();
  });
}

test("classifies an mcpServerStatus/list timeout without changing thread success", async () => {
  const diagnostics: CodexAppServerDiagnosticEvent[] = [];
  let resolveStatusDiagnostic!: () => void;
  const statusDiagnostic = new Promise<void>((resolve) => {
    resolveStatusDiagnostic = resolve;
  });
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport, {
    requestTimeoutMs: 20,
    onDiagnostic: (event) => {
      diagnostics.push(event);
      if (event.stage === "mcp_server_status_list_response") {
        resolveStatusDiagnostic();
      }
    },
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  transport.readOutput();

  const threadPending = client.resumeThread({ threadId: "private-thread-id" });
  await new Promise((resolve) => setImmediate(resolve));
  const threadRequest = JSON.parse(transport.readOutput()[0] ?? "null") as {
    id: number;
    method: string;
  };
  transport.input.write(`${JSON.stringify({
    id: threadRequest.id,
    result: { thread: { id: "private-thread-id" } },
  })}\n`);
  assert.equal((await threadPending).id, "private-thread-id");
  assert.deepEqual(transport.readOutput(), []);
  const statusPending = client.request("mcpServerStatus/list", {
    limit: 1_000, detail: "toolsAndAuthOnly", threadId: "private-thread-id",
  });
  const statusRejected = assert.rejects(statusPending, /timed out/u);
  await new Promise((resolve) => setImmediate(resolve));
  const statusRequests = transport.readOutput().map((line) =>
    JSON.parse(line) as { method: string }
  );
  assert.deepEqual(statusRequests.map((request) => request.method), [
    "mcpServerStatus/list",
  ]);

  await statusDiagnostic;
  await statusRejected;
  assert.deepEqual(client.getDiagnosticSnapshot().mcpServerStatusList, {
    classification: "timeout",
    registrations: [],
  });
  assert.equal(JSON.stringify(diagnostics).includes("private-thread-id"), false);
  await client.close();
});

test("never initiates status queries across repeated lifecycle requests", async () => {
  const transport = new TestTransport();
  const diagnostics: CodexAppServerDiagnosticEvent[] = [];
  const client = new CodexAppServerClient(transport, {
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  transport.readOutput();
  for (const method of ["start", "resume", "resume"] as const) {
    const pending = method === "start"
      ? client.startThread({ cwd: "/workspace" })
      : client.resumeThread({ threadId: "private-thread-id" });
    await new Promise((resolve) => setImmediate(resolve));
    const requests = transport.readOutput();
    assert.equal(requests.length, 1);
    const request = JSON.parse(requests[0] ?? "null") as { id: number; method: string };
    assert.equal(request.method, method === "start" ? "thread/start" : "thread/resume");
    transport.input.write(`${JSON.stringify({
      id: request.id, result: { thread: { id: "private-thread-id" } },
    })}\n`);
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(transport.readOutput(), []);
  }
  assert.equal(client.getDiagnosticSnapshot().mcpServerStatusList, undefined);
  assert.equal(diagnostics.some((event) => event.stage.startsWith("mcp_server_status")), false);
  await client.close();
});

test("correlates responses and exposes server requests", async () => {
  const { client, transport } = await connectClient();
  transport.readOutput();

  const pending = client.startThread({ cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as { id: number; method: string };
  assert.equal(request.method, "thread/start");
  transport.input.write(
    `${JSON.stringify({ id: request.id, result: { thread: { id: "thr_1" } } })}\n`,
  );
  assert.equal((await pending).id, "thr_1");

  const serverRequest = new Promise<{ id: number; method: string }>((resolve) => {
    client.onServerRequest((event) => resolve(event as { id: number; method: string }));
  });
  transport.input.write(
    `${JSON.stringify({
      id: 99,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
    })}\n`,
  );
  assert.deepEqual(await serverRequest, {
    id: 99,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
  });
  client.respondToFileChangeApproval(99, "acceptForSession");
  const [rawResponse] = transport.readOutput();
  assert.deepEqual(JSON.parse(rawResponse ?? "null"), {
    id: 99,
    result: { decision: "acceptForSession" },
  });
  client.respondToPermissionsApproval(100, {
    permissions: { network: { hosts: ["example.com"] } },
    scope: "turn",
  });
  const [rawPermissionsResponse] = transport.readOutput();
  assert.deepEqual(JSON.parse(rawPermissionsResponse ?? "null"), {
    id: 100,
    result: {
      permissions: { network: { hosts: ["example.com"] } },
      scope: "turn",
    },
  });
  await client.respondToUserInputAndDrain(101, {
    answers: { git_approval: { answers: ["承認して実行"] } },
  });
  const [rawUserInputResponse] = transport.readOutput();
  assert.deepEqual(JSON.parse(rawUserInputResponse ?? "null"), {
    id: 101,
    result: {
      answers: { git_approval: { answers: ["承認して実行"] } },
    },
  });
  client.respondToMcpServerElicitation(102, {
    action: "accept",
    content: null,
    _meta: { persist: "session" },
  });
  const [rawElicitationResponse] = transport.readOutput();
  assert.deepEqual(JSON.parse(rawElicitationResponse ?? "null"), {
    id: 102,
    result: {
      action: "accept",
      content: null,
      _meta: { persist: "session" },
    },
  });
  await client.close();
});

test("rejects a request with the app-server RPC error", async () => {
  const { client, transport } = await connectClient();
  transport.readOutput();

  const pending = client.startTurn({
    threadId: "thr_1",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    additionalContext: {
      "showtalk_taishi.slack_persona": {
        kind: "application",
        value: "Strict reviewer",
      },
    },
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "gpt-test",
        reasoning_effort: "medium",
        developer_instructions: "ShowTalk interactive execution mode",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as {
    id: number;
    params?: { additionalContext?: unknown; collaborationMode?: unknown };
  };
  assert.deepEqual(request.params?.additionalContext, {
    "showtalk_taishi.slack_persona": {
      kind: "application",
      value: "Strict reviewer",
    },
  });
  assert.deepEqual(request.params?.collaborationMode, {
    mode: "plan",
    settings: {
      model: "gpt-test",
      reasoning_effort: "medium",
      developer_instructions: "ShowTalk interactive execution mode",
    },
  });
  transport.input.write(
    `${JSON.stringify({ id: request.id, error: { code: -32000, message: "boom" } })}\n`,
  );

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof CodexRpcError);
    assert.equal(error.code, -32000);
    return true;
  });
  await client.close();
});

test("reports malformed JSON values without crashing the client", async () => {
  const { client, transport } = await connectClient();
  const diagnostics: Error[] = [];
  client.onProtocolError((error) => diagnostics.push(error));

  for (const value of ["null", "true", "[]", '"text"', '{"method":7}', '{"id":{},"result":{}}']) {
    transport.input.write(`${value}\n`);
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(diagnostics.length, 6);
  assert.ok(diagnostics.every((error) => error instanceof Error));
  await client.close();
});

test("rejects a pending request when its RPC error shape is malformed", async () => {
  const { client, transport } = await connectClient();
  transport.readOutput();
  const pending = client.startThread({ cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };

  transport.input.write(`${JSON.stringify({ id: request.id, error: "invalid" })}\n`);

  await assert.rejects(pending, /invalid error/u);
  await client.close();
});

test("releases a thread subscription through thread/unsubscribe", async () => {
  const { client, transport } = await connectClient();
  transport.readOutput();

  const pending = client.unsubscribeThread("thr_1");
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as {
    id: number;
    method: string;
    params: { threadId: string };
  };
  assert.equal(request.method, "thread/unsubscribe");
  assert.deepEqual(request.params, { threadId: "thr_1" });
  transport.input.write(
    `${JSON.stringify({ id: request.id, result: { status: "unsubscribed" } })}\n`,
  );
  await pending;
  await client.close();
});

test("pages exact turn status without hydrating paginated thread history", async () => {
  const { client, transport } = await connectClient();
  transport.readOutput();

  const pending = client.listThreadTurns("thr_1", {
    limit: 50,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as {
    id: number;
    method: string;
    params: unknown;
  };
  assert.equal(request.method, "thread/turns/list");
  assert.deepEqual(request.params, {
    threadId: "thr_1",
    limit: 50,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });

  transport.input.write(`${JSON.stringify({
    id: request.id,
    result: {
      data: [{ id: "turn_1", status: "completed" }],
      nextCursor: null,
      backwardsCursor: "newer_1",
    },
  })}\n`);
  const result = await pending;
  assert.equal(result.data[0]?.id, "turn_1");
  assert.equal(result.backwardsCursor, "newer_1");
  await client.close();
});

test("lists one typed page of Codex app-server models", async () => {
  const { client, transport } = await connectClient();
  transport.readOutput();

  const pending = client.listModels({
    cursor: "cursor_1",
    includeHidden: true,
    limit: 25,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as {
    id: number;
    method: string;
    params: unknown;
  };
  assert.equal(request.method, "model/list");
  assert.deepEqual(request.params, {
    cursor: "cursor_1",
    includeHidden: true,
    limit: 25,
  });

  const result = {
    data: [
      {
        id: "gpt-5.4",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "Strong model for everyday coding.",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Faster responses" },
          { reasoningEffort: "medium", description: "Balanced reasoning" },
        ],
        inputModalities: ["text", "image"],
        supportsPersonality: true,
        upgrade: null,
        upgradeInfo: {
          model: "gpt-5.5",
          migrationMarkdown: "Use GPT-5.5 for harder tasks.",
          modelLink: null,
          upgradeCopy: "Upgrade available",
        },
      },
    ],
    nextCursor: "cursor_2",
  };
  transport.input.write(`${JSON.stringify({ id: request.id, result })}\n`);

  assert.deepEqual(await pending, result);
  await client.close();
});

test("times out an app-server request that never receives a response", async () => {
  const lifecycle: CodexAppServerDiagnosticEvent[] = [];
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport, {
    requestTimeoutMs: 100,
    onDiagnostic: (event) => lifecycle.push(event),
  });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  transport.readOutput();
  const pending = client.startThread({ cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as { id: number };
  await assert.rejects(
    pending,
    /request timed out: thread\/start/,
  );
  assert.deepEqual(lifecycle.at(-1), {
    source: "codex_app_server",
    stage: "thread_start_response",
    outcome: "error",
    cwd: "absolute",
    configKeyNames: [],
    configuredMcpRegistrationNames: [],
    errorClassification: "timeout",
  });
  assert.equal(
    client.getDiagnosticSnapshot().threadStart?.errorClassification,
    "timeout",
  );
  const diagnostics: Error[] = [];
  client.onProtocolError((error) => diagnostics.push(error));
  transport.input.write(
    `${JSON.stringify({ id: request.id, result: { thread: { id: "late" } } })}\n`,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(diagnostics, [], "late timed-out responses should be ignored");
  await client.close();
});

test("does not report an intentional runtime shutdown as a transport failure", async () => {
  const { client, transport } = await connectClient();
  const closeErrors: Error[] = [];
  client.onClose((error) => closeErrors.push(error));

  await client.close({ reportAsFailure: false });

  assert.equal(transport.closed, true);
  assert.deepEqual(closeErrors, []);
});

test("still reports an explicit failure close to adapter listeners by default", async () => {
  const { client } = await connectClient();
  const closeErrors: Error[] = [];
  client.onClose((error) => closeErrors.push(error));

  await client.close();

  assert.equal(closeErrors.length, 1);
  assert.match(closeErrors[0]?.message ?? "", /app-server client closed/);
});

test("later close calls await transport cleanup already started by an error", async () => {
  const transport = new DelayedCloseTransport();
  const client = new CodexAppServerClient(transport);
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as {
    id: number;
  };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;

  transport.output.emit("error", new Error("transport failed"));
  await transport.closeStarted;
  let closeFinished = false;
  const closing = client.close().then(() => {
    closeFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeFinished, false);
  transport.releaseClose();
  await closing;
  assert.equal(transport.closed, true);
  assert.equal(transport.closeCalls, 1);
});

test("stdout EOF starts transport cleanup and later close calls await it once", async () => {
  const transport = new DelayedCloseTransport();
  const client = new CodexAppServerClient(transport);
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as {
    id: number;
  };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;

  const closeErrors: Error[] = [];
  client.onClose((error) => closeErrors.push(error));
  transport.input.end();
  await transport.closeStarted;

  let firstFinished = false;
  let secondFinished = false;
  const first = client.close().then(() => {
    firstFinished = true;
  });
  const second = client.close().then(() => {
    secondFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstFinished, false);
  assert.equal(secondFinished, false);
  assert.equal(transport.closeCalls, 1);

  transport.releaseClose();
  await Promise.all([first, second]);
  assert.equal(transport.closed, true);
  assert.equal(transport.closeCalls, 1);
  assert.equal(closeErrors.length, 1);
  assert.match(closeErrors[0]?.message ?? "", /transport closed/);
});
