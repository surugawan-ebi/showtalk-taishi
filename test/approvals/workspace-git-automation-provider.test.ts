import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ManualWorkspaceGitAutomationProvider,
  validateWorkspaceGitAutomationResult,
  validateWorkspaceGitAutomationResultV4,
  type WorkspaceGitAutomationInput,
  type WorkspaceGitAutomationInputV4,
} from "../../src/approvals/workspace-git-automation-provider.js";

const input: WorkspaceGitAutomationInput = {
  contract_version: 1,
  plan: {
    operation_id: "11111111-1111-4111-8111-111111111111",
    plan_hash: "a".repeat(64),
    approval_target: "primary",
    repo_id: "showtalk-taishi",
    expires_at: "2099-09-02T12:00:00+09:00",
    environment: "development",
    capabilities: ["commit"],
    branch: "agent/provider-boundary",
    paths: ["src/approvals/workspace-git-automation-provider.ts"],
    expected_head: "c".repeat(40),
    expected_snapshot_id: "d".repeat(64),
  },
  context: {
    invocation_id: "invocation-1",
    deadline_at: "2099-09-02T12:00:00+09:00",
    koe_id: "implementer",
    app_server: {
      method: "item/tool/requestUserInput",
      rpc_request_id: "request-1",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: "item-1",
      question_id: "git_approval",
      is_blocking: true,
    },
    slack: {
      team_id: "T0123456789",
      app_id: "A0123456789",
      channel_id: "C0123456789",
      root_thread_ts: "1700000000.000001",
      source_message_ts: "1700000000.000002",
      user_id: "U0123456789",
    },
  },
};

const inputV4: WorkspaceGitAutomationInputV4 = {
  ...input,
  contract_version: 4,
  context: {
    ...input.context,
    koe_binding_revision: 17,
    principal_policy_revision: 29,
  },
};

test("the built-in workspace-git automation provider is manual and side-effect free", async () => {
  const provider = new ManualWorkspaceGitAutomationProvider();
  assert.deepEqual(await provider.executePreparedPlan(input), {
    status: "manual",
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    reason: "not_configured",
  });
});

test("accepts only terminal provider results bound to the exact plan", () => {
  assert.deepEqual(validateWorkspaceGitAutomationResult(input, {
    status: "terminal_executed",
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    receipt_id: "receipt-1",
  }), {
    status: "terminal_executed",
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    receipt_id: "receipt-1",
  });
  assert.throws(
    () => validateWorkspaceGitAutomationResult(input, {
      status: "authorized",
      operation_id: input.plan.operation_id,
      plan_hash: input.plan.plan_hash,
    }),
    /non-terminal result/u,
  );
  assert.throws(
    () => validateWorkspaceGitAutomationResult(input, {
      status: "terminal_executed",
      operation_id: "another-operation",
      plan_hash: input.plan.plan_hash,
      receipt_id: "receipt-2",
    }),
    /changed the exact plan identity/u,
  );
});

test("keeps outcome uncertainty blocked instead of falling back to manual", () => {
  assert.deepEqual(validateWorkspaceGitAutomationResult(input, {
    status: "blocked",
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    reason: "outcome_unknown",
  }), {
    status: "blocked",
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    reason: "outcome_unknown",
  });
});

test("shares the exact version-1 provider body shape with local-mcp", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../fixtures/workspace-git-provider-execution-v1.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
  assert.deepEqual(Object.keys(fixture), ["version", "request_id", "method", "body"]);
  assert.equal(fixture.version, 1);
  assert.equal(fixture.method, "execute_prepared_plan");
  const body = fixture.body as WorkspaceGitAutomationInput;
  const provider = new ManualWorkspaceGitAutomationProvider();
  assert.deepEqual(await provider.executePreparedPlan(body), {
    status: "manual",
    operation_id: body.plan.operation_id,
    plan_hash: body.plan.plan_hash,
    reason: "not_configured",
  });
});

test("accepts only exact terminal v4 results for the prepared plan", () => {
  assert.deepEqual(validateWorkspaceGitAutomationResultV4(inputV4, {
    status: "terminal_executed",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    receipt_id: "receipt-v4",
  }), {
    status: "terminal_executed",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    receipt_id: "receipt-v4",
  });
  assert.deepEqual(validateWorkspaceGitAutomationResultV4(inputV4, {
    status: "manual",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    reason: "human_approval_required",
  }), {
    status: "manual",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    reason: "human_approval_required",
  });
  assert.deepEqual(validateWorkspaceGitAutomationResultV4(inputV4, {
    status: "blocked",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    reason: "activation_security_revoked",
  }), {
    status: "blocked",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    reason: "activation_security_revoked",
  });
});

test("rejects non-terminal, mismatched, and widened v4 provider results", () => {
  assert.throws(() => validateWorkspaceGitAutomationResultV4(inputV4, {
    status: "authorized",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
  }), /blocked reason is invalid/u);
  assert.throws(() => validateWorkspaceGitAutomationResultV4(inputV4, {
    status: "manual",
    operation_id: "another-operation",
    plan_hash: inputV4.plan.plan_hash,
    reason: "human_approval_required",
  }), /changed the exact plan identity/u);
  assert.throws(() => validateWorkspaceGitAutomationResultV4(inputV4, {
    status: "terminal_executed",
    operation_id: inputV4.plan.operation_id,
    plan_hash: inputV4.plan.plan_hash,
    receipt_id: "receipt-v4",
    authority: "must-not-cross-boundary",
  }), /unexpected fields/u);
});
