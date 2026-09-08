import assert from "node:assert/strict";
import test from "node:test";

import {
  GatewayRestartReplayGuard,
  type RecentGatewayRestartReceipt,
} from "../../src/state/gateway-restart-replay-guard.js";

const firstKey = "a".repeat(64);
const secondKey = "b".repeat(64);
const instanceId = "11111111-1111-4111-8111-111111111111";

test("persists a bounded restart receipt before reporting it present", async () => {
  let persisted: readonly RecentGatewayRestartReceipt[] = [];
  const guard = new GatewayRestartReplayGuard({
    now: () => new Date("2026-08-31T00:00:00.000Z"),
    persist: async (receipts) => {
      persisted = structuredClone(receipts);
    },
  });

  assert.equal(guard.has(firstKey), false);
  await guard.record(firstKey, instanceId);
  assert.equal(guard.has(firstKey), true);
  assert.deepEqual(persisted, [{
    keyHash: firstKey,
    originInstanceId: instanceId,
    expiresAt: "2026-08-31T00:10:00.000Z",
  }]);
});

test("rolls back an in-memory receipt when durable persistence fails", async () => {
  const guard = new GatewayRestartReplayGuard({
    persist: async () => Promise.reject(new Error("state unavailable")),
  });

  await assert.rejects(guard.record(firstKey, instanceId), /state unavailable/u);
  assert.equal(guard.has(firstKey), false);
});

test("prunes expired receipts and retains distinct live request hashes", async () => {
  let now = new Date("2026-08-31T00:00:00.000Z");
  const guard = new GatewayRestartReplayGuard({
    now: () => now,
    ttlMs: 1_000,
    persist: async () => undefined,
  });

  await guard.record(firstKey, instanceId);
  assert.equal(guard.has(secondKey), false);
  now = new Date("2026-08-31T00:00:01.001Z");
  assert.equal(guard.has(firstKey), false);
  assert.deepEqual(guard.list(), []);
});

test("serializes a failed receipt save before preserving the next receipt", async () => {
  let persistenceCalls = 0;
  let enterFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let persisted: readonly RecentGatewayRestartReceipt[] = [];
  const guard = new GatewayRestartReplayGuard({
    persist: async (receipts) => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        enterFirst();
        await firstBlocked;
        throw new Error("first save failed");
      }
      persisted = structuredClone(receipts);
    },
  });

  const first = guard.record(firstKey, instanceId);
  await firstEntered;
  const second = guard.record(secondKey, instanceId);
  releaseFirst();
  await assert.rejects(first, /first save failed/u);
  await second;

  assert.equal(guard.has(firstKey), false);
  assert.equal(guard.has(secondKey), true);
  assert.deepEqual(persisted.map((receipt) => receipt.keyHash), [secondKey]);
});

test("consumes a replacement-worker replay receipt after one acknowledgement", async () => {
  let persisted: readonly RecentGatewayRestartReceipt[] = [];
  const guard = new GatewayRestartReplayGuard({
    persist: async (receipts) => {
      persisted = structuredClone(receipts);
    },
  });
  await guard.record(firstKey, instanceId);
  assert.equal(await guard.consume(firstKey), true);
  assert.equal(await guard.consume(firstKey), false);
  assert.deepEqual(persisted, []);
});
