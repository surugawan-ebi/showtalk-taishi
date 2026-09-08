import assert from "node:assert/strict";
import test from "node:test";

import type { WorkspaceGitApprovalPlan } from "../../../src/core/index.js";
import {
  WorkspaceGitApprovalLifecycle,
} from "../../../src/adapters/codex/workspace-git-approval-lifecycle.js";

function plan(overrides: Partial<WorkspaceGitApprovalPlan> = {}): WorkspaceGitApprovalPlan {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    planHash: "a".repeat(64),
    approvalTarget: "primary",
    operation: "git_publication",
    repoId: "showtalk-taishi",
    mode: "commit_and_push",
    branch: "agent/approval-lifecycle",
    paths: ["src/core/gateway.ts"],
    expectedHead: "b".repeat(40),
    expectedSnapshotId: "c".repeat(64),
    worktreeId: "primary",
    commitMessage: "Refactor approval lifecycle",
    pushTarget: "origin/agent/approval-lifecycle",
    expiresAt: "2026-08-24T12:00:00.000Z",
    ...overrides,
  } as WorkspaceGitApprovalPlan;
}

function executionItem(
  id: string,
  status: "inProgress" | "completed" | "failed",
  outcome?: string,
  operationId = plan().operationId,
): Record<string, unknown> {
  return {
    type: "mcpToolCall",
    id,
    server: "workspace-git",
    tool: "execute_approved_git_publication",
    status,
    arguments: { operation_id: operationId },
    ...(outcome === undefined
      ? {}
      : {
          result: {
            structuredContent: {
              operation_id: operationId,
              status: outcome,
            },
          },
        }),
  };
}

function repositorySettingsPlan(): WorkspaceGitApprovalPlan {
  return {
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
    expiresAt: "2026-08-26T12:00:00.000Z",
  };
}

function mainUpdatePlan(): WorkspaceGitApprovalPlan {
  return {
    operationId: "44444444-4444-4444-8444-444444444444",
    planHash: "d".repeat(64),
    approvalTarget: "main_update_showtalk-taishi",
    operation: "main_update",
    repoId: "showtalk-taishi",
    environment: "development",
    mode: "main_update",
    paths: [],
    currentBranch: "agent/fix-approval-recovery-v2",
    expectedHead: "b".repeat(40),
    expectedSnapshotId: "c".repeat(64),
    worktreeId: "primary",
    expiresAt: "2026-09-09T01:00:00+09:00",
  };
}

function mainUpdateExecutionItem(outcome: "updated" | "skipped") {
  const exact = mainUpdatePlan();
  return {
    type: "mcpToolCall",
    id: `main-${outcome}`,
    server: "workspace-git",
    tool: "execute_approved_main_update",
    status: "completed",
    arguments: { operation_id: exact.operationId },
    result: {
      structuredContent: {
        operation_id: exact.operationId,
        status: outcome,
      },
    },
  };
}

test("binds exactly one plan and preserves conflicting plans as ambiguous", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const exact = plan();
  lifecycle.rememberPlan("session", "turn", exact);
  lifecycle.rememberPlan("session", "turn", exact);
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "exact",
    plan: exact,
  });

  lifecycle.rememberPlan("session", "turn", plan({ planHash: "d".repeat(64) }));
  lifecycle.rememberPlan(
    "session",
    "turn",
    plan({ planHash: "e".repeat(64), approvalTarget: "wt_other" }),
  );
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "ambiguous",
  });
  assert.equal(lifecycle.takeTurnPlans("session", "turn").length, 3);
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "missing",
  });
});

test("recognizes updated and skipped main-update executions as terminal outcomes", () => {
  for (const outcome of ["updated", "skipped"] as const) {
    const lifecycle = new WorkspaceGitApprovalLifecycle();
    const exact = mainUpdatePlan();
    lifecycle.beginApprovedExecution("session", exact);
    lifecycle.observeItem("session", mainUpdateExecutionItem(outcome));
    assert.deepEqual(
      lifecycle.assessTurnCompletion("session", "idle", true),
      { kind: "executed" },
    );
  }
});

test("treats changed exact-plan fields as ambiguous even when public IDs match", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  lifecycle.rememberPlan("session", "turn", plan());
  lifecycle.rememberPlan(
    "session",
    "turn",
    plan({ paths: ["src/core/router.ts"], branch: "agent/substituted" }),
  );
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "ambiguous",
  });
});

test("does not overwrite an active approved execution", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  lifecycle.beginApprovedExecution("session", plan());
  assert.throws(
    () => lifecycle.beginApprovedExecution(
      "session",
      plan({ operationId: "22222222-2222-4222-8222-222222222222" }),
    ),
    /already active/u,
  );
  assert.equal(lifecycle.approvedPlan("session")?.operationId, plan().operationId);
  assert.equal(
    lifecycle.clearApprovedExecution(
      "session",
      plan({ operationId: "22222222-2222-4222-8222-222222222222" }),
    ),
    false,
  );
  assert.equal(lifecycle.approvedPlan("session")?.operationId, plan().operationId);
});

