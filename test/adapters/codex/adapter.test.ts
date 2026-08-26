import assert from "node:assert/strict";
import test from "node:test";

import { CodexAdapter, type CodexAppServer } from "../../../src/adapters/codex/adapter.js";
import type {
  AgentEvent,
  WorkspaceGitApprovalPlan,
} from "../../../src/core/index.js";
import type { ServerRequestEvent } from "../../../src/adapters/codex/app-server-client.js";
import { CodexRpcError } from "../../../src/adapters/codex/protocol.js";
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
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
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
  readonly readThreadIncludeTurns: boolean[] = [];
  readonly listTurnsParams: ThreadTurnsListParams[] = [];
  readonly hydratedTurns = new Map<string, CodexTurn>();
  readCalls = 0;
  listTurnsCalls = 0;
  threadStatusType = "idle";
  threadHistoryMode: CodexThread["historyMode"];
  readFailures = 0;
  listTurnsFailures = 0;
  rejectExcludeTurnsAsUnsupported = false;
  readonly unsupportedExcludeTurnsThreadIds = new Set<string>();
  rejectResumeWithoutExcludeTurns = false;
  rejectTurnPaginationAsUnsupported = false;
  readonly turnStatuses = new Map<string, CodexTurn["status"]>();
  readonly interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  startTurnBehavior?: (params: TurnStartParams) => Promise<CodexTurn>;
  interruptFailures = 0;
  userInputResponseError: Error | undefined;
  closed = false;
  readonly #notifications = new Set<(method: string, params: unknown) => void>();
  readonly #requests = new Set<(event: ServerRequestEvent) => void>();
  readonly #protocolErrors = new Set<(error: Error) => void>();
  readonly #closeListeners = new Set<(error: Error) => void>();

  async startThread(params: ThreadStartParams): Promise<CodexThread> {
    this.threadStarts.push(params);
    return {
      id: "thr_1",
      sessionId: "thr_1",
      ...(this.threadHistoryMode === undefined
        ? {}
        : { historyMode: this.threadHistoryMode }),
    };
  }

  async resumeThread(params: ThreadResumeParams): Promise<CodexThread> {
    this.threadResumes.push(params);
    if (
      params.excludeTurns === true &&
      (this.rejectExcludeTurnsAsUnsupported ||
        this.unsupportedExcludeTurnsThreadIds.has(params.threadId))
    ) {
      throw new CodexRpcError(
        "paginated_threads is not supported yet",
        -32601,
      );
    }
    if (this.rejectResumeWithoutExcludeTurns && params.excludeTurns !== true) {
      throw new Error("legacy resume failed");
    }
    return {
      id: params.threadId,
      ...(this.threadHistoryMode === undefined
        ? {}
        : { historyMode: this.threadHistoryMode }),
    };
  }

  async readThread(threadId: string, includeTurns = false): Promise<CodexThread> {
    this.readCalls += 1;
    this.readThreadIncludeTurns.push(includeTurns);
    if (this.readFailures > 0) {
      this.readFailures -= 1;
      throw new Error("transient read failure");
    }
    return {
      id: threadId,
      status: { type: this.threadStatusType },
      ...(this.threadHistoryMode === undefined
        ? {}
        : { historyMode: this.threadHistoryMode }),
      ...(includeTurns
        ? {
            turns: this.turnStarts.map((_, index) => {
              const id = `turn_${index + 1}`;
              const hydrated = this.hydratedTurns.get(id);
              if (hydrated !== undefined) return hydrated;
              const inferred = this.threadStatusType === "active"
                ? "inProgress"
                : this.threadStatusType === "systemError"
                  ? "failed"
                  : "completed";
              return {
                id,
                status: this.turnStatuses.get(id) ?? inferred,
              };
            }),
          }
        : {}),
    };
  }

  async listThreadTurns(
    _threadId: string,
    params: ThreadTurnsListParams = {},
  ): Promise<ThreadTurnsListResponse> {
    this.listTurnsCalls += 1;
    this.listTurnsParams.push(params);
    if (this.rejectTurnPaginationAsUnsupported) {
      throw new CodexRpcError(
        "paginated_threads is not supported yet",
        -32601,
      );
    }
    if (this.listTurnsFailures > 0) {
      this.listTurnsFailures -= 1;
      throw new Error("transient turns/list failure");
    }
    return {
      data: this.turnStarts.map((_, index) => {
        const id = `turn_${index + 1}`;
        const hydrated = this.hydratedTurns.get(id);
        if (params.itemsView === "full" && hydrated !== undefined) {
          return hydrated;
        }
        const inferred = this.threadStatusType === "active"
          ? "inProgress"
          : this.threadStatusType === "systemError"
            ? "failed"
            : "completed";
        return {
          id,
          status: this.turnStatuses.get(id) ?? inferred,
        };
      }),
      nextCursor: null,
      backwardsCursor: null,
    };
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    this.unsubscribeCalls.push(threadId);
  }

  async startTurn(params: TurnStartParams): Promise<CodexTurn> {
    this.turnStarts.push(params);
    if (this.startTurnBehavior !== undefined) return this.startTurnBehavior(params);
    return { id: `turn_${this.turnStarts.length}`, status: "inProgress" };
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
    if (this.userInputResponseError !== undefined) {
      throw this.userInputResponseError;
    }
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
    const record =
      params !== null && typeof params === "object"
        ? (params as Record<string, unknown>)
        : undefined;
    const turn =
      record?.turn !== null && typeof record?.turn === "object"
        ? (record.turn as Record<string, unknown>)
        : undefined;
    const normalized =
      record !== undefined &&
      (method.startsWith("turn/") || method.startsWith("item/") || method === "error") &&
      typeof record.turnId !== "string"
        ? { ...record, turnId: typeof turn?.id === "string" ? turn.id : "turn_1" }
        : params;
    for (const listener of this.#notifications) listener(method, normalized);
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
        isOther: false,
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

function ordinaryChoiceQuestion(
  questions: readonly Record<string, unknown>[] = [
    {
      id: "terrain",
      header: "地形",
      question: "どの地形を作りますか？",
      isOther: true,
      isSecret: false,
      options: [
        { label: "砂漠盆地", description: "中央が低い地形" },
        { label: "乾燥岩盤平原", description: "岩盤中心の平地" },
        { label: "緩い砂丘原", description: "低い砂丘が続く地形" },
      ],
    },
  ],
) {
  return {
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "request-choice-1",
    questions,
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

function notifyRepositorySettingsPlan(server: FakeAppServer): void {
  const argumentsValue = {
    repo_id: "showtalk-taishi",
    description: "SlackをAI coding agentsのフロントにするOSS",
    topics: ["Slack", "ai-agents", "slack"],
    dependabot_security_updates: true,
  };
  const item = {
    type: "mcpToolCall",
    id: "mcp-settings-plan-1",
    server: "workspace-git",
    tool: "prepare_github_repository_settings",
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
            repo_id: "showtalk-taishi",
            before: {
              description: "Old description",
              topics: ["slack"],
              dependabot_security_updates: "disabled",
            },
            desired: {
              description: "SlackをAI coding agentsのフロントにするOSS",
              topics: ["ai-agents", "slack"],
              dependabot_security_updates: true,
            },
            resulting_state: {
              description: "SlackをAI coding agentsのフロントにするOSS",
              topics: ["ai-agents", "slack"],
              dependabot_security_updates: "enabled",
            },
          },
          approval_target: "repo_settings_showtalk-taishi",
          plan_hash: "f".repeat(64),
          execute_tool: "execute_approved_github_repository_settings",
          external_write: false,
        },
      },
    },
  });
}

function repositorySettingsExecutionItem() {
  return {
    type: "mcpToolCall",
    id: "mcp-settings-execute-1",
    server: "workspace-git",
    tool: "execute_approved_github_repository_settings",
    arguments: { operation_id: "33333333-3333-4333-8333-333333333333" },
    status: "completed",
    result: {
      structuredContent: {
        operation_id: "33333333-3333-4333-8333-333333333333",
        status: "succeeded",
      },
    },
    error: null,
  };
}

function notifyPublicationExecution(
  server: FakeAppServer,
  overrides: {
    readonly itemId?: string;
    readonly turnId?: string;
    readonly operationId?: string;
    readonly status?: "completed" | "failed";
  } = {},
): void {
  const turnId = overrides.turnId ?? "turn_1";
  const item = publicationExecutionItem(overrides);
  server.notify("item/started", {
    threadId: "thr_1",
    turnId,
    item: { ...item, status: "inProgress" },
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId,
    item: {
      ...item,
      status: overrides.status ?? "completed",
      result: {
        structuredContent: {
          operation_id:
            overrides.operationId ?? "11111111-1111-4111-8111-111111111111",
          status: "executed",
        },
      },
    },
  });
}

