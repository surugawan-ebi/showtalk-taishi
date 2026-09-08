import assert from "node:assert/strict";
import test from "node:test";

import {
  canSafelyRejectAfterPrivateGitDecisionFailure,
  cancelUnprojectedNativeApproval,
  choiceReceiptText,
  closeFailedPrivateGitDecisionBeforeRecovery,
  consumeContinuationIterator,
  parseHumanSlackMessage,
  parseOrphanedPermissionActionSource,
  parseTrustedApprovalAction,
  parseTrustedConversationControlAction,
  parseTrustedGitApprovalRecoveryAction,
  parseTrustedGitPlanAction,
  parseTrustedGitPlanBodyAction,
  parseTrustedGitPlanPathAction,
  parseTrustedPermissionAction,
  permissionApprovalPostArguments,
  permissionApprovalSettlementUpdateArguments,
  recordGitDecisionBeforeAppServerResume,
  recordGitProjectionFailureBeforeAppServerResume,
  recordSystemGitRejection,
  workspaceGitAutonomyStatus,
} from "../../src/slack/frontend.js";
import { WorkspaceGitHumanDecisionBrokerError } from "../../src/approvals/workspace-git-human-decision-broker.js";
import type { WorkspaceGitApprovalPlan } from "../../src/core/index.js";

const exactGitPlan = {
  operationId: "11111111-1111-4111-8111-111111111111",
  planHash: "a".repeat(64),
  approvalTarget: "primary",
  approvalScope: {
    kind: "git_publication",
    repo_id: "showtalk-taishi",
    mode: "commit_only",
    branch: "codex/private-approval",
    worktree_id: "primary",
    expected_head: "b".repeat(40),
    expected_snapshot_id: "c".repeat(64),
    paths: ["src/slack/frontend.ts"],
    commit_message: "Record private approval",
  },
  operation: "git_publication",
  repoId: "showtalk-taishi",
  mode: "commit_only",
  branch: "codex/private-approval",
  paths: ["src/slack/frontend.ts"],
  expectedHead: "b".repeat(40),
  expectedSnapshotId: "c".repeat(64),
  worktreeId: "primary",
  commitMessage: "Record private approval",
  expiresAt: "2099-08-24T02:30:00+09:00",
} satisfies WorkspaceGitApprovalPlan;

test("distinguishes non-Git external-action receipts from ordinary answers", () => {
  assert.equal(
    choiceReceiptText("U0123456789", "external_action_confirmation"),
    "外部操作への回答を受け付けました（<@U0123456789>）。workspace-gitのGit操作は承認されていません。",
  );
  assert.equal(
    choiceReceiptText("U0123456789", "external_action_confirmation", true),
    "外部操作への回答を新しいターンとして受け付けました（<@U0123456789>）。workspace-gitのGit操作は承認されていません。",
  );
  assert.equal(
    choiceReceiptText("U0123456789", "ordinary"),
    "回答を受け付けました（<@U0123456789>）。",
  );
});

test("keeps normal OFF available after an autonomy candidate is removed", () => {
  const status = workspaceGitAutonomyStatus(
    {
      koeId: "implementer",
      channelId: "C0123456789",
      koeBindingRevision: 9,
      principalPolicyRevision: 9,
    },
    {
      koeId: "implementer",
      profileId: "11111111-1111-4111-8111-111111111111",
      profileRevision: 3,
      activationHandle: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-08-31T01:10:00.000Z",
      state: "enabled",
      updatedAt: "2099-08-31T00:10:00.000Z",
    },
    true,
    Date.parse("2099-08-31T00:20:00.000Z"),
  );
  assert.deepEqual(status, {
    koeId: "implementer",
    available: true,
    state: "enabled",
    profileId: "11111111-1111-4111-8111-111111111111",
    profileRevision: 3,
    expiresAt: "2099-08-31T01:10:00.000Z",
  });
});

test("releases a continuation iterator when admission projection fails", async () => {
  let released = false;
  const iterator: AsyncIterator<string> = {
    next: async () => ({ done: false, value: "running" }),
    return: async () => {
      released = true;
      return { done: true, value: undefined };
    },
  };
  await assert.rejects(
    consumeContinuationIterator(
      iterator,
      async () => Promise.reject(new Error("Slack update failed")),
      async () => undefined,
    ),
    /Slack update failed/u,
  );
  assert.equal(released, true);
});

