import assert from "node:assert/strict";
import test from "node:test";

import {
  PermissionApprovalCoordinator,
  type PermissionApprovalPresentation,
  type PermissionApprovalSettlement,
} from "../../src/permissions/approval-coordinator.js";

const request = {
  sourceAgentId: "implementer",
  sourceChannelId: "C1",
  operation: "agent.send",
  summary: "Send a review request to reviewer",
  grantKey: "agent.send:implementer:reviewer",
} as const;

test("allows and denies configured non-interactive policy immediately", async () => {
  const coordinator = new PermissionApprovalCoordinator();
  assert.equal(await coordinator.authorize("allow", request), "allow");
  assert.equal(await coordinator.authorize("deny", request), "deny");
});

test("binds a single-use approval to a host-generated request id", async () => {
  const shown: PermissionApprovalPresentation[] = [];
  const settled: PermissionApprovalSettlement[] = [];
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "one" });
  coordinator.setPresenter(async (approval) => {
    shown.push(approval);
  });
  coordinator.setSettlementPresenter(async (settlement) => {
    settled.push(settlement);
  });
  const result = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown[0]?.requestId, "permission:one");
  await coordinator.resolve("permission:one", "allow_once", {
    resolvedBySlackUserId: "U0123456789",
  });
  assert.equal(await result, "allow");
  assert.deepEqual(settled, [
    {
      requestId: "permission:one",
      reason: "allow_once",
      resolvedBySlackUserId: "U0123456789",
    },
  ]);
  await assert.rejects(coordinator.resolve("permission:one", "allow_once"));
});

test("routes approval UI to the exact trusted Slack turn on the request", async () => {
  let shown: PermissionApprovalPresentation | undefined;
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "thread" });
  coordinator.setPresenter(async (approval) => {
    shown = approval;
  });

  const result = coordinator.authorize("approval", {
    ...request,
    slackContext: {
      rootThreadTs: "1786554845.402859",
      slackUserId: "U0123456789",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown?.sourceRootThreadTs, "1786554845.402859");
  assert.equal(shown?.sourceSlackUserId, "U0123456789");
  await coordinator.resolve("permission:thread", "deny");
  assert.equal(await result, "deny");
});

test("rejects malformed host-owned Slack routing context", async () => {
  const coordinator = new PermissionApprovalCoordinator();
  coordinator.setPresenter(async () => undefined);
  await assert.rejects(
    coordinator.authorize("approval", {
      ...request,
      slackContext: { rootThreadTs: "not-a-ts" },
    }),
    /timestamp/u,
  );
  await assert.rejects(
    coordinator.authorize("approval", {
      ...request,
      slackContext: {
        rootThreadTs: "1786554845.402859",
        slackUserId: "<!channel>",
      },
    }),
    /user ID/u,
  );
});

test("keeps allow-session grants in memory only for their exact scope", async () => {
  let presentation: PermissionApprovalPresentation | undefined;
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "grant" });
  coordinator.setPresenter(async (approval) => {
    presentation = approval;
  });
  const first = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.resolve(presentation?.requestId ?? "", "allow_session");
  assert.equal(await first, "allow");
  assert.equal(await coordinator.authorize("approval", request), "allow");

  const other = coordinator.authorize("approval", {
    ...request,
    grantKey: "agent.send:implementer:security",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.resolve("permission:grant", "deny");
  assert.equal(await other, "deny");
});

test("rejects session grants for operations that require fresh approval", async () => {
  let presentation: PermissionApprovalPresentation | undefined;
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "restart" });
  coordinator.setPresenter(async (approval) => {
    presentation = approval;
  });
  const pending = coordinator.authorize("approval", {
    ...request,
    operation: "gateway.restart",
    grantKey: "gateway.restart:implementer",
    allowSessionGrant: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(presentation?.allowSessionGrant, false);
  await assert.rejects(
    coordinator.resolve("permission:restart", "allow_session"),
    /Session approval is not allowed/u,
  );
  await coordinator.resolve("permission:restart", "allow_once");
  assert.equal(await pending, "allow");
});

test("fails closed on expiry and shutdown", async () => {
  const settlements: PermissionApprovalSettlement[] = [];
  const coordinator = new PermissionApprovalCoordinator({ timeoutMs: 5 });
  coordinator.setPresenter(async () => undefined);
  coordinator.setSettlementPresenter(async (settlement) => {
    settlements.push(settlement);
  });
  assert.equal(await coordinator.authorize("approval", request), "deny");
  assert.equal(settlements[0]?.reason, "expired");

  const pending = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  await coordinator.close();
  assert.equal(await pending, "deny");
  assert.equal(settlements[1]?.reason, "coordinator_closed");
});

test("removes a pending approval when its caller cancels", async () => {
  let settlement: PermissionApprovalSettlement | undefined;
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "cancel" });
  const controller = new AbortController();
  coordinator.setPresenter(async () => undefined);
  coordinator.setSettlementPresenter(async (value) => {
    settlement = value;
  });
  const pending = coordinator.authorize("approval", request, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, "deny");
  assert.equal(settlement?.reason, "caller_cancelled");
  await assert.rejects(coordinator.resolve("permission:cancel", "allow_once"));
});

test("does not release an allowed operation before terminal presentation completes", async () => {
  const coordinator = new PermissionApprovalCoordinator({
    idFactory: () => "barrier",
  });
  coordinator.setPresenter(async () => undefined);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  coordinator.setSettlementPresenter(async () => blocked);

  let authorized = false;
  const pending = coordinator.authorize("approval", request).then((result) => {
    authorized = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const resolving = coordinator.resolve("permission:barrier", "allow_once");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorized, false);

  release();
  await resolving;
  assert.equal(await pending, "allow");
});

test("fails closed without creating a session grant when settlement cannot finalize", async () => {
  const coordinator = new PermissionApprovalCoordinator({
    idFactory: () => "failed-settlement",
  });
  coordinator.setPresenter(async () => undefined);
  coordinator.setSettlementPresenter(async () => {
    throw new Error("outbox unavailable");
  });

  const pending = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    coordinator.resolve("permission:failed-settlement", "allow_session"),
    /safely finalized/u,
  );
  assert.equal(await pending, "deny");

  let shownAgain = false;
  coordinator.setPresenter(async () => {
    shownAgain = true;
  });
  const retry = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shownAgain, true);
  await coordinator.close();
  assert.equal(await retry, "deny");
});

test("does not expose a session grant while its terminal presenter is pending", async () => {
  let sequence = 0;
  const shown: string[] = [];
  const coordinator = new PermissionApprovalCoordinator({
    idFactory: () => `session-barrier-${++sequence}`,
  });
  coordinator.setPresenter(async (approval) => {
    shown.push(approval.requestId);
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let settlements = 0;
  coordinator.setSettlementPresenter(async () => {
    settlements += 1;
    if (settlements === 1) await firstBlocked;
  });

  const first = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  const resolvingFirst = coordinator.resolve(
    "permission:session-barrier-1",
    "allow_session",
  );
  await new Promise((resolve) => setImmediate(resolve));

  const second = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shown, [
    "permission:session-barrier-1",
    "permission:session-barrier-2",
  ]);

  releaseFirst();
  await resolvingFirst;
  assert.equal(await first, "allow");
  await coordinator.resolve("permission:session-barrier-2", "deny");
  assert.equal(await second, "deny");
  assert.equal(await coordinator.authorize("approval", request), "allow");
});