function publicationExecutionItem(
  overrides: {
    readonly itemId?: string;
    readonly operationId?: string;
    readonly status?: "completed" | "failed";
    readonly server?: "workspace-git" | "workspace_git";
    readonly outcomeStatus?: string;
  } = {},
) {
  const operationId =
    overrides.operationId ?? "11111111-1111-4111-8111-111111111111";
  return {
    type: "mcpToolCall",
    id: overrides.itemId ?? "mcp-execute-1",
    server: overrides.server ?? "workspace-git",
    tool: "execute_approved_git_publication",
    arguments: { operation_id: operationId },
    status: overrides.status ?? "completed",
    result: {
      structuredContent: {
        operation_id: operationId,
        status: overrides.outcomeStatus ?? "applied",
      },
    },
    error: null,
  };
}

function publicationStatusItem(status: string) {
  const operationId = "11111111-1111-4111-8111-111111111111";
  return {
    type: "mcpToolCall",
    id: `mcp-status-${status}`,
    server: "workspace-git",
    tool: "get_git_operation_status",
    arguments: { operation_id: operationId },
    status: "completed",
    result: {
      structuredContent: {
        operation_id: operationId,
        status,
      },
    },
    error: null,
  };
}

async function beginApprovedPublication(
  server: FakeAppServer,
  adapter: CodexAdapter,
  rpcId: number,
): Promise<{ readonly eventsPromise: Promise<AgentEvent[]> }> {
  const session = { id: "thr_1" };
  let requestId = "";
  let releaseRequest!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const eventsPromise = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of adapter.sendMessage(session, {
      text: "Publish after approval",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "user_input.requested") {
        requestId = event.requestId;
        releaseRequest();
      }
    }
    return events;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: rpcId,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await requestReady;
  await adapter.respondToUserInput(session, { requestId, optionId: "approve" });
  return { eventsPromise };
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
    /labels alone never create workspace-git authority.*external write.*exact target.*scope.*impact/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /fresh authenticated human decision.*not the assistant approving its own plan/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /Before the App Server receives `承認して実行`.*Continue the resumed turn.*execute_approved_\* tool exactly once/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /pre-approval phase.*post-approval phase.*does not require another Slack message.*exact approved plan/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /model-inaccessible private broker.*Re-read the exact workspace-git operation status.*operation ID.*full plan hash.*approval target.*worktree.*HEAD\/snapshot or PR state.*scope.*expiry/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /execute_approved_\* tool exactly once/su,
  );
  assert.match(
    server.threadStarts[0]?.developerInstructions ?? "",
    /If the answer is `拒否・保留`.*stale.*mismatched.*expired.*rejected.*already executed.*inconclusive.*do not approve or execute/su,
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

test("allows internal subagents when paginated resume is supported", async () => {
  const server = new FakeAppServer();
  server.threadHistoryMode = "paginated";
  const adapter = new CodexAdapter(server);
  const session = await adapter.resumeSession({
    adapterSessionId: "thr_1",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C123",
    },
  });

  const consuming = collectEvents(
    adapter.sendMessage(session, {
      text: "Use internal delegation if it helps this paginated thread",
      source: { type: "human", slackUserId: "U1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.threadResumes[0]?.excludeTurns, true);
  const compatibility = server.turnStarts[0]?.additionalContext?.[
    "showtalk_taishi.paginated_thread_compatibility"
  ];
  assert.equal(compatibility, undefined);

  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("falls back when the active App Server rejects excludeTurns", async () => {
  const server = new FakeAppServer();
  server.rejectExcludeTurnsAsUnsupported = true;
  const adapter = new CodexAdapter(server);
  const session = await adapter.resumeSession({
    adapterSessionId: "thr_1",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C123",
    },
  });

  assert.equal(server.threadResumes.length, 2);
  assert.equal(server.threadResumes[0]?.excludeTurns, true);
  assert.equal(server.threadResumes[1]?.excludeTurns, undefined);

  const consuming = collectEvents(
    adapter.sendMessage(session, {
      text: "Continue through the compatible resume path",
      source: { type: "human", slackUserId: "U1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const compatibility = server.turnStarts[0]?.additionalContext?.[
    "showtalk_taishi.paginated_thread_compatibility"
  ];
  assert.equal(compatibility?.kind, "application");
  assert.match(
    compatibility?.value ?? "",
    /rejected the modern paginated-thread resume path/u,
  );
  assert.match(
    compatibility?.value ?? "",
    /Do not call Codex internal subagent/u,
  );
  assert.match(compatibility?.value ?? "", /current ShowTalk-originated turn/u);
  assert.match(
    compatibility?.value ?? "",
    /agent\.send is a separate ShowTalk Koe/u,
  );
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  const next = collectEvents(
    adapter.sendMessage(session, {
      text: "Resume again without retrying the unsupported field",
      source: { type: "human", slackUserId: "U1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.threadResumes.at(-1)?.excludeTurns, undefined);
  server.notify("turn/completed", {
    threadId: session.id,
    turn: { id: "turn_2", status: "completed" },
  });
  await next;
});

test("keeps legacy paginated compatibility scoped to one session", async () => {
  const server = new FakeAppServer();
  server.unsupportedExcludeTurnsThreadIds.add("thr_legacy");
  const adapter = new CodexAdapter(server);
  const agent = {
    id: "implementer",
    adapter: "codex",
    channelId: "C123",
  };
  const legacySession = await adapter.resumeSession({
    adapterSessionId: "thr_legacy",
    agent,
  });
  const modernSession = await adapter.resumeSession({
    adapterSessionId: "thr_modern",
    agent,
  });

  const legacy = collectEvents(
    adapter.sendMessage(legacySession, {
      text: "Use the proven legacy compatibility path",
      source: { type: "human", slackUserId: "U1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    server.turnStarts[0]?.additionalContext?.[
      "showtalk_taishi.paginated_thread_compatibility"
    ]?.kind,
    "application",
  );
  server.notify("turn/completed", {
    threadId: legacySession.id,
    turn: { id: "turn_1", status: "completed" },
  });
  await legacy;

  const modern = collectEvents(
    adapter.sendMessage(modernSession, {
      text: "Allow internal delegation on the modern path",
      source: { type: "human", slackUserId: "U1" },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    server.turnStarts[1]?.additionalContext?.[
      "showtalk_taishi.paginated_thread_compatibility"
    ],
    undefined,
  );
  server.notify("turn/completed", {
    threadId: modernSession.id,
    turn: { id: "turn_2", status: "completed" },
  });
  await modern;
});

test("records legacy compatibility only after fallback resume succeeds", async () => {
  const server = new FakeAppServer();
  server.rejectExcludeTurnsAsUnsupported = true;
  server.rejectResumeWithoutExcludeTurns = true;
  const adapter = new CodexAdapter(server);
  const request = {
    adapterSessionId: "thr_1",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C123",
    },
  };

  await assert.rejects(adapter.resumeSession(request), /legacy resume failed/u);
  server.rejectResumeWithoutExcludeTurns = false;
  server.rejectExcludeTurnsAsUnsupported = false;
  await adapter.resumeSession(request);

  assert.equal(server.threadResumes.at(-1)?.excludeTurns, true);
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
  assert.match(
    server.threadResumes[0]?.developerInstructions ?? "",
    /Before the App Server receives `承認して実行`.*instead of ending with prose or deferring execution/su,
  );
  assert.match(
    server.threadResumes[0]?.developerInstructions ?? "",
    /pre-approval phase.*post-approval phase.*does not require another Slack message/su,
  );
  assert.match(
    server.threadResumes[0]?.developerInstructions ?? "",
    /operation ID.*full plan hash.*approval target.*worktree.*HEAD\/snapshot or PR state.*scope.*expiry/su,
  );
  assert.match(
    server.threadResumes[0]?.developerInstructions ?? "",
    /rejected.*already executed.*inconclusive.*do not approve or execute/su,
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
    turn: { id: "turn_2", status: "completed" },
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
    turn: { id: "turn_3", status: "completed" },
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

test("ignores stale completion and approval requests from another turn", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  let settled = false;
  const consuming = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Own this turn", source: { type: "human" } },
    ),
  ).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(server.turnStarts[0]?.clientUserMessageId ?? "", /^[0-9a-f-]{36}$/u);
  server.request({
    id: 999,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thr_1",
      turnId: "turn_external",
      itemId: "external-command",
      command: "false",
    },
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_external", status: "completed" },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(server.errorResponses.some(({ id }) => id === 999), true);
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;
});

test("correlates a pre-response server request to the returned exact turn", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    server.request({
      id: 1000,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thr_1",
        turnId: "turn_1",
        itemId: "owned-command",
        command: "true",
      },
    });
    return { id: "turn_1", status: "inProgress" };
  };
  const adapter = new CodexAdapter(server);
  const events = adapter.sendMessage(
    { id: "thr_1" },
    { text: "Request safely", source: { type: "human" } },
  )[Symbol.asyncIterator]();
  assert.equal((await events.next()).value?.type, "status.changed");
  assert.equal((await events.next()).value?.type, "status.changed");
  const approval = await events.next();
  assert.equal(approval.value?.type, "approval.requested");
  assert.equal(server.errorResponses.some(({ id }) => id === 1000), false);
  if (approval.value?.type === "approval.requested") {
    await adapter.approve({ id: "thr_1" }, {
      requestId: approval.value.requestId,
      decision: "deny",
    });
  }
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await events.return?.();
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

test("normalizes completed generated images once for Slack projection", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Generate a logo", source: { type: "human" } },
    )) {
      events.push(event);
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  const item = {
    type: "imageGeneration",
    id: "generated-image-1",
    status: "completed",
    revisedPrompt: "A logo",
    result:
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    savedPath: "/private/tmp/generated-logo.png",
    failure: null,
  };
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    item,
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    item,
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  const generated = events.filter(
    (event): event is Extract<AgentEvent, { type: "attachment.generated" }> =>
      event.type === "attachment.generated",
  );
  assert.equal(generated.length, 1);
  assert.equal(generated[0]?.attachmentId, "generated-image-1");
  assert.equal(generated[0]?.attachment.mimeType, "image/png");
  assert.doesNotMatch(generated[0]?.attachment.name ?? "", /private|tmp/u);
});

test("suppresses retrying App Server errors and emits only the final error", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const consuming = collectEvents(
    adapter.sendMessage(session, {
      text: "Keep working through transient retries",
      source: { type: "human" },
    }),
  );

  await new Promise((resolve) => setImmediate(resolve));
  server.notify("error", {
    threadId: "thr_1",
    turnId: "turn_1",
    error: { message: "Reconnecting... 1/2" },
    willRetry: true,
  });
  server.notify("error", {
    threadId: "thr_1",
    turnId: "turn_1",
    error: { message: "Reconnecting... 2/2" },
    willRetry: true,
  });
  server.notify("error", {
    threadId: "thr_1",
    turnId: "turn_1",
    error: { message: "Connection failed" },
    willRetry: false,
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "failed" },
  });

  const events = await consuming;
  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [{ type: "error", message: "Connection failed" }],
  );
});

test("preserves legacy App Server errors without willRetry", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const consuming = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Report a legacy failure", source: { type: "human" } },
    ),
  );

  await new Promise((resolve) => setImmediate(resolve));
  server.notify("error", {
    threadId: "thr_1",
    turnId: "turn_1",
    error: { message: "Legacy connection failure" },
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "failed" },
  });

  const events = await consuming;
  assert.deepEqual(
    events.filter((event) => event.type === "error"),
    [{ type: "error", message: "Legacy connection failure" }],
  );
});

test("presents and accepts only command decisions offered by Codex", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let offered: readonly string[] | undefined;
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Run it",
      source: { type: "human" },
    })) {
      if (event.type !== "approval.requested") continue;
      offered = event.availableDecisions;
      await assert.rejects(
        adapter.approve(session, {
          requestId: event.requestId,
          decision: "allow_session",
        }),
        /not available/u,
      );
      await adapter.approve(session, {
        requestId: event.requestId,
        decision: "allow_once",
      });
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      availableDecisions: ["accept", "cancel"],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.deepEqual(offered, ["allow_once", "cancel"]);
  assert.deepEqual(server.approvalResponses, [{ id: 71, decision: "accept" }]);
});

test("cancels command approvals with no safely presentable decision", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const events: AgentEvent[] = [];
  const consuming = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Unsupported decision", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 72,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thr_1",
      turnId: "turn_1",
      itemId: "item_1",
      availableDecisions: [{ acceptWithExecpolicyAmendment: {} }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  events.push(...await consuming);

  assert.deepEqual(server.approvalResponses, [{ id: 72, decision: "cancel" }]);
  assert.equal(
    events.some(
      (event) =>
        event.type === "error" && event.code === "UNSUPPORTED_APPROVAL_DECISIONS",
    ),
    true,
  );
  assert.equal(events.some((event) => event.type === "approval.requested"), false);
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

test("normalizes failed Codex internal subagent lifecycle events", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Review locally", source: { type: "human" } },
    )) {
      events.push(event);
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("item/started", {
    threadId: "thr_1",
    turnId: "turn_1",
    item: {
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "inProgress",
      receiverThreadIds: [],
    },
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    item: {
      type: "collabAgentToolCall",
      id: "collab-1",
      tool: "spawnAgent",
      status: "failed",
      receiverThreadIds: [],
    },
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "failed" },
  });
  await consuming;

  assert.ok(events.some((event) =>
    event.type === "tool.started" &&
    event.toolCallId === "collab-1" &&
    event.name === "collabAgent"
  ));
  assert.ok(events.some((event) =>
    event.type === "tool.completed" &&
    event.toolCallId === "collab-1" &&
    event.isError === true
  ));
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

test("ends a silent active stream cleanly during intentional adapter shutdown", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { terminalWatchdogMs: 60_000 });
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Keep working", source: { type: "human" } },
    )) {
      events.push(event);
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));

  adapter.shutdown();
  await consuming;

  assert.ok(
    events.some(
      (event) => event.type === "status.changed" && event.status === "interrupted",
    ),
  );
  assert.deepEqual(server.interruptCalls, []);
});

