import assert from "node:assert/strict";
import test from "node:test";

import type { WebClient } from "@slack/web-api";

import {
  CoreError,
  type DelegationResultMessage,
  type GatewayAgentEvent,
  type WorkspaceGitApprovalPlan,
} from "../../src/core/index.js";
import { projectDelegationContinuation } from "../../src/slack/delegation-continuation.js";
import { WorkspaceGitApprovalDetailsStore } from "../../src/slack/user-input-blocks.js";

const request: DelegationResultMessage = {
  delegationId: "delegation-1",
  sourceAgentId: "implementer",
  sourceChannelId: "C1",
  sourceRootThreadTs: "100.1",
  sourceMessageTs: "100.2",
  sourceSlackUserId: "U123",
  sourceSessionId: "source-session",
  sourceAdapterSessionId: "source-thread",
  targetAgentId: "reviewer",
  depth: 1,
  result: "レビュー結果そのもの",
};

const externallyResolvedGitPlan = {
  operationId: "22222222-2222-4222-8222-222222222222",
  planHash: "a".repeat(64),
  approvalTarget: "primary",
  operation: "git_publication",
  repoId: "mini-all",
  mode: "commit_only",
  branch: "codex/external-resolution",
  paths: ["src/fix.ts"],
  expectedHead: "b".repeat(40),
  expectedSnapshotId: "c".repeat(64),
  worktreeId: "primary",
  expiresAt: "2099-08-14T11:00:00.000Z",
} satisfies WorkspaceGitApprovalPlan;

test("projects a delayed result as the source Koe final reply", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = fakeClient(posts, updates);

  await projectDelegationContinuation(
    client,
    request,
    events([
      gatewayEvent({ type: "message.delta", text: "整理した返答" }),
      gatewayEvent({ type: "message.completed", text: "整理した最終返答" }),
      gatewayEvent({ type: "status.changed", status: "idle" }),
    ]),
    { C1: { username: "Source Koe" } },
  );

  assert.ok(posts.some((post) => post.channel === "C1" && post.thread_ts === "100.1"));
  assert.match(String(posts.at(-1)?.text), /<@U123>.*整理した最終返答/su);
  assert.equal(posts.at(-1)?.username, "Source Koe");
  assert.ok(updates.some((update) => /考えました/u.test(String(update.text))));
  assert.ok(posts.every((post) => !String(post.text).includes("そのまま表示します")));
});

test("posts the target result verbatim when the source continuation fails", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = fakeClient(posts, []);

  await assert.rejects(
    projectDelegationContinuation(
      client,
      request,
      failingEvents(new Error("source Koe unavailable")),
      { C1: { username: "Source Koe" } },
    ),
    /source Koe unavailable/u,
  );

  const fallback = posts.at(-1);
  assert.equal(fallback?.channel, "C1");
  assert.equal(fallback?.thread_ts, "100.1");
  assert.match(String(fallback?.text), /<@U123>/u);
  assert.match(String(fallback?.text), /reviewerのKoeの返答をそのまま表示/u);
  assert.match(String(fallback?.text), /レビュー結果そのもの/u);
  assert.doesNotMatch(String(fallback?.text), /処理が完了しました/u);
});

test("silently ignores a repeated delayed result projection", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = fakeClient(posts, []);

  await projectDelegationContinuation(
    client,
    request,
    events([
      gatewayEvent({
        type: "message.completed",
        text: "最初の整理済み返答",
      }),
    ]),
  );
  const postsAfterFirstProjection = posts.length;

  await projectDelegationContinuation(
    client,
    request,
    immediatelyFailingEvents(
      new CoreError(
        "DELEGATION_RESULT_ALREADY_HANDLED",
        "Delegation result delegation-1 was already delivered",
      ),
    ),
  );

  assert.ok(postsAfterFirstProjection > 0);
  assert.equal(posts.length, postsAfterFirstProjection);
  assert.ok(posts.every((post) => !String(post.text).includes("そのまま表示します")));
});

test("publishes a long delayed source response as one atomic Slack reply", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = fakeClient(posts, []);

  await projectDelegationContinuation(
    client,
    request,
    events([
      gatewayEvent({
        type: "message.completed",
        text: "長い返答".repeat(2_000),
      }),
    ]),
  );

  const finalReplies = posts.filter((post) =>
    String(post.text).startsWith("<@U123>\n\n"),
  );
  assert.equal(finalReplies.length, 1);
  assert.match(String(finalReplies[0]?.text), /Response truncated in Slack/u);
  assert.ok(String(finalReplies[0]?.text).length <= 3_800);
});

