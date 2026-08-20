import assert from "node:assert/strict";
import test from "node:test";

import type { WebClient } from "@slack/web-api";

import { SlackThreadProjector } from "../../src/slack/projector.js";

function recordingClient(): {
  client: WebClient;
  posts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
} {
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
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  return { client, posts, updates };
}

test("coalesces repetitive tool events into the streamed Agent message", async () => {
  const { client, posts, updates } = recordingClient();
  let now = 0;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    now: () => now,
  });

  await projector.project({ type: "message.delta", text: "Investigating" });
  await projector.project({
    type: "tool.started",
    toolCallId: "command-1",
    name: "commandExecution",
  });
  await projector.project({
    type: "tool.started",
    toolCallId: "file-1",
    name: "fileChange",
  });
  await projector.project({
    type: "tool.started",
    toolCallId: "command-1",
    name: "commandExecution",
  });
  await projector.project({ type: "tool.completed", toolCallId: "file-1" });
  await projector.project({ type: "tool.completed", toolCallId: "command-1" });
  await projector.project({ type: "message.completed", text: "Finished safely." });

  assert.ok(
    [...posts, ...updates].every((call) => !String(call.text).includes("<@U123>")),
  );
  now = 134_000;
  await projector.complete();
  await projector.complete();

  assert.equal(posts.length, 2);
  assert.equal(posts[0]?.thread_ts, "100.0");
  assert.equal(posts[1]?.channel, "C1");
  assert.equal(posts[1]?.thread_ts, "100.0");
  const finalReply = String(posts[1]?.text);
  assert.match(finalReply, /^<@U123>\n\nFinished safely\./u);
  assert.match(finalReply, /2 completed/u);
  assert.match(finalReply, /Commands 1/u);
  assert.match(finalReply, /File changes 1/u);
  assert.doesNotMatch(finalReply, /running/u);
  assert.ok(updates.length >= 2);
  assert.equal(
    updates.at(-1)?.text,
    ":hourglass_flowing_sand: 2分14秒考えました。",
  );
  assert.equal(updates.at(-1)?.channel, "C1");
  assert.equal(updates.at(-1)?.ts, "101.1");
  assert.ok(updates.every((update) => !String(update.text).includes("<@U123>")));
  assert.ok(posts.every((post) => post.text !== "<@U123> Your turn."));
  assert.equal(
    [...posts, ...updates]
      .map((call) => String(call.text).match(/<@U123>/gu)?.length ?? 0)
      .reduce((total, count) => total + count, 0),
    1,
  );
});

test("refreshes running activity every five seconds and stops after completion", async () => {
  const { client, posts, updates } = recordingClient();
  let now = 0;
  const scheduled: Array<{
    readonly task: () => Promise<void>;
    readonly delayMs: number;
    cancelled: boolean;
  }> = [];
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    now: () => now,
    heartbeatScheduler: (task, delayMs) => {
      const scheduledTask = { task, delayMs, cancelled: false };
      scheduled.push(scheduledTask);
      return () => {
        scheduledTask.cancelled = true;
      };
    },
  });
  const runNextHeartbeat = async () => {
    const scheduledTask = scheduled.find((task) => !task.cancelled);
    assert.ok(scheduledTask);
    scheduledTask.cancelled = true;
    await scheduledTask.task();
  };

  await projector.project({ type: "status.changed", status: "starting" });
  assert.match(String(posts[0]?.text), /Working ◐/u);
  assert.match(String(posts[0]?.text), /0秒経過/u);

  await projector.project({
    type: "tool.started",
    toolCallId: "command-1",
    name: "commandExecution",
  });

  assert.match(String(updates.at(-1)?.text), /1 running/u);
  assert.equal(scheduled[0]?.delayMs, 5_000);

  now = 5_000;
  await runNextHeartbeat();
  assert.match(String(updates.at(-1)?.text), /Working ◓/u);
  assert.match(String(updates.at(-1)?.text), /5秒経過/u);

  now = 10_000;
  await runNextHeartbeat();
  assert.match(String(updates.at(-1)?.text), /Working ◑/u);
  assert.match(String(updates.at(-1)?.text), /10秒経過/u);

  await projector.complete();

  assert.equal(scheduled.filter((task) => !task.cancelled).length, 0);
  assert.equal(updates.at(-1)?.text, ":hourglass_flowing_sand: 10秒考えました。");
  assert.match(String(posts.at(-1)?.text), /1 unfinished/u);
});