test("bridges ordinary structured choices without projecting Git recovery", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const session = { id: "thr_1" };
  const choices: Array<Extract<AgentEvent, { type: "choice.requested" }>> = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstReady = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondReady = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "地形を選ぶ",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "choice.requested") continue;
      choices.push(event);
      if (choices.length === 1) releaseFirst();
      if (choices.length === 2) releaseSecond();
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 90,
    method: "item/tool/requestUserInput",
    params: ordinaryChoiceQuestion([
      ordinaryChoiceQuestion().questions[0]!,
      {
        id: "finish",
        header: "仕上げ",
        question: "表面の仕上げは？",
        isOther: true,
        isSecret: false,
        options: [
          { label: "粗い", description: "岩らしい表面" },
          { label: "滑らか", description: "簡素な表面" },
        ],
      },
    ]),
  });

  await new Promise((resolve) => setTimeout(resolve, 15));
  await firstReady;
  assert.equal(choices[0]?.question.header, "地形");
  assert.equal(choices[0]?.question.options[0]?.label, "砂漠盆地");
  assert.deepEqual(choices[0]?.completedAnswers, []);
  await adapter.respondToUserInput(session, {
    requestId: choices[0]!.requestId,
    answer: { questionId: "question_1", optionId: "option_1" },
  });

  await secondReady;
  assert.equal(choices[1]?.requestId, choices[0]?.requestId);
  assert.equal(choices[1]?.question.header, "仕上げ");
  assert.deepEqual(choices[1]?.completedAnswers, [{
    header: "地形",
    prompt: "どの地形を作りますか？",
    answers: ["砂漠盆地"],
  }]);
  await adapter.respondToUserInput(session, {
    requestId: choices[1]!.requestId,
    answer: { questionId: "question_2", text: "風化した岩肌" },
  });

  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.deepEqual(server.userInputResponses, [
    {
      id: 90,
      response: {
        answers: {
          terrain: { answers: ["砂漠盆地"] },
          finish: { answers: ["風化した岩肌"] },
        },
      },
    },
  ]);
  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
});

test("bridges non-blocking ordinary structured choices from current Codex normalization", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "通常の選択肢を表示する",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "choice.requested") continue;
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        answer: { questionId: event.question.id, optionId: "option_2" },
      });
      server.notify("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 904,
    method: "item/tool/requestUserInput",
    params: { ...ordinaryChoiceQuestion(), isBlocking: false },
  });
  await consuming;

  assert.ok(events.some((event) => event.type === "choice.requested"));
  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
  assert.deepEqual(server.errorResponses, []);
  assert.deepEqual(server.userInputResponses, [{
    id: 904,
    response: {
      answers: { terrain: { answers: ["乾燥岩盤平原"] } },
    },
  }]);
});

