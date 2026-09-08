import assert from "node:assert/strict";
import test from "node:test";

import type { WebClient } from "@slack/web-api";

import { SlackThreadProjector } from "../../src/slack/projector.js";
import { StructuredChoiceContinuationStore } from "../../src/slack/choice-continuation.js";
import { WorkspaceGitApprovalDetailsStore } from "../../src/slack/user-input-blocks.js";
import type { InteractionAuditInput } from "../../src/slack/interaction-audit.js";

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

test("coalesces streamed text updates for thirty seconds", async () => {
  const { client, posts, updates } = recordingClient();
  let now = 0;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    now: () => now,
  });

  await projector.project({ type: "message.delta", text: "開始" });
  now = 29_999;
  await projector.project({ type: "message.delta", text: "途中" });
  assert.equal(posts.length, 1);
  assert.equal(updates.length, 0);

  now = 30_000;
  await projector.project({ type: "message.delta", text: "経過" });
  assert.equal(updates.length, 1);
  assert.match(String(updates[0]?.text), /開始途中経過/u);
});

test("refreshes running activity at most every thirty seconds and stops after completion", async () => {
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
  assert.equal(scheduled[0]?.delayMs, 30_000);

  now = 30_000;
  await runNextHeartbeat();
  assert.match(String(updates.at(-1)?.text), /Working ◓/u);
  assert.match(String(updates.at(-1)?.text), /30秒経過/u);

  now = 60_000;
  await runNextHeartbeat();
  assert.match(String(updates.at(-1)?.text), /Working ◑/u);
  assert.match(String(updates.at(-1)?.text), /1分0秒経過/u);

  await projector.complete();

  assert.equal(scheduled.filter((task) => !task.cancelled).length, 0);
  assert.equal(updates.at(-1)?.text, ":hourglass_flowing_sand: 1分0秒考えました。");
  assert.match(String(posts.at(-1)?.text), /1 unfinished/u);
});

test("backs off a full heartbeat interval after a Slack update failure", async () => {
  let now = 0;
  const scheduled: Array<{
    readonly task: () => Promise<void>;
    readonly delayMs: number;
    cancelled: boolean;
  }> = [];
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, ts: "101.1" }),
      update: async () => {
        throw new Error("Slack unavailable");
      },
    },
  } as unknown as WebClient;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    now: () => now,
    heartbeatScheduler: (task, delayMs) => {
      const scheduledTask = { task, delayMs, cancelled: false };
      scheduled.push(scheduledTask);
      return () => {
        scheduledTask.cancelled = true;
      };
    },
  });

  await projector.project({ type: "status.changed", status: "starting" });
  assert.equal(scheduled[0]?.delayMs, 30_000);
  now = 30_000;
  scheduled[0]!.cancelled = true;
  await scheduled[0]!.task();

  const retry = scheduled.find((task, index) => index > 0 && !task.cancelled);
  assert.ok(retry);
  assert.equal(retry.delayMs, 30_000);
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
  assert.equal(updates.length, 1);
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

test("uploads generated images to the originating Slack thread once", async () => {
  const { client } = recordingClient();
  const uploads: Array<{
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly names: readonly string[];
  }> = [];
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    attachmentUploader: async (_client, channelId, rootThreadTs, attachments) => {
      uploads.push({
        channelId,
        rootThreadTs,
        names: attachments.map((attachment) => attachment.name),
      });
    },
  });
  const event = {
    type: "attachment.generated",
    attachmentId: "image-1",
    attachment: {
      kind: "image",
      payload: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      name: "codex-generated-image-1.png",
      mimeType: "image/png",
      title: "Codex生成画像",
      altText: "Codexで生成された画像",
    },
  } as const;

  await projector.project(event);
  await projector.project(event);
  await projector.complete();

  assert.deepEqual(uploads, [{
    channelId: "C1",
    rootThreadTs: "100.0",
    names: ["codex-generated-image-1.png"],
  }]);
});