test("uses one Slack message for a tool-only activity burst", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0");

  await projector.project({
    type: "tool.started",
    toolCallId: "mcp-1",
    name: "showtalk_taishi.agent.send",
    input: { secret: "must-not-be-posted" },
  });
  await projector.project({
    type: "tool.completed",
    toolCallId: "mcp-1",
    output: { secret: "must-not-be-posted" },
  });
  await projector.complete();

  assert.equal(posts.length, 1);
  assert.equal(updates.length, 2);
  assert.match(String(updates.at(-1)?.text), /1 completed/u);
  assert.match(String(updates.at(-1)?.text), /MCP calls 1/u);
  assert.doesNotMatch(String(updates.at(-1)?.text), /must-not-be-posted/u);
});

test("keeps source-less final responses in the activity message", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0");

  await projector.project({ type: "message.completed", text: "Looks good" });
  await projector.complete();
  await projector.complete();

  assert.deepEqual(posts, [
    {
      channel: "C1",
      thread_ts: "100.0",
      text: "Looks good",
    },
  ]);
  assert.equal(updates.length, 0);
});

test("keeps a failed tool in the final summary without a separate warning", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "tool.started",
    toolCallId: "prepare-1",
    name: "workspace-git.prepare_pull_request_operation",
  });
  await projector.project({
    type: "tool.started",
    toolCallId: "failed-1",
    name: "commandExecution",
  });
  await projector.project({
    type: "tool.completed",
    toolCallId: "failed-1",
    isError: true,
  });
  await projector.project({
    type: "tool.completed",
    toolCallId: "failed-1",
    isError: true,
  });
  await projector.project({
    type: "tool.started",
    toolCallId: "ok-1",
    name: "commandExecution",
  });
  await projector.project({ type: "tool.completed", toolCallId: "ok-1" });
  await projector.complete();

  assert.equal(posts.length, 2);
  assert.ok(
    posts.every(
      (post) =>
        post.text !==
        ":warning: Tool action did not complete successfully\n\n<@U123>",
    ),
  );
  assert.match(String(updates.at(-1)?.text), /^:hourglass_flowing_sand:/u);
  const finalReply = String(posts.at(-1)?.text);
  assert.match(finalReply, /^<@U123>\n\n:warning:/u);
  assert.match(finalReply, /1 completed/u);
  assert.match(finalReply, /1 failed/u);
  assert.equal(
    [...posts, ...updates]
      .map((call) => String(call.text).match(/<@U123>/gu)?.length ?? 0)
      .reduce((total, count) => total + count, 0),
    1,
  );
  assert.ok(posts.every((post) => post.text !== "<@U123> Your turn."));
});

test("still posts the final response when Slack disables the activity projection", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return posts.length === 1 ? { ok: true } : { ok: true, ts: "102.1" };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await assert.rejects(
    projector.project({
      type: "tool.started",
      toolCallId: "command-1",
      name: "commandExecution",
    }),
    /did not return a timestamp/u,
  );
  await projector.project({ type: "message.delta", text: "Still working" });
  await projector.complete();
  await projector.complete();

  assert.equal(posts.length, 2);
  assert.doesNotMatch(String(posts[0]?.text), /<@U123>/u);
  assert.equal(posts[1]?.channel, "C1");
  assert.equal(posts[1]?.thread_ts, "100.0");
  assert.match(String(posts[1]?.text), /^<@U123>\n\nStill working/u);
  assert.match(String(posts[1]?.text), /1 unfinished/u);
});

