import assert from "node:assert/strict";
import test from "node:test";

import {
  PermissionApprovalCoordinator,
  type PermissionApprovalPresentation,
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
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "one" });
  coordinator.setPresenter(async (approval) => {
    shown.push(approval);
  });
  const result = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown[0]?.requestId, "permission:one");
  coordinator.resolve("permission:one", "allow_once");
  assert.equal(await result, "allow");
  assert.throws(() => coordinator.resolve("permission:one", "allow_once"));
});

test("routes approval UI to the latest trusted Slack thread and user", async () => {
  let shown: PermissionApprovalPresentation | undefined;
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "thread" });
  coordinator.rememberSlackContext("C1", {
    rootThreadTs: "1786554845.402859",
    slackUserId: "U0123456789",
  });
  coordinator.setPresenter(async (approval) => {
    shown = approval;
  });

  const result = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown?.sourceRootThreadTs, "1786554845.402859");
  assert.equal(shown?.sourceSlackUserId, "U0123456789");
  coordinator.resolve("permission:thread", "deny");
  assert.equal(await result, "deny");
});

test("rejects malformed host-owned Slack routing context", () => {
  const coordinator = new PermissionApprovalCoordinator();
  assert.throws(
    () => coordinator.rememberSlackContext("C1", { rootThreadTs: "not-a-ts" }),
    /timestamp/u,
  );
  assert.throws(
    () =>
      coordinator.rememberSlackContext("C1", {
        rootThreadTs: "1786554845.402859",
        slackUserId: "<!channel>",
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
  coordinator.resolve(presentation?.requestId ?? "", "allow_session");
  assert.equal(await first, "allow");
  assert.equal(await coordinator.authorize("approval", request), "allow");

  const other = coordinator.authorize("approval", {
    ...request,
    grantKey: "agent.send:implementer:security",
  });
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.resolve("permission:grant", "deny");
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
  assert.throws(
    () => coordinator.resolve("permission:restart", "allow_session"),
    /Session approval is not allowed/u,
  );
  coordinator.resolve("permission:restart", "allow_once");
  assert.equal(await pending, "allow");
});

test("fails closed on expiry and shutdown", async () => {
  const coordinator = new PermissionApprovalCoordinator({ timeoutMs: 5 });
  coordinator.setPresenter(async () => undefined);
  assert.equal(await coordinator.authorize("approval", request), "deny");

  const pending = coordinator.authorize("approval", request);
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.close();
  assert.equal(await pending, "deny");
});

test("removes a pending approval when its caller cancels", async () => {
  const coordinator = new PermissionApprovalCoordinator({ idFactory: () => "cancel" });
  const controller = new AbortController();
  coordinator.setPresenter(async () => undefined);
  const pending = coordinator.authorize("approval", request, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, "deny");
  assert.throws(() => coordinator.resolve("permission:cancel", "allow_once"));
});
