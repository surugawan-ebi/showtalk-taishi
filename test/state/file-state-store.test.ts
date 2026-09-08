import assert from "node:assert/strict";
import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  emptyRuntimeState,
  FileStateStore,
} from "../../src/state/file-state-store.js";

test("returns empty versioned state before the first write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-"));
  const store = new FileStateStore(join(directory, "nested", "state.json"));
  assert.deepEqual(await store.load(), emptyRuntimeState());
});

test("persists state with owner-only file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-"));
  const path = join(directory, "nested", "state.json");
  const store = new FileStateStore(path);
  const state = {
    ...emptyRuntimeState(),
    recentGatewayRestartReceipts: [{
      keyHash: "d".repeat(64),
      originInstanceId: "11111111-1111-4111-8111-111111111111",
      expiresAt: "2099-08-31T00:10:00.000Z",
    }],
    permissionApprovalCards: [{
      requestId: "permission:durable-card",
      route: {
        channelId: "C123",
        rootThreadTs: "1786654845.402859",
        messageTs: "1786654846.000100",
        operation: "gateway.restart",
      },
      settlement: {
        requestId: "permission:durable-card",
        reason: "allow_once" as const,
        resolvedBySlackUserId: "U123",
      },
    }],
    workspaceGitAutonomyActivations: [{
      koeId: "implementer",
      profileId: "11111111-1111-4111-8111-111111111111",
      profileRevision: 3,
      activationHandle: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-08-31T01:10:00.000Z",
      state: "enabled" as const,
      updatedAt: "2099-08-31T00:10:00.000Z",
    }],
    workspaceGitAutonomyRevisionState: {
      fingerprint: "a".repeat(64),
      revision: 4,
    },
    core: {
      ...emptyRuntimeState().core,
      agents: [{ id: "implementer", adapter: "codex", channelId: "C123" }],
      handledDelegationResults: ["delegation-result-1"],
      usedContinuationDelegations: ["delegation-continuation-1"],
      pendingWorkspaceGitSystemRejections: [{
        operationId: "11111111-1111-4111-8111-111111111111",
        planHash: "a".repeat(64),
        approvalTarget: "primary",
        repoId: "showtalk-taishi",
        expiresAt: "2099-08-26T20:00:00.000Z",
        actor: "showtalk:external-app-server-resolution" as const,
      }],
    },
  };
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("holds an exclusive state lock until the runtime releases it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-lock-"));
  const path = join(directory, "state.json");
  const first = new FileStateStore(path);
  const second = new FileStateStore(path);

  await first.acquireLock();
  await assert.rejects(
    () => second.acquireLock(),
    /Another ShowTalk Taishi process is using state file/,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(`${path}.lock`)).mode & 0o777, 0o600);
  }

  await first.releaseLock();
  await second.acquireLock();
  await second.releaseLock();
});

test("flush reports the latest state write failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-failure-"));
  const store = new FileStateStore(directory);

  await assert.rejects(store.save(emptyRuntimeState()));
  await assert.rejects(store.flush());
});

test("never removes an incomplete lock based only on its age", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-invalid-lock-"));
  const path = join(directory, "state.json");
  const lockPath = `${path}.lock`;
  const store = new FileStateStore(path);
  await writeFile(lockPath, "", { mode: 0o600 });

  await assert.rejects(store.acquireLock(), /lock is invalid/u);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await assert.rejects(store.acquireLock(), /lock is invalid/u);
  assert.equal((await stat(lockPath)).size, 0);
});
