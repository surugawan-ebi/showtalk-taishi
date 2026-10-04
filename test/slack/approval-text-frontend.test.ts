import assert from "node:assert/strict";
import test from "node:test";

import type { App } from "@slack/bolt";
import type { AgentApproval, AgentEvent, AgentUserInputResponse, Gateway, WorkspaceGitApprovalPlan } from "../../src/core/index.js";
import { WorkspaceGitHumanDecisionBrokerError, type WorkspaceGitHumanDecisionInput } from "../../src/approvals/workspace-git-human-decision-broker.js";
import { PermissionApprovalCoordinator } from "../../src/permissions/approval-coordinator.js";
import { ApprovalTextStore } from "../../src/slack/approval-text-store.js";
import { SlackFrontend, type SlackFrontendOptions } from "../../src/slack/frontend.js";
import { createInteractionAudit } from "../../src/slack/interaction-audit.js";
import { WorkspaceGitApprovalDetailsStore } from "../../src/slack/user-input-blocks.js";

// All Slack and Gateway operations below are in-memory fakes. No App is
// started, files downloaded, private broker connected, or work executed.
const baseSeconds = Math.floor(Date.now() / 1_000) - 10;
const rootTs = `${baseSeconds}.000000`;
const cardTs = `${baseSeconds + 2}.000001`;
const now = (baseSeconds + 3) * 1_000;
const expiresAt = now + 600_000;
const channel = "CTEXTTEST";
const user = "UAPPROVER";
const secondUser = "USECOND";
const sessionId = "session-text-test";
const uuid = "11111111-1111-4111-8111-111111111111";
const nativeId = `codex:${uuid}`;
const gitId = `codex-input:${uuid}`;
const choiceId = `codex-choice:${uuid}`;
const attributionProfile = { appId: "ACHATGPT", userId: "UCHATGPT" };

type RecordValue = Record<string, unknown>;
type Listener = (args: RecordValue) => Promise<void>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeSlackApp {
  readonly events = new Map<string, Listener>();
  readonly actions: { pattern: RegExp; listener: Listener }[] = [];
  readonly updates: RecordValue[] = [];
  readonly posts: RecordValue[] = [];
  readonly ephemeral: RecordValue[] = [];
  readonly errors: unknown[] = [];
  failUpdate = false;
  postBarrier: Promise<void> | undefined;
  #sequence = 0;
  readonly client = {
    chat: {
      postMessage: async (input: RecordValue) => {
        this.posts.push(input);
        await this.postBarrier;
        return { ts: `${baseSeconds + 2}.${String(++this.#sequence).padStart(6, "0")}` };
      },
      update: async (input: RecordValue) => {
        if (this.failUpdate) throw new Error("synthetic Slack update failure");
        this.updates.push(input);
        return { ok: true };
      },
      postEphemeral: async (input: RecordValue) => { this.ephemeral.push(input); return { ok: true }; },
      delete: async () => ({ ok: true }),
    },
  };
  event(name: string, listener: Listener) { this.events.set(name, listener); }
  action(pattern: RegExp, listener: Listener) { this.actions.push({ pattern, listener }); }
  view() {}
  async start() { throw new Error("Tests must not start a Slack connection"); }
  async stop() {}

  async message(text: string, overrides: RecordValue = {}, envelope: RecordValue = {}) {
    const event = {
      type: "message", channel, user, ts: `${baseSeconds + 4}.${String(++this.#sequence).padStart(6, "0")}`,
      thread_ts: rootTs, text, ...overrides,
    };
    const listener = this.events.get("message");
    assert.ok(listener);
    await listener({ event, body: { event_id: `event-${this.#sequence}`, team_id: "TTEST", api_app_id: "ATEST", ...envelope },
      client: this.client, logger: { error: (error: unknown) => this.errors.push(error) } });
  }

  async button(actionId: string, value: unknown, overrides: RecordValue = {}) {
    const selected = this.actions.find(({ pattern }) => pattern.test(actionId));
    assert.ok(selected, `Missing action handler: ${actionId}`);
    await selected.listener({
      ack: async () => undefined,
      action: { action_id: actionId, value: JSON.stringify(value) },
      body: { type: "block_actions", user: { id: user }, channel: { id: channel },
        team: { id: "TTEST" }, api_app_id: "ATEST",
        message: { ts: cardTs, thread_ts: rootTs },
        container: { type: "message", channel_id: channel, message_ts: cardTs }, ...overrides },
      client: this.client, logger: { error: (error: unknown) => this.errors.push(error) },
    });
  }
}