test("terminalizes a non-blocking ordinary choice when App Server resolves it first", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  let displayedRequestId = "";
  let releaseDisplayed!: () => void;
  let releaseResolved!: () => void;
  const displayed = new Promise<void>((resolve) => {
    releaseDisplayed = resolve;
  });
  const resolved = new Promise<void>((resolve) => {
    releaseResolved = resolve;
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "通常の選択肢を表示する",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "choice.requested") {
        displayedRequestId = event.requestId;
        releaseDisplayed();
      }
      if (event.type === "choice.resolved_externally") releaseResolved();
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 905,
    method: "item/tool/requestUserInput",
    params: { ...ordinaryChoiceQuestion(), isBlocking: false },
  });
  await displayed;
  server.notify("serverRequest/resolved", {
    threadId: "thr_1",
    requestId: 905,
  });
  await resolved;
  await assert.rejects(
    adapter.respondToUserInput(session, {
      requestId: displayedRequestId,
      answer: { questionId: "question_1", optionId: "option_1" },
    }),
    /Unknown structured input request/u,
  );
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  await consuming;

  assert.ok(events.some(
    (event) =>
      event.type === "choice.resolved_externally" &&
      event.requestId === displayedRequestId,
  ));
  assert.deepEqual(server.userInputResponses, []);
});

test("projects plan-less reserved labels as an ordinary external action", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 60_000 });
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  let releaseChoice!: () => void;
  const choiceReady = new Promise<void>((resolve) => {
    releaseChoice = resolve;
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "main保護を確認する",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "choice.requested") continue;
      assert.equal(event.question.header, "Git approval");
      assert.deepEqual(
        event.question.options.map((option) => option.label),
        ["承認して実行", "拒否・保留"],
      );
      releaseChoice();
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        answer: { questionId: event.question.id, optionId: "option_1" },
      });
      server.notify("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  const params = workspaceGitQuestion();
  const question = params.questions[0];
  assert.ok(question);
  server.request({
    id: 902,
    method: "item/tool/requestUserInput",
    params: {
      ...params,
      questions: [{ ...question, id: "main_protection" }],
    },
  });
  await Promise.race([
    choiceReady,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("ordinary choice waited for a Git plan")),
        250,
      ).unref();
    }),
  ]);
  await consuming;

  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "user_input.requested"),
    false,
  );
  assert.deepEqual(server.errorResponses, []);
  assert.deepEqual(server.userInputResponses, [{
    id: 902,
    response: {
      answers: { main_protection: { answers: ["承認して実行"] } },
    },
  }]);
});

test("keeps an exact plan on the Git path with an ordinary question ID", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "公開計画を確認する",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "user_input.requested") continue;
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        optionId: "reject",
      });
      server.notify("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  const params = workspaceGitQuestion();
  const question = params.questions[0];
  assert.ok(question);
  server.request({
    id: 903,
    method: "item/tool/requestUserInput",
    params: {
      ...params,
      questions: [{ ...question, id: "publication_confirmation" }],
    },
  });
  await consuming;

  assert.equal(events.some((event) => event.type === "choice.requested"), false);
  assert.ok(events.some((event) => event.type === "user_input.requested"));
  assert.deepEqual(server.userInputResponses, [{
    id: 903,
    response: {
      answers: { publication_confirmation: { answers: ["拒否・保留"] } },
    },
  }]);
});

test("keeps ordinary questions about Git approval on the choice path", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "公開範囲を確認する",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "choice.requested") continue;
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        answer: { questionId: event.question.id, optionId: "option_1" },
      });
      server.notify("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 901,
    method: "item/tool/requestUserInput",
    params: ordinaryChoiceQuestion([
      {
        id: "publication_scope",
        header: "AGENTS公開",
        question: "Git承認フローの安全規則も公開対象に含めますか？",
        isOther: false,
        isSecret: false,
        options: [
          { label: "公開に含める", description: "安全規則を含める" },
          { label: "公開から除外", description: "今回は含めない" },
        ],
      },
    ]),
  });

  await consuming;

  assert.ok(events.some((event) => event.type === "choice.requested"));
  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
  assert.deepEqual(server.userInputResponses, [
    {
      id: 901,
      response: {
        answers: { publication_scope: { answers: ["公開に含める"] } },
      },
    },
  ]);
});

test("rejects secret ordinary input without showing Git recovery", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Ask safely", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 91,
    method: "item/tool/requestUserInput",
    params: ordinaryChoiceQuestion([
      {
        ...ordinaryChoiceQuestion().questions[0],
        id: "secret",
        isSecret: true,
      },
    ]),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.equal(server.errorResponses[0]?.id, 91);
  assert.match(server.errorResponses[0]?.message ?? "", /UNSUPPORTED_STRUCTURED_INPUT/u);
  assert.ok(events.some(
    (event) => event.type === "error" && event.code === "UNSUPPORTED_STRUCTURED_INPUT",
  ));
  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
});

test("rejects a malformed approval bound to an exact Git plan without offering recovery", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Publish safely", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 92,
    method: "item/tool/requestUserInput",
    params: { ...ordinaryChoiceQuestion(), isBlocking: true },
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
  assert.ok(events.some(
    (event) =>
      event.type === "error" &&
      event.code === "INVALID_GIT_APPROVAL_REQUEST",
  ));
  assert.equal(events.some((event) => event.type === "choice.requested"), false);
  assert.match(
    server.errorResponses[0]?.message ?? "",
    /INVALID_GIT_APPROVAL_REQUEST.*unsupported choices/u,
  );
});

test("does not reopen Git approval in the same turn after a malformed exact request", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not retry malformed approval", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));

  notifyPublicationPlan(server);
  server.request({
    id: 922,
    method: "item/tool/requestUserInput",
    params: { ...ordinaryChoiceQuestion(), isBlocking: true },
  });

  notifyPublicationPlan(server, {
    itemId: "mcp-plan-after-malformed",
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  server.request({
    id: 923,
    method: "item/tool/requestUserInput",
    params: { ...workspaceGitQuestion(), itemId: "request-after-malformed" },
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.equal(
    events.filter((event) =>
      event.type === "error" && event.code === "INVALID_GIT_APPROVAL_REQUEST"
    ).length,
    1,
  );
  assert.equal(
    events.some((event) => event.type === "user_input.requested"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
  assert.match(
    server.errorResponses.find((response) => response.id === 923)?.message ?? "",
    /INVALID_GIT_APPROVAL_REQUEST.*already terminated this turn/u,
  );
});

test("accepts an exact Git approval when App Server omits schema-default fields", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Publish with schema defaults omitted",
      source: { type: "human" },
    })) {
      if (event.type !== "user_input.requested") continue;
      requested = event;
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        optionId: "reject",
      });
      server.notify("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  const params = workspaceGitQuestion();
  server.request({
    id: 921,
    method: "item/tool/requestUserInput",
    params: {
      ...params,
      autoResolutionMs: undefined,
      questions: params.questions.map((question) => ({
        ...question,
        isOther: undefined,
        isSecret: undefined,
      })),
    },
  });
  await consuming;

  assert.equal(requested?.plan.operationId, "11111111-1111-4111-8111-111111111111");
  assert.equal(server.errorResponses.length, 0);
  assert.deepEqual(server.userInputResponses, [{
    id: 921,
    response: {
      answers: { git_approval: { answers: ["拒否・保留"] } },
    },
  }]);
});

test("accepts current Default-mode App Server flags without weakening Git approval", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Publish with current request_user_input normalization",
      source: { type: "human" },
    })) {
      if (event.type !== "user_input.requested") continue;
      requested = event;
      await adapter.respondToUserInput(session, {
        requestId: event.requestId,
        optionId: "reject",
      });
      server.notify("turn/completed", {
        threadId: "thr_1",
        turn: { id: "turn_1", status: "completed" },
      });
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  const params = workspaceGitQuestion();
  server.request({
    id: 922,
    method: "item/tool/requestUserInput",
    params: {
      ...params,
      isBlocking: false,
      questions: params.questions.map((question) => ({
        ...question,
        isOther: true,
      })),
    },
  });
  await consuming;

  assert.deepEqual(requested?.options, [
    { id: "approve", label: "承認して実行" },
    { id: "reject", label: "拒否・保留" },
  ]);
  assert.equal(server.errorResponses.length, 0);
  assert.deepEqual(server.userInputResponses, [{
    id: 922,
    response: {
      answers: { git_approval: { answers: ["拒否・保留"] } },
    },
  }]);
});

