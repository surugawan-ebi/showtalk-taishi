import assert from "node:assert/strict";
import test from "node:test";

import { CodexAdapter, type CodexAppServer } from "../../../src/adapters/codex/adapter.js";
import type { AgentEvent } from "../../../src/core/index.js";
import type { ServerRequestEvent } from "../../../src/adapters/codex/app-server-client.js";
import type {
  CodexThread,
  CodexTurn,
  CommandApprovalDecision,
  FileChangeApprovalDecision,
  PermissionsApprovalResponse,
  RpcError,
  RpcId,
  ThreadResumeParams,
  ThreadStartParams,
  ToolRequestUserInputResponse,
  TurnStartParams,
} from "../../../src/adapters/codex/protocol.js";

class FakeAppServer implements CodexAppServer {
  readonly threadStarts: ThreadStartParams[] = [];
  readonly threadResumes: ThreadResumeParams[] = [];
  readonly turnStarts: TurnStartParams[] = [];
  readonly approvalResponses: Array<{ id: RpcId; decision: string }> = [];
  readonly permissionsApprovalResponses: Array<{
    id: RpcId;
    response: PermissionsApprovalResponse;
  }> = [];
  readonly errorResponses: Array<{ id: RpcId; code: number; message: string }> = [];
  readonly userInputResponses: Array<{
    id: RpcId;
    response: ToolRequestUserInputResponse;
  }> = [];
  readonly unsubscribeCalls: string[] = [];
  readCalls = 0;
  threadStatusType = "idle";
  readFailures = 0;
  readonly interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  startTurnBehavior?: (params: TurnStartParams) => Promise<CodexTurn>;
  interruptFailures = 0;
  closed = false;
  readonly #notifications = new Set<(method: string, params: unknown) => void>();
  readonly #requests = new Set<(event: ServerRequestEvent) => void>();
  readonly #protocolErrors = new Set<(error: Error) => void>();
  readonly #closeListeners = new Set<(error: Error) => void>();

  async startThread(params: ThreadStartParams): Promise<CodexThread> {
    this.threadStarts.push(params);
    return { id: "thr_1", sessionId: "thr_1" };
  }

  async resumeThread(params: ThreadResumeParams): Promise<CodexThread> {
    this.threadResumes.push(params);
    return { id: "thr_1" };
  }