test("releases a failed continuation before another turn is consumed", async () => {
  let firstReleased = false;
  const failedIterator: AsyncIterator<string> = {
    next: async () => ({ done: false, value: "first event" }),
    return: async () => {
      firstReleased = true;
      return { done: true, value: undefined };
    },
  };
  await assert.rejects(
    consumeContinuationIterator(
      failedIterator,
      async () => undefined,
      async () => Promise.reject(new Error("projection failed")),
    ),
    /projection failed/u,
  );
  assert.equal(firstReleased, true);

  const events: string[] = [];
  let step = 0;
  await consumeContinuationIterator<string>(
    {
      next: async () => step++ === 0
        ? { done: false, value: "next turn" }
        : { done: true, value: undefined },
    } as AsyncIterator<string>,
    async () => undefined,
    async (event) => {
      events.push(event);
    },
  );
  assert.deepEqual(events, ["next turn"]);
});

test("records the exact private Git decision before resuming App Server", async () => {
  const order: string[] = [];
  await recordGitDecisionBeforeAppServerResume(
    {
      contract_version: 1,
      recordDecision: async (input) => {
        order.push("broker");
        assert.equal(input.plan, exactGitPlan);
        assert.equal(input.decision, "approve");
        assert.equal(input.deliveryId, "d".repeat(64));
        assert.equal(input.context.callerId, "U0123456789");
      },
    },
    exactGitPlan,
    "approve",
    "d".repeat(64),
    {
      callerId: "U0123456789",
      koeId: "taishi",
      channelId: "C0123456789",
      rootThreadTs: "1700000000.000001",
      sessionId: "session-1",
    },
    async () => {
      order.push("app-server");
    },
  );
  assert.deepEqual(order, ["broker", "app-server"]);
});

test("does not resume App Server when the private Git decision fails", async () => {
  let resumed = false;
  await assert.rejects(
    recordGitDecisionBeforeAppServerResume(
      {
        contract_version: 1,
        recordDecision: async () => Promise.reject(new Error("private mismatch")),
      },
      exactGitPlan,
      "approve",
      "d".repeat(64),
      {
        callerId: "U0123456789",
        koeId: "taishi",
        channelId: "C0123456789",
        rootThreadTs: "1700000000.000001",
        sessionId: "session-1",
      },
      async () => {
        resumed = true;
      },
    ),
    /private mismatch/u,
  );
  assert.equal(resumed, false);
});

test("durably rejects a failed private decision before closing App Server and replacing Slack controls", async () => {
  const order: string[] = [];
  await closeFailedPrivateGitDecisionBeforeRecovery(
    {
      recordRejection: async (plan, actor) => {
        order.push("durable-rejection");
        assert.equal(plan, exactGitPlan);
        assert.equal(actor, "showtalk:private-decision-failure");
      },
    },
    exactGitPlan,
    async () => {
      order.push("app-server-reject");
    },
    async () => {
      order.push("slack-recovery");
    },
  );
  assert.deepEqual(order, [
    "durable-rejection",
    "app-server-reject",
    "slack-recovery",
  ]);
});

test("keeps App Server and Slack controls pending when durable failure rejection cannot be recorded", async () => {
  const order: string[] = [];
  await assert.rejects(
    closeFailedPrivateGitDecisionBeforeRecovery(
      {
        recordRejection: async () => {
          order.push("durable-rejection");
          throw new Error("private store unavailable");
        },
      },
      exactGitPlan,
      async () => {
        order.push("app-server-reject");
      },
      async () => {
        order.push("slack-recovery");
      },
    ),
    /private store unavailable/u,
  );
  assert.deepEqual(order, ["durable-rejection"]);
});

test("keeps uncertain or conflicting private decisions pending for exact-delivery reconciliation", () => {
  for (const code of [
    "decision_outcome_unknown",
    "state_write_failed",
    "decision_replay",
    "status_conflict",
  ] as const) {
    assert.equal(
      canSafelyRejectAfterPrivateGitDecisionFailure(
        new WorkspaceGitHumanDecisionBrokerError(code),
      ),
      false,
    );
  }
  for (const code of [
    "invalid_decision",
    "operation_not_found",
    "plan_mismatch",
    "expired",
  ] as const) {
    assert.equal(
      canSafelyRejectAfterPrivateGitDecisionFailure(
        new WorkspaceGitHumanDecisionBrokerError(code),
      ),
      true,
    );
  }
  assert.equal(
    canSafelyRejectAfterPrivateGitDecisionFailure(new Error("transport failed")),
    false,
  );
});

test("records a system Git rejection before closing an unprojected App Server request", async () => {
  const order: string[] = [];
  await recordGitProjectionFailureBeforeAppServerResume(
    {
      recordRejection: async (plan, actor) => {
        order.push("broker");
        assert.equal(actor, "showtalk:slack-projection-failure");
        assert.equal(plan, exactGitPlan);
      },
    },
    exactGitPlan,
    async () => {
      order.push("app-server");
    },
  );
  assert.deepEqual(order, ["broker", "app-server"]);
});

