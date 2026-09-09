import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  emptyRuntimeState,
  FileStateStore,
} from "../../src/state/file-state-store.js";

const execFileAsync = promisify(execFile);

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for path: ${path}`);
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function releaseFifoReader(path: string, contents: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
    await handle.writeFile(contents, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENXIO") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

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

test("recovers an ordinary stale state lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-stale-lock-"));
  const path = join(directory, "state.json");
  const lockPath = `${path}.lock`;
  await writeFile(
    lockPath,
    `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "11111111-1111-4111-8111-111111111111",
    })}\n`,
    { mode: 0o600 },
  );

  const store = new FileStateStore(path);
  await store.acquireLock();
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
  assert.equal(lock.pid, process.pid);
  await store.releaseLock();
});

test("serializes concurrent stale-lock recovery so only one store wins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-stale-race-"));
  const path = join(directory, "state.json");
  await writeFile(
    `${path}.lock`,
    `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "22222222-2222-4222-8222-222222222222",
    })}\n`,
    { mode: 0o600 },
  );
  const stores = [new FileStateStore(path), new FileStateStore(path)];

  const outcomes = await Promise.allSettled(stores.map((store) => store.acquireLock()));
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal((await stat(`${path}.lock`)).isFile(), true);

  const winner = outcomes.findIndex(({ status }) => status === "fulfilled");
  await stores[winner]?.releaseLock();
});

test(
  "blocks a second recovery while the first process is reading the stale lock",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "taishi-state-stale-barrier-"));
    const path = join(directory, "state.json");
    const lockPath = `${path}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    await execFileAsync("mkfifo", [lockPath]);
    const second = new FileStateStore(path);
    const worker = fileURLToPath(
      new URL("../fixtures/state-lock-recovery-worker.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["--import", "tsx", worker, path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const acquired = withTimeout(
      new Promise<string>((resolve, reject) => {
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("acquired\n")) resolve(output);
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (!output.includes("acquired\n")) {
            reject(new Error(`State-lock worker exited before acquisition: ${code}`));
          }
        });
      }),
      "State-lock worker did not acquire the lock",
    );
    void acquired.catch(() => undefined);
    const staleRecord = `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "44444444-4444-4444-8444-444444444444",
    })}\n`;
    try {
      await waitForPath(recoveryPath);
      await assert.rejects(
        withTimeout(
          second.acquireLock(),
          "Second state-lock recovery attempt did not fail closed",
        ),
        /lock recovery is already in progress/u,
      );
      await releaseFifoReader(lockPath, staleRecord);
      await acquired;

      const installed = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid: number;
      };
      assert.equal(installed.pid, child.pid);
      await assert.rejects(stat(recoveryPath), /ENOENT/u);
      child.stdin.end("release\n");
      await withTimeout(
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        "State-lock worker did not release the lock",
      );
    } finally {
      await releaseFifoReader(lockPath, staleRecord).catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  },
);

test("an existing recovery guard blocks recovery and preserves the state lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-state-recovery-guard-"));
  const path = join(directory, "state.json");
  const lockPath = `${path}.lock`;
  const lock = `${JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    nonce: "33333333-3333-4333-8333-333333333333",
  })}\n`;
  await writeFile(lockPath, lock, { mode: 0o600 });
  await writeFile(`${lockPath}.recovery`, "manual inspection required\n", {
    mode: 0o600,
  });

  await assert.rejects(
    new FileStateStore(path).acquireLock(),
    /lock recovery is already in progress/u,
  );
  assert.equal(await readFile(lockPath, "utf8"), lock);
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
  await assert.rejects(stat(`${lockPath}.recovery`), /ENOENT/u);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  await assert.rejects(store.acquireLock(), /lock is invalid/u);
  assert.equal((await stat(lockPath)).size, 0);
});