class FakeGateway {
  readonly pending = new Set<string>();
  readonly approvals: { sessionId?: string; approval: AgentApproval }[] = [];
  readonly answers: AgentUserInputResponse[] = [];
  readonly order: string[] = [];
  humanTurns = 0;
  eventToProject: AgentEvent | undefined;
  readonly projected = deferred();
  readonly finishTurn = deferred();

  #consume(requestId: string) {
    if (!this.pending.delete(requestId)) throw new Error("Unknown or settled synthetic request");
  }
  async resolveSessionApproval(selectedSession: string, approval: AgentApproval) {
    assert.equal(selectedSession, sessionId);
    this.#consume(approval.requestId);
    this.approvals.push({ sessionId: selectedSession, approval });
  }
  async resolveApproval(selectedChannel: string, thread: string, approval: AgentApproval) {
    assert.equal(selectedChannel, channel);
    assert.equal(thread, rootTs);
    this.#consume(approval.requestId);
    this.approvals.push({ approval });
  }
  async resolveUserInput(selectedChannel: string, thread: string, response: AgentUserInputResponse) {
    assert.equal(selectedChannel, channel);
    assert.equal(thread, rootTs);
    this.#consume(response.requestId);
    this.order.push("resume");
    this.answers.push(response);
  }
  async resolveSessionUserInput(_selectedSession: string, response: AgentUserInputResponse) {
    this.#consume(response.requestId);
    this.answers.push(response);
  }
  async *handleHumanMessage() {
    this.humanTurns += 1;
    if (this.eventToProject !== undefined) {
      yield { sessionId, event: this.eventToProject };
      this.projected.resolve();
      await this.finishTurn.promise;
    }
  }
}

function harness(options: Partial<SlackFrontendOptions> = {}) {
  const app = new FakeSlackApp();
  const gateway = new FakeGateway();
  const clock = { now };
  const store = new ApprovalTextStore(() => clock.now);
  const gitDetails = new WorkspaceGitApprovalDetailsStore();
  const frontend = new SlackFrontend(gateway as unknown as Gateway, {
    appToken: "xapp-test", botToken: "xoxb-test", approverUserIds: [user, secondUser],
    agentChannelIds: [channel, "COTHER"], agentIdsByChannel: { [channel]: "test-koe", COTHER: "other-koe" },
    attachmentRoot: "/tmp", now: () => clock.now, approvalTextStore: store,
    approvalTextAttributionProfile: attributionProfile,
    workspaceGitApprovalDetailsStore: gitDetails, interactionAudit: () => undefined,
    ...options,
  }, app as unknown as App);
  return { app, gateway, clock, store, gitDetails, frontend };
}

function attributedCommand(command: string) {
  const footer = `*使用して送信されました* <@${attributionProfile.userId}>`;
  return {
    text: `${command} ${footer}`,
    fields: {
      app_id: attributionProfile.appId,
      blocks: [
        { type: "rich_text", block_id: "synthetic-command", elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: command }] },
        ] },
        { type: "context", block_id: "synthetic-footer", elements: [
          { type: "mrkdwn", text: footer, verbatim: false },
        ] },
      ],
    },
  };
}

function sendCommand(app: FakeSlackApp, command: string, attributed: boolean, overrides: RecordValue = {}) {
  const input = attributedCommand(command);
  return attributed ? app.message(input.text, { ...input.fields, ...overrides }) : app.message(command, overrides);
}