test("terminates a malformed Git-looking approval without offering recovery", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { gitPlanBindingGraceMs: 10 });
  const eventsPromise = collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Publish safely", source: { type: "human" } },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 93,
    method: "item/tool/requestUserInput",
    params: ordinaryChoiceQuestion([
      {
        id: "git_approval",
        header: "Git publication approval",
        question: "このGit planを承認しますか？",
        isOther: false,
        isSecret: false,
        options: [
          { label: " 承認して実行 ", description: "実行する" },
          { label: "後で", description: "今は実行しない" },
          { label: "拒否", description: "実行しない" },
        ],
      },
    ]),
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: { id: "turn_1", status: "completed" },
  });
  const events = await eventsPromise;

  assert.equal(
    events.some((event) => event.type === "git_approval.reprepare_required"),
    false,
  );
  assert.ok(events.some(
    (event) =>
      event.type === "error" &&
      event.code === "INVALID_GIT_APPROVAL_REQUEST",
  ));
  assert.equal(events.some((event) => event.type === "choice.requested"), false);
  assert.match(
    server.errorResponses[0]?.message ?? "",
    /INVALID_GIT_APPROVAL_REQUEST/u,
  );
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
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem()],
    },
  });
  await consuming;
  assert.equal(server.turnStarts.length, 1);
});

test("rejects a second same-turn Git approval while the first execution is unfinished", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const requests: Extract<AgentEvent, { type: "user_input.requested" }>[] = [];
  let releaseFirstRequest!: () => void;
  const firstRequestReady = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Publish one exact plan",
      source: { type: "human" },
    })) {
      if (event.type !== "user_input.requested") continue;
      requests.push(event);
      if (requests.length === 1) releaseFirstRequest();
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 811,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await firstRequestReady;
  await adapter.respondToUserInput(session, {
    requestId: requests[0]?.requestId ?? "",
    optionId: "approve",
  });

  notifyPublicationPlan(server, {
    itemId: "mcp-plan-2",
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  server.request({
    id: 812,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.match(
    server.errorResponses.find((response) => response.id === 812)?.message ?? "",
    /CONCURRENT_GIT_APPROVAL_NOT_SUPPORTED/u,
  );

  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem({ outcomeStatus: "succeeded" })],
    },
  });
  await consuming;
  assert.equal(server.turnStarts.length, 1);
});

test("accepts a second same-turn Git approval after the first exact execution succeeds", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const requests: Extract<AgentEvent, { type: "user_input.requested" }>[] = [];
  let releaseSecondRequest!: () => void;
  const secondRequestReady = new Promise<void>((resolve) => {
    releaseSecondRequest = resolve;
  });
  const consuming = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of adapter.sendMessage(session, {
      text: "Publish two exact plans sequentially",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "user_input.requested") continue;
      requests.push(event);
      if (requests.length === 2) releaseSecondRequest();
    }
    return events;
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 813,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  while (requests.length < 1) await new Promise((resolve) => setImmediate(resolve));
  await adapter.respondToUserInput(session, {
    requestId: requests[0]?.requestId ?? "",
    optionId: "approve",
  });
  notifyPublicationExecution(server);

  notifyPublicationPlan(server, {
    itemId: "mcp-plan-2",
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  server.request({
    id: 814,
    method: "item/tool/requestUserInput",
    params: { ...workspaceGitQuestion(), itemId: "request-input-2" },
  });
  await secondRequestReady;
  await adapter.respondToUserInput(session, {
    requestId: requests[1]?.requestId ?? "",
    optionId: "reject",
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem()],
    },
  });
  const events = await consuming;

  assert.equal(requests.length, 2);
  assert.equal(
    server.errorResponses.some((response) => response.id === 814),
    false,
  );
  assert.equal(
    events.some((event) =>
      event.type === "error" &&
      event.code === "CONCURRENT_GIT_APPROVAL_NOT_SUPPORTED"
    ),
    false,
  );
  assert.equal(
    requests[1]?.plan.operationId,
    "22222222-2222-4222-8222-222222222222",
  );
});

test("rejects a completed operation before projecting another approval UI", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  const requests: Extract<AgentEvent, { type: "user_input.requested" }>[] = [];
  let releaseFirstRequest!: () => void;
  const firstRequestReady = new Promise<void>((resolve) => {
    releaseFirstRequest = resolve;
  });
  const consuming = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of adapter.sendMessage(session, {
      text: "Do not replay a completed Git operation",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type !== "user_input.requested") continue;
      requests.push(event);
      if (requests.length === 1) releaseFirstRequest();
    }
    return events;
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 818,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await firstRequestReady;
  await adapter.respondToUserInput(session, {
    requestId: requests[0]?.requestId ?? "",
    optionId: "approve",
  });
  notifyPublicationExecution(server);

  notifyPublicationPlan(server, { itemId: "mcp-plan-replayed" });
  server.request({
    id: 819,
    method: "item/tool/requestUserInput",
    params: { ...workspaceGitQuestion(), itemId: "request-input-replayed" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem()],
    },
  });
  const events = await consuming;

  assert.equal(requests.length, 1);
  assert.match(
    server.errorResponses.find((response) => response.id === 819)?.message ?? "",
    /GIT_APPROVAL_OPERATION_ALREADY_COMPLETED/u,
  );
  assert.ok(events.some((event) =>
    event.type === "error" &&
    event.code === "GIT_APPROVAL_OPERATION_ALREADY_COMPLETED"
  ));
});

test("projects and completes an exact GitHub repository settings approval", async () => {
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
      text: "Update the repository settings",
      source: { type: "human" },
    })) {
      if (event.type === "user_input.requested") {
        requested = event;
        releaseRequest();
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyRepositorySettingsPlan(server);
  server.request({
    id: 815,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await requestReady;
  assert.equal(requested?.plan.operation, "github_repository_settings");
  await adapter.respondToUserInput(session, {
    requestId: requested?.requestId ?? "",
    optionId: "approve",
  });
  server.notify("item/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    item: repositorySettingsExecutionItem(),
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [repositorySettingsExecutionItem()],
    },
  });
  await consuming;
  assert.deepEqual(server.userInputResponses.at(-1), {
    id: 815,
    response: {
      answers: { git_approval: { answers: ["承認して実行"] } },
    },
  });
});

test("continues one bounded turn when an approved Git plan was not executed", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  let releaseRequest!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const consuming = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of adapter.sendMessage(session, {
      text: "Publish after approval",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "user_input.requested") {
        requested = event;
        releaseRequest();
      }
    }
    return events;
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 94,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await requestReady;
  await adapter.respondToUserInput(session, {
    requestId: requested?.requestId ?? "",
    optionId: "approve",
  });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.turnStarts.length, 2);
  const continuationInput = server.turnStarts[1]?.input[0];
  assert.equal(continuationInput?.type, "text");
  if (continuationInput?.type !== "text") {
    throw new Error("Git continuation did not use a text input");
  }
  assert.match(
    continuationInput.text,
    /Continue the exact workspace-git operation already approved/u,
  );
  const continuation = server.turnStarts[1]?.additionalContext?.[
    "showtalk_taishi.git_approval_continuation"
  ];
  assert.equal(continuation?.kind, "application");
  assert.match(continuation?.value ?? "", /11111111-1111-4111-8111-111111111111/u);
  assert.match(continuation?.value ?? "", /"planHash":"a{64}"/u);
  assert.deepEqual(
    JSON.parse(continuation?.value.split("\n").at(-1) ?? "null"),
    requested?.plan,
  );

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_2",
    turn: {
      id: "turn_2",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem({ server: "workspace_git" })],
    },
  });
  const events = await consuming;
  assert.equal(
    events.some(
      (event) => event.type === "error" &&
        event.code === "GIT_APPROVAL_EXECUTION_NOT_OBSERVED",
    ),
    false,
  );
});

test("hydrates a summarized approved turn before starting its bounded continuation", async () => {
  const server = new FakeAppServer();
  server.hydratedTurns.set("turn_1", {
    id: "turn_1",
    status: "completed",
    itemsView: "full",
    items: [],
  });
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 108);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "summary",
      items: [],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.listTurnsParams[0]?.itemsView, "full");
  assert.equal(server.turnStarts.length, 2);
  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_2",
    turn: {
      id: "turn_2",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem()],
    },
  });
  const events = await eventsPromise;
  assert.equal(
    events.some(
      (event) =>
        event.type === "error" &&
        event.code === "GIT_APPROVAL_FINAL_STATE_INCOMPLETE",
    ),
    false,
  );
});