  async readThread(threadId: string): Promise<CodexThread> {
    this.readCalls += 1;
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("transient read failure");
    }
    return { id: threadId, status: { type: this.threadStatusType } };
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    this.unsubscribeCalls.push(threadId);
  }

  async startTurn(params: TurnStartParams): Promise<CodexTurn> {
    this.turnStarts.push(params);
    if (this.startTurnBehavior !== undefined) return this.startTurnBehavior(params);
    return { id: "turn_1", status: "inProgress" };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interruptCalls.push({ threadId, turnId });
    if (this.interruptFailures > 0) {
      this.interruptFailures -= 1;
      throw new Error("interrupt failed");
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.closeWithError(new Error("fake app-server closed"));
  }

  respondToCommandApproval(id: RpcId, decision: CommandApprovalDecision): void {
    this.approvalResponses.push({ id, decision: String(decision) });
  }

  respondToFileChangeApproval(id: RpcId, decision: FileChangeApprovalDecision): void {
    this.approvalResponses.push({ id, decision });
  }

  respondToPermissionsApproval(
    id: RpcId,
    response: PermissionsApprovalResponse,
  ): void {
    this.permissionsApprovalResponses.push({ id, response });
  }

  respondToUserInput(id: RpcId, response: ToolRequestUserInputResponse): void {
    this.userInputResponses.push({ id, response });
  }

  respondError(id: RpcId, error: RpcError): void {
    this.errorResponses.push({ id, code: error.code, message: error.message });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onServerRequest(listener: (event: ServerRequestEvent) => void): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  onProtocolError(listener: (error: Error) => void): () => void {
    this.#protocolErrors.add(listener);
    return () => this.#protocolErrors.delete(listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  notify(method: string, params: unknown): void {
    for (const listener of this.#notifications) listener(method, params);
  }

  request(event: ServerRequestEvent): void {
    for (const listener of this.#requests) listener(event);
  }

  closeWithError(error: Error): void {
    for (const listener of this.#closeListeners) listener(error);
  }
}

function workspaceGitQuestion() {
  return workspaceGitQuestionForTurn("turn_1");
}

function workspaceGitQuestionForTurn(turnId: string) {
  return {
    threadId: "thr_1",
    turnId,
    itemId: "request-input-1",
    questions: [
      {
        id: "git_approval",
        header: "Git approval",
        question: "表示されたexact Git planを承認しますか？",
        isOther: true,
        isSecret: false,
        options: [
          { label: "承認して実行", description: "再検証して実行へ進む" },
          { label: "拒否・保留", description: "実行しない" },
        ],
      },
    ],
    isBlocking: true,
    autoResolutionMs: null,
  };
}

function notifyPublicationPlan(
  server: FakeAppServer,
  overrides: {
    readonly itemId?: string;
    readonly turnId?: string;
    readonly operationId?: string;
    readonly planHash?: string;
    readonly expiresAt?: string;
  } = {},
): void {
  const itemId = overrides.itemId ?? "mcp-plan-1";
  const turnId = overrides.turnId ?? "turn_1";
  const argumentsValue = {
    repo_id: "showtalk-taishi",
    worktree_id: "primary",
    mode: "commit_push_and_open_draft_pr",
    commit_message: "Add Slack Git approval buttons",
    expected_head: "b".repeat(40),
    expected_snapshot_id: "c".repeat(64),
    paths: ["src/core/gateway.ts", "README.md"],
    pr: {
      title: "Add Slack Git approval buttons",
      body: "Render an exact pending plan and accept only fixed Block Kit actions.",
    },
    pr_base_branch: "main",
  };
  server.notify("item/started", {
    threadId: "thr_1",
    turnId,
    item: {
      type: "mcpToolCall",
      id: itemId,
      server: "workspace-git",
      tool: "prepare_git_publication",
      arguments: argumentsValue,
      status: "inProgress",
    },
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId,
    item: {
      type: "mcpToolCall",
      id: itemId,
      server: "workspace-git",
      tool: "prepare_git_publication",
      arguments: argumentsValue,
      status: "completed",
      result: {
        structuredContent: {
          status: "awaiting_human_approval",
          operation_id:
            overrides.operationId ?? "11111111-1111-4111-8111-111111111111",
          approval_expires_at:
            overrides.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
          scope: {
            repo_id: "showtalk-taishi",
            worktree_id: "primary",
            mode: "commit_push_and_open_draft_pr",
            branch: "agent/slack-git-approval",
            paths: ["src/core/gateway.ts", "README.md"],
          },
          plan_hash: overrides.planHash ?? "a".repeat(64),
          execute_tool: "execute_approved_git_publication",
          external_write: false,
        },
      },
    },
  });
}

function notifyInitialPushPlan(server: FakeAppServer): void {
  const argumentsValue = {
    repo_id: "empty-example-repo",
    worktree_id: "primary",
    mode: "initial_push_existing",
    expected_head: "b".repeat(40),
    expected_snapshot_id: "c".repeat(64),
  };
  const item = {
    type: "mcpToolCall",
    id: "mcp-initial-plan",
    server: "workspace-git",
    tool: "prepare_git_publication",
    arguments: argumentsValue,
  };
  server.notify("item/started", {
    threadId: "thr_1",
    turnId: "turn_1",
    item: { ...item, status: "inProgress" },
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    item: {
      ...item,
      status: "completed",
      result: {
        structuredContent: {
          status: "awaiting_human_approval",
          operation_id: "33333333-3333-4333-8333-333333333333",
          approval_expires_at: new Date(Date.now() + 60_000).toISOString(),
          scope: {
            repo_id: "empty-example-repo",
            worktree_id: "primary",
            mode: "initial_push_existing",
            branch: "main",
            paths: [],
          },
          plan_hash: "d".repeat(64),
          execute_tool: "execute_approved_git_publication",
          external_write: false,
        },
      },
    },
  });
}

test("creates a Codex thread with workspace and role instructions", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = await adapter.createSession({
    reason: "slack_conversation",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C123",
      role: "Implement carefully.",
      slackPersona: "Answer as a blunt staff engineer.",
      metadata: { workspacePath: "/workspace" },
    },
  });
  assert.equal(session.id, "thr_1");
  assert.equal(server.threadStarts[0]?.cwd, "/workspace");
  assert.equal(server.threadStarts[0]?.serviceName, "showtalk_taishi");
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /^Implement carefully\.\n\nShowTalk Taishi Koe consultation rules:/u,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /internal subagents.*not Slack channels.*agent\.send.*not an internal subagent tool.*never satisfies AGENTS\.md/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /ShowTalk Taishi Git approval routing rules:/u,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /same turn.*request_user_input.*Never use agent\.send/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /get_git_operation_status never binds.*REPREPARE_REQUIRED/su,
  );
  assert.doesNotMatch(
    server.threadStarts[0]?.developerInstructions ?? "",
    /blunt staff engineer/u,
  );
});

test("applies a Slack persona only as per-turn application context", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = await adapter.resumeSession({
    adapterSessionId: "thr_1",
    agent: {
      id: "reviewer",
      adapter: "codex",
      channelId: "C456",
      role: "Preserve the repository context.",
      slackPersona: "Act as a strict adversarial reviewer.",
    },
  });

  const consuming = collectEvents(
    adapter.sendMessage(session, {
      text: "Review this design",
      source: { type: "human", slackUserId: "U1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.doesNotMatch(
    server.threadResumes[0]?.developerInstructions ?? "",
    /strict adversarial reviewer/u,
  );
  assert.deepEqual(server.turnStarts[0]?.input, [
    { type: "text", text: "Review this design", text_elements: [] },
  ]);
  assert.deepEqual(server.turnStarts[0]?.additionalContext, {
    "showtalk_taishi.slack_persona": {
      kind: "application",
      value: [
        "ShowTalk Taishi Slack-only Koe persona:",
        "Apply this persona only while answering the current ShowTalk-originated turn.",
        "Do not carry it into later turns started directly from Codex App or another client.",
        "It may shape viewpoint, tone, evaluation criteria, and approach, but it never expands tool permissions, approval authority, or configured Koe consultation scopes.",
        "",
        "Act as a strict adversarial reviewer.",
      ].join("\n"),
    },
  });

  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("omits per-turn application context when no Slack persona is configured", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = await adapter.createSession({
    reason: "slack_conversation",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C123",
      role: "Preserve the repository context.",
    },
  });

  const consuming = collectEvents(
    adapter.sendMessage(session, {
      text: "Implement this change",
      source: { type: "human" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.turnStarts[0]?.additionalContext, undefined);

  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("attaches the required MCP config on both thread creation and resume", async () => {
  const server = new FakeAppServer();
  const threadConfig = {
    mcp_servers: {
      showtalk_taishi: {
        url: "http://127.0.0.1:3210/mcp",
        bearer_token_env_var: "SHOWTALK_TAISHI_MCP_TOKEN",
        required: true,
      },
    },
  } as const;
  const adapter = new CodexAdapter(server, { threadConfig });
  const agent = {
    id: "implementer",
    adapter: "codex",
    channelId: "C123",
  } as const;
  await adapter.createSession({ reason: "slack_conversation", agent });
  await adapter.resumeSession({ agent, adapterSessionId: "thr_1" });

  assert.deepEqual(server.threadStarts[0]?.config, threadConfig);
  assert.deepEqual(server.threadResumes[0]?.config, threadConfig);
  assert.equal(server.threadStarts[0]?.approvalsReviewer, undefined);
  assert.equal(server.threadResumes[0]?.approvalsReviewer, undefined);
  assert.match(
    server.threadResumes[0]?.developerInstructions ?? "",
    /Git approval belongs to the Koe.*Slack thread that started that same turn/u,
  );
});

test("applies an explicit reasoning effort to Codex turns", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { reasoningEffort: "low" });
  const consuming = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Quick check", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.turnStarts[0]?.approvalPolicy, undefined);
  assert.equal(server.turnStarts[0]?.approvalsReviewer, undefined);
  assert.equal(server.turnStarts[0]?.effort, "low");
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("applies hot model settings only to subsequent Codex turns", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, {
    model: "model-before",
    reasoningEffort: "low",
  });
  const session = { id: "thr_1" };
  const first = collectEvents(
    adapter.sendMessage(session, {
      text: "First turn",
      source: { type: "human" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  adapter.updateModelSettings({
    model: "model-after",
    reasoningEffort: "high",
  });
  assert.equal(server.turnStarts[0]?.model, "model-before");
  assert.equal(server.turnStarts[0]?.effort, "low");
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await first;

  const second = collectEvents(
    adapter.sendMessage(session, {
      text: "Second turn",
      source: { type: "human" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.turnStarts[1]?.model, "model-after");
  assert.equal(server.turnStarts[1]?.effort, "high");
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await second;

  adapter.updateModelSettings({});
  const third = collectEvents(
    adapter.sendMessage(session, {
      text: "Default turn",
      source: { type: "human" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.turnStarts[2]?.model, undefined);
  assert.equal(server.turnStarts[2]?.effort, undefined);
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await third;
});

test("applies explicit Codex permission overrides to threads and turns", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, {
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
    sandbox: "read-only",
  });
  const agent = {
    id: "implementer",
    adapter: "codex",
    channelId: "C123",
  } as const;
  const session = await adapter.createSession({ reason: "slack_conversation", agent });
  await adapter.resumeSession({ agent, adapterSessionId: session.id });
  const consuming = collectEvents(
    adapter.sendMessage(session, { text: "Check", source: { type: "human" } }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.threadStarts[0]?.approvalPolicy, "never");
  assert.equal(server.threadStarts[0]?.approvalsReviewer, "auto_review");
  assert.equal(server.threadStarts[0]?.sandbox, "read-only");
  assert.equal(server.threadResumes[0]?.approvalPolicy, "never");
  assert.equal(server.threadResumes[0]?.approvalsReviewer, "auto_review");
  assert.equal(server.threadResumes[0]?.sandbox, "read-only");
  assert.equal(server.turnStarts[0]?.approvalPolicy, "never");
  assert.equal(server.turnStarts[0]?.approvalsReviewer, "auto_review");

  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("passes multiple images natively and exposes audio as a bounded local file", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const consuming = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      {
        text: "Compare the screenshots and inspect the voice note.",
        source: { type: "human" },
        attachments: [
          {
            kind: "image",
            path: "/private/attachments/before.png",
            name: "before.png",
            mimeType: "image/png",
            size: 100,
          },
          {
            kind: "image",
            path: "/private/attachments/after.jpg",
            name: "after.jpg",
            mimeType: "image/jpeg",
            size: 200,
          },
          {
            kind: "audio",
            path: "/private/attachments/note.m4a",
            name: "note.m4a",
            mimeType: "audio/mp4",
            size: 300,
          },
        ],
      },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));

  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.deepEqual(server.turnStarts[0]?.input.slice(1), [
    { type: "localImage", path: "/private/attachments/before.png" },
    { type: "localImage", path: "/private/attachments/after.jpg" },
  ]);
  const textInput = server.turnStarts[0]?.input[0];
  assert.equal(textInput?.type, "text");
  assert.match(textInput?.type === "text" ? textInput.text : "", /note\.m4a/u);
  assert.match(textInput?.type === "text" ? textInput.text : "", /native audio input/u);
});

test("releases and resumes the same Codex thread between turns", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const agent = {
    id: "implementer",
    adapter: "codex",
    channelId: "C123",
    metadata: { workspacePath: "/workspace" },
  } as const;
  const session = await adapter.createSession({
    reason: "slack_conversation",
    agent,
  });

  const first = collectEvents(
    adapter.sendMessage(session, { text: "First", source: { type: "human" } }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await first;

  const second = collectEvents(
    adapter.sendMessage(session, { text: "Second", source: { type: "human" } }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_2", status: "completed" },
  });
  await second;

  assert.deepEqual(server.unsubscribeCalls, [session.id, session.id]);
  assert.equal(server.threadResumes.length, 1);
  assert.equal(server.threadResumes[0]?.threadId, session.id);
  assert.equal(server.threadResumes[0]?.cwd, "/workspace");
});

test("times out safely without interrupting a long-running external turn", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, {
    externalTurnPollMs: 1,
    externalTurnWaitMs: 3,
  });
  const session = await adapter.createSession({
    reason: "slack_conversation",
    agent: { id: "implementer", adapter: "codex", channelId: "C123" },
  });
  server.threadStatusType = "active";

  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        session,
        { text: "Do not race", source: { type: "human" } },
      ),
    ),
    (error) => error instanceof Error && error.message.includes("another client"),
  );
  assert.deepEqual(server.turnStarts, []);
  assert.deepEqual(server.interruptCalls, []);
  assert.deepEqual(server.unsubscribeCalls, [session.id]);
});

test("queues a Slack turn until the external client becomes idle", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, {
    externalTurnPollMs: 1,
    externalTurnWaitMs: 100,
  });
  const session = await adapter.createSession({
    reason: "slack_conversation",
    agent: { id: "implementer", adapter: "codex", channelId: "C123" },
  });
  server.threadStatusType = "active";

  const consuming = collectEvents(
    adapter.sendMessage(session, {
      text: "Run after the App turn",
      source: { type: "human" },
    }),
  );
  setTimeout(() => {
    server.threadStatusType = "idle";
  }, 5);
  while (server.turnStarts.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.equal(server.turnStarts.length, 1);
  assert.equal(server.threadResumes.length, 1);
  assert.deepEqual(server.interruptCalls, []);
});

test("status inspection does not retain an idle thread subscription", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const agent = { id: "implementer", adapter: "codex", channelId: "C123" } as const;
  const session = await adapter.resumeSession({ agent, adapterSessionId: "thr_1" });

  assert.equal(await adapter.status(session), "idle");
  assert.deepEqual(server.unsubscribeCalls, [session.id]);
});

test("normalizes stream events and resolves an approval", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const events: unknown[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Fix it",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "approval.requested") {
        await adapter.approve(session, {
          requestId: event.requestId,
          decision: "allow_once",
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.notify("item/agentMessage/delta", {
    threadId: "thr_1",
    turnId: "turn_1",
    delta: "Working",
  });
  server.request({
    id: 7,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      command: "npm test",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.ok(events.some((event) => JSON.stringify(event).includes("Working")));
  assert.deepEqual(server.approvalResponses, [{ id: 7, decision: "accept" }]);
  const approvalEvent = events.find(
    (event): event is { type: "approval.requested"; requestId: string } =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "approval.requested" &&
      "requestId" in event &&
      typeof event.requestId === "string",
  );
  assert.match(approvalEvent?.requestId ?? "", /^codex:[0-9a-f-]{36}$/);
  await assert.rejects(
    adapter.approve(session, {
      requestId: approvalEvent?.requestId ?? "missing",
      decision: "allow_once",
    }),
    /Unknown approval request/,
  );
});

test("grants only requested modern permission fields for one turn", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Request scoped access",
      source: { type: "human" },
    })) {
      if (event.type === "approval.requested") {
        assert.match(event.summary, /network and fileSystem/u);
        await adapter.approve(session, {
          requestId: event.requestId,
          decision: "allow_once",
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 17,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      reason: "Run a bounded check",
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/workspace"], write: null },
        injected: { all: true },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.deepEqual(server.permissionsApprovalResponses, [
    {
      id: 17,
      response: {
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ["/workspace"], write: null },
        },
        scope: "turn",
      },
    },
  ]);
});

test("denies modern permission requests with an empty turn-scoped grant", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Do not grant access",
      source: { type: "human" },
    })) {
      if (event.type === "approval.requested") {
        await adapter.approve(session, {
          requestId: event.requestId,
          decision: "deny",
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 18,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      permissions: { network: { enabled: true }, fileSystem: null },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.deepEqual(server.permissionsApprovalResponses, [
    { id: 18, response: { permissions: {}, scope: "turn" } },
  ]);
});

test("maps session grants and cancellations for modern permission requests", async () => {
  const cases = [
    {
      decision: "allow_session" as const,
      expected: {
        permissions: { network: { enabled: true } },
        scope: "session" as const,
      },
    },
    {
      decision: "cancel" as const,
      expected: { permissions: {}, scope: "turn" as const },
    },
  ];

  for (const [index, current] of cases.entries()) {
    const server = new FakeAppServer();
    const adapter = new CodexAdapter(server);
    const session = { id: "thr_1" };
    const consuming = (async () => {
      for await (const event of adapter.sendMessage(session, {
        text: "Resolve scoped permission",
        source: { type: "human" },
      })) {
        if (event.type === "approval.requested") {
          await adapter.approve(session, {
            requestId: event.requestId,
            decision: current.decision,
          });
        }
      }
    })();

    await new Promise((resolve) => setImmediate(resolve));
    server.request({
      id: 30 + index,
      method: "item/permissions/requestApproval",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "item_1",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    server.notify("turn/completed", {
      threadId: "thr_1",
      turn: { id: "turn_1", status: "completed" },
    });
    await consuming;

    assert.deepEqual(server.permissionsApprovalResponses, [
      { id: 30 + index, response: current.expected },
    ]);
  }
});

test("normalizes ShowTalk Taishi MCP tool lifecycle events", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "List agents", source: { type: "human" } },
    )) {
      events.push(event);
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("item/started", {
    threadId: "thr_1",
    item: {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "showtalk_taishi",
      tool: "agent.list",
      arguments: {},
      status: "inProgress",
    },
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    item: {
      type: "mcpToolCall",
      id: "mcp-1",
      server: "showtalk_taishi",
      tool: "agent.list",
      status: "completed",
      result: { structuredContent: { agents: [] } },
    },
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.deepEqual(events[2], {
    type: "tool.started",
    toolCallId: "mcp-1",
    name: "showtalk_taishi.agent.list",
    input: {},
  });
  assert.deepEqual(events[3], {
    type: "tool.completed",
    toolCallId: "mcp-1",
    output: { structuredContent: { agents: [] } },
  });
});

test("fails an active stream when the app-server transport closes", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const consuming = (async () => {
    for await (const _event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Keep working", source: { type: "human" } },
    )) {
      // Drain until the simulated transport closes.
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  server.closeWithError(new Error("transport gone"));
  await assert.rejects(consuming, /transport gone/);
});

test("rejects structured input that is not bound to one exact workspace-git plan", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Ask", source: { type: "human" } },
    )) {
      if (event.type === "git_approval.reprepare_required") return event;
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 8,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  const recovery = await consuming;
  assert.equal(server.errorResponses[0]?.id, 8);
  assert.equal(server.errorResponses[0]?.code, -32602);
  assert.match(
    server.errorResponses[0]?.message ?? "",
    /REPREPARE_REQUIRED.*Do not call request_user_input again.*get_git_operation_status does not bind.*re-run.*prepare_/u,
  );
  assert.equal(recovery?.type, "git_approval.reprepare_required");
});

test("bridges one exact workspace-git publication choice to the same App Server request", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  let releaseRequest!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Publish after approval",
      source: { type: "human" },
    })) {
      if (event.type === "user_input.requested") {
        requested = event;
        releaseRequest();
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({ id: 81, method: "item/tool/requestUserInput", params: workspaceGitQuestion() });
  await requestReady;
  assert.equal(requested?.plan.operationId, "11111111-1111-4111-8111-111111111111");
  assert.equal(requested?.plan.worktreeId, "primary");
  assert.deepEqual(requested?.plan.paths, ["src/core/gateway.ts", "README.md"]);

  const requestId = requested?.requestId ?? "";
  await adapter.respondToUserInput(session, { requestId, optionId: "approve" });
  await assert.rejects(
    adapter.respondToUserInput(session, { requestId, optionId: "approve" }),
    /Unknown structured input request/u,
  );
  assert.deepEqual(server.userInputResponses, [
    {
      id: 81,
      response: {
        answers: { git_approval: { answers: ["承認して実行"] } },
      },
    },
  ]);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("bridges an exact initial push plan instead of projecting recovery", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  let releaseRequest!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Publish the initial private workbench commit",
      source: { type: "human" },
    })) {
      if (event.type === "user_input.requested") {
        requested = event;
        releaseRequest();
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyInitialPushPlan(server);
  server.request({ id: 89, method: "item/tool/requestUserInput", params: workspaceGitQuestion() });
  await requestReady;
  assert.equal(requested?.plan.mode, "initial_push_existing");
  assert.equal(requested?.plan.branch, "main");
  assert.equal(requested?.plan.pushTarget, "origin/main");
  assert.equal(server.errorResponses.length, 0);

  await adapter.respondToUserInput(session, {
    requestId: requested?.requestId ?? "",
    optionId: "reject",
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
  assert.deepEqual(server.userInputResponses, [
    {
      id: 89,
      response: {
        answers: { git_approval: { answers: ["拒否・保留"] } },
      },
    },
  ]);
});

test("waits briefly when structured input arrives before its same-turn Git plan", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  let releaseRequest!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Publish this change",
      source: { type: "human" },
    })) {
      if (event.type === "user_input.requested") {
        requested = event;
        releaseRequest();
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 84,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestionForTurn("turn_1"),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.errorResponses.length, 0);

  notifyPublicationPlan(server);
  await requestReady;
  assert.equal(requested?.plan.operationId, "11111111-1111-4111-8111-111111111111");
  await adapter.respondToUserInput(session, {
    requestId: requested?.requestId ?? "",
    optionId: "reject",
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.equal(server.turnStarts.length, 1);
  assert.equal(server.errorResponses.length, 0);
  assert.deepEqual(server.userInputResponses, [
    {
      id: 84,
      response: {
        answers: { git_approval: { answers: ["拒否・保留"] } },
      },
    },
  ]);
});

test("does not bind a structured request to a Git plan from another turn", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not substitute turns", source: { type: "human" } },
    ),
  );

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 85,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestionForTurn("turn_1"),
  });
  notifyPublicationPlan(server, { turnId: "turn_2" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.equal(server.errorResponses[0]?.id, 85);
  assert.match(
    server.errorResponses[0]?.message ?? "",
    /No exact workspace-git plan arrived/u,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "git_approval.reprepare_required",
    ),
  );
});

test("fails closed when two different Git plans precede one structured question", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const consuming = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not substitute plans", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  notifyPublicationPlan(server, {
    itemId: "mcp-plan-2",
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  server.request({ id: 82, method: "item/tool/requestUserInput", params: workspaceGitQuestion() });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await consuming;

  assert.equal(server.errorResponses[0]?.id, 82);
  assert.equal(server.errorResponses[0]?.code, -32602);
  assert.match(
    server.errorResponses[0]?.message ?? "",
    /More than one workspace-git plan.*Do not use agent\.send/u,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "git_approval.reprepare_required",
    ),
  );
});

test("fails closed when two Git plans race an early structured request", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not choose between racing plans", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 86,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  notifyPublicationPlan(server);
  notifyPublicationPlan(server, {
    itemId: "mcp-plan-race-2",
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.equal(server.errorResponses[0]?.id, 86);
  assert.match(
    server.errorResponses[0]?.message ?? "",
    /More than one workspace-git plan/u,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === "git_approval.reprepare_required",
    ),
  );
});

test("projects one recovery action when an unbound structured request is retried", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Recover without duplicating Slack warnings", source: { type: "human" } },
    ),
  );

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 87,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestionForTurn("turn_1"),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.request({
    id: 88,
    method: "item/tool/requestUserInput",
    params: { ...workspaceGitQuestionForTurn("turn_1"), itemId: "request-input-2" },
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.deepEqual(server.errorResponses.map((response) => response.id), [87, 88]);
  assert.equal(
    events.filter((event) => event.type === "git_approval.reprepare_required").length,
    1,
  );
  assert.equal(
    events.filter(
      (event) =>
        event.type === "error" && event.code === "UNBOUND_GIT_APPROVAL",
    ).length,
    0,
  );
});

test("rejects an expired structured choice and resumes the App Server once", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { approvalTimeoutMs: 10 });
  const session = { id: "thr_1" };
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Wait for approval",
      source: { type: "human" },
    })) {
      if (event.type === "error" && event.code === "STRUCTURED_INPUT_EXPIRED") {
        server.notify("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "completed" },
        });
      }
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({ id: 83, method: "item/tool/requestUserInput", params: workspaceGitQuestion() });
  await consuming;

  assert.deepEqual(server.userInputResponses, [
    {
      id: 83,
      response: {
        answers: { git_approval: { answers: ["拒否・保留"] } },
      },
    },
  ]);
});