function registerNative(h: ReturnType<typeof harness>, decisions: readonly AgentApproval["decision"][] = ["allow_once", "deny", "cancel"]) {
  const route = { requestId: nativeId, channelId: channel, rootThreadTs: rootTs, messageTs: cardTs, sessionId };
  h.store.remember({ kind: "native", ...route, expiresAt, availableDecisions: decisions });
  h.gateway.pending.add(nativeId);
  return route;
}

test("text native allow-once and rejection use the same single-use button handlers", async () => {
  for (const attributed of [false, true]) {
  for (const first of ["text", "button", "concurrent"] as const) {
    for (const decision of ["approve", "reject"] as const) {
      const h = harness();
      const route = registerNative(h);
      const selected = decision === "approve" ? "allow_once" : "deny";
      const text = () => sendCommand(h.app, `${decision === "approve" ? "承認" : "拒否"} ${nativeId}`, attributed);
      const button = () => h.app.button(`taishi.approval.${selected}`, route);
      if (first === "text") { await text(); await button(); }
      else if (first === "button") { await button(); await text(); }
      else await Promise.all([text(), button(), text()]);
      assert.deepEqual(h.gateway.approvals, [{ sessionId, approval: { requestId: nativeId, decision: selected } }]);
      assert.equal(h.gateway.humanTurns, 0);
      assert.equal(h.store.get(nativeId), undefined);
    }
  }
  }
});

test("native rejection maps to advertised cancel and never grants session or command rules", async () => {
  const h = harness();
  registerNative(h, ["allow_session", "allow_command_rule", "cancel"]);
  await h.app.message(`承認 ${nativeId}`);
  assert.equal(h.gateway.approvals.length, 0);
  await h.app.message(`拒否 ${nativeId}`);
  assert.equal(h.gateway.approvals[0]?.approval.decision, "cancel");
});

test("opposing native text and button decisions cannot both settle the request", async () => {
  const h = harness();
  const route = registerNative(h);
  await Promise.all([h.app.message(`承認 ${nativeId}`), h.app.button("taishi.approval.deny", route)]);
  assert.equal(h.gateway.approvals.length, 1);
  assert.ok(["allow_once", "deny"].includes(h.gateway.approvals[0]!.approval.decision));
});

test("wrong author, route, request, envelope and exact expiry cannot settle or start a turn", async () => {
  for (const attributed of [false, true]) {
  const h = harness();
  registerNative(h);
  for (const override of [{ user: "UOTHER" }, { channel: "COTHER" }, { thread_ts: `${baseSeconds - 1}.000000` },
    { ts: cardTs }, { ts: `${baseSeconds + 603}.000000` }]) {
    await sendCommand(h.app, `承認 ${nativeId}`, attributed, override);
  }
  await sendCommand(h.app, `承認 codex:22222222-2222-4222-8222-222222222222`, attributed);
  const input = attributedCommand(`承認 ${nativeId}`);
  await h.app.message(attributed ? input.text : `承認 ${nativeId}`, attributed ? input.fields : {}, { api_app_id: undefined });
  h.clock.now = expiresAt;
  await sendCommand(h.app, `承認 ${nativeId}`, attributed);
  assert.equal(h.gateway.approvals.length, 0);
  assert.equal(h.gateway.humanTurns, 0);
  }
});

