import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  ClaudeCodeAdapter,
  claudeShowTalkInstructions,
  normalizeClaudeMessage,
  type ClaudeCodeAdapterOptions,
  type ClaudeQueryFunction,
} from "../../../src/adapters/claude/adapter.js";
import type { AgentDefinition, AgentEvent } from "../../../src/core/index.js";
import {
  AdapterSessionUnavailableError,
  AgentWorkspaceUnavailableError,
} from "../../../src/core/index.js";

type QueryParams = Parameters<ClaudeQueryFunction>[0];
type CanUseTool = NonNullable<QueryParams["options"]["canUseTool"]>;

interface ScriptContext {
  readonly params: QueryParams;
  readonly firstMessage: SDKUserMessage;
  readonly canUseTool: CanUseTool;
  readonly signal: AbortSignal;
}

type Script = (context: ScriptContext) => AsyncGenerator<unknown>;

interface QueryCall {
  readonly params: QueryParams;
  firstMessage?: SDKUserMessage;
  interrupts: number;
}

function fakeQuery(scripts: Script[]): { query: ClaudeQueryFunction; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query: ClaudeQueryFunction = (params) => {
    const call: QueryCall = { params, interrupts: 0 };
    calls.push(call);
    const script = scripts[calls.length - 1] ?? scripts[scripts.length - 1];
    assert.ok(script, "a script is required");
    let interruptWake: (() => void) | undefined;
    return {
      async *[Symbol.asyncIterator]() {
        const first = await params.prompt[Symbol.asyncIterator]().next();
        assert.equal(first.done, false);
        call.firstMessage = first.value as SDKUserMessage;
        const canUseTool = params.options.canUseTool;
        assert.ok(canUseTool);
        const generator = script({
          params,
          firstMessage: call.firstMessage,
          canUseTool,
          signal: params.options.abortController?.signal ?? new AbortController().signal,
        });
        const interrupted = new Promise<"interrupted">((resolve) => {
          interruptWake = () => resolve("interrupted");
        });
        while (true) {
          const next = await Promise.race([generator.next(), interrupted]);
          if (next === "interrupted") return;
          if (next.done) return;
          yield next.value as SDKMessage;
        }
      },
      async interrupt() {
        call.interrupts += 1;
        interruptWake?.();
      },
    };
  };
  return { query, calls };
}

const initMessage = { type: "system", subtype: "init" };
const successResult = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
};

async function* simpleTurn(): AsyncGenerator<unknown> {
  yield initMessage;
  yield successResult;
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "taishi-claude-"));
}

function agentFor(
  workspacePath: string | undefined,
  extra: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    id: "koe-claude",
    adapter: "claude",
    channelId: "C0123456789",
    ...(workspacePath === undefined ? {} : { metadata: { workspacePath } }),
    ...extra,
  } as AgentDefinition;
}

const humanSource = { type: "human" } as const;

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function adapterWith(
  scripts: Script[],
  options: ClaudeCodeAdapterOptions = {},
): { adapter: ClaudeCodeAdapter; calls: QueryCall[] } {
  const { query, calls } = fakeQuery(scripts);
  return {
    adapter: new ClaudeCodeAdapter({
      query,
      sessionExists: async () => true,
      ...options,
    }),
    calls,
  };
}

test("createSession returns a UUID and the first turn uses sessionId, later turns resume", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({
    agent: agentFor(workspace),
    reason: "manual",
  });
  assert.match(session.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  assert.equal(await adapter.status(session), "idle");

  await collect(adapter.sendMessage(session, { text: "one", source: humanSource }));
  assert.equal(calls[0]?.params.options.sessionId, session.id);
  assert.equal(calls[0]?.params.options.resume, undefined);

  await collect(adapter.sendMessage(session, { text: "two", source: humanSource }));
  assert.equal(calls[1]?.params.options.resume, session.id);
  assert.equal(calls[1]?.params.options.sessionId, undefined);
});

