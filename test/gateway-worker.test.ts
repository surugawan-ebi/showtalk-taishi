import assert from "node:assert/strict";
import test from "node:test";

import {
  createGatewayStopController,
  finishGatewayRestart,
  runGatewayWorkerLifecycle,
  waitForGatewayDrain,
  workspaceGitRuntimeOptionsFromComposition,
} from "../src/gateway-worker.js";
import { GATEWAY_RESTART_EXIT_CODE } from "../src/supervisor.js";
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

test("restart drain finishes when accepted work becomes idle", async () => {
  let release!: () => void;
  const idle = new Promise<void>((resolve) => { release = resolve; });
  const draining = waitForGatewayDrain(
    () => idle,
    new Promise<void>(() => undefined),
    1_000,
  );
  release();
  assert.equal(await draining, "idle");
});

test("restart drain reports a timeout checkpoint while work remains active", async () => {
  const pending = new Promise<void>(() => undefined);
  assert.equal(
    await waitForGatewayDrain(() => pending, pending, 20),
    "timeout",
  );
});

test("a pre-resolved stop request wins when restart drain is already idle", async () => {
  assert.equal(
    await waitForGatewayDrain(
      async () => undefined,
      Promise.resolve(),
      1_000,
    ),
    "stop",
  );
});

test("restart keeps waiting while accepted work is active", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  const pending = new Promise<void>(() => undefined);
  let sawWarning!: () => void;
  const warned = new Promise<void>((resolve) => { sawWarning = resolve; });
  let stops = 0;
  const warnings: string[] = [];
  const finishing = finishGatewayRestart(
    {
      waitForIdle: () => idle,
      idleComponents: () => ({ gateway: false, slack: true, mcpService: true, mcpServer: true }),
    },
    async () => { stops += 1; },
    pending,
    { timeoutMs: 20, progressIntervalMs: 1_000, log: () => undefined, warn: (line) => { warnings.push(line); sawWarning(); } },
  );
  await warned;
  assert.equal(stops, 0);
  releaseIdle();
  const exitCode = await finishing;
  assert.equal(stops, 1);
  assert.equal(exitCode, GATEWAY_RESTART_EXIT_CODE);
  assert.match(warnings[0] ?? "", /"gateway":false/u);
});

test("restart recovers a missed idle wakeup only when every component is idle", async () => {
  const pending = new Promise<void>(() => undefined);
  let stops = 0;
  const exitCode = await finishGatewayRestart(
    {
      waitForIdle: () => pending,
      idleComponents: () => ({ gateway: true, slack: true, mcpService: true, mcpServer: true }),
    },
    async () => { stops += 1; },
    pending,
    { timeoutMs: 20, progressIntervalMs: 1_000, log: () => undefined, warn: () => undefined },
  );
  assert.equal(stops, 1);
  assert.equal(exitCode, GATEWAY_RESTART_EXIT_CODE);
});

test("restart shutdown failure cannot request worker replacement", async () => {
  const pending = new Promise<void>(() => undefined);
  await assert.rejects(
    finishGatewayRestart(
      {
        waitForIdle: async () => undefined,
        idleComponents: () => ({ gateway: true, slack: true, mcpService: true, mcpServer: true }),
      },
      async () => { throw new Error("shutdown failed"); },
      pending,
      { log: () => undefined, warn: () => undefined },
    ),
    /shutdown failed/u,
  );
});

test("stop request exits cleanly after the runtime reaches idle", async () => {
  let beginRestartCalls = 0;
  const controller = createGatewayStopController(() => { beginRestartCalls += 1; });
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  let stops = 0;
  const exiting = finishGatewayRestart(
    {
      waitForIdle: () => idle,
      idleComponents: () => ({ gateway: false, slack: true, mcpService: true, mcpServer: true }),
    },
    async () => { stops += 1; },
    controller.stopRequested,
    { timeoutMs: 1_000, log: () => undefined, warn: () => undefined },
  );
  controller.requestStop();
  await Promise.resolve();
  assert.equal(stops, 0);
  releaseIdle();
  assert.equal(await exiting, 0);
  assert.equal(beginRestartCalls, 1);
  assert.equal(stops, 1);
});

test("stop request closes admission synchronously and duplicate signals are idempotent", async () => {
  let accepting = true;
  let accepted = 0;
  let admissionClosed = false;
  const controller = createGatewayStopController(() => {
    accepting = false;
    admissionClosed = true;
  });
  const acceptWork = () => {
    if (!accepting) return false;
    accepted += 1;
    return true;
  };

  assert.equal(acceptWork(), true);
  controller.requestStop();
  assert.equal(admissionClosed, true);
  assert.equal(acceptWork(), false);
  controller.requestStop();
  assert.equal(accepted, 1);
});