test("attribution is preserved and audited as syntax without changing the authenticated actor", async () => {
  const lines: string[] = [];
  const h = harness({ interactionAudit: createInteractionAudit((line) => lines.push(line), () => now) });
  registerNative(h);
  const input = attributedCommand(`承認 ${nativeId}`);
  const before = structuredClone(input);
  await h.app.message(input.text, input.fields);
  assert.deepEqual(input, before);
  assert.equal(h.gateway.approvals.length, 1);
  assert.equal(h.app.posts.length, 0);
  assert.deepEqual(h.app.updates.map((update) => update.ts), [cardTs]);
  assert.ok(String(h.app.updates[0]?.text).includes(`<@${user}>`));
  assert.ok(!String(h.app.updates[0]?.text).includes(`<@${attributionProfile.userId}>`));
  const audit = lines.map((line) => JSON.parse(line) as RecordValue);
  const validated = audit.find((record) => record.event === "approval_text.binding_validated");
  assert.ok(validated);
  assert.equal(validated.approvalTextFormat, "chatgpt_slack_footer_v1");
  assert.equal(validated.outcome, "approve");
  assert.notEqual(validated.actorRef, validated.attributionUserRef);
  assert.notEqual(validated.commandMessageRef, validated.messageRef);
  assert.match(String(validated.attributionAppRef), /^[0-9a-f]{16}$/u);
  for (const value of [user, attributionProfile.userId, attributionProfile.appId, nativeId, input.text]) {
    assert.ok(!lines.join("\n").includes(value));
  }
  await h.app.message(input.text, input.fields);
  assert.equal(h.gateway.approvals.length, 1);
  assert.equal(lines.filter((line) => JSON.parse(line).event === "approval_text.binding_validated").length, 1);
  assert.equal(JSON.parse(lines.at(-1)!).event, "approval_text.failed");
});

test("attributed malformed or unauthorized messages never settle or become model prompts", async () => {
  const h = harness();
  registerNative(h);
  const input = attributedCommand(`承認 ${nativeId}`);
  for (const fields of [
    { user: "UOTHER" }, { user: attributionProfile.userId },
    { app_id: "AOTHER" }, { app_id: undefined }, { bot_id: "BBOT" },
    { bot_profile: {} }, { subtype: "bot_message" }, { edited: { user, ts: cardTs } },
    { blocks: [] }, { files: [] }, { attachments: [] },
  ]) await h.app.message(input.text, { ...input.fields, ...fields });
  for (const text of [
    `${input.text}\n`, `${input.text} more`, input.text.replace("UCHATGPT", "UOTHER"),
    input.text.replace(" *使用", "\n*使用"), input.text.replace("UCHATGPT>", "UCHATGPT|ChatGPT>"),
  ]) await h.app.message(text, input.fields);
  assert.equal(h.gateway.approvals.length, 0);
  assert.equal(h.gateway.humanTurns, 0);
  assert.ok(h.store.get(nativeId));
});

test("quoted, bot, edited and malformed command attempts never fall through to the coding agent", async () => {
  const h = harness();
  registerNative(h);
  const exact = `承認 ${nativeId}`;
  const variants: { text: string; fields?: RecordValue }[] = [
    { text: "承認" }, { text: `> ${exact}` }, { text: `\`${exact}\`` }, { text: `${exact}\n` },
    { text: `\`承認\t${nativeId}\`` }, { text: "> 承認 req_unknown" },
    { text: `${exact}\n使用して送信されました <@UOTHER>` }, { text: `承認  ${nativeId}` },
    { text: exact, fields: { bot_id: "BTEST" } }, { text: exact, fields: { app_id: "ATEST" } },
    { text: exact, fields: { edited: { user, ts: cardTs } } },
    { text: exact, fields: { subtype: "message_changed" } },
    { text: exact, fields: { attachments: [] } }, { text: exact, fields: { files: [] } },
    { text: exact, fields: { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_quote", elements: [{ type: "text", text: exact }] }] }] } },
  ];
  for (const variant of variants) await h.app.message(variant.text, variant.fields);
  assert.equal(h.gateway.approvals.length, 0);
  assert.equal(h.gateway.humanTurns, 0);
  await h.app.message(exact, { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: exact }] }] }] });
  assert.equal(h.gateway.approvals.length, 1);
});