test("cancels an expired approval instead of stranding the Codex turn", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { approvalTimeoutMs: 10 });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Run it", source: { type: "human" } },
    )) {
      if (event.type === "error" && event.code === "APPROVAL_EXPIRED") return;
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 9,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thr_1", turnId: "turn_1", itemId: "item_1" },
  });
  await consuming;
  assert.deepEqual(server.approvalResponses, [{ id: 9, decision: "cancel" }]);
});

test("reconciles a missed terminal event with thread status", async () => {
  const server = new FakeAppServer();
  server.threadStatusType = "idle";
  const adapter = new CodexAdapter(server, { terminalWatchdogMs: 10 });
  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage(
    { id: "thr_1" },
    { text: "Finish silently", source: { type: "human" } },
  )) {
    events.push(event);
  }
  assert.equal(server.readCalls, 2, "preflight and watchdog should both read state");
  assert.equal(events.at(-1)?.type, "status.changed");
});

test("retries a transient thread status failure without ending the stream", async () => {
  const server = new FakeAppServer();
  server.threadStatusType = "idle";
  server.startTurnBehavior = async () => {
    server.readFailures = 1;
    return { id: "turn_1", status: "inProgress" };
  };
  const adapter = new CodexAdapter(server, { terminalWatchdogMs: 5 });
  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage(
    { id: "thr_1" },
    { text: "Keep tracking", source: { type: "human" } },
  )) {
    events.push(event);
  }
  assert.equal(server.readCalls, 3);
  assert.equal(events.at(-1)?.type, "status.changed");
});