test("hydrates a summarized approved turn through legacy thread/read compatibility", async () => {
  const server = new FakeAppServer();
  server.rejectExcludeTurnsAsUnsupported = true;
  server.hydratedTurns.set("turn_1", {
    id: "turn_1",
    status: "completed",
    itemsView: "full",
    items: [],
  });
  const adapter = new CodexAdapter(server);
  await adapter.resumeSession({
    adapterSessionId: "thr_1",
    agent: {
      id: "implementer",
      adapter: "codex",
      channelId: "C123",
    },
  });
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 109);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "summary",
      items: [],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.listTurnsCalls, 0);
  assert.ok(server.readThreadIncludeTurns.includes(true));
  assert.equal(server.turnStarts.length, 2);
  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_2",
    turn: {
      id: "turn_2",
      status: "completed",
      itemsView: "full",
      items: [publicationExecutionItem()],
    },
  });
  const events = await eventsPromise;
  assert.equal(
    events.some(
      (event) =>
        event.type === "error" &&
        event.code === "GIT_APPROVAL_FINAL_STATE_INCOMPLETE",
    ),
    false,
  );
});

test("uses a hydrated execution result instead of starting a duplicate continuation", async () => {
  const server = new FakeAppServer();
  server.hydratedTurns.set("turn_1", {
    id: "turn_1",
    status: "completed",
    itemsView: "full",
    items: [publicationExecutionItem()],
  });
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 110);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "summary",
      items: [],
    },
  });
  const events = await eventsPromise;

  assert.equal(server.turnStarts.length, 1);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("audits a hydrated final snapshot after live execution already succeeded", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 111);
  notifyPublicationExecution(server);
  server.hydratedTurns.set("turn_1", {
    id: "turn_1",
    status: "completed",
    itemsView: "full",
    items: [
      publicationExecutionItem(),
      publicationExecutionItem({ itemId: "mcp-execute-replay" }),
    ],
  });

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "summary",
      items: [],
    },
  });
  const events = await eventsPromise;

  assert.ok(events.some((event) =>
    event.type === "error" && event.code === "GIT_APPROVAL_EXECUTION_REPLAY"
  ));
});

test("rolls back execution watching when the App Server answer cannot be sent", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requestId = "";
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
        requestId = event.requestId;
        releaseRequest();
      }
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 101,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await requestReady;
  server.userInputResponseError = new Error("answer transport failed");

  await assert.rejects(
    adapter.respondToUserInput(session, { requestId, optionId: "approve" }),
    /answer transport failed/u,
  );
  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
  });
  await consuming;
  assert.equal(server.turnStarts.length, 1);
});

test("stops after one approved Git continuation without an execute call", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const session = { id: "thr_1" };
  let requestId = "";
  let releaseRequest!: () => void;
  const requestReady = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const consuming = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of adapter.sendMessage(session, {
      text: "Publish after approval",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "user_input.requested") {
        requestId = event.requestId;
        releaseRequest();
      }
    }
    return events;
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 95,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await requestReady;
  await adapter.respondToUserInput(session, { requestId, optionId: "approve" });
  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_2",
    turn: { id: "turn_2", status: "completed", itemsView: "full", items: [] },
  });

  const events = await consuming;
  assert.equal(server.turnStarts.length, 2);
  assert.ok(events.some(
    (event) => event.type === "error" &&
      event.code === "GIT_APPROVAL_EXECUTION_NOT_OBSERVED",
  ));
});

test("fails visibly when the bounded continuation turn cannot start", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    if (server.turnStarts.length === 1) {
      return { id: "turn_1", status: "inProgress" };
    }
    throw new Error("continuation start failed");
  };
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 102);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
  });

  await assert.rejects(eventsPromise, /continuation start failed/u);
  assert.equal(server.turnStarts.length, 2);
});

test("accepts a continuation completion announced before turn start responds", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    if (server.turnStarts.length === 1) {
      return { id: "turn_1", status: "inProgress" };
    }
    server.notify("turn/completed", {
      threadId: "thr_1",
      turnId: "turn_2",
      turn: {
        id: "turn_2",
        status: "completed",
        itemsView: "full",
        items: [publicationExecutionItem()],
      },
    });
    return { id: "turn_2", status: "completed" };
  };
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 103);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
  });
  const events = await eventsPromise;

  assert.equal(server.turnStarts.length, 2);
  assert.equal(
    events.some(
      (event) => event.type === "error" &&
        event.code === "GIT_APPROVAL_EXECUTION_NOT_OBSERVED",
    ),
    false,
  );
});

test("does not continue a Git operation already in a terminal status", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 96);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [publicationStatusItem("applied")],
    },
  });
  const events = await eventsPromise;

  assert.equal(server.turnStarts.length, 1);
  assert.equal(
    events.some((event) => event.type === "error"),
    false,
  );
});

test("does not retry an execute call that ended failed or in progress", async () => {
  for (const executionStatus of ["failed", "inProgress"] as const) {
    const server = new FakeAppServer();
    const adapter = new CodexAdapter(server);
    const { eventsPromise } = await beginApprovedPublication(
      server,
      adapter,
      executionStatus === "failed" ? 97 : 98,
    );
    const item = {
      ...publicationExecutionItem(),
      status: executionStatus,
      ...(executionStatus === "failed"
        ? { error: { message: "execution failed" } }
        : { result: null }),
    };

    server.notify("turn/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      turn: {
        id: "turn_1",
        status: "completed",
        itemsView: "full",
        items: [item],
      },
    });
    const events = await eventsPromise;

    assert.equal(server.turnStarts.length, 1);
    assert.ok(events.some(
      (event) => event.type === "error" &&
        event.code === "GIT_APPROVAL_EXECUTION_INCOMPLETE",
    ));
  }
});

test("surfaces non-applied workspace-git execution outcomes", async () => {
  for (const [index, outcomeStatus] of [
    "partial",
    "failed",
    "outcome_uncertain",
  ].entries()) {
    const server = new FakeAppServer();
    const adapter = new CodexAdapter(server);
    const { eventsPromise } = await beginApprovedPublication(
      server,
      adapter,
      104 + index,
    );

    server.notify("turn/completed", {
      threadId: "thr_1",
      turnId: "turn_1",
      turn: {
        id: "turn_1",
        status: "completed",
        itemsView: "full",
        items: [publicationExecutionItem({ outcomeStatus })],
      },
    });
    const events = await eventsPromise;

    assert.equal(server.turnStarts.length, 1);
    assert.ok(events.some(
      (event) => event.type === "error" &&
        event.code === "GIT_APPROVAL_EXECUTION_INCOMPLETE",
    ));
  }
});

test("does not continue without a complete terminal turn snapshot", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 99);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "summary",
      items: [],
    },
  });
  const events = await eventsPromise;

  assert.equal(server.turnStarts.length, 1);
  assert.ok(events.some(
    (event) => event.type === "error" &&
      event.code === "GIT_APPROVAL_FINAL_STATE_INCOMPLETE",
  ));
});

test("reports two exact execute item IDs without attempting a continuation", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server);
  const { eventsPromise } = await beginApprovedPublication(server, adapter, 100);

  server.notify("turn/completed", {
    threadId: "thr_1",
    turnId: "turn_1",
    turn: {
      id: "turn_1",
      status: "completed",
      itemsView: "full",
      items: [
        publicationExecutionItem({ itemId: "execute-a" }),
        publicationExecutionItem({ itemId: "execute-b" }),
      ],
    },
  });
  const events = await eventsPromise;

  assert.equal(server.turnStarts.length, 1);
  assert.ok(events.some(
    (event) => event.type === "error" &&
      event.code === "GIT_APPROVAL_EXECUTION_REPLAY",
  ));
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