test("reports a generated image upload failure without aborting the final reply", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    attachmentUploader: async () => {
      throw new Error("sensitive Slack upload failure");
    },
  });

  await projector.project({
    type: "attachment.generated",
    attachmentId: "image-1",
    attachment: {
      kind: "image",
      payload: new Blob([new Uint8Array([1])], { type: "image/png" }),
      name: "image.png",
      mimeType: "image/png",
    },
  });
  await projector.project({ type: "message.completed", text: "画像生成は完了しました。" });
  await projector.complete();

  assert.ok(posts.some((post) =>
    String(post.text).includes("生成画像をSlackへ添付できませんでした")
  ));
  assert.ok(posts.some((post) =>
    String(post.text).includes("画像生成は完了しました")
  ));
  assert.ok(posts.every((post) =>
    !String(post.text).includes("sensitive Slack upload failure")
  ));
});

test("retries an unconfirmed source-less final chunk without duplicating confirmed chunks", async () => {
  const attempts: Array<Record<string, unknown>> = [];
  const confirmed: Array<Record<string, unknown>> = [];
  let finalChunkAttempts = 0;
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        attempts.push(input);
        if (attempts.length === 1) {
          confirmed.push(input);
          return { ok: true, ts: "101.1" };
        }
        finalChunkAttempts += 1;
        if (finalChunkAttempts === 2) return { ok: true };
        confirmed.push(input);
        return { ok: true, ts: `${101 + confirmed.length}.1` };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackThreadProjector(client, "C1", "100.0");

  await projector.project({
    type: "message.completed",
    text: "長い返答".repeat(10_000),
  });
  await assert.rejects(
    projector.complete(),
    /timestamp for Koe continuation/u,
  );
  await projector.complete();
  await projector.complete();

  const confirmedFinalTexts = confirmed.slice(1).map(({ text }) => String(text));
  assert.ok(confirmedFinalTexts.length >= 2);
  assert.equal(new Set(confirmedFinalTexts).size, confirmedFinalTexts.length);
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

test("does not append a generic success after a text-less turn error", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "error",
    message: "paginated_threads is not supported yet",
  });
  await projector.complete();

  assert.deepEqual(posts, [
    {
      channel: "C1",
      thread_ts: "100.0",
      text: ":warning: paginated_threads is not supported yet\n\n<@U123>",
      mrkdwn: true,
    },
  ]);
  assert.equal(updates.length, 0);
  assert.ok(posts.every((post) => !String(post.text).includes("処理が完了しました")));
});

test("audits structured input rejected before Slack controls are displayed", async () => {
  const { client } = recordingClient();
  const audit: InteractionAuditInput[] = [];
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    interactionAudit: (event) => audit.push(event),
  });
  projector.setSessionId("session_1");

  await projector.project({
    type: "error",
    code: "UNSUPPORTED_STRUCTURED_INPUT",
    message: "The approval shape is invalid",
  });

  assert.deepEqual(audit, [{
    event: "structured_input.rejected_before_display",
    channelId: "C1",
    rootThreadTs: "100.0",
    sessionId: "session_1",
    outcome: "UNSUPPORTED_STRUCTURED_INPUT",
  }]);
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
  const { client, posts, updates } = recordingClient();
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
  const approvalUpdate = updates.find((update) => update.ts === "102.1");
  assert.ok(Array.isArray(approvalUpdate?.blocks));
  assert.deepEqual((approvalUpdate?.blocks as Array<Record<string, unknown>>)[0], {
    type: "section",
    text: { type: "mrkdwn", text: "<@U123>" },
  });
  assert.equal(posts[2]?.text, ":warning: Turn failed\n\n<@U123>");
  assert.equal(posts[2]?.mrkdwn, true);
});

