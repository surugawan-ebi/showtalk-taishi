import assert from "node:assert/strict";
import test from "node:test";

import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import type {
  AgentEvent,
  Gateway,
  WorkspaceGitApprovalPlan,
} from "../../src/core/index.js";
import {
  parseHumanSlackMessage,
  permissionApprovalPostArguments,
  SlackFrontend,
  type SlackFrontendOptions,
} from "../../src/slack/frontend.js";
import {
  classifyDotSlackMessage,
  createDotOriginDiagnosticReporter,
  diagnoseRejectedDotSlackMessage,
  DOT_BOT_USER_ID,
  shouldSuppressDotUserMention,
} from "../../src/slack/dot-origin.js";
import { CHATGPT_ATTRIBUTION_PROFILE } from "../../src/slack/approval-text-command.js";
import { parseChoiceActionValue } from "../../src/slack/choice-blocks.js";
import { parsePermissionActionValue } from "../../src/slack/permission-blocks.js";
import { SlackThreadProjector } from "../../src/slack/projector.js";
import { StructuredChoiceContinuationStore } from "../../src/slack/choice-continuation.js";
import { WorkspaceGitApprovalDetailsStore } from "../../src/slack/user-input-blocks.js";

type Call = Record<string, unknown>;
type Listener = (args: Record<string, unknown>) => Promise<void>;

const connectorSourceUser = "UDOTSOURCE";
const mentionedUser = "UMENTIONTARGET";
const footer = `*使用して送信されました* <@${CHATGPT_ATTRIBUTION_PROFILE.userId}>`;

function attributedDotEvent(
  text = "dot request",
  leaves: readonly Call[] = [{ type: "text", text }],
): Call {
  return {
    type: "message",
    channel: "C1",
    ts: "2.000001",
    thread_ts: "1.000001",
    user: connectorSourceUser,
    app_id: CHATGPT_ATTRIBUTION_PROFILE.appId,
    text: `${text} ${footer}`,
    blocks: [
      { type: "rich_text", elements: [
        { type: "rich_text_section", elements: leaves },
      ] },
      { type: "context", elements: [{ type: "mrkdwn", text: footer, verbatim: false }] },
    ],
  };
}

const longConnectorText =
  `<@${mentionedUser}> Koeモデル日次見直し｜2026-10-07 JST。dot経由です。\n` +
  "既存管理APIと最新公式情報 " +
  "<https://learn.chatgpt.com/docs/models|learn.chatgpt.com/docs/models> " +
  "<https://learn.chatgpt.com/docs/pricing|learn.chatgpt.com/docs/pricing> " +
  "<https://developers.openai.com/api/docs/pricing|developers.openai.com/api/docs/pricing> " +
  "を照合し、設定変更が不要なら維持してください。";

function longAttributedDotEvent(): Call {
  return attributedDotEvent(longConnectorText, [
    { type: "user", user_id: mentionedUser, from_llm: true },
    { type: "text", text: " Koeモデル日次見直し｜2026-10-07 JST。dot経由です。\n既存管理APIと最新公式情報 " },
    {
      type: "link",
      url: "https://learn.chatgpt.com/docs/models",
      text: "learn.chatgpt.com/docs/models",
      from_llm: true,
    },
    { type: "text", text: " " },
    {
      type: "link",
      url: "https://learn.chatgpt.com/docs/pricing",
      text: "learn.chatgpt.com/docs/pricing",
    },
    { type: "text", text: " " },
    {
      type: "link",
      url: "https://developers.openai.com/api/docs/pricing",
      text: "developers.openai.com/api/docs/pricing",
    },
    { type: "text", text: " を照合し、設定変更が不要なら維持してください。" },
  ]);
}

function numberedListDotEvent(secret = "synthetic-list-body"): Call {
  const text = `確認事項\n1. ${secret}\n2. second item\n完了条件`;
  const event = attributedDotEvent(text);
  event.blocks = [
    { type: "rich_text", elements: [
      { type: "rich_text_section", elements: [{ type: "text", text: "確認事項\n" }] },
      { type: "rich_text_list", style: "ordered", elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: `1. ${secret}` }] },
        { type: "rich_text_section", elements: [{ type: "text", text: "2. second item" }] },
      ] },
      { type: "rich_text_section", elements: [{ type: "text", text: "\n完了条件" }] },
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: footer, verbatim: false }] },
  ];
  return event;
}