test("rejects a delayed structured request when its Slack buttons cannot be projected", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: `${100 + posts.length}.1` };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        throw new Error("Slack update failed");
      },
    },
  } as unknown as WebClient;
  const rejected: unknown[] = [];

  await assert.rejects(
    projectDelegationContinuation(
      client,
      request,
      events([
        gatewayEvent({
          type: "user_input.requested",
          requestId: "codex-input:11111111-1111-4111-8111-111111111111",
          expiresAt: "2099-08-14T11:00:00.000Z",
          prompt: "Approve?",
          options: [
            { id: "approve", label: "承認して実行" },
            { id: "reject", label: "拒否・保留" },
          ],
          plan: {
            operationId: "22222222-2222-4222-8222-222222222222",
            planHash: "a".repeat(64),
            approvalTarget: "primary",
            operation: "git_publication",
            repoId: "mini-all",
            mode: "commit_and_push",
            branch: "codex/fix",
            paths: ["src/fix.ts"],
            expectedHead: "b".repeat(40),
            expectedSnapshotId: "c".repeat(64),
            worktreeId: "primary",
            pushTarget: "origin/codex/fix",
            expiresAt: "2026-08-14T20:00:00+09:00",
          },
        }),
        gatewayEvent({ type: "status.changed", status: "idle" }),
      ]),
      {},
      undefined,
      async (failure) => {
        rejected.push(failure);
      },
    ),
    /Slack update failed/u,
  );

  assert.equal(rejected.length, 1);
  const failure = rejected[0] as {
    readonly kind: string;
    readonly plan: WorkspaceGitApprovalPlan;
    readonly sessionId: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly requestId: string;
  };
  assert.deepEqual(
    {
      kind: failure.kind,
      sessionId: failure.sessionId,
      channelId: failure.channelId,
      rootThreadTs: failure.rootThreadTs,
      requestId: failure.requestId,
    },
    {
      kind: "git_approval",
      sessionId: "source-session",
      channelId: "C1",
      rootThreadTs: "100.1",
      requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    },
  );
  assert.equal(
    failure.plan.operationId,
    "22222222-2222-4222-8222-222222222222",
  );
  assert.ok(posts.length >= 2);
  assert.ok(updates.length >= 1);
});

test("settles an externally resolved delayed Git request even when terminal Slack projection fails", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: `${100 + posts.length}.1` };
      },
      update: async (input: Record<string, unknown>) => {
        if (String(input.text).includes("別のCodexクライアント")) {
          throw new Error("terminal Slack update failed");
        }
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const plan = externallyResolvedGitPlan;
  const settled: string[] = [];

  await projectDelegationContinuation(
    client,
    request,
    events([
        gatewayEvent({
          type: "user_input.requested",
          requestId: "codex-input:11111111-1111-4111-8111-111111111111",
          expiresAt: plan.expiresAt,
          prompt: "Approve?",
          options: [
            { id: "approve", label: "承認して実行" },
            { id: "reject", label: "拒否・保留" },
          ],
          plan,
        }),
        gatewayEvent({
          type: "git_approval.resolved_externally",
          requestId: "codex-input:11111111-1111-4111-8111-111111111111",
          plan,
        }),
        gatewayEvent({ type: "status.changed", status: "idle" }),
    ]),
    {},
    undefined,
    undefined,
    new WorkspaceGitApprovalDetailsStore(),
    async (event) => {
      settled.push(event.plan.operationId);
    },
  );

  assert.deepEqual(settled, [plan.operationId]);
});

test("terminalizes an externally resolved delayed Git card even when private settlement fails", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = fakeClient(posts, updates);
  const requestId = "codex-input:99999999-9999-4999-8999-999999999999";

  await assert.rejects(
    projectDelegationContinuation(
      client,
      request,
      events([
        gatewayEvent({
          type: "user_input.requested",
          requestId,
          expiresAt: externallyResolvedGitPlan.expiresAt,
          prompt: "Approve?",
          options: [
            { id: "approve", label: "承認して実行" },
            { id: "reject", label: "拒否・保留" },
          ],
          plan: externallyResolvedGitPlan,
        }),
        gatewayEvent({
          type: "git_approval.resolved_externally",
          requestId,
          plan: externallyResolvedGitPlan,
        }),
      ]),
      {},
      undefined,
      undefined,
      new WorkspaceGitApprovalDetailsStore(),
      async () => {
        throw new Error("private broker unavailable");
      },
    ),
    /private broker unavailable/u,
  );

  const terminalUpdate = updates.find((update) =>
    String(update.text).includes("別のCodexクライアント"),
  );
  assert.match(String(terminalUpdate?.text), /別のCodexクライアント/u);
  assert.doesNotMatch(
    JSON.stringify(terminalUpdate?.blocks),
    /承認して実行|拒否・保留|"type":"button"/u,
  );
});

test("cancels a delayed native approval when its Slack buttons cannot be projected", async () => {
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, ts: "101.1" }),
      update: async () => {
        throw new Error("Slack approval update failed");
      },
    },
  } as unknown as WebClient;
  const rejected: unknown[] = [];

  await assert.rejects(
    projectDelegationContinuation(
      client,
      request,
      events([
        gatewayEvent({
          type: "approval.requested",
          requestId: "approval-1",
          summary: "Run a command",
        }),
      ]),
      {},
      undefined,
      async (failure) => {
        rejected.push(failure);
      },
    ),
    /Slack approval update failed/u,
  );

  assert.deepEqual(rejected, [{
    kind: "approval",
    sessionId: "source-session",
    channelId: "C1",
    rootThreadTs: "100.1",
    requestId: "approval-1",
  }]);
});

function fakeClient(
  posts: Array<Record<string, unknown>>,
  updates: Array<Record<string, unknown>>,
): WebClient {
  return {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: `${100 + posts.length}.1` };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
}

function gatewayEvent(
  event: GatewayAgentEvent["event"],
): GatewayAgentEvent {
  return {
    agentId: "implementer",
    sessionId: "source-session",
    conversation: {
      channelId: "C1",
      rootThreadTs: "100.1",
      agentId: "implementer",
      sessionId: "source-session",
    },
    event,
  };
}

async function* events(
  values: readonly GatewayAgentEvent[],
): AsyncIterable<GatewayAgentEvent> {
  yield* values;
}

async function* failingEvents(error: Error): AsyncIterable<GatewayAgentEvent> {
  yield gatewayEvent({ type: "status.changed", status: "running" });
  throw error;
}

async function* immediatelyFailingEvents(
  error: Error,
): AsyncIterable<GatewayAgentEvent> {
  throw error;
}
