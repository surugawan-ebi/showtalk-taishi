import assert from "node:assert/strict";
import test from "node:test";

import type { PendingWorkspaceGitSystemRejection } from "../../src/core/index.js";
import { WorkspaceGitSystemRejectionCoordinator } from "../../src/approvals/workspace-git-system-rejection-coordinator.js";

const plan = {
  operationId: "11111111-1111-4111-8111-111111111111",
  planHash: "a".repeat(64),
  approvalTarget: "primary",
  repoId: "showtalk-taishi",
  expiresAt: "2099-08-26T20:00:00.000Z",
};

test("persists a system rejection before tolerating a transient broker failure", async () => {
  const scheduled: Array<() => void> = [];
  const persisted: PendingWorkspaceGitSystemRejection[][] = [];
  let brokerCalls = 0;
  const coordinator = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        brokerCalls += 1;
        if (brokerCalls === 1) throw new Error("temporary broker failure");
      },
    },
    persist: async (records) => {
      persisted.push(structuredClone([...records]));
    },
    schedule: (task) => {
      scheduled.push(task);
      return () => {
        const index = scheduled.indexOf(task);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
  });

  await coordinator.recordRejection(
    plan,
    "showtalk:slack-projection-failure",
  );
  assert.equal(brokerCalls, 1);
  assert.equal(coordinator.listPending().length, 1);
  assert.equal(persisted[0]?.[0]?.operationId, plan.operationId);

  scheduled.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(brokerCalls, 2);
  assert.deepEqual(coordinator.listPending(), []);
  assert.deepEqual(persisted.at(-1), []);
  await coordinator.close();
});

test("resumes a persisted rejection after restart", async () => {
  let durable: PendingWorkspaceGitSystemRejection[] = [];
  const first = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => Promise.reject(new Error("offline")),
    },
    persist: async (records) => {
      durable = structuredClone([...records]);
    },
    schedule: () => () => undefined,
  });
  await first.recordRejection(
    plan,
    "showtalk:external-app-server-resolution",
  );
  assert.equal(durable.length, 1);
  await first.close();

  const scheduled: Array<() => void> = [];
  let resumedCalls = 0;
  const resumed = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        resumedCalls += 1;
      },
    },
    initialRecords: durable,
    persist: async (records) => {
      durable = structuredClone([...records]);
    },
    schedule: (task) => {
      scheduled.push(task);
      return () => undefined;
    },
  });
  resumed.start();
  scheduled.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resumedCalls, 1);
  assert.deepEqual(durable, []);
  await resumed.close();
});

test("does not release a rejection intent when durable persistence fails", async () => {
  let brokerCalled = false;
  const coordinator = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        brokerCalled = true;
      },
    },
    persist: async () => Promise.reject(new Error("state write failed")),
  });

  await assert.rejects(
    coordinator.recordRejection(
      plan,
      "showtalk:slack-projection-failure",
    ),
    /state write failed/u,
  );
  assert.equal(brokerCalled, false);
  assert.deepEqual(coordinator.listPending(), []);
  await coordinator.close();
});

test("rejects a malformed plan before it can enter durable state", async () => {
  let persisted = false;
  let brokerCalled = false;
  const coordinator = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        brokerCalled = true;
      },
    },
    persist: async () => {
      persisted = true;
    },
  });

  await assert.rejects(
    coordinator.recordRejection(
      { ...plan, expiresAt: "not-a-date" },
      "showtalk:slack-projection-failure",
    ),
    /expiry is invalid/u,
  );
  assert.equal(persisted, false);
  assert.equal(brokerCalled, false);
  await coordinator.close();
});

test("serializes duplicate arrivals behind the durable write-ahead boundary", async () => {
  let releasePersist: (() => void) | undefined;
  const firstPersist = new Promise<void>((resolve) => {
    releasePersist = resolve;
  });
  let persistCalls = 0;
  let brokerCalls = 0;
  const coordinator = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        brokerCalls += 1;
      },
    },
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 1) await firstPersist;
    },
  });

  const first = coordinator.recordRejection(
    plan,
    "showtalk:slack-projection-failure",
  );
  const duplicate = coordinator.recordRejection(
    plan,
    "showtalk:slack-projection-failure",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(brokerCalls, 0);

  releasePersist?.();
  await Promise.all([first, duplicate]);
  assert.equal(brokerCalls, 1);
  assert.deepEqual(coordinator.listPending(), []);
  await coordinator.close();
});

test("coalesces two system reasons for the same exact rejection plan", async () => {
  let brokerCalls = 0;
  let releaseBroker: (() => void) | undefined;
  const brokerBlocked = new Promise<void>((resolve) => {
    releaseBroker = resolve;
  });
  const coordinator = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        brokerCalls += 1;
        await brokerBlocked;
      },
    },
    persist: async () => undefined,
  });

  const projectionFailure = coordinator.recordRejection(
    plan,
    "showtalk:slack-projection-failure",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const externalResolution = coordinator.recordRejection(
    plan,
    "showtalk:external-app-server-resolution",
  );
  releaseBroker?.();

  await Promise.all([projectionFailure, externalResolution]);
  assert.equal(brokerCalls, 1);
  assert.deepEqual(coordinator.listPending(), []);
  await coordinator.close();
});

test("retains a completed rejection until removal persistence can retry", async () => {
  const scheduled: Array<() => void> = [];
  let persistCalls = 0;
  let brokerCalls = 0;
  const coordinator = new WorkspaceGitSystemRejectionCoordinator({
    broker: {
      recordDecision: async () => {
        brokerCalls += 1;
      },
    },
    persist: async () => {
      persistCalls += 1;
      if (persistCalls === 2) throw new Error("temporary removal write failure");
    },
    schedule: (task) => {
      scheduled.push(task);
      return () => {
        const index = scheduled.indexOf(task);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
  });

  await coordinator.recordRejection(
    plan,
    "showtalk:slack-projection-failure",
  );
  assert.equal(brokerCalls, 1);
  assert.equal(coordinator.listPending().length, 1);

  scheduled.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(brokerCalls, 2);
  assert.deepEqual(coordinator.listPending(), []);
  await coordinator.close();
});
