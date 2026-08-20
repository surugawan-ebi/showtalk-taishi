import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
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
    core: {
      ...emptyRuntimeState().core,
      agents: [{ id: "implementer", adapter: "codex", channelId: "C123" }],
      handledDelegationResults: ["delegation-result-1"],
      usedContinuationDelegations: ["delegation-continuation-1"],
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