test("allows sequential approvals after each exact execution succeeds", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const first = plan();
  const second = plan({
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  lifecycle.beginApprovedExecution("session", first);
  assert.throws(
    () => lifecycle.beginApprovedExecution("session", second),
    /already active/u,
  );

  lifecycle.observeItem(
    "session",
    executionItem("execute-first", "completed", "applied"),
  );
  assert.equal(lifecycle.approvedPlan("session"), undefined);
  lifecycle.beginApprovedExecution("session", second);
  assert.equal(lifecycle.approvedPlan("session")?.operationId, second.operationId);

  lifecycle.observeItem(
    "session",
    executionItem("execute-second", "completed", "applied", second.operationId),
  );
  const third = plan({
    operationId: "33333333-3333-4333-8333-333333333333",
    planHash: "e".repeat(64),
  });
  lifecycle.beginApprovedExecution("session", third);
  assert.equal(lifecycle.approvedPlan("session")?.operationId, third.operationId);

  assert.equal(
    lifecycle.observeItem(
      "session",
      {
        ...executionItem("execute-first-replay", "completed", "applied"),
      },
    ).duplicateExecutionDetected,
    true,
  );
});

test("allows the next approval after an exact execution reaches terminal failed", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const first = plan();
  const second = plan({
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  lifecycle.beginApprovedExecution("session", first);
  lifecycle.observeItem(
    "session",
    executionItem("execute-first", "completed", "failed"),
  );

  assert.equal(lifecycle.approvedPlan("session"), undefined);
  assert.equal(lifecycle.isCompletedOperation("session", first.operationId), true);
  lifecycle.beginApprovedExecution("session", second);
  assert.equal(lifecycle.approvedPlan("session")?.operationId, second.operationId);
});

test("keeps outcome-uncertain and transport-failed executions fail closed", () => {
  for (const item of [
    executionItem("execute-uncertain", "completed", "outcome_uncertain"),
    executionItem("execute-transport-failed", "failed"),
  ]) {
    const lifecycle = new WorkspaceGitApprovalLifecycle();
    const first = plan();
    const second = plan({
      operationId: "22222222-2222-4222-8222-222222222222",
      planHash: "d".repeat(64),
    });
    lifecycle.beginApprovedExecution("session", first);
    lifecycle.observeItem("session", item);

    assert.equal(lifecycle.approvedPlan("session")?.operationId, first.operationId);
    assert.throws(
      () => lifecycle.beginApprovedExecution("session", second),
      /already active/u,
    );
  }
});

test("does not treat one success plus another unfinished execute as completed", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const first = plan();
  const second = plan({
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  lifecycle.beginApprovedExecution("session", first);
  lifecycle.observeItem(
    "session",
    executionItem("execute-success", "completed", "applied"),
  );
  lifecycle.observeItem(
    "session",
    executionItem("execute-still-running", "inProgress"),
  );

  assert.equal(lifecycle.hasExecutionWatch("session"), true);
  assert.equal(lifecycle.approvedPlan("session")?.operationId, first.operationId);
  assert.equal(lifecycle.isCompletedOperation("session", first.operationId), false);
  assert.throws(
    () => lifecycle.beginApprovedExecution("session", second),
    /already active/u,
  );
});

test("retains completed operation identity for replay rejection and auditing", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const first = plan();
  const second = plan({
    operationId: "22222222-2222-4222-8222-222222222222",
    planHash: "d".repeat(64),
  });
  lifecycle.beginApprovedExecution("session", first);
  lifecycle.observeItem(
    "session",
    executionItem("execute-first", "completed", "applied"),
  );

  assert.equal(lifecycle.hasExecutionWatch("session"), true);
  assert.equal(lifecycle.isCompletedOperation("session", first.operationId), true);
  lifecycle.beginApprovedExecution("session", second);
  assert.equal(lifecycle.isCompletedOperation("session", first.operationId), true);
  assert.equal(lifecycle.isCompletedOperation("session", second.operationId), false);
});

test("observes the exact GitHub repository settings execute tool", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const exact = repositorySettingsPlan();
  lifecycle.beginApprovedExecution("session", exact);
  lifecycle.observeItem("session", {
    type: "mcpToolCall",
    id: "settings-execute-1",
    server: "workspace_git",
    tool: "execute_approved_github_repository_settings",
    status: "completed",
    arguments: { operation_id: exact.operationId },
    result: {
      structuredContent: {
        operation_id: exact.operationId,
        status: "succeeded",
      },
    },
  });
  assert.deepEqual(lifecycle.assessTurnCompletion("session", "idle", true), {
    kind: "executed",
  });
});

test("consumes only the exact inspected plan", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const exact = plan();
  lifecycle.rememberPlan("session", "turn", exact);
  assert.throws(
    () => lifecycle.consumeExactPlan(
      "session",
      "turn",
      plan({ approvalTarget: "wt_substituted" }),
    ),
    /binding changed/u,
  );
  lifecycle.consumeExactPlan("session", "turn", exact);
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "missing",
  });
});

