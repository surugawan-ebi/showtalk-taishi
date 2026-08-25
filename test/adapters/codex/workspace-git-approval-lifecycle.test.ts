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
): Record<string, unknown> {
  return {
    type: "mcpToolCall",
    id,
    server: "workspace-git",
    tool: "execute_approved_git_publication",
    status,
    arguments: { operation_id: plan().operationId },
    ...(outcome === undefined
      ? {}
      : {
          result: {
            structuredContent: {
              operation_id: plan().operationId,
              status: outcome,
            },
          },
        }),
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

test("deduplicates recovery per turn and clears only the selected session", () => {
  const lifecycle = new WorkspaceGitApprovalLifecycle();
  assert.equal(lifecycle.markRecoveryRequired("session-a", "turn"), true);
  assert.equal(lifecycle.markRecoveryRequired("session-a", "turn"), false);
  assert.equal(lifecycle.markRecoveryRequired("session-b", "turn"), true);
  lifecycle.clearTurnArtifacts("session-a");
  assert.equal(lifecycle.markRecoveryRequired("session-a", "turn"), true);
  assert.equal(lifecycle.markRecoveryRequired("session-b", "turn"), false);
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
