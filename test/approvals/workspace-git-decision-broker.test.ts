import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PrivateWorkspaceGitDecisionBroker,
  createWorkspaceGitDecisionBrokerFromEnvironment,
  type WorkspaceGitApprovalCliRunner,
} from "../../src/approvals/workspace-git-decision-broker.js";
import type { WorkspaceGitApprovalPlan } from "../../src/core/index.js";

const plan = {
  operationId: "11111111-1111-4111-8111-111111111111",
  planHash: "a".repeat(64),
  approvalTarget: "wt_opaque",
  operation: "git_publication",
  repoId: "showtalk-taishi",
  mode: "commit_and_push",
  branch: "codex/private-approval",
  paths: ["src/slack/frontend.ts"],
  expectedHead: "b".repeat(40),
  expectedSnapshotId: "c".repeat(64),
  worktreeId: "wt_opaque",
  commitMessage: "Record Slack approval privately",
  pushTarget: "origin/codex/private-approval",
  expiresAt: "2099-08-24T02:30:00+09:00",
} satisfies WorkspaceGitApprovalPlan;

function result(status: string, overrides: Record<string, unknown> = {}) {
  return {
    operation_id: plan.operationId,
    plan_hash: plan.planHash,
    approval_target: plan.approvalTarget,
    repo_id: plan.repoId,
    expires_at: plan.expiresAt,
    status,
    ...overrides,
  };
}

test("records an exact approval before the App Server may resume", async () => {
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const runner: WorkspaceGitApprovalCliRunner = async (arguments_) => {
    mutableCalls.push([...arguments_]);
    return arguments_[0] === "status" ? result("awaiting_human_approval") : result("approved");
  };
  const broker = new PrivateWorkspaceGitDecisionBroker(runner);

  await broker.recordDecision({
    decision: "approve",
    plan,
    actor: "slack-user:U0123456789",
  });

  assert.deepEqual(calls, [
    ["status", plan.operationId],
    [
      "approve",
      plan.operationId,
      plan.planHash,
      plan.approvalTarget,
      "slack-user:U0123456789",
    ],
  ]);
});

test("records rejection without exposing plan authority in Slack payloads", async () => {
  const calls: string[][] = [];
  const broker = new PrivateWorkspaceGitDecisionBroker(async (arguments_) => {
    calls.push([...arguments_]);
    return arguments_[0] === "status" ? result("awaiting_human_approval") : result("rejected");
  });

  await broker.recordDecision({
    decision: "reject",
    plan,
    actor: "slack-user:U0123456789",
  });
  assert.deepEqual(calls, [
    ["status", plan.operationId],
    ["reject", plan.operationId],
  ]);
});

test("accepts a duplicate exact decision idempotently without invoking approve twice", async () => {
  const calls: string[][] = [];
  const broker = new PrivateWorkspaceGitDecisionBroker(async (arguments_) => {
    calls.push([...arguments_]);
    return result("approved");
  });

  await broker.recordDecision({
    decision: "approve",
    plan,
    actor: "slack-user:U0123456789",
  });
  assert.deepEqual(calls, [["status", plan.operationId]]);
});

test("fails closed when private state does not exactly match the Slack plan", async () => {
  const broker = new PrivateWorkspaceGitDecisionBroker(async () =>
    result("awaiting_human_approval", { approval_target: "wt_other" })
  );
  await assert.rejects(
    broker.recordDecision({
      decision: "approve",
      plan,
      actor: "slack-user:U0123456789",
    }),
    /does not match the Slack plan/u,
  );
});

test("does not accept terminal or malformed private approval responses", async () => {
  for (const status of ["executing", "applied", "failed", "outcome_uncertain"]) {
    const broker = new PrivateWorkspaceGitDecisionBroker(async () => result(status));
    await assert.rejects(
      broker.recordDecision({
        decision: "approve",
        plan,
        actor: "slack-user:U0123456789",
      }),
      new RegExp(status, "u"),
    );
  }

  const malformed = new PrivateWorkspaceGitDecisionBroker(async () => ({
    status: "approved",
  }));
  await assert.rejects(
    malformed.recordDecision({
      decision: "approve",
      plan,
      actor: "slack-user:U0123456789",
    }),
    /invalid operation ID/u,
  );
});

test("the command broker does not inherit Slack or MCP credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "showtalk-git-broker-"));
  try {
    const cliPath = join(directory, "approval-cli.mjs");
    const environmentCapturePath = join(directory, "environment.json");
    await writeFile(
      cliPath,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(environmentCapturePath)}, JSON.stringify(process.env));`,
        'const command = process.argv[2];',
        `console.log(JSON.stringify(${JSON.stringify(result("awaiting_human_approval"))}.status && {`,
        `  ...${JSON.stringify(result("awaiting_human_approval"))},`,
        '  status: command === "approve" ? "approved" : "awaiting_human_approval"',
        '}));',
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    const broker = await createWorkspaceGitDecisionBrokerFromEnvironment({
      PATH: process.env.PATH,
      SHOWTALK_WORKSPACE_GIT_APPROVAL_CLI: cliPath,
      WORKSPACE_GIT_STATE_ROOT: directory,
      SLACK_BOT_TOKEN: "xoxb-must-not-leak",
      SHOWTALK_TAISHI_MCP_TOKEN: "mcp-must-not-leak",
      WORKSPACE_GIT_HTTP_TOKEN: "http-must-not-leak",
    });
    assert.ok(broker);
    await broker.recordDecision({
      decision: "approve",
      plan,
      actor: "slack-user:U0123456789",
    });
    const captured = JSON.parse(
      await readFile(environmentCapturePath, "utf8"),
    ) as Record<string, string>;
    assert.equal(captured.WORKSPACE_GIT_STATE_ROOT, directory);
    assert.equal(captured.SLACK_BOT_TOKEN, undefined);
    assert.equal(captured.SHOWTALK_TAISHI_MCP_TOKEN, undefined);
    assert.equal(captured.WORKSPACE_GIT_HTTP_TOKEN, undefined);
    assert.equal(captured.SHOWTALK_WORKSPACE_GIT_APPROVAL_CLI, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