test("a first turn that never initialised keeps using sessionId", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([
    async function* () {
      yield successResult;
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await collect(adapter.sendMessage(session, { text: "one", source: humanSource }));
  await collect(adapter.sendMessage(session, { text: "two", source: humanSource }));
  assert.equal(calls[1]?.params.options.sessionId, session.id);
  assert.equal(calls[1]?.params.options.resume, undefined);
});

test("createSession rejects a missing workspace", async () => {
  const { adapter } = adapterWith([simpleTurn as Script]);
  await assert.rejects(
    adapter.createSession({
      agent: agentFor(join(tmpdir(), "taishi-claude-does-not-exist-0001")),
      reason: "manual",
    }),
    AgentWorkspaceUnavailableError,
  );
});

test("resumeSession throws when the session is missing and resumes when it exists", async () => {
  const workspace = await makeWorkspace();
  const lookups: Array<[string, string | undefined]> = [];
  const missing = adapterWith([simpleTurn as Script], {
    sessionExists: async (id, path) => {
      lookups.push([id, path]);
      return false;
    },
  });
  await assert.rejects(
    missing.adapter.resumeSession({
      agent: agentFor(workspace),
      adapterSessionId: "11111111-1111-4111-8111-111111111111",
    }),
    AdapterSessionUnavailableError,
  );
  assert.deepEqual(lookups, [["11111111-1111-4111-8111-111111111111", workspace]]);

  const failing = adapterWith([simpleTurn as Script], {
    sessionExists: async () => {
      throw new Error("disk failure");
    },
  });
  await assert.rejects(
    failing.adapter.resumeSession({
      agent: agentFor(workspace),
      adapterSessionId: "11111111-1111-4111-8111-111111111111",
    }),
    AdapterSessionUnavailableError,
  );

  const present = adapterWith([simpleTurn as Script], {
    sessionExists: async () => true,
  });
  const session = await present.adapter.resumeSession({
    agent: agentFor(workspace),
    adapterSessionId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(session.id, "22222222-2222-4222-8222-222222222222");
  await collect(present.adapter.sendMessage(session, { text: "hi", source: humanSource }));
  assert.equal(present.calls[0]?.params.options.resume, session.id);
  assert.equal(present.calls[0]?.params.options.sessionId, undefined);
});

test("streams deltas, completed messages, tool events, and ignores subagent messages", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([
    async function* () {
      yield initMessage;
      yield {
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      };
      yield {
        type: "stream_event",
        parent_tool_use_id: "toolu_parent",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hidden" } },
      };
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "text", text: "Hello there" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
          ],
        },
      };
      yield {
        type: "assistant",
        parent_tool_use_id: "toolu_parent",
        message: { content: [{ type: "text", text: "subagent chatter" }] },
      };
      yield {
        type: "user",
        parent_tool_use_id: "toolu_parent",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "sub" }],
        },
      };
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true },
          ],
        },
      };
      yield successResult;
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events = await collect(
    adapter.sendMessage(session, { text: "go", source: humanSource }),
  );
  assert.deepEqual(events, [
    { type: "status.changed", status: "running" },
    { type: "message.delta", text: "Hel" },
    { type: "message.completed", text: "Hello there" },
    { type: "tool.started", toolCallId: "toolu_1", name: "Bash", input: { command: "ls" } },
    { type: "tool.completed", toolCallId: "toolu_1", output: "boom", isError: true },
    { type: "status.changed", status: "idle" },
  ]);
  assert.equal(await adapter.status(session), "idle");
});

test("an error result becomes an error event before the final idle status", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([
    async function* () {
      yield initMessage;
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["it broke"],
      };
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events = await collect(
    adapter.sendMessage(session, { text: "go", source: humanSource }),
  );
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.code, "CLAUDE_ERROR_DURING_EXECUTION");
  assert.match(error.message, /it broke/u);
  assert.equal(error.retryable, true);
  assert.deepEqual(events.at(-1), { type: "status.changed", status: "idle" });
});

