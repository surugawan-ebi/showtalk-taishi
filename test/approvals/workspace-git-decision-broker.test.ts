import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  PrivateWorkspaceGitDecisionBroker,
  WorkspaceGitDecisionBrokerError,
  createWorkspaceGitDecisionDeliveryId,
  createWorkspaceGitDecisionBrokerFromEnvironment,
  type WorkspaceGitPrivateBrokerTransport,
} from "../../src/approvals/workspace-git-decision-broker.js";
import type { WorkspaceGitApprovalPlan } from "../../src/core/index.js";

const plan = {
  operationId: "11111111-1111-4111-8111-111111111111",
  planHash: "a".repeat(64),
  approvalTarget: "wt_opaque",
  approvalAuthorityId: "e".repeat(64),
  approvalScope: {
    kind: "git_publication",
    repo_id: "showtalk-taishi",
    mode: "commit_push_and_open_draft_pr",
    branch: "codex/private-approval",
    worktree_id: "wt_opaque",
    expected_head: "b".repeat(40),
    expected_snapshot_id: "c".repeat(64),
    paths: ["src/slack/frontend.ts"],
    commit_message: "Record Slack approval privately",
    pr: {
      title: "Record Slack approval privately",
      body: "Exact private approval test",
    },
    pr_base_branch: "release",
  },
  operation: "git_publication",
  repoId: "showtalk-taishi",
  mode: "commit_push_and_open_draft_pr",
  branch: "codex/private-approval",
  paths: ["src/slack/frontend.ts"],
  expectedHead: "b".repeat(40),
  expectedSnapshotId: "c".repeat(64),
  worktreeId: "wt_opaque",
  commitMessage: "Record Slack approval privately",
  pushTarget: "origin/codex/private-approval",
  pullRequestTitle: "Record Slack approval privately",
  pullRequestBody: "Exact private approval test",
  pullRequestBaseBranch: "release",
  expiresAt: "2099-08-24T02:30:00+09:00",
} satisfies WorkspaceGitApprovalPlan;
const deliveryId = "d".repeat(64);

test("binds a human decision delivery to one Slack message, request, user, and plan", () => {
  const input = {
    channelId: "C0123456789",
    rootThreadTs: "1700000000.000001",
    messageTs: "1700000000.000002",
    requestId: "request-1",
    userId: "U0123456789",
    decision: "approve" as const,
    operationId: plan.operationId,
    planHash: plan.planHash,
  };
  const first = createWorkspaceGitDecisionDeliveryId(input);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(createWorkspaceGitDecisionDeliveryId(input), first);
  assert.notEqual(
    createWorkspaceGitDecisionDeliveryId({ ...input, requestId: "request-2" }),
    first,
  );
  assert.notEqual(
    createWorkspaceGitDecisionDeliveryId({ ...input, messageTs: "1700000000.000003" }),
    first,
  );
});

test("sends the complete exact scope to the private transport", async () => {
  const calls: unknown[] = [];
  const transport: WorkspaceGitPrivateBrokerTransport = {
    recordDecision: async (input) => {
      calls.push(input);
      return { status: "approved", disposition: "transitioned" };
    },
  };
  const broker = new PrivateWorkspaceGitDecisionBroker(transport);

  await broker.recordDecision({
    decision: "approve",
    plan,
    actor: "chat-user-via-showtalk",
    deliveryId,
  });

  assert.deepEqual(calls, [{
    version: 1,
    decision: "approve",
    actor: "chat-user-via-showtalk",
    operation_id: plan.operationId,
    plan_hash: plan.planHash,
    approval_target: plan.approvalTarget,
    approval_authority_id: plan.approvalAuthorityId,
    repo_id: plan.repoId,
    expires_at: plan.expiresAt,
    decision_delivery_id: deliveryId,
    scope: plan.approvalScope,
  }]);
});

test("does not resume when the private store does not return the expected state", async () => {
  const broker = new PrivateWorkspaceGitDecisionBroker({
    recordDecision: async () => ({
      status: "awaiting_human_approval",
      disposition: "transitioned",
    }),
  });
  await assert.rejects(
    broker.recordDecision({
      decision: "approve",
      plan,
      actor: "chat-user-via-showtalk",
      deliveryId,
    }),
    /did not record/u,
  );
});