test("projects an ordinary model question as non-Git Slack choices", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "choice.requested",
    requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
    expiresAt: "2030-01-01T00:00:00.000Z",
    completedAnswers: [],
    question: {
      id: "question_1",
      header: "地形",
      prompt: "どの地形を作りますか？",
      options: [
        { id: "option_1", label: "砂漠盆地", description: "中央が低い" },
        { id: "option_2", label: "乾燥岩盤平原", description: "岩盤中心" },
      ],
      allowsOther: true,
    },
  });

  assert.equal(posts.length, 2);
  assert.equal(posts[1]?.thread_ts, "100.0");
  assert.match(String(posts[1]?.text), /選択してください/u);
  const choiceUpdate = updates.find((update) => update.ts === "102.1");
  const rendered = JSON.stringify(choiceUpdate?.blocks);
  assert.match(rendered, /砂漠盆地/u);
  assert.match(rendered, /乾燥岩盤平原/u);
  assert.match(rendered, /その他を入力/u);
  assert.doesNotMatch(rendered, /Git操作|承認して実行|拒否・保留/u);
});

test("projects an external-action confirmation with an explicit non-Git warning", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "choice.requested",
    requestId: "codex-choice:11111111-1111-4111-8111-111111111113",
    expiresAt: "2030-01-01T00:00:00.000Z",
    completedAnswers: [],
    question: {
      id: "question_1",
      purpose: "external_action_confirmation",
      header: "外部設定",
      prompt: "main保護を設定しますか？",
      options: [
        {
          id: "option_1",
          label: "外部操作を承認（Git承認ではありません）",
          description: "設定する",
        },
        { id: "option_2", label: "外部操作を拒否・保留", description: "保留する" },
      ],
      allowsOther: false,
    },
  });

  const rendered = JSON.stringify(updates.find((update) => update.ts === "102.1")?.blocks);
  assert.match(String(posts[1]?.text), /Git承認ではありません/u);
  assert.match(rendered, /workspace-gitのGit承認ではありません/u);
  assert.match(rendered, /Git承認状態を変更しません/u);
  assert.match(rendered, /external_action_confirmation/u);
  assert.doesNotMatch(rendered, /taishi\.git_plan/u);
});

test("replaces an externally resolved ordinary choice with a new-turn continuation", async () => {
  const { client, updates } = recordingClient();
  const store = new StructuredChoiceContinuationStore(
    () => Date.parse("2026-08-27T00:00:00.000Z"),
  );
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    choiceContinuationStore: store,
  });
  projector.setSessionId("session_1");
  const requestId = "codex-choice:11111111-1111-4111-8111-111111111112";

  await projector.project({
    type: "choice.requested",
    requestId,
    expiresAt: "2026-08-27T00:10:00.000Z",
    completedAnswers: [{
      header: "対象",
      prompt: "対象repoを選んでください",
      answers: ["showtalk-taishi"],
    }],
    question: {
      id: "question_1",
      purpose: "ordinary",
      header: "公開方針",
      prompt: "公開設定案を作りますか？",
      options: [
        {
          id: "option_1",
          label: "設定案を作る",
          description: "変更は実行しない",
        },
        { id: "option_2", label: "保留する", description: "今回は進めない" },
      ],
      allowsOther: false,
    },
  });
  await projector.project({ type: "choice.resolved_externally", requestId });

  const continuation = store.getForOriginalRequest(requestId);
  assert.ok(continuation);
  assert.equal(continuation.sessionId, "session_1");
  assert.deepEqual(continuation.completedAnswers, [{
    header: "対象",
    prompt: "対象repoを選んでください",
    answers: ["showtalk-taishi"],
  }]);
  const terminalUpdate = updates.at(-1);
  assert.equal(terminalUpdate?.ts, "102.1");
  assert.match(String(terminalUpdate?.text), /通常の新しいターン/u);
  const rendered = JSON.stringify(terminalUpdate?.blocks);
  assert.match(rendered, /通常の新しいターン/u);
  assert.match(rendered, /設定案を作る/u);
  assert.match(rendered, /taishi\.choice_continue\.select\.option_1/u);
  assert.doesNotMatch(rendered, /codex-choice:/u);
});