test("a turn that ends without a result reports CLAUDE_TURN_INCOMPLETE", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([
    async function* () {
      yield initMessage;
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events = await collect(
    adapter.sendMessage(session, { text: "go", source: humanSource }),
  );
  assert.ok(
    events.some((event) => event.type === "error" && event.code === "CLAUDE_TURN_INCOMPLETE"),
  );
});

test("a thrown query error is reported with bearer tokens redacted", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([
    // eslint-disable-next-line require-yield
    async function* () {
      throw new Error("failed with Bearer synthetic-secret-value");
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events = await collect(
    adapter.sendMessage(session, { text: "go", source: humanSource }),
  );
  const error = events.find((event) => event.type === "error");
  assert.ok(error && error.type === "error");
  assert.equal(error.code, "CLAUDE_QUERY_FAILED");
  assert.doesNotMatch(error.message, /synthetic-secret-value/u);
  assert.match(error.message, /Bearer \[redacted\]/u);
});

test("a second concurrent turn for the same session is rejected as busy", async () => {
  const workspace = await makeWorkspace();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { adapter } = adapterWith([
    async function* () {
      yield initMessage;
      await gate;
      yield successResult;
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const first = adapter.sendMessage(session, { text: "one", source: humanSource })[
    Symbol.asyncIterator
  ]();
  await first.next();
  await assert.rejects(
    collect(adapter.sendMessage(session, { text: "two", source: humanSource })),
    (error: { code?: string }) => error.code === "AGENT_BUSY",
  );
  release();
  while (!(await first.next()).done) {
    // drain
  }
});

test("an expired queued continuation does not start a Claude turn", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([simpleTurn as Script], { now: () => 1_000 });
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await assert.rejects(
    collect(
      adapter.sendMessage(session, {
        text: "late",
        source: humanSource,
        startNotAfterMs: 1_000,
      }),
    ),
    (error: { code?: string }) => error.code === "SESSION_AGENT_MISMATCH",
  );
  assert.equal(calls.length, 0);
});

interface ApprovalHarness {
  readonly results: unknown[];
  readonly events: AgentEvent[];
}

/** Runs one turn whose script requests approval, answering via `respond`. */
async function runApprovalTurn(input: {
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly suggestions?: unknown[];
  readonly respond?: (
    adapter: ClaudeCodeAdapter,
    session: { id: string },
    requestId: string,
  ) => Promise<void>;
  readonly options?: ClaudeCodeAdapterOptions;
}): Promise<ApprovalHarness> {
  const workspace = await makeWorkspace();
  const results: unknown[] = [];
  const { adapter } = adapterWith(
    [
      async function* ({ canUseTool, signal }) {
        yield initMessage;
        const result = await canUseTool(
          input.toolName ?? "Bash",
          input.toolInput ?? { command: "ls" },
          {
            signal,
            ...(input.suggestions === undefined ? {} : { suggestions: input.suggestions }),
          } as Parameters<CanUseTool>[2],
        );
        results.push(result);
        yield successResult;
      },
    ],
    input.options,
  );
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage(session, { text: "go", source: humanSource })) {
    events.push(event);
    if (event.type === "approval.requested" && input.respond !== undefined) {
      await input.respond(adapter, session, event.requestId);
    }
  }
  return { results, events };
}

test("approval request surfaces status, request id, and session decision when suggestions exist", async () => {
  const suggestion = {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
    behavior: "allow",
    destination: "localSettings",
  };
  const { events } = await runApprovalTurn({
    suggestions: [suggestion],
    respond: (adapter, session, requestId) =>
      adapter.approve(session, { requestId, decision: "deny" }),
  });
  const statuses = events.filter((event) => event.type === "status.changed");
  assert.deepEqual(
    statuses.map((event) => event.status),
    ["running", "waiting_for_approval", "running", "idle"],
  );
  const request = events.find((event) => event.type === "approval.requested");
  assert.ok(request && request.type === "approval.requested");
  assert.match(request.requestId, /^claude:/u);
  assert.deepEqual(request.availableDecisions, ["allow_once", "allow_session", "deny", "cancel"]);
  assert.match(request.summary, /Claude wants to use Bash/u);
  assert.match(request.summary, /ls/u);
  assert.ok(Number.isFinite(Date.parse(request.expiresAt ?? "")));
});

test("approval without suggestions omits allow_session", async () => {
  const { events } = await runApprovalTurn({
    respond: (adapter, session, requestId) =>
      adapter.approve(session, { requestId, decision: "deny" }),
  });
  const request = events.find((event) => event.type === "approval.requested");
  assert.ok(request && request.type === "approval.requested");
  assert.deepEqual(request.availableDecisions, ["allow_once", "deny", "cancel"]);
});

test("rejects approval decisions that were not advertised and keeps the request pending", async () => {
  const rejectedUnavailable: string[] = [];
  const { results } = await runApprovalTurn({
    respond: async (adapter, session, requestId) => {
      for (const decision of ["allow_session", "allow_command_rule"] as const) {
        await assert.rejects(
          adapter.approve(session, { requestId, decision }),
          (error: { code?: string }) => error.code === "PERMISSION_DENIED",
        );
        rejectedUnavailable.push(decision);
      }
      await adapter.approve(session, { requestId, decision: "deny" });
    },
  });
  assert.deepEqual(rejectedUnavailable, ["allow_session", "allow_command_rule"]);
  assert.deepEqual(results, [{
    behavior: "deny",
    message: "The human denied this action in Slack. Do not retry it; ask how to proceed.",
  }]);
});

test("allow_once resolves canUseTool with allow and the original input", async () => {
  const { results } = await runApprovalTurn({
    respond: (adapter, session, requestId) =>
      adapter.approve(session, { requestId, decision: "allow_once" }),
  });
  assert.deepEqual(results, [{ behavior: "allow", updatedInput: { command: "ls" } }]);
});

test("allow_session returns session-scoped permission updates", async () => {
  const { results } = await runApprovalTurn({
    suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
    respond: (adapter, session, requestId) =>
      adapter.approve(session, { requestId, decision: "allow_session" }),
  });
  assert.deepEqual(results, [
    {
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "ls:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    },
  ]);
});

test("deny and cancel map to deny results, cancel interrupting", async () => {
  const denied = await runApprovalTurn({
    respond: (adapter, session, requestId) =>
      adapter.approve(session, { requestId, decision: "deny" }),
  });
  const deniedResult = denied.results[0] as { behavior: string; interrupt?: boolean };
  assert.equal(deniedResult.behavior, "deny");
  assert.equal(deniedResult.interrupt, undefined);

  const cancelled = await runApprovalTurn({
    respond: (adapter, session, requestId) =>
      adapter.approve(session, { requestId, decision: "cancel" }),
  });
  const cancelledResult = cancelled.results[0] as { behavior: string; interrupt?: boolean };
  assert.equal(cancelledResult.behavior, "deny");
  assert.equal(cancelledResult.interrupt, true);
});

test("approve rejects an unknown request id", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await assert.rejects(
    adapter.approve(session, { requestId: "claude:unknown", decision: "allow_once" }),
    (error: { code?: string }) => error.code === "UNKNOWN_APPROVAL_REQUEST",
  );
});

test("approve rejects a request that belongs to a different session", async () => {
  const workspace = await makeWorkspace();
  let otherRejected = false;
  const { adapter } = adapterWith([
    async function* ({ canUseTool, signal }) {
      yield initMessage;
      yield { type: "noop" };
      await canUseTool("Bash", { command: "ls" }, { signal } as Parameters<CanUseTool>[2]);
      yield successResult;
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const other = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  for await (const event of adapter.sendMessage(session, { text: "go", source: humanSource })) {
    if (event.type !== "approval.requested") continue;
    await assert.rejects(
      adapter.approve(other, { requestId: event.requestId, decision: "allow_once" }),
    );
    otherRejected = true;
    await adapter.approve(session, { requestId: event.requestId, decision: "deny" });
  }
  assert.equal(otherRejected, true);
});

test("showtalk MCP tools are auto-allowed and AskUserQuestion is denied without approvals", async () => {
  const workspace = await makeWorkspace();
  const results: unknown[] = [];
  const { adapter } = adapterWith([
    async function* ({ canUseTool, signal }) {
      yield initMessage;
      const options = { signal } as Parameters<CanUseTool>[2];
      results.push(await canUseTool("mcp__showtalk_taishi__slack.reply", { text: "x" }, options));
      results.push(await canUseTool("AskUserQuestion", { questions: [] }, options));
      yield successResult;
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events = await collect(
    adapter.sendMessage(session, { text: "go", source: humanSource }),
  );
  assert.equal(events.some((event) => event.type === "approval.requested"), false);
  assert.deepEqual(results[0], { behavior: "allow", updatedInput: { text: "x" } });
  const denied = results[1] as { behavior: string; message: string };
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /Slack thread/u);
});

test("an unanswered approval expires with APPROVAL_EXPIRED and a deny", async () => {
  // The adapter unrefs its approval timer, so hold the loop open in the test.
  const keepAlive = setInterval(() => undefined, 1_000);
  const { events, results } = await runApprovalTurn({
    options: { approvalTimeoutMs: 20 },
  }).finally(() => clearInterval(keepAlive));
  assert.ok(
    events.some((event) => event.type === "error" && event.code === "APPROVAL_EXPIRED"),
  );
  const result = results[0] as { behavior: string; interrupt?: boolean };
  assert.equal(result.behavior, "deny");
  assert.equal(result.interrupt, true);
});

test("interrupt calls the query interrupt and the final status is interrupted", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([
    async function* () {
      yield initMessage;
      await new Promise(() => undefined);
    },
  ]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage(session, { text: "go", source: humanSource })) {
    events.push(event);
    if (event.type === "status.changed" && event.status === "running") {
      setImmediate(() => void adapter.interrupt(session));
    }
  }
  assert.equal(calls[0]?.interrupts, 1);
  assert.deepEqual(events.at(-1), { type: "status.changed", status: "interrupted" });
  assert.equal(await adapter.status(session), "interrupted");
});

test("interrupt without an active turn is a no-op", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await adapter.interrupt(session);
  assert.equal(await adapter.status(session), "idle");
});

test("passes cwd, model, effort, permission mode, tools, MCP server, and system prompt to query", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([simpleTurn as Script], {
    model: "sonnet",
    reasoningEffort: "high",
    permissionMode: "acceptEdits",
    allowedTools: ["Read", "Bash(git status:*)"],
    settingSources: ["user"],
    maxTurns: 7,
    env: { ANTHROPIC_API_KEY: "synthetic-anthropic-key", PATH: "/usr/bin" },
    pathToClaudeCodeExecutable: "/opt/synthetic/claude",
    mcp: {
      url: "http://127.0.0.1:4799/mcp",
      bearerTokenEnvVar: "SHOWTALK_TAISHI_MCP_TOKEN",
    },
  });
  const session = await adapter.createSession({
    agent: agentFor(workspace, {
      role: "Reviewer of synthetic code",
      slackPersona: "Speaks like a calm librarian",
    }),
    reason: "manual",
  });
  await collect(adapter.sendMessage(session, { text: "go", source: humanSource }));
  const options = calls[0]?.params.options;
  assert.ok(options);
  assert.equal(options.cwd, workspace);
  assert.equal(options.model, "sonnet");
  assert.equal(options.effort, "high");
  assert.equal(options.permissionMode, "acceptEdits");
  assert.deepEqual(options.allowedTools, ["Read", "Bash(git status:*)"]);
  assert.equal(options.allowedTools?.includes("mcp__showtalk_taishi"), false);
  assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
  assert.deepEqual(options.settingSources, ["user"]);
  assert.equal(options.maxTurns, 7);
  assert.equal(options.includePartialMessages, true);
  assert.equal(options.pathToClaudeCodeExecutable, "/opt/synthetic/claude");
  assert.deepEqual(options.env, { ANTHROPIC_API_KEY: "synthetic-anthropic-key", PATH: "/usr/bin" });
  assert.deepEqual(options.mcpServers, {
    showtalk_taishi: {
      type: "http",
      url: "http://127.0.0.1:4799/mcp",
      headers: { Authorization: "Bearer ${SHOWTALK_TAISHI_MCP_TOKEN}" },
    },
  });
  const systemPrompt = options.systemPrompt as { type: string; preset: string; append: string };
  assert.equal(systemPrompt.type, "preset");
  assert.equal(systemPrompt.preset, "claude_code");
  assert.match(systemPrompt.append, /Reviewer of synthetic code/u);
  assert.match(systemPrompt.append, /Speaks like a calm librarian/u);
});

test("defaults apply when optional settings are omitted", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await collect(adapter.sendMessage(session, { text: "go", source: humanSource }));
  const options = calls[0]?.params.options;
  assert.ok(options);
  assert.equal(options.permissionMode, "default");
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.deepEqual(options.allowedTools, []);
  assert.equal("model" in options, false);
  assert.equal("effort" in options, false);
  assert.equal("mcpServers" in options, false);
});

test("rejects an invalid MCP bearer token environment variable name", () => {
  assert.throws(
    () =>
      new ClaudeCodeAdapter({
        mcp: { url: "http://127.0.0.1:1/mcp", bearerTokenEnvVar: "BAD NAME}" },
      }),
    /Invalid MCP bearer token environment variable name/u,
  );
});

test("image attachments become base64 image blocks and audio becomes a path notice", async () => {
  const workspace = await makeWorkspace();
  const imagePath = join(workspace, "pic.png");
  const audioPath = join(workspace, "note.m4a");
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await writeFile(imagePath, imageBytes);
  await writeFile(audioPath, Buffer.from([1, 2, 3]));
  const { adapter, calls } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await collect(
    adapter.sendMessage(session, {
      text: "look",
      source: humanSource,
      attachments: [
        { kind: "image", path: imagePath, name: "pic.png", mimeType: "image/png", size: 4 },
        { kind: "audio", path: audioPath, name: "note.m4a", mimeType: "audio/mp4", size: 3 },
      ],
    }),
  );
  const message = calls[0]?.firstMessage;
  assert.ok(message);
  assert.equal(message.session_id, session.id);
  const content = message.message.content as unknown as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(content));
  const text = content[0] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.match(text.text, /^look/u);
  assert.ok(text.text.includes(audioPath));
  assert.ok(text.text.includes("audio/mp4"));
  assert.ok(!text.text.includes(imagePath));
  assert.deepEqual(content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: imageBytes.toString("base64") },
  });
});

test("unsupported image types fall back to a path notice and plain text content", async () => {
  const workspace = await makeWorkspace();
  const imagePath = join(workspace, "pic.bmp");
  await writeFile(imagePath, Buffer.from([1]));
  const { adapter, calls } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await collect(
    adapter.sendMessage(session, {
      text: "look",
      source: humanSource,
      attachments: [
        { kind: "image", path: imagePath, name: "pic.bmp", mimeType: "image/bmp", size: 1 },
      ],
    }),
  );
  const content = calls[0]?.firstMessage?.message.content;
  assert.equal(typeof content, "string");
  assert.ok((content as string).includes(imagePath));
});

test("agent-sourced messages carry a consultation header", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([simpleTurn as Script]);
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await collect(
    adapter.sendMessage(session, {
      text: "please review",
      source: { type: "agent", agentId: "koe-other", delegationId: "del-1", depth: 2 },
    }),
  );
  const content = calls[0]?.firstMessage?.message.content as string;
  assert.match(content, /consultation from koe-other \(delegation del-1, depth 2\)/u);
  assert.match(content, /please review$/u);
});

test("updateModelSettings changes the model for the next turn", async () => {
  const workspace = await makeWorkspace();
  const { adapter, calls } = adapterWith([simpleTurn as Script], {
    model: "sonnet",
    reasoningEffort: "low",
  });
  const session = await adapter.createSession({ agent: agentFor(workspace), reason: "manual" });
  await collect(adapter.sendMessage(session, { text: "one", source: humanSource }));
  adapter.updateModelSettings({ model: "opus", reasoningEffort: "max" });
  await collect(adapter.sendMessage(session, { text: "two", source: humanSource }));
  assert.equal(calls[0]?.params.options.model, "sonnet");
  assert.equal(calls[0]?.params.options.effort, "low");
  assert.equal(calls[1]?.params.options.model, "opus");
  assert.equal(calls[1]?.params.options.effort, "max");
  adapter.updateModelSettings({});
  await collect(adapter.sendMessage(session, { text: "three", source: humanSource }));
  assert.equal("model" in (calls[2]?.params.options ?? {}), false);
});

test("shutdown rejects new sessions", async () => {
  const workspace = await makeWorkspace();
  const { adapter } = adapterWith([simpleTurn as Script]);
  adapter.shutdown();
  await assert.rejects(
    adapter.createSession({ agent: agentFor(workspace), reason: "manual" }),
    (error: { code?: string }) => error.code === "ADAPTER_CAPABILITY_UNAVAILABLE",
  );
});

test("normalizeClaudeMessage handles tool results with array content and unknown messages", () => {
  const names = new Map<string, string>();
  assert.deepEqual(
    normalizeClaudeMessage(
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_9",
              content: [{ type: "text", text: "line" }, { type: "image" }],
            },
          ],
        },
      } as unknown as SDKMessage,
      names,
    ),
    [{ type: "tool.completed", toolCallId: "toolu_9", output: "line\n[image]" }],
  );
  assert.deepEqual(
    normalizeClaudeMessage({ type: "system", subtype: "init" } as unknown as SDKMessage),
    [],
  );
  assert.deepEqual(
    normalizeClaudeMessage({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "   " }] },
    } as unknown as SDKMessage),
    [],
  );
});