test("durably closes a late Git plan after its waiting request was resolved externally", async () => {
  const server = new FakeAppServer();
  const recordedPlans: WorkspaceGitApprovalPlan[] = [];
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const adapter = new CodexAdapter(server, {
    recordExternallyResolvedGitPlan: async (plan) => {
      recordedPlans.push(plan);
      await persistenceGate;
    },
  });
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Publish after transport reordering", source: { type: "human" } },
    )) {
      events.push(event);
      if (event.type === "git_approval.resolved_externally") {
        server.notify("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 891,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  server.notify("serverRequest/resolved", {
    threadId: "thr_1",
    requestId: 891,
  });
  notifyPublicationPlan(server);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recordedPlans.length, 1);
  assert.equal(
    events.some((event) => event.type === "git_approval.resolved_externally"),
    false,
  );
  releasePersistence();
  await consuming;

  const resolved = events.filter(
    (event): event is Extract<AgentEvent, {
      type: "git_approval.resolved_externally";
    }> => event.type === "git_approval.resolved_externally",
  );
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.systemRejectionRecorded, true);
  assert.equal(
    resolved[0]?.plan.operationId,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    events.some((event) => event.type === "user_input.requested"),
    false,
  );
  assert.deepEqual(server.userInputResponses, []);
  assert.deepEqual(server.errorResponses, []);
});

test("durably closes every delayed plan after one waiting request was resolved externally", async () => {
  const server = new FakeAppServer();
  const recordedPlans: WorkspaceGitApprovalPlan[] = [];
  const adapter = new CodexAdapter(server, {
    recordExternallyResolvedGitPlan: async (plan) => {
      recordedPlans.push(plan);
    },
  });
  const resolvedPlans: WorkspaceGitApprovalPlan[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Reject every ambiguous publication", source: { type: "human" } },
    )) {
      if (event.type !== "git_approval.resolved_externally") continue;
      resolvedPlans.push(event.plan);
      if (resolvedPlans.length === 3) {
        server.notify("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  server.request({
    id: 892,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  server.notify("serverRequest/resolved", {
    threadId: "thr_1",
    requestId: 892,
  });
  notifyPublicationPlan(server, {
    itemId: "mcp-plan-delayed-1",
    operationId: "11111111-1111-4111-8111-111111111111",
    planHash: "1".repeat(64),
  });
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server, {
    itemId: "mcp-plan-delayed-2",
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "2".repeat(64),
  });
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server, {
    itemId: "mcp-plan-delayed-3",
    operationId: "33333333-3333-4333-8333-333333333333",
    planHash: "3".repeat(64),
  });
  await consuming;

  assert.deepEqual(
    recordedPlans.map((plan) => plan.operationId),
    [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ],
  );
  assert.deepEqual(
    resolvedPlans.map((plan) => plan.operationId),
    recordedPlans.map((plan) => plan.operationId),
  );
  assert.deepEqual(server.userInputResponses, []);
  assert.deepEqual(server.errorResponses, []);
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
    /No exact workspace-git plan is bound to this structured request/u,
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
  let expiredRequestId: string | undefined;
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Wait for approval",
      source: { type: "human" },
    })) {
      if (event.type === "git_approval.expired") {
        expiredRequestId = event.requestId;
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

  assert.match(expiredRequestId ?? "", /^codex-input:/u);
  assert.deepEqual(server.userInputResponses, [
    {
      id: 83,
      response: {
        answers: { git_approval: { answers: ["拒否・保留"] } },
      },
    },
  ]);
});

test("emits a terminal Git lifecycle event when another App Server client resolves the request", async () => {
  const server = new FakeAppServer();
  const recordedPlans: WorkspaceGitApprovalPlan[] = [];
  let releasePersistence!: () => void;
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  const adapter = new CodexAdapter(server, {
    recordExternallyResolvedGitPlan: async (plan) => {
      recordedPlans.push(plan);
      await persistenceGate;
    },
  });
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  let slackRequestId: string | undefined;
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(session, {
      text: "Wait for an external decision",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "user_input.requested") {
        slackRequestId = event.requestId;
        server.notify("serverRequest/resolved", {
          threadId: "thr_1",
          requestId: 890,
        });
      }
      if (event.type === "git_approval.resolved_externally") {
        server.notify("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
        });
      }
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 890,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recordedPlans.length, 1);
  assert.equal(
    events.some((event) => event.type === "git_approval.resolved_externally"),
    false,
  );
  releasePersistence();
  await consuming;

  const resolved = events.find(
    (event): event is Extract<AgentEvent, {
      type: "git_approval.resolved_externally";
    }> => event.type === "git_approval.resolved_externally",
  );
  assert.ok(resolved);
  assert.equal(resolved?.systemRejectionRecorded, true);
  assert.equal(resolved?.requestId, slackRequestId);
  assert.equal(
    resolved?.plan.operationId,
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(server.userInputResponses, []);
  await adapter.respondToUserInput(session, {
    requestId: slackRequestId ?? "missing",
    optionId: "reject",
    plan: resolved.plan,
  });
  await adapter.respondToUserInput(session, {
    requestId: slackRequestId ?? "missing",
    optionId: "reject",
    plan: resolved.plan,
  });
  await assert.rejects(
    adapter.respondToUserInput(session, {
      requestId: slackRequestId ?? "missing",
      optionId: "reject",
      plan: { ...resolved.plan, planHash: "f".repeat(64) },
    }),
    /Unknown structured input request/u,
  );
  await assert.rejects(
    adapter.respondToUserInput(session, {
      requestId: slackRequestId ?? "missing",
      optionId: "approve",
    }),
    /Unknown structured input request/u,
  );
});