test("duplicate Slack events and failed receipt updates cannot replay a settled native request", async () => {
  const h = harness();
  const route = registerNative(h);
  h.app.failUpdate = true;
  const identity = { event_id: "same-event" };
  await h.app.message(`承認 ${nativeId}`, {}, identity);
  await h.app.message(`承認 ${nativeId}`, {}, identity);
  await h.app.button("taishi.approval.allow_once", route);
  assert.equal(h.gateway.approvals.length, 1);
  assert.equal(h.gateway.humanTurns, 0);
});

test("restart and unregistered cards keep text approvals inert", async () => {
  const restarted = harness();
  restarted.gateway.pending.add(nativeId);
  await restarted.app.message(`承認 ${nativeId}`);
  assert.equal(restarted.gateway.approvals.length, 0);
  registerNative(restarted);
  restarted.frontend.beginRestart();
  await restarted.app.message(`承認 ${nativeId}`);
  assert.equal(restarted.gateway.approvals.length, 0);
});

async function projectChoice(h: ReturnType<typeof harness>, sourceUser = user, ordinary = false) {
  h.gateway.pending.add(choiceId);
  h.gateway.eventToProject = {
    type: "choice.requested", requestId: choiceId, expiresAt: new Date(expiresAt).toISOString(), completedAnswers: [],
    question: { id: "question_1", purpose: ordinary ? "ordinary" : "external_action_confirmation", header: "Test action",
      prompt: "Target: synthetic target\nScope: no-op test\nImpact: no external writes",
      allowsOther: false, options: [
        { id: "option_1", label: "外部操作を承認（Git承認ではありません）", description: "Confirm synthetic request" },
        { id: "option_2", label: "外部操作を拒否・保留", description: "Reject synthetic request" },
      ] },
  };
  const turn = h.app.message("Show the synthetic question", { user: sourceUser });
  await Promise.race([h.gateway.projected.promise, turn.then(() => { throw new Error("Projection failed before yielding"); })]);
  return { finish: async () => { h.gateway.finishTurn.resolve(); await turn; } };
}

test("external confirmation text requires both original responder and configured approver", async () => {
  for (const attributed of [false, true]) {
  for (const sourceUser of [user, "UUNCONFIGURED"]) {
    const h = harness();
    const projection = await projectChoice(h, sourceUser);
    try {
      await sendCommand(h.app, `承認 ${choiceId}`, attributed, { user: secondUser });
      assert.equal(h.gateway.answers.length, 0);
      await sendCommand(h.app, `承認 ${choiceId}`, attributed, { user: sourceUser });
      assert.equal(h.gateway.answers.length, sourceUser === user ? 1 : 0);
      if (sourceUser === user) {
        assert.deepEqual(h.gateway.answers[0], { requestId: choiceId, answer: { questionId: "question_1", optionId: "option_1" } });
        await sendCommand(h.app, `拒否 ${choiceId}`, attributed);
        assert.equal(h.gateway.answers.length, 1);
      }
      assert.equal(h.gateway.humanTurns, 1);
    } finally { await projection.finish(); }
  }
  }
});

test("external rejection uses option two while ordinary choices stay button-only", async () => {
  for (const attributed of [false, true]) {
  for (const ordinary of [false, true]) {
    const h = harness();
    const projection = await projectChoice(h, user, ordinary);
    try {
      await sendCommand(h.app, `拒否 ${choiceId}`, attributed);
      assert.equal(h.gateway.answers.length, ordinary ? 0 : 1);
      if (!ordinary) assert.deepEqual(h.gateway.answers[0], { requestId: choiceId, answer: { questionId: "question_1", optionId: "option_2" } });
      assert.equal(h.gateway.humanTurns, 1);
    } finally { await projection.finish(); }
  }
  }
});