test("normalizeClaudeMessage redacts and bounds assistant and result errors", () => {
  const secrets = [
    ["Bearer", "synthetic-bearer-secret"].join(" "),
    ["sk", "ant-api03-SYNTHETICANTHROPIC123456"].join("-"),
    ["xoxb", "SYNTHETICSLACK123456"].join("-"),
    ["ghp", "SYNTHETICGITHUB123456"].join("_"),
    ["github", "pat", "SYNTHETIC_FINE_GRAINED_123456"].join("_"),
  ];
  const assistant = normalizeClaudeMessage({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [] },
    error: `request failed with ${secrets.join(" and ")}; keep-this-context ${"x".repeat(3_000)}`,
  } as unknown as SDKMessage);
  const result = normalizeClaudeMessage({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: [`upstream rejected ${secrets.join(" ")}`, "keep-result-context", "y".repeat(3_000)],
  } as unknown as SDKMessage);

  for (const event of [...assistant, ...result]) {
    assert.equal(event.type, "error");
    if (event.type !== "error") continue;
    for (const secret of secrets) assert.equal(event.message.includes(secret), false);
    assert.match(event.message, /Bearer \[redacted\]/u);
    assert.match(event.message, /\[redacted Anthropic credential\]/u);
    assert.match(event.message, /\[redacted Slack credential\]/u);
    assert.match(event.message, /\[redacted Git credential\]/u);
    assert.match(event.message, /keep-(?:this|result)-context/u);
    assert.ok(event.message.length <= 2_500);
  }
});

test("claudeShowTalkInstructions includes role and persona only when present", () => {
  const bare = claudeShowTalkInstructions({
    id: "k",
    adapter: "claude",
    channelId: "C0123456789",
  } as AgentDefinition);
  assert.doesNotMatch(bare, /# Koe role/u);
  assert.doesNotMatch(bare, /# ShowTalk Slack persona/u);
  assert.match(bare, /agent\.send/u);
  const full = claudeShowTalkInstructions({
    id: "k",
    adapter: "claude",
    channelId: "C0123456789",
    role: "Planner",
    slackPersona: "Terse",
  } as AgentDefinition);
  assert.match(full, /# Koe role\nPlanner/u);
  assert.match(full, /# ShowTalk Slack persona[\s\S]*Terse/u);
});
