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
  tracker.rememberSettlement(settlement);
  tracker.rememberRoute(settlement.requestId, route);
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

test("discards an early settlement only when posting produced no route", () => {
  const tracker = new PermissionApprovalCardTracker();
  tracker.rememberSettlement(settlement);
  tracker.discardUnroutedSettlement(settlement.requestId);
  assert.equal(tracker.settlementFor(settlement.requestId), undefined);
});