test("allows only bounded fail-closed system rejection without full scope", async () => {
  const calls: unknown[] = [];
  const broker = new PrivateWorkspaceGitDecisionBroker({
    recordDecision: async (input) => {
      calls.push(input);
      return { status: "rejected", disposition: "transitioned" };
    },
  });
  const minimal = {
    operationId: plan.operationId,
    planHash: plan.planHash,
    approvalTarget: plan.approvalTarget,
    repoId: plan.repoId,
    expiresAt: plan.expiresAt,
  };
  await broker.recordDecision({
    decision: "reject",
    plan: minimal,
    actor: "showtalk:slack-projection-failure",
  });
  await assert.rejects(
    broker.recordDecision({
      decision: "approve",
      plan: minimal,
      actor: "chat-user-via-showtalk",
    }),
    /require an exact plan/u,
  );
  assert.equal(calls.length, 1);
});

test("loads the private module once in a credential-isolated worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "showtalk-private-broker-"));
  let broker: Awaited<ReturnType<typeof createWorkspaceGitDecisionBrokerFromEnvironment>>;
  try {
    const modulePath = join(directory, "private-approval-broker.mjs");
    const capturePath = join(directory, "capture.json");
    await writeFile(
      modulePath,
      [
        'import { writeFile } from "node:fs/promises";',
        `const capturePath = ${JSON.stringify(capturePath)};`,
        "export async function createPrivateWorkspaceGitApprovalBroker() {",
        "  const environment = {",
        "    stateRoot: process.env.WORKSPACE_GIT_STATE_ROOT,",
        "    slack: process.env.SLACK_BOT_TOKEN,",
        "    mcp: process.env.SHOWTALK_TAISHI_MCP_TOKEN",
        "  };",
        "  return { recordDecision: async (input) => {",
        "    await writeFile(capturePath, JSON.stringify({ environment, input }));",
        "    return { status: input.decision === 'approve' ? 'approved' : 'rejected', disposition: 'transitioned' };",
        "  }, inspectDecision: async () => ({ status: 'awaiting_human_approval', disposition: 'pending' }) };",
        "}",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    broker = await createWorkspaceGitDecisionBrokerFromEnvironment({
      SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE: modulePath,
      WORKSPACE_GIT_STATE_ROOT: directory,
      SLACK_BOT_TOKEN: "xoxb-must-not-leak",
      SHOWTALK_TAISHI_MCP_TOKEN: "mcp-must-not-leak",
    });
    assert.ok(broker);

    // A local-mcp rebuild may replace dist after startup. The already-loaded
    // private module must continue serving decisions without touching the file.
    await rm(modulePath);
    await broker.recordDecision({
      decision: "approve",
      plan,
      actor: "chat-user-via-showtalk",
      deliveryId,
    });
    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      environment: Record<string, string | undefined>;
      input: Record<string, unknown>;
    };
    assert.equal(captured.environment.stateRoot, directory);
    assert.equal(captured.environment.slack, undefined);
    assert.equal(captured.environment.mcp, undefined);
    assert.equal(captured.input.operation_id, plan.operationId);
  } finally {
    await broker?.close?.().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy CLI configuration derives the private module but never executes the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "showtalk-private-broker-legacy-"));
  let broker: Awaited<ReturnType<typeof createWorkspaceGitDecisionBrokerFromEnvironment>>;
  try {
    const cliPath = join(directory, "dist", "src", "cli", "approval-cli.js");
    const modulePath = join(
      directory,
      "dist",
      "src",
      "approval",
      "private-approval-broker.js",
    );
    const cliMarker = join(directory, "cli-ran");
    await mkdir(dirname(cliPath), { recursive: true });
    await mkdir(dirname(modulePath), { recursive: true });
    await writeFile(
      cliPath,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(cliMarker)}, "bad");`,
      { encoding: "utf8", mode: 0o600 },
    );
    await writeFile(
      modulePath,
      "export async function createPrivateWorkspaceGitApprovalBroker() { return { recordDecision: async () => ({ status: 'approved', disposition: 'transitioned' }), inspectDecision: async () => ({ status: 'approved', disposition: 'recorded' }) }; }",
      { encoding: "utf8", mode: 0o600 },
    );
    broker = await createWorkspaceGitDecisionBrokerFromEnvironment({
      SHOWTALK_WORKSPACE_GIT_APPROVAL_CLI: cliPath,
      WORKSPACE_GIT_STATE_ROOT: directory,
    });
    assert.ok(broker);
    await broker.recordDecision({
      decision: "approve",
      plan,
      actor: "chat-user-via-showtalk",
      deliveryId,
    });
    await assert.rejects(readFile(cliMarker), /ENOENT/u);
  } finally {
    await broker?.close?.().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the isolated worker forwards only bounded error classifications", async () => {
  for (const scenario of [
    {
      source:
        "const error = new Error('/private/secret/state operation=hidden'); error.code = 'plan_mismatch'; throw error;",
      expectedCode: "plan_mismatch",
    },
    {
      source: "throw new Error('/private/secret/state write exploded');",
      expectedCode: "state_write_failed",
    },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "showtalk-private-broker-error-"));
    let broker: Awaited<ReturnType<typeof createWorkspaceGitDecisionBrokerFromEnvironment>>;
    try {
      const modulePath = join(directory, "private-approval-broker.mjs");
      await writeFile(
        modulePath,
        `export async function createPrivateWorkspaceGitApprovalBroker() { return { recordDecision: async () => { ${scenario.source} }, inspectDecision: async () => ({ status: 'awaiting_human_approval', disposition: 'pending' }) }; }`,
        { encoding: "utf8", mode: 0o600 },
      );
      broker = await createWorkspaceGitDecisionBrokerFromEnvironment({
        SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE: modulePath,
        WORKSPACE_GIT_STATE_ROOT: directory,
      });
      assert.ok(broker);
      await assert.rejects(
        broker.recordDecision({
          decision: "approve",
          plan,
          actor: "chat-user-via-showtalk",
          deliveryId,
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkspaceGitDecisionBrokerError);
          assert.equal(error.code, scenario.expectedCode);
          assert.doesNotMatch(
            error.message,
            /\/private\/secret|hidden|exploded/u,
          );
          return true;
        },
      );
    } finally {
      await broker?.close?.().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("a hung private decision is bounded and does not leave the Slack handler waiting forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "showtalk-private-broker-hang-"));
  let broker: Awaited<ReturnType<typeof createWorkspaceGitDecisionBrokerFromEnvironment>>;
  try {
    const modulePath = join(directory, "private-approval-broker.mjs");
    await writeFile(
      modulePath,
      "export async function createPrivateWorkspaceGitApprovalBroker() { return { recordDecision: async () => new Promise(() => {}), inspectDecision: async () => ({ status: 'awaiting_human_approval', disposition: 'pending' }) }; }",
      { encoding: "utf8", mode: 0o600 },
    );
    broker = await createWorkspaceGitDecisionBrokerFromEnvironment(
      {
        SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE: modulePath,
        WORKSPACE_GIT_STATE_ROOT: directory,
      },
      { requestTimeoutMs: 50 },
    );
    assert.ok(broker);
    const startedAt = Date.now();
    await assert.rejects(
      broker.recordDecision({
        decision: "approve",
        plan,
        actor: "chat-user-via-showtalk",
        deliveryId,
      }),
      (error: unknown) =>
        error instanceof WorkspaceGitDecisionBrokerError &&
        error.code === "decision_outcome_unknown",
    );
    assert.ok(Date.now() - startedAt < 1_000);
  } finally {
    await broker?.close?.().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciles a durable decision when the worker response arrives after timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "showtalk-private-broker-late-"));
  let broker: Awaited<ReturnType<typeof createWorkspaceGitDecisionBrokerFromEnvironment>>;
  try {
    const modulePath = join(directory, "private-approval-broker.mjs");
    await writeFile(
      modulePath,
      [
        "let recorded;",
        "export async function createPrivateWorkspaceGitApprovalBroker() {",
        "  return {",
        "    recordDecision: async (input) => {",
        "      recorded = input;",
        "      await new Promise((resolve) => setTimeout(resolve, 100));",
        "      return { status: 'approved', disposition: 'transitioned' };",
        "    },",
        "    inspectDecision: async (input) => recorded?.decision_delivery_id === input.decision_delivery_id",
        "      ? { status: 'approved', disposition: 'recorded' }",
        "      : { status: 'awaiting_human_approval', disposition: 'pending' }",
        "  };",
        "}",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    broker = await createWorkspaceGitDecisionBrokerFromEnvironment(
      {
        SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE: modulePath,
        WORKSPACE_GIT_STATE_ROOT: directory,
      },
      { requestTimeoutMs: 50 },
    );
    assert.ok(broker);
    await broker.recordDecision({
      decision: "approve",
      plan,
      actor: "chat-user-via-showtalk",
      deliveryId,
    });
  } finally {
    await broker?.close?.().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