test("posts one mentioned completion when the turn has no response projection", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.complete();
  await projector.complete();

  assert.deepEqual(posts, [
    {
      channel: "C1",
      thread_ts: "100.0",
      text: "<@U123>\n\n処理が完了しました。",
    },
  ]);
  assert.equal(updates.length, 0);
});

test("uses the configured channel identity for every new projected message", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    presentation: {
      username: "Taishi Implementer",
      icon_url: "https://example.com/implementer.png",
    },
  });

  await projector.project({ type: "message.completed", text: "Implemented" });
  await projector.project({
    type: "approval.requested",
    requestId: "approval-1",
    summary: "Run tests",
  });
  await projector.complete();

  assert.ok(posts.length >= 3);
  assert.ok(
    posts.every(
      (post) =>
        post.username === "Taishi Implementer" &&
        post.icon_url === "https://example.com/implementer.png" &&
        !("as_user" in post),
    ),
  );
});

test("retries a final response that Slack did not confirm", async () => {
  const attempts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        attempts.push(input);
        return attempts.length === 1 ? { ok: true } : { ok: true, ts: "102.1" };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await assert.rejects(projector.complete(), /timestamp for final Koe response/u);
  await projector.complete();
  await projector.complete();

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], {
    channel: "C1",
    thread_ts: "100.0",
    text: "<@U123>\n\n処理が完了しました。",
  });
});

test("deduplicates concurrent and repeated completion", async () => {
  const { client, posts, updates } = recordingClient();
  let now = 0;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    now: () => now,
  });

  await projector.project({ type: "message.completed", text: "Done once" });
  now = 61_000;
  await Promise.all([projector.complete(), projector.complete()]);
  await projector.complete();

  assert.equal(
    updates.filter(
      (update) =>
        update.text === ":hourglass_flowing_sand: 1分1秒考えました。",
    ).length,
    1,
  );
  assert.equal(
    posts.filter((post) => String(post.text).startsWith("<@U123>\n\nDone once"))
      .length,
    1,
  );
  assert.ok(posts.every((post) => post.text !== "<@U123> Your turn."));
});

test("marks still-running tools unfinished when a turn projection closes", async () => {
  const { client, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0");

  await projector.project({
    type: "tool.started",
    toolCallId: "unfinished-1",
    name: "commandExecution",
  });
  await projector.complete();

  const finalText = String(updates.at(-1)?.text);
  assert.match(finalText, /1 unfinished/u);
  assert.doesNotMatch(finalText, /running/u);
  assert.match(finalText, /^:warning:/u);
});

test("keeps approvals and errors as separate actionable messages", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });
  projector.setSessionId("session-1");

  await projector.project({
    type: "tool.started",
    toolCallId: "command-1",
    name: "commandExecution",
  });
  await projector.project({
    type: "approval.requested",
    requestId: "request-1",
    summary: "Allow command?",
  });
  await projector.project({ type: "error", message: "Turn failed" });

  assert.equal(posts.length, 3);
  assert.match(String(posts[0]?.text), /Working/u);
  assert.doesNotMatch(String(posts[0]?.text), /<@U123>/u);
  assert.equal(posts[1]?.text, "Allow command?\n\n<@U123>");
  assert.equal(posts[1]?.mrkdwn, true);
  assert.ok(Array.isArray(posts[1]?.blocks));
  assert.deepEqual((posts[1]?.blocks as Array<Record<string, unknown>>)[0], {
    type: "section",
    text: { type: "mrkdwn", text: "<@U123>" },
  });
  assert.equal(posts[2]?.text, ":warning: Turn failed\n\n<@U123>");
  assert.equal(posts[2]?.mrkdwn, true);
});