test("stop during restart drain waits for accepted work and timeouts never force shutdown", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  let beginRestartCalls = 0;
  let stops = 0;
  let sawTimeout!: () => void;
  const timedOut = new Promise<void>((resolve) => { sawTimeout = resolve; });
  const controller = createGatewayStopController(() => { beginRestartCalls += 1; });
  const finishing = finishGatewayRestart(
    {
      waitForIdle: () => idle,
      idleComponents: () => ({ gateway: false, slack: true, mcpService: true, mcpServer: true }),
    },
    async () => { stops += 1; },
    controller.stopRequested,
    {
      timeoutMs: 20,
      progressIntervalMs: 1_000,
      log: () => undefined,
      warn: () => sawTimeout(),
    },
  );
  controller.requestStop();
  await timedOut;
  assert.equal(stops, 0);
  assert.equal(beginRestartCalls, 1);
  releaseIdle();
  assert.equal(await finishing, 0);
  assert.equal(stops, 1);
});

test("worker lifecycle awaits the drain before its finally cleanup stops the runtime", async () => {
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  let beginRestartCalls = 0;
  let runtimeStopped = false;
  let compositionStopped = false;
  const controller = createGatewayStopController(() => { beginRestartCalls += 1; });
  const previousLog = console.log;
  console.log = () => undefined;
  try {
    const lifecycle = runGatewayWorkerLifecycle(
      {
        beginRestart: () => { beginRestartCalls += 1; },
        waitForIdle: () => idle,
        idleComponents: () => ({ gateway: false, slack: true, mcpService: true, mcpServer: true }),
      },
      async () => undefined,
      async () => undefined,
      async () => { runtimeStopped = true; },
      async () => { compositionStopped = true; },
      controller.stopRequested,
      new Promise<void>(() => undefined),
    );
    controller.requestStop();
    await Promise.resolve();
    assert.equal(runtimeStopped, false);
    assert.equal(compositionStopped, false);
    assert.equal(beginRestartCalls, 1);
    releaseIdle();
    assert.equal(await lifecycle, 0);
    assert.equal(runtimeStopped, true);
    assert.equal(compositionStopped, true);
  } finally {
    console.log = previousLog;
  }
});

test("stop during composition cleanup overrides restart after cleanup completes", async () => {
  let releaseComposition!: () => void;
  const compositionRelease = new Promise<void>((resolve) => { releaseComposition = resolve; });
  let compositionStarted!: () => void;
  const compositionStart = new Promise<void>((resolve) => { compositionStarted = resolve; });
  let handlersAttached = true;
  let runtimeStopCalls = 0;
  let runtimeStopped = false;
  const controller = createGatewayStopController(() => undefined);
  const previousLog = console.log;
  console.log = () => undefined;
  try {
    const lifecycle = runGatewayWorkerLifecycle(
      {
        beginRestart: () => undefined,
        waitForIdle: async () => undefined,
        idleComponents: () => ({ gateway: true, slack: true, mcpService: true, mcpServer: true }),
      },
      async () => undefined,
      async () => undefined,
      async () => {
        if (runtimeStopped) return;
        runtimeStopped = true;
        runtimeStopCalls += 1;
      },
      async () => { compositionStarted(); await compositionRelease; },
      controller.stopRequested,
      Promise.resolve(),
      () => { handlersAttached = false; },
    );

    await compositionStart;
    controller.requestStop();
    assert.equal(handlersAttached, true);
    releaseComposition();
    assert.equal(await lifecycle, 0);
    assert.equal(handlersAttached, false);
    assert.equal(runtimeStopCalls, 1);
  } finally {
    console.log = previousLog;
  }
});

test("stop arriving during shutdown overrides a clean restart exit code", async () => {
  let releaseShutdown!: () => void;
  let shutdownStarted!: () => void;
  const shutdown = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const started = new Promise<void>((resolve) => { shutdownStarted = resolve; });
  const controller = createGatewayStopController(() => undefined);
  const finishing = finishGatewayRestart(
    {
      waitForIdle: async () => undefined,
      idleComponents: () => ({ gateway: true, slack: true, mcpService: true, mcpServer: true }),
    },
    async () => { shutdownStarted(); await shutdown; },
    controller.stopRequested,
    { log: () => undefined, warn: () => undefined },
  );
  await started;
  controller.requestStop();
  releaseShutdown();
  assert.equal(await finishing, 0);
});

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