test("interrupts a turn announced after turn/start becomes ambiguous", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    server.notify("turn/started", {
      threadId: "thr_1",
      turn: { id: "turn_late", status: "inProgress" },
    });
    throw new Error("turn/start timed out");
  };
  const adapter = new CodexAdapter(server);
  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        { id: "thr_1" },
        { text: "Ambiguous start", source: { type: "human" } },
      ),
    ),
    /turn\/start timed out/,
  );
  assert.deepEqual(server.interruptCalls, [
    { threadId: "thr_1", turnId: "turn_late" },
  ]);
});

test("closes app-server when ambiguous turn start cannot be reconciled", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    server.readFailures = 3;
    throw new Error("turn/start timed out");
  };
  const adapter = new CodexAdapter(server, {
    ambiguousStartRetryMs: 1,
    terminalWatchdogMs: 5,
  });
  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        { id: "thr_1" },
        { text: "Late start", source: { type: "human" } },
      ),
    ),
    /turn\/start timed out/,
  );
  assert.equal(server.closed, true);
});

test("retries a failed interrupt before closing app-server", async () => {
  const server = new FakeAppServer();
  server.interruptFailures = 1;
  server.startTurnBehavior = async () => {
    server.threadStatusType = "active";
    server.notify("turn/started", {
      threadId: "thr_1",
      turn: { id: "turn_retry_interrupt", status: "inProgress" },
    });
    throw new Error("turn/start timed out");
  };
  const adapter = new CodexAdapter(server, { ambiguousStartRetryMs: 1 });
  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        { id: "thr_1" },
        { text: "Retry interrupt", source: { type: "human" } },
      ),
    ),
    /turn\/start timed out/,
  );
  assert.equal(server.interruptCalls.length, 2);
  assert.equal(server.closed, false);
});