test("terminalizes an externally resolved external approval without continuation buttons", async () => {
  const { client, updates } = recordingClient();
  const audit: InteractionAuditInput[] = [];
  const store = new StructuredChoiceContinuationStore(
    () => Date.parse("2026-08-27T00:00:00.000Z"),
  );
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    choiceContinuationStore: store,
    interactionAudit: (event) => audit.push(event),
  });
  projector.setSessionId("session_1");
  const requestId = "codex-choice:11111111-1111-4111-8111-111111111113";

  await projector.project({
    type: "choice.requested",
    requestId,
    expiresAt: "2026-08-27T00:10:00.000Z",
    completedAnswers: [],
    question: {
      id: "question_1",
      purpose: "external_action_confirmation",
      header: "外部操作の最終確認",
      prompt: "対象を変更しますか？",
      options: [
        {
          id: "option_1",
          label: "外部操作を承認（Git承認ではありません）",
          description: "実行する",
        },
        {
          id: "option_2",
          label: "外部操作を拒否・保留",
          description: "実行しない",
        },
      ],
      allowsOther: false,
    },
  });
  await projector.project({ type: "choice.resolved_externally", requestId });

  assert.equal(store.getForOriginalRequest(requestId), undefined);
  assert.equal(store.getDisplayed(requestId), undefined);
  const terminalUpdate = updates.at(-1);
  assert.equal(terminalUpdate?.ts, "102.1");
  assert.match(String(terminalUpdate?.text), /未承認として閉じました/u);
  assert.match(String(terminalUpdate?.text), /新しい最終承認が必要/u);
  assert.deepEqual(terminalUpdate?.blocks, []);
  assert.deepEqual(
    audit.map(({ event }) => event),
    [
      "choice.request_received",
      "choice.card_posted",
      "choice.controls_attached",
      "choice.resolved_externally",
      "choice.card_terminalized",
    ],
  );
  assert.ok(audit.every((entry) => entry.requestId === requestId));
});

test("projects an exact workspace-git plan as Slack buttons in the originating thread", async () => {
  const { client, posts, updates } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });

  await projector.project({
    type: "user_input.requested",
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-08-14T11:00:00.000Z",
    prompt: "このexact planを承認しますか？",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan: {
      operationId: "22222222-2222-4222-8222-222222222222",
      planHash: "a".repeat(64),
      approvalTarget: "pr_42",
      operation: "pull_request_merge",
      repoId: "showtalk-taishi",
      mode: "merge",
      branch: "agent/approval-ui",
      paths: [],
      expectedHead: "b".repeat(40),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/example-org/example-repo/pull/42",
      targetPullRequestTitle: "Approval UI",
      baseBranch: "main",
      basePolicy: "catalog_publication_branch",
      headRepositoryOwner: "example-org",
      expectedIsDraft: false,
      autoMergeEnabled: false,
      mergeMethod: "squash",
      expiresAt: "2026-08-14T20:00:00+09:00",
    },
  });

  assert.equal(posts.length, 2);
  assert.equal(updates.length, 0);
  const approvalPost = posts[1];
  assert.equal(approvalPost?.channel, "C1");
  assert.equal(approvalPost?.thread_ts, "100.0");
  assert.match(String(approvalPost?.text), /<@U123>$/u);
  const blocks = JSON.stringify(approvalPost?.blocks);
  assert.match(blocks, /承認して実行/u);
  assert.match(blocks, /拒否・保留/u);
  assert.match(blocks, /22222222-2222-4222-8222-222222222222/u);
  assert.match(blocks, /squash/u);
});

