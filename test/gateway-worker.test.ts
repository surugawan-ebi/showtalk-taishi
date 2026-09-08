import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceGitRuntimeOptionsFromComposition,
} from "../src/gateway-worker.js";
import type { WorkspaceGitApprovalPlan } from "../src/core/index.js";
import type { WorkspaceGitAutomationProviderFactoryV4 } from "../src/approvals/workspace-git-automation-provider.js";
import type { WorkspaceGitAutonomyControlBrokerFactoryV4 } from "../src/approvals/workspace-git-autonomy-control.js";

const plan = {
  operationId: "22222222-2222-4222-8222-222222222222",
  planHash: "b".repeat(64),
  approvalTarget: "primary",
  approvalScope: {
    kind: "git_publication",
    repo_id: "fixture",
    mode: "commit_only",
    branch: "codex/private-host",
    worktree_id: "primary",
    expected_head: "3".repeat(40),
    expected_snapshot_id: "d".repeat(64),
    paths: ["README.md"],
    commit_message: "private host",
  },
  operation: "git_publication",
  repoId: "fixture",
  mode: "commit_only",
  branch: "codex/private-host",
  paths: ["README.md"],
  expectedHead: "3".repeat(40),
  expectedSnapshotId: "d".repeat(64),
  worktreeId: "primary",
  commitMessage: "private host",
  expiresAt: "2099-01-01T00:00:00.000Z",
} satisfies WorkspaceGitApprovalPlan;

test("adapts the manual human-decision composition without exposing authority", async () => {
  const recorded: unknown[] = [];
  const options = workspaceGitRuntimeOptionsFromComposition({
    contract_version: 1,
    human_decision_broker_factory: {
      contract_version: 1,
      create: () => ({
        contract_version: 1,
        recordDecision: async (input) => {
          recorded.push(input);
          return {
            version: 1,
            status: "approved",
            disposition: "transitioned",
          };
        },
      }),
    },
  });

  const broker = await options.workspaceGitHumanDecisionBrokerFactory?.create();
  await broker?.recordDecision({
    decision: "approve",
    plan,
    deliveryId: "c".repeat(64),
    context: {
      callerId: "caller",
      koeId: "implementer",
      channelId: "channel",
      rootThreadTs: "root",
      sessionId: "session",
    },
  });

  assert.equal(recorded.length, 1);
  const payload = recorded[0] as Record<string, unknown>;
  assert.equal(payload.version, 1);
  assert.equal(payload.koe_id, "implementer");
  assert.equal("approval_authority_id" in payload, false);
  assert.equal("signature" in payload, false);
  assert.equal("key_id" in payload, false);
});

test("rejects ambiguous or unsupported private composition contracts", () => {
  assert.throws(
    () => workspaceGitRuntimeOptionsFromComposition({
      contract_version: 2 as 1,
    }),
    /Unsupported workspace-git private composition contract/u,
  );
  assert.throws(
    () => workspaceGitRuntimeOptionsFromComposition({
      workspaceGitAutomationProviderFactory: {
        contract_version: 1,
        create: () => undefined,
      },
    }),
    /automation is retired/u,
  );
});

test("rejects all v4 automation compositions after returning to manual", () => {
  const providerFactory: WorkspaceGitAutomationProviderFactoryV4 = {
    contract_version: 4,
    create: () => ({
      contract_version: 4,
      id: "local-mcp-v4",
      executePreparedPlan: async (input) => ({
        status: "manual",
        operation_id: input.plan.operation_id,
        plan_hash: input.plan.plan_hash,
        reason: "human_approval_required",
      }),
    }),
  };
  const controlFactory: WorkspaceGitAutonomyControlBrokerFactoryV4 = {
    contract_version: 4,
    create: () => ({
      contract_version: 4,
      enable: async () => ({
        version: 4,
        activation_handle: "11111111-1111-4111-8111-111111111111",
        expires_at: "2099-01-01T00:00:00.000Z",
        disposition: "created",
      }),
      disable: async (input) => ({
        version: 4,
        activation_handle: input.activation_handle,
        status: "disabled",
      }),
    }),
  };
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    contract_version: 4,
    automation_provider_factory: providerFactory,
    autonomy_control_broker_factory: controlFactory,
  }), /automation is retired/u);
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    contract_version: 4,
    automation_provider_factory: providerFactory,
  }), /automation is retired/u);
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    contract_version: 4,
    autonomy_control_broker_factory: controlFactory,
  }), /automation is retired/u);
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    contract_version: 1,
    automation_provider_factory: providerFactory,
  }), /automation is retired/u);
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    automation_provider_factory: providerFactory,
  }), /automation is retired/u);
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    contract_version: 1,
    automation_provider_factory: providerFactory,
    autonomy_control_broker_factory: controlFactory,
  }), /automation is retired/u);
  assert.throws(() => workspaceGitRuntimeOptionsFromComposition({
    automation_provider_factory: providerFactory,
    autonomy_control_broker_factory: controlFactory,
  }), /automation is retired/u);
});