test("closes app-server and refuses a new turn when cleanup interrupt fails", async () => {
  const server = new FakeAppServer();
  server.interruptFailures = 10;
  server.startTurnBehavior = async () => {
    server.threadStatusType = "active";
    return { id: "turn_1", status: "inProgress" };
  };
  const adapter = new CodexAdapter(server, { ambiguousStartRetryMs: 1 });
  const first = adapter
    .sendMessage(
      { id: "thr_1" },
      { text: "Cancel this stream", source: { type: "human" } },
    )
    [Symbol.asyncIterator]();
  assert.equal((await first.next()).value?.type, "status.changed");
  await first.return?.();

  assert.equal(server.closed, true);
  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        { id: "thr_1" },
        { text: "Must not start", source: { type: "human" } },
      ),
    ),
    /transport is unavailable/,
  );
});

test("interrupts a turn when its unconsumed event queue exceeds the limit", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { ambiguousStartRetryMs: 1 });
  const events = adapter
    .sendMessage(
      { id: "thr_1" },
      { text: "Produce too many events", source: { type: "human" } },
    )
    [Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "status.changed");

  for (let index = 0; index < 300; index += 1) {
    server.notify("item/started", {
      threadId: "thr_1",
      item: {
        id: `command-${index}`,
        type: "commandExecution",
        command: "true",
      },
    });
  }

  await assert.rejects(
    () => events.next(),
    /event queue exceeded its memory safety limit/,
  );
  assert.ok(server.interruptCalls.length >= 1);
});

async function collectEvents(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