test("projects GitHub repository settings as an exact Slack approval card", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    gitApprovalDetailsStore: new WorkspaceGitApprovalDetailsStore(),
  });

  await projector.project({
    type: "user_input.requested",
    requestId: "codex-input:33333333-3333-4333-8333-333333333333",
    expiresAt: "2099-08-26T11:00:00.000Z",
    prompt: "Repository設定を承認しますか？",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan: {
      operationId: "33333333-3333-4333-8333-333333333333",
      planHash: "f".repeat(64),
      approvalTarget: "repo_settings_showtalk-taishi",
      operation: "github_repository_settings",
      repoId: "showtalk-taishi",
      mode: "repository_settings",
      paths: [],
      repositorySettingsBefore: {
        description: "Old description",
        topics: ["slack"],
        dependabotSecurityUpdates: "disabled",
      },
      repositorySettingsDesired: {
        description: "New description",
        dependabotSecurityUpdates: true,
      },
      repositorySettingsResultingState: {
        description: "New description",
        topics: ["slack"],
        dependabotSecurityUpdates: "enabled",
      },
      expiresAt: "2026-08-26T20:00:00+09:00",
    },
  });

  assert.equal(posts.length, 2);
  const rendered = JSON.stringify(posts[1]?.blocks);
  assert.match(rendered, /GitHub Repository設定を変更/u);
  assert.match(rendered, /Old description/u);
  assert.match(rendered, /New description/u);
  assert.match(rendered, /承認して実行/u);
  assert.doesNotMatch(rendered, /変更ファイル|Branch|Worktree/u);
});

test("projects terminal and blocked Git automation without approval buttons", async () => {
  const { client, posts } = recordingClient();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
  });
  const plan = {
    operationId: "11111111-1111-4111-8111-111111111111",
    planHash: "a".repeat(64),
    approvalTarget: "primary",
    operation: "git_publication" as const,
    repoId: "showtalk-taishi",
    mode: "commit_only" as const,
    branch: "agent/provider",
    paths: ["src/runtime.ts"],
    expectedHead: "b".repeat(40),
    expectedSnapshotId: "c".repeat(64),
    worktreeId: "primary",
    commitMessage: "Wire provider",
    expiresAt: "2099-08-26T20:00:00+09:00",
  };

  await projector.project({ type: "git_automation.executed", plan });
  await projector.project({
    type: "git_automation.blocked",
    plan,
    reason: "outcome_unknown",
  });

  assert.equal(posts.length, 2);
  assert.match(String(posts[0]?.text), /Git自動運転が完了/u);
  assert.match(String(posts[1]?.text), /Git自動運転を安全停止/u);
  assert.match(String(posts[1]?.text), /manual承認にも切り替えていません/u);
  assert.ok(posts.every((post) => post.blocks === undefined));
});

test("projects Git approvals with the file list collapsed when toggle state is available", async () => {
  const { client, posts, updates } = recordingClient();
  const detailsStore = new WorkspaceGitApprovalDetailsStore();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    gitApprovalDetailsStore: detailsStore,
  });

  await projector.project({
    type: "user_input.requested",
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-08-14T11:00:00.000Z",
    prompt: "このexact planを承認しますか？",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan: {
      operationId: "22222222-2222-4222-8222-222222222222",
      planHash: "a".repeat(64),
      approvalTarget: "primary",
      operation: "git_publication",
      repoId: "showtalk-taishi",
      mode: "commit_push_and_open_draft_pr",
      branch: "agent/collapsed-paths",
      paths: ["src/one.ts", "src/two.ts"],
      expectedHead: "b".repeat(40),
      expectedSnapshotId: "c".repeat(64),
      worktreeId: "primary",
      commitMessage: "Collapse Git approval paths",
      pushTarget: "origin/agent/collapsed-paths",
      pullRequestTitle: "Collapse Git approval paths",
      pullRequestBody: "Keep exact paths available behind a bound toggle.",
      pullRequestBaseBranch: "main",
      expiresAt: "2026-08-21T20:00:00+09:00",
    },
  });

  const approvalPost = posts[1];
  assert.ok(approvalPost);
  const rendered = JSON.stringify(approvalPost.blocks);
  assert.match(rendered, /変更ファイルを表示/u);
  assert.match(rendered, /PR本文を表示/u);
  assert.match(rendered, /2件/u);
  assert.match(rendered, /2099-08-14T11:00:00\.000Z/u);
  assert.doesNotMatch(rendered, /2026-08-21T20:00:00\+09:00/u);
  assert.doesNotMatch(rendered, /src\/one\.ts|src\/two\.ts/u);
  assert.doesNotMatch(rendered, /Keep exact paths available behind a bound toggle\./u);
  const routing = {
    version: 1 as const,
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    channelId: "C1",
    rootThreadTs: "100.0",
    messageTs: "102.1",
  };
  assert.deepEqual(detailsStore.get(routing)?.plan.paths, [
    "src/one.ts",
    "src/two.ts",
  ]);
  assert.deepEqual(detailsStore.get(routing)?.display, {
    pathsExpanded: false,
    bodyExpanded: false,
  });

  // An external resolution can be detected before its durable private
  // rejection retry reaches expiry. Keep the route inert but project expiry.
  detailsStore.invalidateRequest(routing.requestId);
  assert.equal(detailsStore.get(routing), undefined);

  await projector.project({
    type: "git_approval.expired",
    requestId: routing.requestId,
  });

  const expiredUpdate = updates.at(-1);
  assert.equal(expiredUpdate?.channel, routing.channelId);
  assert.equal(expiredUpdate?.ts, routing.messageTs);
  assert.match(String(expiredUpdate?.text), /承認期限が切れました/u);
  const expiredBlocks = JSON.stringify(expiredUpdate?.blocks);
  assert.match(expiredBlocks, /期限切れ（実行不可）/u);
  assert.doesNotMatch(
    expiredBlocks,
    /承認して実行|拒否・保留|taishi\.git_plan|"type":"button"/u,
  );
  assert.equal(detailsStore.get(routing), undefined);
});