test("external text followed by a stale button preserves its dispatched receipt", async () => {
  const h = harness();
  const projection = await projectChoice(h);
  try {
    const entry = h.store.get(choiceId);
    assert.ok(entry?.kind === "external");
    await h.app.message(`承認 ${choiceId}`);
    const receipt = h.app.updates.at(-1);
    assert.ok(String(receipt?.text).includes("外部操作への回答をCodexへ送信しました"));
    await h.app.button("taishi.choice.select.option_1", { ...entry.routing, optionId: "option_1" }, {
      message: { ts: entry.messageTs, thread_ts: rootTs },
      container: { type: "message", channel_id: channel, message_ts: entry.messageTs },
    });
    assert.equal(h.gateway.answers.length, 1);
    assert.deepEqual(h.app.updates.at(-1), receipt);
  } finally { await projection.finish(); }
});

test("external button-first and concurrent text responses dispatch only one answer", async () => {
  for (const attributed of [false, true]) {
  for (const concurrent of [false, true]) {
    const h = harness();
    const projection = await projectChoice(h);
    try {
      const entry = h.store.get(choiceId);
      assert.ok(entry?.kind === "external");
      const button = () => h.app.button("taishi.choice.select.option_2", { ...entry.routing, optionId: "option_2" }, {
        message: { ts: entry.messageTs, thread_ts: rootTs },
        container: { type: "message", channel_id: channel, message_ts: entry.messageTs },
      });
      const text = () => sendCommand(h.app, `拒否 ${choiceId}`, attributed);
      if (concurrent) await Promise.all([button(), text()]);
      else { await button(); await text(); }
      assert.equal(h.gateway.answers.length, 1);
      assert.deepEqual(h.gateway.answers[0], { requestId: choiceId, answer: { questionId: "question_1", optionId: "option_2" } });
      assert.equal(h.gateway.humanTurns, 1);
    } finally { await projection.finish(); }
  }
  }
});

test("permission settlement during slow card posting cannot revive a text command", async () => {
  const h = harness();
  const blocked = deferred();
  h.app.postBarrier = blocked.promise;
  const requestId = `permission:${uuid}`;
  const posting = h.frontend.presentPermissionApproval({ requestId, sourceAgentId: "test-koe", sourceChannelId: channel,
    sourceRootThreadTs: rootTs, sourceSlackUserId: user, operation: "synthetic.noop", summary: "Synthetic permission",
    expiresAt: new Date(expiresAt).toISOString(), allowSessionGrant: false });
  await h.frontend.settlePermissionApproval({ requestId, reason: "caller_cancelled" });
  blocked.resolve();
  await posting;
  assert.equal(h.store.get(requestId), undefined);
  await h.app.message(`承認 ${requestId}`);
  assert.equal(h.gateway.humanTurns, 0);
  assert.deepEqual(h.app.updates.at(-1)?.blocks, []);
});

test("permission text decisions settle the real coordinator once and preserve actual author", async () => {
  for (const attributed of [false, true]) {
  for (const decision of ["承認", "拒否"]) {
    const coordinator = new PermissionApprovalCoordinator({ now: () => new Date(now), idFactory: () => uuid });
    const h = harness({ permissionApprovals: coordinator });
    const shown = deferred();
    const settlements: string[] = [];
    coordinator.setPresenter(async (request) => { await h.frontend.presentPermissionApproval(request); shown.resolve(); });
    coordinator.setSettlementPresenter(async (settlement) => {
      settlements.push(settlement.resolvedBySlackUserId ?? "missing");
      await h.frontend.settlePermissionApproval(settlement);
    });
    const requestId = `permission:${uuid}`;
    const result = coordinator.authorize("approval", { sourceAgentId: "test-koe", sourceChannelId: channel,
      operation: "synthetic.noop", summary: "No action is performed", grantKey: "test-only", allowSessionGrant: false,
      slackContext: { rootThreadTs: rootTs, slackUserId: user } });
    try {
      await shown.promise;
      await Promise.all([sendCommand(h.app, `${decision} ${requestId}`, attributed), sendCommand(h.app, `${decision} ${requestId}`, attributed)]);
      assert.equal(await result, decision === "承認" ? "allow" : "deny");
      assert.deepEqual(settlements, [user]);
      assert.equal(h.gateway.humanTurns, 0);
      assert.equal(h.store.get(requestId), undefined);
    } finally { await coordinator.close(); }
  }
  }
});