test("classifies only explicit dot identities and rejects self-reported or envelope-only signals", () => {
  assert.equal(Object.isFrozen(CHATGPT_ATTRIBUTION_PROFILE), true);
  const attributed = attributedDotEvent();
  const standalone = {
    type: "message", channel: "C1", ts: "3.000001", thread_ts: "1.000001",
    user: DOT_BOT_USER_ID, text: "dot bot request",
  };
  const direct = {
    ...attributed,
    user: "U1",
    app_id: undefined,
    text: `dot request ${footer}`,
  };
  assert.equal(classifyDotSlackMessage(attributed), "dot_chatgpt_connector");
  assert.equal(classifyDotSlackMessage(standalone), "dot_bot");
  assert.equal(shouldSuppressDotUserMention(direct), false);
  assert.equal(shouldSuppressDotUserMention({
    ...attributed, app_id: undefined, api_app_id: CHATGPT_ATTRIBUTION_PROFILE.appId,
  }), false);
  assert.equal(shouldSuppressDotUserMention({ ...attributed, text: "dot request" }), false);
});

test("classifies the canonical long connector shape with multiple URLs and a user mention", () => {
  const long = longAttributedDotEvent();
  assert.equal(classifyDotSlackMessage(long), "dot_chatgpt_connector");

  const plainUrl = "See https://example.com/one and <https://example.com/two>.";
  assert.equal(classifyDotSlackMessage(attributedDotEvent(plainUrl, [
    { type: "text", text: "See " },
    { type: "link", url: "https://example.com/one" },
    { type: "text", text: " and " },
    { type: "link", url: "https://example.com/two" },
    { type: "text", text: "." },
  ])), "dot_chatgpt_connector");

  const blocks = structuredClone(long.blocks) as Call[];
  const section = ((blocks[0] as Call).elements as Call[])[0] as Call;
  const leaves = section.elements as Call[];
  leaves[2] = { ...leaves[2], url: "https://attacker.example/changed" };
  assert.equal(classifyDotSlackMessage({ ...long, blocks }), undefined);

  assert.equal(classifyDotSlackMessage(attributedDotEvent("styled", [
    { type: "text", text: "styled", style: { bold: true } },
  ])), undefined);
});

test("diagnoses rejected connector shapes without changing classification or copying payloads", () => {
  const canonical = longAttributedDotEvent();
  assert.equal(diagnoseRejectedDotSlackMessage(canonical), undefined);
  assert.equal(classifyDotSlackMessage(canonical), "dot_chatgpt_connector");

  const list = numberedListDotEvent("SECRET_LIST_TOKEN");
  assert.equal(classifyDotSlackMessage(list), undefined);
  assert.deepEqual(diagnoseRejectedDotSlackMessage(list), {
    component: "showtalk.dot_origin",
    version: 1,
    event: "classification_rejected",
    reason: "body_elements_unsupported",
    sectionCount: "2",
    bodyElementTypes: ["section", "list", "section"],
  });

  const multipleSections = attributedDotEvent("first\nsecond");
  multipleSections.blocks = [
    { type: "rich_text", elements: [
      { type: "rich_text_section", elements: [{ type: "text", text: "first\n" }] },
      { type: "rich_text_section", elements: [{ type: "text", text: "second" }] },
    ] },
    { type: "context", elements: [{ type: "mrkdwn", text: footer, verbatim: false }] },
  ];
  assert.equal(classifyDotSlackMessage(multipleSections), undefined);
  assert.deepEqual(diagnoseRejectedDotSlackMessage(multipleSections), {
    component: "showtalk.dot_origin",
    version: 1,
    event: "classification_rejected",
    reason: "body_elements_unsupported",
    sectionCount: "2",
    bodyElementTypes: ["section", "section"],
  });

  const unknownField = attributedDotEvent("SECRET_FIELD_TOKEN", [
    { type: "text", text: "SECRET_FIELD_TOKEN", secret_value: "do-not-log" },
  ]);
  assert.equal(classifyDotSlackMessage(unknownField), undefined);
  assert.equal(
    diagnoseRejectedDotSlackMessage(unknownField)?.reason,
    "unsupported_field",
  );

  const unknownElement = numberedListDotEvent("SECRET_UNKNOWN_TYPE");
  ((unknownElement.blocks as Call[])[0] as Call).elements = [
    { type: "private_SECRET_UNKNOWN_TYPE", payload: "do-not-log" },
  ];
  assert.equal(classifyDotSlackMessage(unknownElement), undefined);
  assert.deepEqual(diagnoseRejectedDotSlackMessage(unknownElement)?.bodyElementTypes, [
    "unknown",
  ]);

  const fakeFooter = {
    ...attributedDotEvent("SECRET_FAKE_FOOTER"),
    app_id: "SECRET_FAKE_APP_ID",
  };
  assert.equal(classifyDotSlackMessage(fakeFooter), undefined);
  assert.equal(
    diagnoseRejectedDotSlackMessage(fakeFooter)?.reason,
    "app_identity_mismatch",
  );

  for (const event of [list, multipleSections, unknownField, unknownElement, fakeFooter]) {
    const encoded = JSON.stringify(diagnoseRejectedDotSlackMessage(event));
    assert.ok(encoded.length < 512);
    for (const forbidden of [
      "SECRET_", "do-not-log", "https://", CHATGPT_ATTRIBUTION_PROFILE.appId,
      connectorSourceUser, CHATGPT_ATTRIBUTION_PROFILE.userId,
      "使用して送信されました",
    ]) assert.equal(encoded.includes(forbidden), false);
  }
});