test("projects an exact workspace-git plan as Slack buttons in the originating thread", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "user_input.requested",
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    prompt: "このexact planを承認しますか？",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan: {
      operationId: "22222222-2222-4222-8222-222222222222",
      planHash: "a".repeat(64),
      operation: "pull_request_merge",
      repoId: "showtalk-taishi",
      mode: "merge",
      branch: "agent/approval-ui",
      paths: [],
      expectedHead: "b".repeat(40),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example-org/example-repo/pull/42",
      baseBranch: "main",
      mergeMethod: "squash",
      expiresAt: "2026-08-14T20:00:00+09:00",
    },
  });

  assert.equal(posts.length, 2);
  const approvalPost = posts[1];
  assert.equal(approvalPost?.channel, "C1");
  assert.equal(approvalPost?.thread_ts, "100.0");
  assert.match(String(approvalPost?.text), /<@U123>$/u);
  const approvalUpdate = updates.find((update) => update.ts === "102.1");
  const blocks = JSON.stringify(approvalUpdate?.blocks);
  assert.match(blocks, /承認して実行/u);
  assert.match(blocks, /拒否・保留/u);
  assert.match(blocks, /22222222-2222-4222-8222-222222222222/u);
  assert.match(blocks, /squash/u);
});

test("projects one safe recovery choice when an exact Git plan is unavailable", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "git_approval.reprepare_required",
    message: "古い計画は現在のターンに紐づいていません。",
  });

  assert.equal(posts.length, 2);
  const recoveryPost = posts[1];
  assert.equal(recoveryPost?.channel, "C1");
  assert.equal(recoveryPost?.thread_ts, "100.0");
  assert.match(String(recoveryPost?.text), /<@U123>$/u);
  const recoveryUpdate = updates.find((update) => update.ts === "102.1");
  const blocks = JSON.stringify(recoveryUpdate?.blocks);
  assert.match(blocks, /承認画面を再作成/u);
  assert.match(blocks, /保留/u);
  assert.doesNotMatch(blocks, /承認して実行/u);
});

test("bounds and escapes actionable text before adding the source mention", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "error",
    message: `Do not notify <@U999> ${"😀".repeat(4_000)}`,
  });

  assert.equal(posts.length, 1);
  const text = String(posts[0]?.text);
  assert.ok(text.length <= 3_800);
  assert.doesNotMatch(text, /<@U999>/u);
  assert.match(text, /&lt;@U999&gt;/u);
  assert.match(text, /<@U123>$/u);
});

test("bounds actionable text even when no source user can be mentioned", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0");

  await projector.project({
    type: "error",
    message: `<@U999>${"&<>😀".repeat(10_000)}`,
  });

  assert.equal(posts.length, 1);
  const text = String(posts[0]?.text);
  assert.ok(text.length <= 3_800);
  assert.doesNotMatch(text, /<@U999>/u);
  assert.match(text, /&lt;@U999&gt;/u);
});

test("posts bounded final chunks with a mention only on the first chunk", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({ type: "message.delta", text: "😀".repeat(40_000) });
  await projector.project({
    type: "tool.started",
    toolCallId: "command-1",
    name: "commandExecution",
  });
  await projector.project({ type: "tool.completed", toolCallId: "command-1" });
  await projector.complete();

  const allTexts = [
    ...updates.map((update) => String(update.text)),
    ...posts.map((post) => String(post.text)),
  ];
  assert.ok(allTexts.every((text) => text.length <= 3_800));
  const finalText = allTexts.join("\n");
  assert.match(finalText, /Tool activity/u);
  assert.ok(allTexts.every((text) => !/[\uD800-\uDBFF]$/u.test(text)));
  const finalReplies = posts.slice(1);
  assert.ok(finalReplies.length > 1);
  assert.ok(finalReplies.length <= 4);
  assert.equal(finalReplies[0]?.thread_ts, "100.0");
  assert.match(String(finalReplies[0]?.text), /^<@U123>\n\n\*Response 1\//u);
  assert.ok(
    finalReplies.slice(1).every((post) => !String(post.text).includes("<@U123>")),
  );
  assert.match(finalText, /Response truncated in Slack/u);
  assert.equal(
    allTexts
      .map((text) => text.match(/<@U123>/gu)?.length ?? 0)
      .reduce((total, count) => total + count, 0),
    1,
  );
  assert.match(String(updates.at(-1)?.text), /^:hourglass_flowing_sand:/u);
  assert.ok(posts.every((post) => post.text !== "<@U123> Your turn."));
});