const gitPlan: WorkspaceGitApprovalPlan = {
  operationId: uuid, planHash: "a".repeat(64), approvalTarget: "primary",
  approvalScope: { kind: "git_publication", repo_id: "synthetic-repo", mode: "commit_only", branch: "codex/synthetic",
    worktree_id: "primary", expected_head: "b".repeat(40), expected_snapshot_id: "c".repeat(64), paths: ["synthetic.ts"], commit_message: "Synthetic change" },
  operation: "git_publication", repoId: "synthetic-repo", mode: "commit_only", branch: "codex/synthetic",
  paths: ["synthetic.ts"], expectedHead: "b".repeat(40), expectedSnapshotId: "c".repeat(64), worktreeId: "primary",
  commitMessage: "Synthetic change", expiresAt: new Date(expiresAt).toISOString(),
};

function registerGit(h: ReturnType<typeof harness>) {
  const routing = { version: 1 as const, requestId: gitId, channelId: channel, rootThreadTs: rootTs, messageTs: cardTs };
  h.store.remember({ kind: "git", ...routing, routing, expiresAt });
  h.gitDetails.remember({ routing, plan: gitPlan, sessionId, expiresAt, prompt: "Synthetic plan", fallbackText: "Synthetic plan",
    display: { pathsExpanded: true, bodyExpanded: true } });
  h.gateway.pending.add(gitId);
  return routing;
}

test("Git text and button races share private-broker-before-resume ordering and one-shot state", async () => {
  for (const attributed of [false, true]) {
  for (const decision of ["approve", "reject"] as const) {
    const recorded: WorkspaceGitHumanDecisionInput[] = [];
    const h = harness({ workspaceGitDecisionBroker: { contract_version: 1, recordDecision: async (input) => {
      recorded.push(input); h.gateway.order.push("broker");
    } } });
    const routing = registerGit(h);
    await Promise.all([sendCommand(h.app, `${decision === "approve" ? "承認" : "拒否"} ${gitId}`, attributed),
      h.app.button(`taishi.git_plan.${decision}`, routing)]);
    assert.deepEqual(h.gateway.order, ["broker", "resume"]);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.context.callerId, user);
    assert.equal(recorded[0]?.context.sessionId, sessionId);
    assert.equal(recorded[0]?.decision, decision);
    assert.deepEqual(recorded[0]?.plan, gitPlan);
    assert.equal(h.gateway.answers.length, 1);
    assert.equal(h.gateway.humanTurns, 0);
  }
  }
});

test("Git uncertain broker result keeps the same bound delivery retryable without resuming", async () => {
  const recorded: WorkspaceGitHumanDecisionInput[] = [];
  const h = harness({ workspaceGitDecisionBroker: { contract_version: 1, recordDecision: async (input) => {
    recorded.push(input);
    if (recorded.length === 1) throw new WorkspaceGitHumanDecisionBrokerError("decision_outcome_unknown");
  } } });
  const routing = registerGit(h);
  await h.app.message(`承認 ${gitId}`);
  assert.equal(h.gateway.answers.length, 0);
  assert.ok(h.store.get(gitId));
  await h.app.button("taishi.git_plan.approve", routing);
  assert.equal(h.gateway.answers.length, 1);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0]?.deliveryId, recorded[1]?.deliveryId);
});

test("expired or adapter-invalidated Git cards never reach the private broker", async () => {
  for (const invalidate of [false, true]) {
    let brokerCalls = 0;
    const h = harness({ workspaceGitDecisionBroker: { contract_version: 1, recordDecision: async () => { brokerCalls += 1; } } });
    registerGit(h);
    if (invalidate) h.frontend.invalidateWorkspaceGitApproval(gitId);
    else h.clock.now = expiresAt;
    await h.app.message(`承認 ${gitId}`);
    assert.equal(brokerCalls, 0);
    assert.equal(h.gateway.answers.length, 0);
  }
});