test("keeps an expired Git card retryable when the terminal Slack update fails", async () => {
  const updates: Array<Record<string, unknown>> = [];
  let postCount = 0;
  let terminalFailures = 3;
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, ts: `${101 + postCount++}.1` }),
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        if (
          JSON.stringify(input.blocks).includes("承認期限が切れました") &&
          terminalFailures-- > 0
        ) {
          throw new Error("temporary Slack failure");
        }
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const detailsStore = new WorkspaceGitApprovalDetailsStore();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    gitApprovalDetailsStore: detailsStore,
  });
  const requestId = "codex-input:11111111-1111-4111-8111-111111111111";

  await projector.project({
    type: "user_input.requested",
    requestId,
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
      repoId: "showtalk-taishi",
      mode: "commit_only",
      branch: "agent/expired-card",
      paths: ["src/slack/projector.ts"],
      expectedHead: "b".repeat(40),
      expectedSnapshotId: "c".repeat(64),
      worktreeId: "primary",
      expiresAt: "2099-08-14T11:00:00.000Z",
    },
  });
  const routing = {
    version: 1 as const,
    requestId,
    channelId: "C1",
    rootThreadTs: "100.0",
    messageTs: "102.1",
  };

  await projector.project({ type: "git_approval.expired", requestId });
  assert.ok(detailsStore.get(routing));
  await projector.project({ type: "git_approval.expired", requestId });
  assert.equal(detailsStore.get(routing), undefined);
  assert.doesNotMatch(
    JSON.stringify(updates.at(-1)?.blocks),
    /承認して実行|拒否・保留|"type":"button"/u,
  );
});

test("terminalizes a Git approval card resolved by another App Server client", async () => {
  const { client, updates } = recordingClient();
  const detailsStore = new WorkspaceGitApprovalDetailsStore();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    sourceUserId: "U123",
    gitApprovalDetailsStore: detailsStore,
  });
  const requestId = "codex-input:44444444-4444-4444-8444-444444444444";
  const plan = {
    operationId: "55555555-5555-4555-8555-555555555555",
    planHash: "a".repeat(64),
    approvalTarget: "primary",
    operation: "git_publication" as const,
    repoId: "showtalk-taishi",
    mode: "commit_only" as const,
    branch: "agent/external-resolution",
    paths: ["src/slack/projector.ts"],
    expectedHead: "b".repeat(40),
    expectedSnapshotId: "c".repeat(64),
    worktreeId: "primary",
    expiresAt: "2099-08-14T11:00:00.000Z",
  };

  // Simulate serverRequest/resolved arriving while Slack postMessage is still
  // in flight. The eventual remember must stay inert but retain its route.
  detailsStore.invalidateRequest(requestId);

  await projector.project({
    type: "user_input.requested",
    requestId,
    expiresAt: plan.expiresAt,
    prompt: "Approve?",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan,
  });
  const routing = {
    version: 1 as const,
    requestId,
    channelId: "C1",
    rootThreadTs: "100.0",
    messageTs: "102.1",
  };
  assert.equal(detailsStore.get(routing), undefined);
  assert.ok(detailsStore.getForTerminalProjection(requestId, "C1", "100.0"));

  await projector.project({
    type: "git_approval.resolved_externally",
    requestId,
    plan,
  });

  const terminal = updates.at(-1);
  assert.match(String(terminal?.text), /別のCodexクライアント/u);
  assert.doesNotMatch(
    JSON.stringify(terminal?.blocks),
    /承認して実行|拒否・保留|"type":"button"/u,
  );
  assert.equal(detailsStore.get(routing), undefined);
});