test("leaves an unprojected App Server request pending when its system rejection cannot be recorded", async () => {
  let resumed = false;
  await assert.rejects(
    recordGitProjectionFailureBeforeAppServerResume(
      {
        recordRejection: async () => Promise.reject(new Error("broker unavailable")),
      },
      exactGitPlan,
      async () => {
        resumed = true;
      },
    ),
    /broker unavailable/u,
  );
  assert.equal(resumed, false);
});

test("records externally resolved App Server Git requests as private rejections", async () => {
  const decisions: unknown[] = [];
  await recordSystemGitRejection(
    {
      recordRejection: async (plan, actor) => {
        decisions.push({ decision: "reject", plan, actor });
      },
    },
    exactGitPlan,
    "showtalk:external-app-server-resolution",
  );
  assert.deepEqual(decisions, [{
    decision: "reject",
    plan: exactGitPlan,
    actor: "showtalk:external-app-server-resolution",
  }]);
});

test("accepts permission and control actions only from their exact Slack message", () => {
  const route = {
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    messageTs: "1786654846.000100",
    operation: "gateway.restart",
  } as const;
  const body = {
    type: "block_actions",
    api_app_id: "A0123456789",
    team: { id: "T0123456789" },
    user: { id: "U0123456789" },
    channel: { id: route.channelId },
    message: { ts: route.messageTs, thread_ts: route.rootThreadTs },
    container: {
      type: "message",
      channel_id: route.channelId,
      message_ts: route.messageTs,
    },
  };
  const approvers = new Set(["U0123456789"]);
  const permissionAction = {
    action_id: "taishi.permission.allow_once",
    value: JSON.stringify({
      requestId: "permission:one",
      channelId: route.channelId,
    }),
  };
  assert.equal(
    parseTrustedPermissionAction(body, permissionAction, approvers, route)
      .decision,
    "allow_once",
  );
  assert.throws(() =>
    parseTrustedPermissionAction(
      { ...body, message: { ...body.message, ts: "1786654846.999999" } },
      permissionAction,
      approvers,
      route,
    ),
  );

  const controlAction = {
    action_id: "taishi.conversation.restart",
    value: JSON.stringify({
      channelId: route.channelId,
      rootThreadTs: route.rootThreadTs,
      messageTs: route.messageTs,
    }),
  };
  assert.equal(
    parseTrustedConversationControlAction(body, controlAction, approvers)
      .operation,
    "restart",
  );
  assert.throws(() =>
    parseTrustedConversationControlAction(
      {
        ...body,
        container: { ...body.container, message_ts: "1786654846.999999" },
      },
      controlAction,
      approvers,
    ),
  );
});

test("recovers an orphaned permission card fail-closed without authorizing it", () => {
  const channelId = "C0123456789";
  const messageTs = "1786654846.000100";
  const rootThreadTs = "1786654845.402859";
  const action = {
    action_id: "taishi.permission.allow_once",
    value: JSON.stringify({
      requestId: "permission:orphaned",
      channelId,
    }),
  };
  const body = {
    type: "block_actions",
    api_app_id: "A0123456789",
    team: { id: "T0123456789" },
    user: { id: "U0123456789" },
    channel: { id: channelId },
    message: { ts: messageTs, thread_ts: rootThreadTs },
    container: {
      type: "message",
      channel_id: channelId,
      message_ts: messageTs,
    },
  };

  assert.deepEqual(
    parseOrphanedPermissionActionSource(
      body,
      action,
      new Set(["U0123456789"]),
    ),
    {
      userId: "U0123456789",
      channelId,
      rootThreadTs,
      messageTs,
      teamId: "T0123456789",
      apiAppId: "A0123456789",
      requestId: "permission:orphaned",
    },
  );
  assert.throws(() =>
    parseOrphanedPermissionActionSource(
      {
        ...body,
        container: { ...body.container, message_ts: "1786654846.999999" },
      },
      action,
      new Set(["U0123456789"]),
    ),
  );
  assert.equal(
    parseOrphanedPermissionActionSource(
      {
        ...body,
        message: { ts: messageTs },
      },
      action,
      new Set(["U0123456789"]),
    ).rootThreadTs,
    messageTs,
  );
});