test("automatically retries an externally resolved plan until rejection is durable", async () => {
  const server = new FakeAppServer();
  let attempts = 0;
  const adapter = new CodexAdapter(server, {
    recordExternallyResolvedGitPlan: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("state write failed");
    },
    externalGitRejectionRetryMs: 1,
  });
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Keep the rejected plan until persistence recovers", source: { type: "human" } },
    )) {
      if (event.type === "user_input.requested") {
        server.notify("serverRequest/resolved", {
          threadId: "thr_1",
          requestId: 893,
        });
      }
      if (event.type === "git_approval.resolved_externally") {
        server.notify("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 893,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await consuming;

  assert.equal(attempts, 3);
  assert.deepEqual(server.userInputResponses, []);
});

test("does not finish shutdown while an external Git rejection is not durable", async () => {
  const server = new FakeAppServer();
  let attempts = 0;
  let persistenceAvailable = false;
  const adapter = new CodexAdapter(server, {
    recordExternallyResolvedGitPlan: async () => {
      attempts += 1;
      if (!persistenceAvailable) throw new Error("state write unavailable");
    },
    externalGitRejectionRetryMs: 1,
  });
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not drop the rejected plan during shutdown", source: { type: "human" } },
    )) {
      events.push(event);
      if (event.type === "user_input.requested") {
        server.notify("serverRequest/resolved", {
          threadId: "thr_1",
          requestId: 894,
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 894,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  while (attempts < 2) await new Promise((resolve) => setTimeout(resolve, 1));

  adapter.shutdown();
  let shutdownSettled = false;
  const shutdownWait = adapter.waitForSystemRejections().then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(shutdownSettled, false);
  assert.equal(
    events.some((event) => event.type === "git_approval.resolved_externally"),
    false,
  );

  persistenceAvailable = true;
  await shutdownWait;
  await consuming;
  assert.ok(attempts >= 3);
});

test("expires an external Git rejection instead of blocking shutdown forever", async () => {
  const server = new FakeAppServer();
  let attempts = 0;
  const adapter = new CodexAdapter(server, {
    recordExternallyResolvedGitPlan: async () => {
      attempts += 1;
      throw new Error("state write remains unavailable");
    },
    externalGitRejectionRetryMs: 1,
  });
  const session = { id: "thr_1" };
  const events: AgentEvent[] = [];
  let requested: Extract<AgentEvent, { type: "user_input.requested" }> | undefined;
  const consuming = (async () => {
    for await (const event of adapter.sendMessage(
      session,
      { text: "Stop retrying after exact expiry", source: { type: "human" } },
    )) {
      events.push(event);
      if (event.type === "user_input.requested") {
        requested = event;
        server.notify("serverRequest/resolved", {
          threadId: "thr_1",
          requestId: 895,
        });
      }
      if (event.type === "git_approval.expired") {
        server.notify("turn/completed", {
          threadId: "thr_1",
          turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
        });
      }
    }
  })();

  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server, {
    expiresAt: new Date(Date.now() + 20).toISOString(),
  });
  server.request({
    id: 895,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  await consuming;
  await adapter.waitForSystemRejections();

  assert.ok(attempts >= 1);
  assert.ok(events.some((event) => event.type === "git_approval.expired"));
  assert.equal(
    events.some((event) => event.type === "git_approval.resolved_externally"),
    false,
  );
  assert.ok(requested);
  await assert.rejects(
    adapter.respondToUserInput(session, {
      requestId: requested.requestId,
      optionId: "approve",
      plan: requested.plan,
    }),
    /Unknown structured input request/u,
  );
  adapter.shutdown();
  await adapter.waitForSystemRejections();
});

test("allows a fresh exact approval in the same turn after the previous one expires", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { approvalTimeoutMs: 10 });
  const session = { id: "thr_1" };
  const requests: Extract<AgentEvent, { type: "user_input.requested" }>[] = [];
  let freshPlanSent = false;
  const consuming = (async () => {
    const events: AgentEvent[] = [];
    for await (const event of adapter.sendMessage(session, {
      text: "Retry the exact plan after expiry",
      source: { type: "human" },
    })) {
      events.push(event);
      if (event.type === "user_input.requested") {
        requests.push(event);
        if (requests.length === 2) {
          await adapter.respondToUserInput(session, {
            requestId: event.requestId,
            optionId: "reject",
          });
          server.notify("turn/completed", {
            threadId: "thr_1",
            turn: { id: "turn_1", status: "completed", itemsView: "full", items: [] },
          });
        }
      }
      if (event.type === "git_approval.expired" && !freshPlanSent) {
        freshPlanSent = true;
        notifyPublicationPlan(server, {
          itemId: "mcp-plan-after-expiry",
          operationId: "22222222-2222-4222-8222-222222222222",
          planHash: "d".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        server.request({
          id: 816,
          method: "item/tool/requestUserInput",
          params: { ...workspaceGitQuestion(), itemId: "request-after-expiry" },
        });
      }
    }
    return events;
  })();
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 817,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });
  const events = await consuming;

  assert.equal(requests.length, 2);
  assert.equal(
    requests[1]?.plan.operationId,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.equal(requests[1]?.plan.planHash, "d".repeat(64));
  assert.equal(
    events.some((event) =>
      event.type === "error" &&
      event.code === "CONCURRENT_GIT_APPROVAL_NOT_SUPPORTED"
    ),
    false,
  );
  assert.equal(
    server.errorResponses.some((response) => response.id === 816),
    false,
  );
});

test("projects an expired Git approval before a rejection transport failure", async () => {
  const server = new FakeAppServer();
  const adapter = new CodexAdapter(server, { approvalTimeoutMs: 10 });
  server.userInputResponseError = new Error("expiry rejection transport failed");
  const events: AgentEvent[] = [];
  const consuming = (async () => {
    try {
      for await (const event of adapter.sendMessage(
        { id: "thr_1" },
        { text: "Wait for approval", source: { type: "human" } },
      )) {
        events.push(event);
      }
      return undefined;
    } catch (error) {
      return error;
    }
  })();
  await new Promise((resolve) => setImmediate(resolve));
  notifyPublicationPlan(server);
  server.request({
    id: 84,
    method: "item/tool/requestUserInput",
    params: workspaceGitQuestion(),
  });

  const error = await consuming;

  assert.match(String(error), /expiry rejection transport failed/u);
  assert.equal(
    events.some((event) => event.type === "git_approval.expired"),
    true,
  );
  assert.deepEqual(server.userInputResponses, []);
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
  assert.equal(server.readCalls, 1, "preflight should read thread metadata once");
  assert.equal(server.listTurnsCalls, 1, "watchdog should page exact turn state");
  assert.equal(events.at(-1)?.type, "status.changed");
});

test("retries a transient thread status failure without ending the stream", async () => {
  const server = new FakeAppServer();
  server.threadStatusType = "idle";
  server.startTurnBehavior = async () => {
    server.listTurnsFailures = 1;
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
  assert.equal(server.readCalls, 1);
  assert.equal(server.listTurnsCalls, 2);
  assert.equal(events.at(-1)?.type, "status.changed");
});

test("falls back to aggregate status when turn pagination is unavailable", async () => {
  const server = new FakeAppServer();
  server.threadStatusType = "idle";
  server.rejectTurnPaginationAsUnsupported = true;
  const adapter = new CodexAdapter(server, { terminalWatchdogMs: 5 });

  const events = await collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Finish on a backend without paginated turn reads", source: { type: "human" } },
    ),
  );

  assert.equal(server.listTurnsCalls, 1);
  assert.equal(server.readCalls, 2);
  const terminal = events.at(-1);
  assert.equal(
    terminal?.type === "status.changed" ? terminal.status : undefined,
    "idle",
  );
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("fails closed after bounded exact-turn reconciliation misses", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => ({ id: "turn_missing", status: "inProgress" });
  const adapter = new CodexAdapter(server, {
    terminalWatchdogMs: 2,
    terminalWatchdogMaxRetries: 2,
  });

  const events = await collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not wait forever", source: { type: "human" } },
    ),
  );

  assert.deepEqual(server.interruptCalls, [
    { threadId: "thr_1", turnId: "turn_missing" },
  ]);
  assert.equal(
    events.some(
      (event) =>
        event.type === "error" &&
        event.code === "CODEX_TURN_RECONCILIATION_FAILED",
    ),
    true,
  );
  const terminal = events.at(-1);
  assert.equal(
    terminal?.type === "status.changed" ? terminal.status : undefined,
    "failed",
  );
});

test("reconciles the exact owned turn even while the thread aggregate is active", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    server.threadStatusType = "active";
    server.turnStatuses.set("turn_1", "completed");
    return { id: "turn_1", status: "inProgress" };
  };
  const adapter = new CodexAdapter(server, { terminalWatchdogMs: 5 });

  const events = await collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Track only my turn", source: { type: "human" } },
    ),
  );

  const terminal = events.at(-1);
  assert.equal(terminal?.type, "status.changed");
  assert.equal(
    terminal?.type === "status.changed" ? terminal.status : undefined,
    "idle",
  );
});

test("does not treat an idle thread aggregate as proof that the owned turn ended", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    server.turnStatuses.set("turn_1", "inProgress");
    setTimeout(() => {
      server.turnStatuses.set("turn_1", "completed");
    }, 20);
    return { id: "turn_1", status: "inProgress" };
  };
  const adapter = new CodexAdapter(server, { terminalWatchdogMs: 5 });

  const events = await collectEvents(
    adapter.sendMessage(
      { id: "thr_1" },
      { text: "Do not close early", source: { type: "human" } },
    ),
  );

  assert.ok(server.listTurnsCalls >= 3);
  const terminal = events.at(-1);
  assert.equal(terminal?.type === "status.changed" ? terminal.status : undefined, "idle");
});

test("does not interrupt a turn announced while turn/start ownership is ambiguous", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async () => {
    server.threadStatusType = "active";
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
  assert.deepEqual(server.interruptCalls, []);
  assert.equal(server.closed, true);
});

test("interrupts only an ambiguous turn proven by clientUserMessageId", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async (params) => {
    server.threadStatusType = "active";
    server.notify("turn/started", {
      threadId: "thr_1",
      turn: {
        id: "turn_owned",
        status: "inProgress",
        items: [{
          type: "userMessage",
          id: "user-owned",
          clientId: params.clientUserMessageId,
          content: [],
        }],
      },
    });
    throw new Error("turn/start timed out");
  };
  const adapter = new CodexAdapter(server, { ambiguousStartRetryMs: 1 });
  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        { id: "thr_1" },
        { text: "Ambiguous but owned", source: { type: "human" } },
      ),
    ),
    /turn\/start timed out/u,
  );
  assert.deepEqual(server.interruptCalls, [
    { threadId: "thr_1", turnId: "turn_owned" },
  ]);
});

test("closes transport and interrupts both turns on ownership conflict", async () => {
  const server = new FakeAppServer();
  server.startTurnBehavior = async (params) => {
    server.notify("turn/started", {
      threadId: "thr_1",
      turn: {
        id: "turn_notification",
        status: "inProgress",
        items: [{
          type: "userMessage",
          id: "user-owned",
          clientId: params.clientUserMessageId,
          content: [],
        }],
      },
    });
    return { id: "turn_response", status: "inProgress" };
  };
  const adapter = new CodexAdapter(server);

  await assert.rejects(
    collectEvents(
      adapter.sendMessage(
        { id: "thr_1" },
        { text: "Conflicting ownership", source: { type: "human" } },
      ),
    ),
    /turn ownership conflict/u,
  );
  assert.deepEqual(server.interruptCalls, [
    { threadId: "thr_1", turnId: "turn_notification" },
    { threadId: "thr_1", turnId: "turn_response" },
  ]);
  assert.equal(server.closed, true);
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

test("never adopts an external turn notification as the Slack-owned turn", async () => {
  const server = new FakeAppServer();
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
  assert.equal(server.interruptCalls.length, 0);
  assert.equal(server.closed, true);
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