test("forgets an externally resolved Git card after terminal Slack update failure", async () => {
  let postCount = 0;
  let terminalFailures = 3;
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, ts: `${101 + postCount++}.1` }),
      update: async (input: Record<string, unknown>) => {
        if (
          String(input.text).includes("別のCodexクライアント") &&
          terminalFailures-- > 0
        ) {
          throw new Error("temporary Slack failure");
        }
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const detailsStore = new WorkspaceGitApprovalDetailsStore();
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    gitApprovalDetailsStore: detailsStore,
  });
  const requestId = "codex-input:66666666-6666-4666-8666-666666666666";
  const plan = {
    operationId: "77777777-7777-4777-8777-777777777777",
    planHash: "d".repeat(64),
    approvalTarget: "primary",
    operation: "git_publication" as const,
    repoId: "showtalk-taishi",
    mode: "commit_only" as const,
    branch: "agent/external-retry",
    paths: ["src/slack/projector.ts"],
    expectedHead: "e".repeat(40),
    expectedSnapshotId: "f".repeat(64),
    worktreeId: "primary",
    expiresAt: "2099-08-14T11:00:00.000Z",
  };
  const routing = {
    version: 1 as const,
    requestId,
    channelId: "C1",
    rootThreadTs: "100.0",
    messageTs: "102.1",
  };

  await projector.project({
    type: "user_input.requested",
    requestId,
    expiresAt: plan.expiresAt,
    prompt: "Approve?",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan,
  });
  await projector.project({
    type: "git_approval.resolved_externally",
    requestId,
    plan,
  });
  assert.equal(detailsStore.get(routing), undefined);
  await projector.project({
    type: "git_approval.resolved_externally",
    requestId,
    plan,
  });
  assert.equal(detailsStore.get(routing), undefined);
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
  assert.match(blocks, /新しい依頼方法を確認/u);
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
  assert.ok(
    allTexts.every((text) => Buffer.byteLength(text, "utf8") <= 3_800),
  );
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

test("retries msg_too_long once with a compact activity message", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let rejectNextUpdate = true;
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: "101.1" };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        if (rejectNextUpdate) {
          rejectNextUpdate = false;
          throw { data: { error: "msg_too_long" } };
        }
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  let now = 0;
  const projector = new SlackThreadProjector(client, "C1", "100.0", {
    now: () => now,
  });

  await projector.project({ type: "message.delta", text: "開始" });
  now = 30_000;
  await projector.project({
    type: "message.delta",
    text: "日本語😀".repeat(4_000),
  });

  assert.equal(posts.length, 1);
  assert.equal(updates.length, 2);
  const failedText = String(updates[0]?.text);
  const compactText = String(updates[1]?.text);
  assert.ok(Buffer.byteLength(failedText, "utf8") <= 3_800);
  assert.ok(Buffer.byteLength(compactText, "utf8") <= 3_800);
  assert.ok(compactText.length < failedText.length);

  now = 60_000;
  await projector.project({ type: "message.delta", text: "続行" });
  assert.equal(updates.length, 3);
  assert.ok(Buffer.byteLength(String(updates[2]?.text), "utf8") <= 3_800);
});
