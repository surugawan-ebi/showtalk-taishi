import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PrivateWorkspaceGitHumanDecisionBroker,
  WorkspaceGitHumanDecisionBrokerError,
  createWorkspaceGitHumanDecisionDeliveryId,
  workspaceGitHumanDecisionPayload,
  type WorkspaceGitHumanDecisionInput,
} from "../../src/approvals/workspace-git-human-decision-broker.js";
import { createWorkspaceGitHumanDecisionBrokerFromEnvironment } from "../../src/approvals/workspace-git-manual-worker-transport.js";
import type { WorkspaceGitApprovalPlan } from "../../src/core/index.js";

const plan = {
  operationId: "22222222-2222-4222-8222-222222222222",
  planHash: "b".repeat(64),
  approvalTarget: "primary",
  approvalScope: {
    branch: "codex/v3",
    expected_head: "3".repeat(40),
    expected_snapshot_id: "d".repeat(64),
    kind: "git_publication",
    mode: "commit_only",
    paths: [],
    repo_id: "fixture",
    worktree_id: "primary",
  },
  operation: "git_publication",
  repoId: "fixture",
  mode: "commit_only",
  branch: "codex/v3",
  paths: [],
  expectedHead: "3".repeat(40),
  expectedSnapshotId: "d".repeat(64),
  worktreeId: "primary",
  commitMessage: "human v3",
  expiresAt: "2099-01-01T00:00:00.000Z",
} satisfies WorkspaceGitApprovalPlan;

const decision = {
  decision: "approve",
  plan,
  deliveryId: "c".repeat(64),
  context: {
    callerId: "caller",
    koeId: "koe",
    channelId: "channel",
    rootThreadTs: "root",
    sessionId: "session",
  },
} satisfies WorkspaceGitHumanDecisionInput;

test("binds a human decision delivery to one Slack action and exact plan", () => {
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
  const first = createWorkspaceGitHumanDecisionDeliveryId(input);
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(createWorkspaceGitHumanDecisionDeliveryId(input), first);
  assert.notEqual(
    createWorkspaceGitHumanDecisionDeliveryId({ ...input, requestId: "request-2" }),
    first,
  );
  assert.notEqual(
    createWorkspaceGitHumanDecisionDeliveryId({ ...input, userId: "U999" }),
    first,
  );
});

test("matches the shared manual v1 human decision body without private scope or authority", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../fixtures/workspace-git-human-decision-v1.json", import.meta.url),
    "utf8",
  )) as { body: unknown };
  const payload = workspaceGitHumanDecisionPayload(decision);

  assert.deepEqual(payload, fixture.body);
  assert.equal("approval_authority_id" in payload, false);
  assert.equal("key_id" in payload, false);
  assert.equal("signature" in payload, false);
  assert.equal("scope" in payload, false);
});

test("records manual v1 through an opaque transport before accepting the decision", async () => {
  const calls: unknown[] = [];
  const broker = new PrivateWorkspaceGitHumanDecisionBroker({
    recordHumanDecision: async (input) => {
      calls.push(input);
      return { status: "approved", disposition: "transitioned" };
    },
  });

  await broker.recordDecision(decision);

  assert.deepEqual(calls, [workspaceGitHumanDecisionPayload(decision)]);
});

test("accepts only the expected terminal state and same-delivery replay", async () => {
  const replay = new PrivateWorkspaceGitHumanDecisionBroker({
    recordHumanDecision: async () => ({
      status: "approved",
      disposition: "already_recorded_same_delivery",
    }),
  });
  await replay.recordDecision(decision);

  const conflict = new PrivateWorkspaceGitHumanDecisionBroker({
    recordHumanDecision: async () => ({
      status: "awaiting_human_approval",
      disposition: "transitioned",
    }),
  });
  await assert.rejects(
    conflict.recordDecision(decision),
    (error: unknown) =>
      error instanceof WorkspaceGitHumanDecisionBrokerError &&
      error.code === "status_conflict",
  );
});

test("maps unknown transport failures to outcome unknown", async () => {
  const broker = new PrivateWorkspaceGitHumanDecisionBroker({
    recordHumanDecision: async () => Promise.reject(new Error("socket closed")),
  });
  await assert.rejects(
    broker.recordDecision(decision),
    (error: unknown) =>
      error instanceof WorkspaceGitHumanDecisionBrokerError &&
      error.code === "decision_outcome_unknown",
  );
});

test("rejects a decision without the exact public approval scope", () => {
  const { approvalScope: _approvalScope, ...planWithoutScope } = plan;
  assert.throws(
    () => workspaceGitHumanDecisionPayload({
      ...decision,
      plan: planWithoutScope as unknown as WorkspaceGitApprovalPlan,
    }),
    (error: unknown) =>
      error instanceof WorkspaceGitHumanDecisionBrokerError &&
      error.code === "plan_mismatch",
  );
});

test("loads only the configured manual v1 composition in an isolated worker", async () => {
  const broker = await createWorkspaceGitHumanDecisionBrokerFromEnvironment({
    SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE:
      new URL("../fixtures/workspace-git-manual-module.mjs", import.meta.url)
        .pathname,
    WORKSPACE_GIT_STATE_ROOT: "/tmp/showtalk-manual-broker-fixture",
  });
  assert.ok(broker);
  try {
    await broker.recordDecision(decision);
  } finally {
    await broker.close?.();
  }
});

test("fails closed for an unsupported private composition", async () => {
  await assert.rejects(
    createWorkspaceGitHumanDecisionBrokerFromEnvironment({
      SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE:
        new URL("../fixtures/workspace-git-manual-module-invalid.mjs", import.meta.url)
          .pathname,
      WORKSPACE_GIT_STATE_ROOT: "/tmp/showtalk-manual-broker-fixture",
    }),
    /manual decision worker failed|manual decision worker exited/u,
  );
});

test("does not load a human broker unless an explicit module is configured", async () => {
  assert.equal(
    await createWorkspaceGitHumanDecisionBrokerFromEnvironment({}),
    undefined,
  );
  await assert.rejects(
    createWorkspaceGitHumanDecisionBrokerFromEnvironment({
      SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE: "relative/manual.js",
      WORKSPACE_GIT_STATE_ROOT: "/tmp/showtalk-manual-broker-fixture",
    }),
    /absolute file path/u,
  );
});

test("rejects a group-writable manual module before importing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "showtalk-manual-module-"));
  const modulePath = join(root, "manual.mjs");
  try {
    await copyFile(
      new URL("../fixtures/workspace-git-manual-module.mjs", import.meta.url),
      modulePath,
    );
    await chmod(modulePath, 0o620);
    await assert.rejects(
      createWorkspaceGitHumanDecisionBrokerFromEnvironment({
        SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE: modulePath,
        WORKSPACE_GIT_STATE_ROOT: root,
      }),
      /must not be group\/world writable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
