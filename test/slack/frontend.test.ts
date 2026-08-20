import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHumanSlackMessage,
  parseTrustedGitApprovalRecoveryAction,
  parseTrustedGitPlanAction,
  permissionApprovalPostArguments,
} from "../../src/slack/frontend.js";

test("accepts ordinary human messages", () => {
  assert.deepEqual(
    parseHumanSlackMessage({
      channel: "C1",
      ts: "1.001",
      text: "Please continue",
      thread_ts: "1.000",
      user: "U1",
    }),
    {
      channel: "C1",
      ts: "1.001",
      text: "Please continue",
      thread_ts: "1.000",
      user: "U1",
      fileIds: [],
    },
  );
});

test("accepts the text of human file-share messages", () => {
  assert.deepEqual(
    parseHumanSlackMessage({
      channel: "C1",
      ts: "1.002",
      text: "Why did this stop?",
      thread_ts: "1.000",
      user: "U1",
      subtype: "file_share",
      files: [{ id: "F1", mimetype: "image/png" }],
    }),
    {
      channel: "C1",
      ts: "1.002",
      text: "Why did this stop?",
      thread_ts: "1.000",
      user: "U1",
      fileIds: ["F1"],
    },
  );
});

test("keeps ordered file IDs from regular and compact Slack file payloads", () => {
  assert.deepEqual(
    parseHumanSlackMessage({
      channel: "C1",
      ts: "1.003",
      text: "Compare these",
      user: "U1",
      subtype: "file_share",
      files: [{ id: "F1" }, { id: "F2" }],
      x_files: ["F3"],
    })?.fileIds,
    ["F1", "F2", "F3"],
  );
});

test("rejects bot and non-message file-share subtypes", () => {
  const base = {
    channel: "C1",
    ts: "1.002",
    text: "ignored",
    user: "U1",
  };

  assert.equal(
    parseHumanSlackMessage({ ...base, subtype: "file_share", bot_id: "B1" }),
    undefined,
  );
  assert.equal(
    parseHumanSlackMessage({ ...base, subtype: "message_changed" }),
    undefined,
  );
  assert.equal(
    parseHumanSlackMessage({ ...base, subtype: "message_deleted" }),
    undefined,
  );
  assert.equal(
    parseHumanSlackMessage({ ...base, subtype: "channel_join" }),
    undefined,
  );
});

test("rejects messages without required routing fields", () => {
  assert.equal(
    parseHumanSlackMessage({ ts: "1.002", text: "missing channel" }),
    undefined,
  );
  assert.equal(
    parseHumanSlackMessage({ channel: "C1", text: "missing timestamp" }),
    undefined,
  );
  assert.equal(
    parseHumanSlackMessage({ channel: "C1", ts: "1.002" }),
    undefined,
  );
});

test("posts permission approval UI in the originating thread and mentions its user", () => {
  const input = permissionApprovalPostArguments(
    {
      requestId: "permission:one",
      sourceAgentId: "showtalk",
      sourceChannelId: "C1",
      sourceRootThreadTs: "1786554845.402859",
      sourceSlackUserId: "U123",
      operation: "slack.write",
      summary: "Post a review result",
      expiresAt: "2026-08-13T00:10:00.000Z",
    },
    "U999",
    { username: "Taishi ShowTalk", icon_emoji: ":speech_balloon:" },
  );

  assert.equal(input.channel, "C1");
  assert.equal(input.thread_ts, "1786554845.402859");
  assert.match(input.text, /^<@U123> /u);
  assert.match(JSON.stringify(input.blocks), /<@U123>/u);
  assert.doesNotMatch(JSON.stringify(input), /<@U999>/u);
  assert.equal(input.username, "Taishi ShowTalk");
  assert.equal(input.icon_emoji, ":speech_balloon:");
});

test("falls back to a configured approver when no Slack user context exists", () => {
  const input = permissionApprovalPostArguments(
    {
      requestId: "permission:two",
      sourceAgentId: "showtalk",
      sourceChannelId: "C1",
      operation: "agent.send",
      summary: "Delegate work",
      expiresAt: "2026-08-13T00:10:00.000Z",
    },
    "U999",
  );

  assert.equal("thread_ts" in input, false);
  assert.match(input.text, /^<@U999> /u);
  assert.match(JSON.stringify(input.blocks), /<@U999>/u);
});

test("parses a Git approval callback only from the bound Slack Block source", () => {
  const routing = {
    version: 1,
    requestId: "codex-input:11111111-1111-4111-8111-111111111111",
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    messageTs: "1786654846.000100",
  } as const;
  const body = {
    type: "block_actions",
    api_app_id: "A0123456789",
    team: { id: "T0123456789" },
    user: { id: "U0123456789" },
    channel: { id: routing.channelId },
    message: { ts: routing.messageTs, thread_ts: routing.rootThreadTs },
    container: {
      type: "message",
      channel_id: routing.channelId,
      message_ts: routing.messageTs,
    },
  };
  assert.deepEqual(
    parseTrustedGitPlanAction(
      body,
      {
        action_id: "taishi.git_plan.approve",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
    {
      decision: "approve",
      routing,
      source: {
        userId: "U0123456789",
        channelId: routing.channelId,
        rootThreadTs: routing.rootThreadTs,
        messageTs: routing.messageTs,
        teamId: "T0123456789",
        apiAppId: "A0123456789",
      },
    },
  );
  assert.throws(() =>
    parseTrustedGitPlanAction(
      { ...body, user: { id: "UATTACKER" } },
      {
        action_id: "taishi.git_plan.approve",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
  );
});

test("parses a Git approval recovery callback only from its bound Slack message", () => {
  const routing = {
    version: 1,
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    messageTs: "1786654846.000200",
  } as const;
  const body = {
    type: "block_actions",
    api_app_id: "A0123456789",
    team: { id: "T0123456789" },
    user: { id: "U0123456789" },
    channel: { id: routing.channelId },
    message: { ts: routing.messageTs, thread_ts: routing.rootThreadTs },
    container: {
      type: "message",
      channel_id: routing.channelId,
      message_ts: routing.messageTs,
    },
  };

  assert.deepEqual(
    parseTrustedGitApprovalRecoveryAction(
      body,
      {
        action_id: "taishi.git_recovery.reprepare",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
    {
      decision: "reprepare",
      routing,
      source: {
        userId: "U0123456789",
        channelId: routing.channelId,
        rootThreadTs: routing.rootThreadTs,
        messageTs: routing.messageTs,
        teamId: "T0123456789",
        apiAppId: "A0123456789",
      },
    },
  );
  assert.throws(() =>
    parseTrustedGitApprovalRecoveryAction(
      { ...body, message: { ...body.message, ts: "1786654846.999999" } },
      {
        action_id: "taishi.git_recovery.reprepare",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
  );
});