test("rate-limits identical dot rejection diagnostics without affecting classification", () => {
  let now = 1_000_000;
  const lines: string[] = [];
  const report = createDotOriginDiagnosticReporter(
    (line) => lines.push(line),
    () => now,
  );
  const event = numberedListDotEvent("SECRET_RATE_TOKEN");
  report(event);
  report(event);
  assert.equal(lines.length, 1);
  now += 5 * 60 * 1_000;
  report(event);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.length < 512));
  assert.ok(lines.every((line) => !line.includes("SECRET_RATE_TOKEN")));
  assert.equal(classifyDotSlackMessage(event), undefined);
});

test("does not newly accept a typical bot_message as a dot turn", () => {
  const event = {
    type: "message", channel: "C1", ts: "4.000001", thread_ts: "1.000001",
    user: DOT_BOT_USER_ID, bot_id: "B-DOT", subtype: "bot_message", text: "dot bot",
  };
  assert.equal(classifyDotSlackMessage(event), undefined);
  assert.equal(shouldSuppressDotUserMention(event), false);
  assert.equal(parseHumanSlackMessage(event), undefined);
});

function recordingClient(): { client: WebClient; posts: Call[]; updates: Call[] } {
  const posts: Call[] = [];
  const updates: Call[] = [];
  const client = {
    chat: {
      postMessage: async (input: Call) => {
        posts.push(input);
        return { ok: true, ts: `${100 + posts.length}.000001` };
      },
      update: async (input: Call) => {
        updates.push(input);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  return { client, posts, updates };
}

test("keeps notification classification per projector turn, including normal and final replies", async () => {
  const dot = recordingClient();
  const dotProjector = new SlackThreadProjector(dot.client, "C1", "1.000001", {
    sourceUserId: connectorSourceUser,
    mentionSourceUserInTurnMessages: false,
    mentionSourceUserInActionableMessages: false,
  });
  await dotProjector.project({ type: "message.delta", text: "dot answer" });
  await dotProjector.complete();
  assert.ok([...dot.posts, ...dot.updates].every(
    (call) => !String(call.text).includes(`<@${connectorSourceUser}>`),
  ));

  const human = recordingClient();
  const humanProjector = new SlackThreadProjector(human.client, "C1", "1.000001", {
    sourceUserId: "U1",
  });
  await humanProjector.project({ type: "message.completed", text: "human answer" });
  await humanProjector.complete();
  assert.ok([...human.posts, ...human.updates].some(
    (call) => String(call.text).includes("<@U1>"),
  ));
});

class FakeApp {
  readonly events = new Map<string, Listener>();
  readonly posts: Call[] = [];
  readonly updates: Call[] = [];
  readonly client = {
    chat: {
      postMessage: async (input: Call) => {
        this.posts.push(input);
        return { ok: true, ts: `${200 + this.posts.length}.000001` };
      },
      update: async (input: Call) => {
        this.updates.push(input);
        return { ok: true };
      },
      postEphemeral: async () => ({ ok: true }),
    },
  };
  event(name: string, listener: Listener): void { this.events.set(name, listener); }
  action(): void {}
  view(): void {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

class FakeGateway {
  nextEvent: AgentEvent = { type: "message.completed", text: "answer" };
  async *handleHumanMessage(): AsyncIterable<{ sessionId: string; event: AgentEvent }> {
    yield { sessionId: "session-dot-fixture", event: this.nextEvent };
  }
}

function frontendFixture(audit: string[]) {
  const app = new FakeApp();
  const gateway = new FakeGateway();
  const dotDiagnostics: string[] = [];
  const options: SlackFrontendOptions = {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    approverUserIds: ["U1"],
    agentChannelIds: ["C1"],
    agentIdsByChannel: { C1: "test-koe" },
    attachmentRoot: "/tmp",
    interactionAudit: (event) => audit.push(event.event),
    dotOriginDiagnosticWrite: (line) => dotDiagnostics.push(line),
  };
  const frontend = new SlackFrontend(
    gateway as unknown as Gateway,
    options,
    app as unknown as App,
  );
  return { app, gateway, frontend, dotDiagnostics };
}

async function sendMessage(
  fixture: ReturnType<typeof frontendFixture>,
  event: Call,
  eventId: string,
): Promise<void> {
  const listener = fixture.app.events.get("message");
  assert.ok(listener);
  await listener({
    event,
    body: { event_id: eventId, team_id: "T1", api_app_id: "AENVELOPE" },
    client: fixture.app.client,
    logger: { error: () => undefined },
  });
}

test("SlackFrontend passes dot suppression per message while preserving choice notification and responder/audit", async () => {
  const audit: string[] = [];
  const fixture = frontendFixture(audit);
  await sendMessage(fixture, longAttributedDotEvent(), "event-dot");
  assertNoDisplayedMention([...fixture.app.posts, ...fixture.app.updates], connectorSourceUser);

  fixture.gateway.nextEvent = { type: "message.completed", text: "human answer" };
  await sendMessage(fixture, {
    type: "message", channel: "C1", ts: "5.000001", thread_ts: "1.000001",
    user: "U1", text: "direct human follow-up",
  }, "event-human");
  assert.ok(fixture.app.posts.some((call) => String(call.text).includes("<@U1>")));

  fixture.gateway.nextEvent = {
    type: "choice.requested",
    requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T00:00:00.000Z",
    completedAnswers: [],
    question: {
      id: "question_1",
      purpose: "external_action_confirmation",
      header: "Test action",
      prompt: "Target: synthetic target\nScope: no-op test\nImpact: no external writes",
      allowsOther: false,
      options: [
        { id: "option_1", label: "外部操作を承認（Git承認ではありません）", description: "Confirm" },
        { id: "option_2", label: "外部操作を拒否・保留", description: "Reject" },
      ],
    },
  };
  const beforeApproval = fixture.app.posts.length;
  const beforeApprovalUpdates = fixture.app.updates.length;
  await sendMessage(fixture, attributedDotEvent("approval request"), "event-approval");
  const approvalCalls = [
    ...fixture.app.posts.slice(beforeApproval),
    ...fixture.app.updates.slice(beforeApprovalUpdates),
  ];
  assertNoDisplayedMention(approvalCalls, connectorSourceUser);
  const choiceUpdate = [...fixture.app.updates].reverse().find((call) =>
    Array.isArray(call.blocks) && JSON.stringify(call.blocks).includes("taishi.choice."),
  );
  assert.ok(choiceUpdate);
  const actionsBlock = (choiceUpdate.blocks as unknown[]).find((block) =>
    typeof block === "object" && block !== null &&
    (block as Call).type === "actions",
  ) as Call | undefined;
  assert.ok(actionsBlock);
  const firstButton = (actionsBlock.elements as unknown[])[0] as Call | undefined;
  assert.ok(firstButton);
  const decodedChoice = parseChoiceActionValue(String(firstButton.value));
  assert.equal(decodedChoice.requestId, "codex-choice:11111111-1111-4111-8111-111111111111");
  assert.equal(decodedChoice.responderUserId, connectorSourceUser);
  assert.deepEqual(
    audit.filter((event) => event.startsWith("choice.")),
    ["choice.request_received", "choice.card_posted", "choice.controls_attached"],
  );

  for (const [event, eventId] of [
    [{
      type: "approval.requested" as const,
      requestId: "codex:11111111-1111-4111-8111-111111111111",
      summary: "Run a command",
      availableDecisions: ["allow_once", "deny", "cancel"] as const,
    }, "event-native"],
    [{
      type: "choice.requested" as const,
      requestId: "codex-choice:22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-01-01T00:00:00.000Z",
      completedAnswers: [],
      question: {
        id: "question_1",
        header: "Ordinary choice",
        prompt: "Choose",
        allowsOther: false,
        options: [
          { id: "option_1", label: "Yes", description: "Continue" },
          { id: "option_2", label: "No", description: "Stop" },
        ],
      },
    }, "event-ordinary"],
    [{
      type: "user_input.requested" as const,
      requestId: "codex-input:33333333-3333-4333-8333-333333333333",
      expiresAt: "2099-01-01T00:00:00.000Z",
      prompt: "Approve this synthetic plan",
      options: [
        { id: "approve", label: "承認して実行" },
        { id: "reject", label: "拒否・保留" },
      ],
      plan: {
        operationId: "44444444-4444-4444-8444-444444444444",
        planHash: "a".repeat(64),
        approvalTarget: "primary",
        approvalScope: {
          kind: "git_publication",
          repo_id: "synthetic-repo",
          mode: "commit_only",
          branch: "codex/dot-fixture",
          worktree_id: "primary",
          expected_head: "b".repeat(40),
          expected_snapshot_id: "c".repeat(64),
          paths: ["synthetic.ts"],
          commit_message: "Synthetic dot fixture",
        },
        operation: "git_publication",
        repoId: "synthetic-repo",
        mode: "commit_only",
        branch: "codex/dot-fixture",
        paths: ["synthetic.ts"],
        expectedHead: "b".repeat(40),
        expectedSnapshotId: "c".repeat(64),
        worktreeId: "primary",
        commitMessage: "Synthetic dot fixture",
        expiresAt: "2099-01-01T00:00:00.000Z",
      } satisfies WorkspaceGitApprovalPlan,
    }, "event-git"],
  ] as const) {
    const beforePosts = fixture.app.posts.length;
    const beforeUpdates = fixture.app.updates.length;
    fixture.gateway.nextEvent = event;
    await sendMessage(fixture, attributedDotEvent(eventId), eventId);
    assertNoDisplayedMention([
      ...fixture.app.posts.slice(beforePosts),
      ...fixture.app.updates.slice(beforeUpdates),
    ], connectorSourceUser);
  }

  // A regenerated frontend still classifies a direct human by this message,
  // not by any sticky state left on the shared Slack thread.
  const regenerated = frontendFixture([]);
  await sendMessage(regenerated, {
    type: "message", channel: "C1", ts: "6.000001", thread_ts: "1.000001",
    user: "U1", text: "human after restore",
  }, "event-restored-human");
  assert.ok(regenerated.app.posts.some((call) => String(call.text).includes("<@U1>")));
});

test("SlackFrontend records a bounded rejection diagnostic without accepting the shape", async () => {
  const fixture = frontendFixture([]);
  const event = numberedListDotEvent("SECRET_FRONTEND_TOKEN");
  await sendMessage(fixture, event, "event-rejected-dot-shape");

  assert.equal(classifyDotSlackMessage(event), undefined);
  assert.equal(fixture.dotDiagnostics.length, 1);
  assert.deepEqual(JSON.parse(fixture.dotDiagnostics[0]!), {
    component: "showtalk.dot_origin",
    version: 1,
    event: "classification_rejected",
    reason: "body_elements_unsupported",
    sectionCount: "2",
    bodyElementTypes: ["section", "list", "section"],
  });
  assert.equal(fixture.dotDiagnostics[0]!.includes("SECRET_FRONTEND_TOKEN"), false);
  assert.ok(fixture.app.posts.some((call) =>
    String(call.text).includes(`<@${connectorSourceUser}>`),
  ));
});

test("SlackFrontend ignores dot diagnostics outside configured Koe channels", async () => {
  const fixture = frontendFixture([]);
  const outside = numberedListDotEvent("SECRET_OUTSIDE_CHANNEL");
  outside.channel = "COUTSIDE";
  await sendMessage(fixture, outside, "event-rejected-dot-outside");
  assert.equal(fixture.dotDiagnostics.length, 0);

  await sendMessage(
    fixture,
    numberedListDotEvent("SECRET_CONFIGURED_CHANNEL"),
    "event-rejected-dot-configured",
  );
  assert.equal(fixture.dotDiagnostics.length, 1);
});

test("Permission Engine card display can suppress only the source mention", () => {
  const request = {
    requestId: "permission:55555555-5555-4555-8555-555555555555",
    sourceAgentId: "test-koe",
    sourceChannelId: "C1",
    sourceRootThreadTs: "1.000001",
    sourceSlackUserId: connectorSourceUser,
    operation: "synthetic.noop",
    summary: "Synthetic permission",
    expiresAt: "2099-01-01T00:00:00.000Z",
    allowSessionGrant: false,
  };
  const dotCard = permissionApprovalPostArguments(request, undefined, {}, false);
  assertNoDisplayedMention([dotCard], connectorSourceUser);
  const humanCard = permissionApprovalPostArguments(request);
  assert.ok(String(humanCard.text).includes(`<@${connectorSourceUser}>`));
  assert.ok(JSON.stringify(humanCard.blocks).includes(`<@${connectorSourceUser}>`));
  const actionPairs = (card: Call) => {
    const actions = (card.blocks as Call[]).find((block) => block.type === "actions");
    assert.ok(actions);
    return (actions.elements as Call[]).map((element) => ({
      action_id: element.action_id,
      value: element.value,
    }));
  };
  assert.deepEqual(actionPairs(dotCard), actionPairs(humanCard));
  for (const pair of actionPairs(dotCard)) {
    const decoded = parsePermissionActionValue(String(pair.value));
    assert.equal(decoded.requestId, request.requestId);
    assert.equal(decoded.channelId, request.sourceChannelId);
  }
});

test("dot actionable terminal, recovery, and continuation updates stay unmentioned", async () => {
  const git = recordingClient();
  const details = new WorkspaceGitApprovalDetailsStore();
  const projector = new SlackThreadProjector(git.client, "C1", "1.000001", {
    sourceUserId: connectorSourceUser,
    mentionSourceUserInTurnMessages: false,
    mentionSourceUserInActionableMessages: false,
    gitApprovalDetailsStore: details,
  });
  const requestId = "codex-input:66666666-6666-4666-8666-666666666666";
  await projector.project({
    type: "user_input.requested",
    requestId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    prompt: "Approve synthetic plan",
    options: [
      { id: "approve", label: "承認して実行" },
      { id: "reject", label: "拒否・保留" },
    ],
    plan: {
      operationId: "77777777-7777-4777-8777-777777777777",
      planHash: "d".repeat(64),
      approvalTarget: "primary",
      operation: "git_publication",
      repoId: "synthetic-repo",
      mode: "commit_only",
      branch: "codex/dot-lifecycle",
      paths: ["synthetic.ts"],
      expectedHead: "e".repeat(40),
      expectedSnapshotId: "f".repeat(64),
      worktreeId: "primary",
      commitMessage: "Synthetic dot lifecycle",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });
  await projector.project({ type: "git_approval.expired", requestId });
  await projector.project({
    type: "git_approval.reprepare_required",
    message: "Synthetic recovery",
  });
  await projector.project({ type: "message.completed", text: "Synthetic final" });
  await projector.complete();
  assertNoDisplayedMention([...git.posts, ...git.updates], connectorSourceUser);

  const choice = recordingClient();
  const continuations = new StructuredChoiceContinuationStore(() => Date.now());
  const choiceProjector = new SlackThreadProjector(choice.client, "C1", "1.000001", {
    sourceUserId: connectorSourceUser,
    mentionSourceUserInTurnMessages: false,
    mentionSourceUserInActionableMessages: false,
    choiceContinuationStore: continuations,
  });
  choiceProjector.setSessionId("session-dot-lifecycle");
  const choiceRequestId = "codex-choice:88888888-8888-4888-8888-888888888888";
  await choiceProjector.project({
    type: "choice.requested",
    requestId: choiceRequestId,
    expiresAt: "2099-01-01T00:00:00.000Z",
    completedAnswers: [],
    question: {
      id: "question_dot",
      header: "Synthetic question",
      prompt: "Choose",
      allowsOther: false,
      options: [
        { id: "option_1", label: "Yes", description: "Continue" },
        { id: "option_2", label: "No", description: "Stop" },
      ],
    },
  });
  await choiceProjector.project({ type: "choice.resolved_externally", requestId: choiceRequestId });
  const continuation = continuations.getForOriginalRequest(choiceRequestId);
  assert.ok(continuation);
  assert.equal(continuation.responderUserId, connectorSourceUser);
  assertNoDisplayedMention([...choice.posts, ...choice.updates], connectorSourceUser);
});

function assertNoDisplayedMention(calls: readonly Call[], userId: string): void {
  const mention = `<@${userId}>`;
  assert.ok(calls.every((call) => !String(call.text).includes(mention)));
  assert.ok(calls.every((call) => !JSON.stringify(call.blocks ?? []).includes(mention)));
}