test("parses a native approval only from its exact Slack message and thread", () => {
  const approval = {
    requestId: "approval-1",
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    messageTs: "1786654846.000100",
    sessionId: "session-1",
  } as const;
  const body = {
    type: "block_actions",
    api_app_id: "A0123456789",
    team: { id: "T0123456789" },
    user: { id: "U0123456789" },
    channel: { id: approval.channelId },
    message: { ts: approval.messageTs, thread_ts: approval.rootThreadTs },
    container: {
      type: "message",
      channel_id: approval.channelId,
      message_ts: approval.messageTs,
    },
  };
  const action = {
    action_id: "taishi.approval.allow_once",
    value: JSON.stringify(approval),
  };

  assert.deepEqual(
    parseTrustedApprovalAction(
      body,
      action,
      new Set(["U0123456789"]),
    ),
    {
      decision: "allow_once",
      approval,
      source: {
        userId: "U0123456789",
        channelId: approval.channelId,
        rootThreadTs: approval.rootThreadTs,
        messageTs: approval.messageTs,
        teamId: "T0123456789",
        apiAppId: "A0123456789",
      },
    },
  );
  assert.throws(() =>
    parseTrustedApprovalAction(
      { ...body, message: { ...body.message, ts: "1786654846.999999" } },
      action,
      new Set(["U0123456789"]),
    ),
  );
  assert.throws(() =>
    parseTrustedApprovalAction(
      {
        ...body,
        message: { ...body.message, thread_ts: "1786654845.999999" },
      },
      action,
      new Set(["U0123456789"]),
    ),
  );
  assert.throws(() =>
    parseTrustedApprovalAction(
      { ...body, user: { id: "UATTACKER" } },
      action,
      new Set(["U0123456789"]),
    ),
  );
});

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

test("closes permission cards with unambiguous terminal status", () => {
  const route = {
    channelId: "C1",
    messageTs: "1786554846.000100",
    rootThreadTs: "1786554845.402859",
    operation: "gateway.restart",
  };

  const expired = permissionApprovalSettlementUpdateArguments(route, {
    requestId: "permission:expired",
    reason: "expired",
  });
  assert.equal(expired.channel, "C1");
  assert.equal(expired.ts, "1786554846.000100");
  assert.deepEqual(expired.blocks, []);
  assert.match(expired.text, /expired/u);
  assert.match(expired.text, /No action was authorized/u);

  const cancelled = permissionApprovalSettlementUpdateArguments(route, {
    requestId: "permission:cancelled",
    reason: "caller_cancelled",
  });
  assert.match(cancelled.text, /requesting operation ended/u);
  assert.match(cancelled.text, /No action was authorized/u);

  const approved = permissionApprovalSettlementUpdateArguments(route, {
    requestId: "permission:approved",
    reason: "allow_once",
    resolvedBySlackUserId: "U0123456789",
  });
  assert.match(approved.text, /approved once/u);
  assert.match(approved.text, /<@U0123456789>/u);
  assert.match(approved.text, /does not confirm operation completion/u);
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
  const actionToken = {
    version: 1,
    requestId: routing.requestId,
    channelId: routing.channelId,
    rootThreadTs: routing.rootThreadTs,
  } as const;
  assert.deepEqual(
    parseTrustedGitPlanAction(
      body,
      {
        action_id: "taishi.git_plan.approve",
        value: JSON.stringify(actionToken),
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
        value: JSON.stringify(actionToken),
      },
      new Set(["U0123456789"]),
    ),
  );
});

test("parses a Git file-list toggle only from the bound approval message", () => {
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
    parseTrustedGitPlanPathAction(
      body,
      {
        action_id: "taishi.git_plan.paths.show",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
    {
      visibility: "show",
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
    parseTrustedGitPlanPathAction(
      { ...body, message: { ...body.message, ts: "1786654846.000999" } },
      {
        action_id: "taishi.git_plan.paths.hide",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
  );
});

test("parses a Git PR-body toggle only from the bound approval message", () => {
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
    parseTrustedGitPlanBodyAction(
      body,
      {
        action_id: "taishi.git_plan.body.show",
        value: JSON.stringify(routing),
      },
      new Set(["U0123456789"]),
    ),
    {
      visibility: "show",
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
    parseTrustedGitPlanBodyAction(
      { ...body, message: { ...body.message, ts: "1786654846.000999" } },
      {
        action_id: "taishi.git_plan.body.hide",
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

test("cancels a native approval whose Slack controls could not be displayed", async () => {
  const calls: unknown[] = [];
  const gateway = {
    resolveSessionApproval: async (...args: unknown[]) => {
      calls.push(args);
    },
  };

  assert.equal(
    await cancelUnprojectedNativeApproval(gateway, "session-1", {
      type: "approval.requested",
      requestId: "codex:11111111-1111-4111-8111-111111111111",
      summary: "Run a command",
    }),
    true,
  );
  assert.deepEqual(calls, [[
    "session-1",
    {
      requestId: "codex:11111111-1111-4111-8111-111111111111",
      decision: "cancel",
    },
  ]]);
  assert.equal(
    await cancelUnprojectedNativeApproval(gateway, "session-1", {
      type: "message.completed",
      text: "done",
    }),
    false,
  );
  assert.equal(calls.length, 1);
});
