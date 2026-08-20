import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceGitApprovalPlan } from "../../src/core/index.js";
import {
  buildWorkspaceGitApprovalBlocks,
  parseUserInputActionValue,
  parseUserInputDecision,
} from "../../src/slack/user-input-blocks.js";

const plan: WorkspaceGitApprovalPlan = {
  operationId: "11111111-1111-4111-8111-111111111111",
  planHash: "a".repeat(64),
  operation: "git_publication",
  repoId: "showtalk-taishi",
  mode: "commit_push_and_open_draft_pr",
  branch: "agent/slack-git-approval",
  paths: ["src/core/gateway.ts", "README.md"],
  expectedHead: "b".repeat(40),
  expectedSnapshotId: "c".repeat(64),
  worktreeId: "wt_opaque",
  commitMessage: "Add Slack approval UI",
  pushTarget: "origin/agent/slack-git-approval",
  pullRequestTitle: "Add Slack approval UI",
  pullRequestBody: "Show the exact plan before approval.",
  pullRequestBaseBranch: "main",
  expiresAt: "2026-08-14T20:00:00+09:00",
};

const routing = {
  version: 1 as const,
  requestId: "codex-input:11111111-1111-4111-8111-111111111111",
  channelId: "C0123456789",
  rootThreadTs: "1786654845.402859",
  messageTs: "1786654846.000100",
};

test("renders an exact Git plan while keeping it out of the action value", () => {
  const blocks = buildWorkspaceGitApprovalBlocks("この計画を承認しますか？", plan, routing);
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /承認して実行/u);
  assert.match(rendered, /拒否・保留/u);
  assert.match(rendered, /11111111-1111-4111-8111-111111111111/u);
  assert.match(rendered, new RegExp("a{64}", "u"));
  assert.match(rendered, /src\/core\/gateway\.ts/u);
  assert.match(rendered, /wt_opaque/u);
  assert.match(rendered, /Add Slack approval UI/u);
  assert.match(rendered, /origin\/agent\/slack-git-approval/u);
  assert.match(rendered, /Show the exact plan before approval/u);
  assert.match(rendered, /Draft PR base/u);

  const actions = blocks.at(-1);
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;
  const encoded = "value" in actions.elements[0]! ? actions.elements[0]!.value : undefined;
  assert.equal(encoded, JSON.stringify(routing));
  assert.doesNotMatch(String(encoded), /showtalk-taishi|planHash|operationId/u);
});

test("renders an unborn initial publication without inventing a HEAD", () => {
  const initialPlan: WorkspaceGitApprovalPlan = {
    operationId: plan.operationId,
    planHash: plan.planHash,
    operation: "git_publication",
    repoId: plan.repoId,
    mode: "initial_commit_and_push",
    branch: "main",
    paths: plan.paths,
    expectedHead: null,
    expectedSnapshotId: "c".repeat(64),
    worktreeId: "primary",
    commitMessage: "Initialize repository",
    pushTarget: "origin/main",
    expiresAt: plan.expiresAt,
  };
  const blocks = buildWorkspaceGitApprovalBlocks(
    "初回公開を承認しますか？",
    initialPlan,
    routing,
  );
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /initial_commit_and_push/u);
  assert.match(rendered, /unborn/u);
  assert.match(rendered, /origin\/main/u);
  assert.match(rendered, /承認して実行/u);
  const actions = blocks.at(-1);
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;
  const encoded = "value" in actions.elements[0]! ? actions.elements[0]!.value : undefined;
  assert.equal(encoded, JSON.stringify(routing));
  assert.doesNotMatch(
    String(encoded),
    /empty-example-repo|initial_commit_and_push|planHash|operationId|unborn/u,
  );
});

test("makes control characters and bidirectional overrides visible", () => {
  const blocks = buildWorkspaceGitApprovalBlocks(
    "Review",
    {
      ...plan,
      paths: ["src/line\nbreak.ts", "src/right\u202eleft.ts"],
      commitMessage: "line one\nline two\u202e",
    },
    routing,
  );
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /line\\\\nbreak/u);
  assert.match(rendered, /right\\\\u202eleft/u);
  assert.match(rendered, /line one\\\\nline two\\\\u202e/u);
});

test("parses only the two fixed Git decision action IDs", () => {
  assert.equal(parseUserInputDecision("taishi.git_plan.approve"), "approve");
  assert.equal(parseUserInputDecision("taishi.git_plan.reject"), "reject");
  assert.equal(parseUserInputDecision("taishi.git_plan.allow_session"), undefined);
  assert.equal(parseUserInputDecision("taishi.approval.approve"), undefined);
});

test("rejects forged, replay-targeted, and ambiguous action payload shapes", () => {
  assert.deepEqual(parseUserInputActionValue(JSON.stringify(routing)), routing);
  assert.throws(() =>
    parseUserInputActionValue(
      '{"version":1,"requestId":"codex-input:11111111-1111-4111-8111-111111111111","channelId":"C1","channelId":"C2","rootThreadTs":"1.1"}',
    ),
  );
  assert.throws(() =>
    parseUserInputActionValue(JSON.stringify({ ...routing, planHash: "forged" })),
  );
  assert.throws(() =>
    parseUserInputActionValue(JSON.stringify({ ...routing, version: 2 })),
  );
  assert.throws(() =>
    parseUserInputActionValue(JSON.stringify({ ...routing, requestId: "known-operation-id" })),
  );
});

test("splits exact path display into bounded Block Kit sections", () => {
  const paths = Array.from({ length: 100 }, (_, index) =>
    `src/features/${String(index).padStart(3, "0")}/${"x".repeat(180)}.ts`
  );
  const blocks = buildWorkspaceGitApprovalBlocks("Review all paths", { ...plan, paths }, routing);
  assert.ok(blocks.length < 50);
  for (const block of blocks) {
    if (block.type === "section" && "text" in block) {
      assert.ok(block.text.text.length <= 3_000);
    }
  }
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /src\/features\/000/u);
  assert.match(rendered, /src\/features\/099/u);
});
