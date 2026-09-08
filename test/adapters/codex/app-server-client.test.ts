import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServerClient,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  resolveCodexAppServerArgs,
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

async function connectClientWithTimeout(requestTimeoutMs: number) {
  const transport = new TestTransport();
  const client = new CodexAppServerClient(transport, { requestTimeoutMs });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.readOutput()[0] ?? "null") as { id: number };
  transport.input.write(`${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await starting;
  transport.readOutput();
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
  client.respondToUserInput(101, {
    answers: { git_approval: { answers: ["承認して実行"] } },
  });
  const [rawUserInputResponse] = transport.readOutput();
  assert.deepEqual(JSON.parse(rawUserInputResponse ?? "null"), {
    id: 101,
    result: {
      answers: { git_approval: { answers: ["承認して実行"] } },
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
  const { client, transport } = await connectClientWithTimeout(100);
  const pending = client.startThread({ cwd: "/workspace" });
  await new Promise((resolve) => setImmediate(resolve));
  const [rawRequest] = transport.readOutput();
  const request = JSON.parse(rawRequest ?? "null") as { id: number };
  await assert.rejects(
    pending,
    /request timed out: thread\/start/,
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
});