test("discards all stale plan candidates for one recoverable turn", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  lifecycle.rememberPlan("session", "turn", plan());
  lifecycle.rememberPlan(
    "session",
    "turn",
    plan({
      operationId: "22222222-2222-4222-8222-222222222222",
      planHash: "d".repeat(64),
    }),
  );
  lifecycle.rememberPlan("session", "other-turn", plan());

  assert.equal(lifecycle.discardTurnPlans("session", "turn"), 2);
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "missing",
  });
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "other-turn"), {
    kind: "exact",
    plan: plan(),
  });
  assert.equal(lifecycle.discardTurnPlans("session", "turn"), 0);
});

test("deduplicates recovery per turn and clears only the selected session", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  assert.equal(lifecycle.markRecoveryRequired("session-a", "turn"), true);
  assert.equal(lifecycle.markRecoveryRequired("session-a", "turn"), false);
  assert.equal(lifecycle.markRecoveryRequired("session-b", "turn"), true);
  lifecycle.clearTurnArtifacts("session-a");
  assert.equal(lifecycle.markRecoveryRequired("session-a", "turn"), true);
  assert.equal(lifecycle.markRecoveryRequired("session-b", "turn"), false);
});

test("blocks new plans after a malformed request until turn artifacts clear", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  assert.equal(lifecycle.markRequestInvalid("session", "turn"), true);
  assert.equal(lifecycle.markRequestInvalid("session", "turn"), false);
  assert.equal(lifecycle.isRequestInvalid("session", "turn"), true);

  lifecycle.rememberPlan("session", "turn", plan());
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "missing",
  });

  lifecycle.clearTurnArtifacts("session");
  assert.equal(lifecycle.isRequestInvalid("session", "turn"), false);
  lifecycle.rememberPlan("session", "turn", plan());
  assert.deepEqual(lifecycle.inspectPlanBinding("session", "turn"), {
    kind: "exact",
    plan: plan(),
  });
});

test("requests one bounded continuation when approval produced no execute item", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  const exact = plan();
  lifecycle.beginApprovedExecution("session", exact);
  assert.deepEqual(
    lifecycle.assessTurnCompletion("session", "idle", true),
    { kind: "continue", plan: exact },
  );
  assert.deepEqual(
    lifecycle.assessTurnCompletion("session", "idle", true),
    { kind: "execution_not_observed" },
  );
});

test("classifies completed, failed, terminal, and incomplete approved turns", () => {
  const completed = new WorkspaceGitApprovalLifecycle();
  completed.beginApprovedExecution("session", plan());
  completed.observeItem("session", executionItem("execute-1", "completed", "applied"));
  assert.deepEqual(completed.assessTurnCompletion("session", "idle", true), {
    kind: "executed",
  });

  const failed = new WorkspaceGitApprovalLifecycle();
  failed.beginApprovedExecution("session", plan());
  failed.observeItem("session", executionItem("execute-1", "failed", "failed"));
  assert.deepEqual(failed.assessTurnCompletion("session", "idle", true), {
    kind: "execution_incomplete",
  });

  const terminal = new WorkspaceGitApprovalLifecycle();
  terminal.beginApprovedExecution("session", plan());
  terminal.observeItem("session", {
    type: "mcpToolCall",
    id: "status-1",
    server: "workspace_git",
    tool: "get_git_operation_status",
    status: "completed",
    arguments: { operation_id: plan().operationId },
    result: {
      structuredContent: {
        operation_id: plan().operationId,
        status: "expired",
      },
    },
  });
  assert.deepEqual(terminal.assessTurnCompletion("session", "idle", true), {
    kind: "terminal_state_observed",
    statuses: ["expired"],
  });

  const incomplete = new WorkspaceGitApprovalLifecycle();
  incomplete.beginApprovedExecution("session", plan());
  assert.deepEqual(incomplete.assessTurnCompletion("session", "idle", false), {
    kind: "final_state_incomplete",
  });
});

test("reports duplicate execute item IDs only once", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  lifecycle.beginApprovedExecution("session", plan());
  assert.equal(
    lifecycle.observeItem("session", executionItem("execute-1", "inProgress"))
      .duplicateExecutionDetected,
    false,
  );
  assert.equal(
    lifecycle.observeItem("session", executionItem("execute-2", "inProgress"))
      .duplicateExecutionDetected,
    true,
  );
  assert.equal(
    lifecycle.observeItem("session", executionItem("execute-3", "inProgress"))
      .duplicateExecutionDetected,
    false,
  );
});

test("does not accept an execution result for a different operation", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  lifecycle.beginApprovedExecution("session", plan());
  lifecycle.observeItem("session", {
    ...executionItem("execute-1", "completed", "succeeded"),
    result: {
      structuredContent: {
        operation_id: "22222222-2222-4222-8222-222222222222",
        status: "succeeded",
      },
    },
  });
  assert.deepEqual(lifecycle.assessTurnCompletion("session", "idle", true), {
    kind: "execution_incomplete",
  });
});
