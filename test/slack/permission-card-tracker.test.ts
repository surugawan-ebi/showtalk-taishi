import assert from "node:assert/strict";
import test from "node:test";

import { PermissionApprovalCardTracker } from "../../src/slack/permission-card-tracker.js";

const route = {
  channelId: "C0123456789",
  rootThreadTs: "1786654845.402859",
  messageTs: "1786654846.000100",
  operation: "gateway.restart",
};
const settlement = {
  requestId: "permission:one",
  reason: "expired" as const,
};

test("retains an early settlement until its terminal Slack update succeeds", async () => {
  const tracker = new PermissionApprovalCardTracker();
  await tracker.rememberSettlement(settlement);
  await tracker.rememberRoute(settlement.requestId, route);
  let attempts = 0;

  await assert.rejects(
    tracker.apply(settlement.requestId, async () => {
      attempts += 1;
      throw new Error("Slack unavailable");
    }),
  );
  assert.deepEqual(tracker.routeFor(settlement.requestId), route);
  assert.deepEqual(tracker.settlementFor(settlement.requestId), settlement);

  assert.equal(
    await tracker.apply(settlement.requestId, async (actualRoute, actualSettlement) => {
      attempts += 1;
      assert.deepEqual(actualRoute, route);
      assert.deepEqual(actualSettlement, settlement);
    }),
    true,
  );
  assert.equal(attempts, 2);
  assert.equal(tracker.routeFor(settlement.requestId), undefined);
  assert.equal(tracker.settlementFor(settlement.requestId), undefined);
});

test("discards an early settlement only when posting produced no route", async () => {
  const tracker = new PermissionApprovalCardTracker();
  await tracker.rememberSettlement(settlement);
  await tracker.discardUnroutedSettlement(settlement.requestId);
  assert.equal(tracker.settlementFor(settlement.requestId), undefined);
});

test("durably closes an unsettled card after a worker replacement", async () => {
  const snapshots: unknown[] = [];
  const tracker = new PermissionApprovalCardTracker({
    initialCards: [{ requestId: settlement.requestId, route }],
    persist: async (cards) => {
      snapshots.push(structuredClone(cards));
    },
  });

  await tracker.closeUnsettled();
  assert.equal(
    tracker.settlementFor(settlement.requestId)?.reason,
    "coordinator_closed",
  );
  assert.equal(snapshots.length, 1);

  await tracker.apply(settlement.requestId, async (_route, actualSettlement) => {
    assert.equal(actualSettlement.reason, "coordinator_closed");
  });
  assert.deepEqual(snapshots.at(-1), []);
});

test("single-flights concurrent terminal updates for one card", async () => {
  const tracker = new PermissionApprovalCardTracker();
  await tracker.rememberRoute(settlement.requestId, route);
  await tracker.rememberSettlement(settlement);
  let updates = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = async () => {
    updates += 1;
    await blocked;
  };

  const first = tracker.apply(settlement.requestId, update);
  const second = tracker.apply(settlement.requestId, update);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(updates, 1);
});

test("rolls back tracker mutations when outbox persistence fails", async () => {
  const tracker = new PermissionApprovalCardTracker({
    persist: async () => Promise.reject(new Error("state unavailable")),
  });
  await assert.rejects(
    tracker.rememberRoute(settlement.requestId, route),
    /state unavailable/u,
  );
  assert.equal(tracker.routeFor(settlement.requestId), undefined);
});

test("serializes a failed outbox save before preserving the next card", async () => {
  let persistenceCalls = 0;
  let enterFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enterFirst = resolve;
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let persisted: readonly unknown[] = [];
  const tracker = new PermissionApprovalCardTracker({
    persist: async (cards) => {
      persistenceCalls += 1;
      if (persistenceCalls === 1) {
        enterFirst();
        await firstBlocked;
        throw new Error("first save failed");
      }
      persisted = structuredClone(cards);
    },
  });
  const secondRoute = {
    ...route,
    messageTs: "1786654846.000200",
  };

  const first = tracker.rememberRoute("permission:first", route);
  await firstEntered;
  const second = tracker.rememberRoute("permission:second", secondRoute);
  releaseFirst();
  await assert.rejects(first, /first save failed/u);
  await second;

  assert.equal(tracker.routeFor("permission:first"), undefined);
  assert.deepEqual(tracker.routeFor("permission:second"), secondRoute);
  assert.deepEqual(persisted, [{
    requestId: "permission:second",
    route: secondRoute,
  }]);
});
