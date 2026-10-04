import assert from "node:assert/strict";
import test from "node:test";

import type { AgentApproval } from "../../src/core/index.js";
import {
  ApprovalTextStore,
  type TextApprovalEntry,
} from "../../src/slack/approval-text-store.js";

const NOW = 1_710_000_000_500;
const EXPIRES = 1_710_000_060_000;
const APPROVER = "U0123456789";
const OTHER_APPROVER = "U9876543210";
const APPROVERS = new Set([APPROVER, OTHER_APPROVER]);
const common = {
  channelId: "C0123456789",
  rootThreadTs: "1710000000.000001",
  messageTs: "1710000000.000002",
  expiresAt: EXPIRES,
};

function entry(kind: TextApprovalEntry["kind"] = "permission"): TextApprovalEntry {
  const prefix = {
    permission: "permission", native: "codex", git: "codex-input", external: "codex-choice",
  }[kind];
  const route = { ...common, requestId: `${prefix}:00000000-0000-4000-8000-000000000001` };
  switch (kind) {
    case "permission": return { ...route, kind };
    case "native": return {
      ...route, kind, sessionId: "session-1", availableDecisions: ["allow_once", "deny"],
    };
    case "git": return { ...route, kind, routing: { ...route, version: 1 } };
    case "external": return {
      ...route,
      kind,
      routing: {
        ...route,
        version: 1,
        questionId: "question_1",
        purpose: "external_action_confirmation",
        responderUserId: APPROVER,
      },
      approveOptionId: "option_1",
      rejectOptionId: "option_2",
    };
  }
}

function command(card: TextApprovalEntry = entry()) {
  return {
    requestId: card.requestId,
    channelId: card.channelId,
    rootThreadTs: card.rootThreadTs,
    userId: APPROVER,
    messageTs: "1710000000.000003",
  };
}

test("retrieves each kind only for its displayed route and an actual approver", () => {
  const store = new ApprovalTextStore(() => NOW);
  for (const kind of ["native", "permission", "git", "external"] as const) {
    const card = entry(kind);
    store.remember(card);
    assert.deepEqual(store.getForCommand(command(card), APPROVERS), card);
  }
});

test("lookup does not consume backend state and explicit settlement forgets the card", () => {
  const store = new ApprovalTextStore(() => NOW);
  const card = entry();
  store.remember(card);
  assert.equal(
    store.getForCommand(command(card), APPROVERS),
    store.getForCommand(command(card), APPROVERS),
  );
  store.forget(card.requestId);
  assert.equal(store.get(card.requestId), undefined);
  assert.throws(() => store.getForCommand(command(card), APPROVERS), /unavailable/u);
  store.forget(card.requestId);
});

test("rejects unknown IDs and never restores entries in a new process-local store", () => {
  const store = new ApprovalTextStore(() => NOW);
  assert.throws(() => store.getForCommand(command(), APPROVERS), /unavailable/u);
  store.remember(entry());
  const restartedStore = new ApprovalTextStore(() => NOW);
  assert.equal(restartedStore.get(entry().requestId), undefined);
  assert.throws(() => restartedStore.getForCommand(command(), APPROVERS), /unavailable/u);
});

test("expires at the exact current-time boundary even for an earlier message event", () => {
  let now = NOW;
  const store = new ApprovalTextStore(() => now);
  store.remember(entry());
  now = EXPIRES - 1;
  assert.equal(store.getForCommand(command(), APPROVERS).requestId, entry().requestId);
  now = EXPIRES;
  assert.equal(store.get(entry().requestId), undefined);
  assert.throws(() => store.getForCommand(command(), APPROVERS), /expired/u);
});

test("rejects an event at or after expiry independent of the injected current time", () => {
  const store = new ApprovalTextStore(() => NOW);
  store.remember(entry());
  assert.doesNotThrow(() => store.getForCommand({
    ...command(), messageTs: "1710000059.999999",
  }, APPROVERS));
  for (const messageTs of ["1710000060.000000", "1710000060.000001"]) {
    assert.throws(() => store.getForCommand({ ...command(), messageTs }, APPROVERS), /expired/u);
  }
});

test("rejects replayed pre-card events and events at the exact card time", () => {
  const store = new ApprovalTextStore(() => NOW);
  store.remember(entry());
  for (const messageTs of [
    "1709999999.999999", common.rootThreadTs, common.messageTs, "1710000000.0000020",
  ]) {
    assert.throws(() => store.getForCommand({ ...command(), messageTs }, APPROVERS), /follow/u);
  }
});

test("compares close timestamps without losing decimal precision", () => {
  const card = { ...entry(), messageTs: "1710000000.12345678901234567890" };
  const store = new ApprovalTextStore(() => NOW);
  store.remember(card);
  assert.throws(() => store.getForCommand({
    ...command(card), messageTs: "1710000000.12345678901234567889",
  }, APPROVERS), /follow/u);
  assert.doesNotThrow(() => store.getForCommand({
    ...command(card), messageTs: "1710000000.12345678901234567891",
  }, APPROVERS));
});

test("rejects cross-channel and cross-thread replies without changing the card", () => {
  const store = new ApprovalTextStore(() => NOW);
  store.remember(entry());
  for (const overrides of [
    { channelId: "C9876543210" },
    { rootThreadTs: "1710000000.000000" },
  ]) {
    assert.throws(() => store.getForCommand({ ...command(), ...overrides }, APPROVERS), /route/u);
  }
  assert.doesNotThrow(() => store.getForCommand(command(), APPROVERS));
});

test("requires the actual author in the current configured approver set", () => {
  const store = new ApprovalTextStore(() => NOW);
  store.remember(entry());
  assert.throws(() => store.getForCommand({
    ...command(), userId: "U5555555555",
  }, APPROVERS), /configured approver/u);
  assert.throws(() => store.getForCommand(command(), new Set()), /configured approver/u);
});

test("external approval additionally requires the original responder", () => {
  const store = new ApprovalTextStore(() => NOW);
  const card = entry("external");
  store.remember(card);
  assert.throws(() => store.getForCommand({
    ...command(card), userId: OTHER_APPROVER,
  }, APPROVERS), /bound responder/u);
  assert.throws(() => store.getForCommand(command(card), new Set([OTHER_APPROVER])), /configured approver/u);
  assert.doesNotThrow(() => store.getForCommand(command(card), APPROVERS));
});

test("external cards without a bound responder still require a configured approver", () => {
  const card = entry("external");
  assert.equal(card.kind, "external");
  if (card.kind !== "external") return;
  const { responderUserId: _responder, ...routing } = card.routing;
  const store = new ApprovalTextStore(() => NOW);
  store.remember({ ...card, routing });
  assert.doesNotThrow(() => store.getForCommand({
    ...command(card), userId: OTHER_APPROVER,
  }, APPROVERS));
});

test("rejects invalid, expired, or nonfinite expiry and nonfinite clocks", () => {
  const store = new ApprovalTextStore(() => NOW);
  for (const expiresAt of [NaN, Infinity, -Infinity, -1, NOW - 1, NOW]) {
    assert.throws(() => store.remember({ ...entry(), expiresAt }), /expiry/u);
  }
  const earlyClock = new ApprovalTextStore(() => 0);
  assert.throws(() => earlyClock.remember({
    ...entry(), expiresAt: Number(common.messageTs) * 1_000,
  }), /expiry/u);
  for (const invalidClock of [NaN, Infinity, -Infinity]) {
    const invalidStore = new ApprovalTextStore(() => invalidClock);
    assert.throws(() => invalidStore.remember(entry()), /clock/u);
    assert.throws(() => invalidStore.get(entry().requestId), /clock/u);
  }
});

test("duplicate active IDs invalidate both routes and cannot be revived before expiry", () => {
  let now = NOW;
  const store = new ApprovalTextStore(() => now);
  const card = entry();
  store.remember(card);
  assert.throws(() => store.remember({
    ...card, messageTs: "1710000000.000004",
  }), /Duplicate/u);
  assert.equal(store.get(card.requestId), undefined);
  assert.throws(() => store.getForCommand(command(card), APPROVERS), /unavailable/u);
  assert.throws(() => store.remember(card), /Duplicate/u);
  now = EXPIRES;
  store.remember({ ...card, expiresAt: EXPIRES + 60_000 });
  assert.notEqual(store.get(card.requestId), undefined);
});

test("copies and freezes native decisions without mutating the caller's array", () => {
  const decisions: AgentApproval["decision"][] = ["allow_once", "deny"];
  const card = { ...common, kind: "native" as const, requestId: "codex:test", availableDecisions: decisions };
  const store = new ApprovalTextStore(() => NOW);
  store.remember(card);
  decisions[0] = "allow_session";
  card.channelId = "C9876543210";
  const stored = store.get(card.requestId);
  assert.equal(stored?.kind, "native");
  if (stored?.kind !== "native") return;
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.availableDecisions), true);
  assert.deepEqual(stored.availableDecisions, ["allow_once", "deny"]);
  assert.equal(stored.channelId, common.channelId);
  assert.equal(Object.isFrozen(decisions), false);
});

test("copies and freezes Git and external routing before accepting text replies", () => {
  for (const kind of ["git", "external"] as const) {
    const card = entry(kind);
    if (card.kind !== "git" && card.kind !== "external") continue;
    const registered = card.kind === "git"
      ? { ...card, routing: { ...card.routing } }
      : { ...card, routing: { ...card.routing } };
    const mutableRouting = registered.routing;
    const store = new ApprovalTextStore(() => NOW);
    store.remember(registered);
    mutableRouting.channelId = "C9876543210";
    const stored = store.getForCommand(command(card), APPROVERS);
    assert.equal(Object.isFrozen(stored), true);
    if (stored.kind !== "git" && stored.kind !== "external") continue;
    assert.equal(Object.isFrozen(stored.routing), true);
    assert.equal(stored.routing.channelId, common.channelId);
    assert.equal(Object.isFrozen(mutableRouting), false);
  }
});

test("rejects inconsistent request, channel, thread, and message routing", () => {
  for (const kind of ["git", "external"] as const) {
    const card = entry(kind);
    if (card.kind !== "git" && card.kind !== "external") continue;
    for (const overrides of [
      { requestId: "different-request" },
      { channelId: "C9876543210" },
      { rootThreadTs: "1710000000.000000" },
      { messageTs: "1710000000.000003" },
      { version: 2 },
    ]) {
      const store = new ApprovalTextStore(() => NOW);
      assert.throws(() => store.remember({
        ...card, routing: { ...card.routing, ...overrides },
      } as TextApprovalEntry), /inconsistent/u);
    }
  }
});

test("requires explicit nonempty native decisions and valid external option binding", () => {
  const native = entry("native");
  for (const availableDecisions of [undefined, [], ["invalid"], ["allow_once", "allow_once"]]) {
    const store = new ApprovalTextStore(() => NOW);
    assert.throws(() => store.remember({ ...native, availableDecisions } as TextApprovalEntry), /decisions/u);
  }
  const external = entry("external");
  if (external.kind !== "external") return;
  for (const overrides of [
    { approveOptionId: "option_2" },
    { rejectOptionId: "option_9" },
    { routing: { ...external.routing, purpose: undefined } },
    { routing: { ...external.routing, questionId: "question_1\n" } },
    { routing: { ...external.routing, responderUserId: "U0123456789\n" } },
  ]) {
    const store = new ApprovalTextStore(() => NOW);
    assert.throws(() => store.remember({ ...external, ...overrides } as TextApprovalEntry), /external/u);
  }
});

test("validates safe ASCII identifiers and bounded numeric timestamps on registration and lookup", () => {
  for (const overrides of [
    { requestId: "permission:test\n" },
    { requestId: "permission:テスト" },
    { requestId: "<@U0123456789>" },
    { requestId: "a".repeat(257) },
    { channelId: "C0123456789\n" },
    { rootThreadTs: "1710000000.000001\n" },
    { rootThreadTs: "1710000000.000004" },
    { messageTs: "1710000000.000002\n" },
    { messageTs: "1e9.000002" },
    { messageTs: "99999999999999999999.99999999999999999999" },
  ]) {
    const store = new ApprovalTextStore(() => NOW);
    assert.throws(() => store.remember({ ...entry(), ...overrides }), /Invalid/u);
  }
  const store = new ApprovalTextStore(() => NOW);
  store.remember(entry());
  for (const overrides of [
    { requestId: "permission:test\n" },
    { channelId: "C0123456789\n" },
    { userId: "U0123456789\n" },
    { userId: "B0123456789" },
    { messageTs: "1710000000.000003\n" },
    { rootThreadTs: "1710000000.000001\n" },
    { messageTs: "Infinity" },
  ]) {
    assert.throws(() => store.getForCommand({ ...command(), ...overrides }, APPROVERS), /Invalid/u);
  }
});

test("bounds active storage at 1024 without evicting a live approval", () => {
  const store = new ApprovalTextStore(() => NOW);
  for (let index = 0; index < 1_024; index += 1) {
    store.remember({ ...entry(), requestId: `permission:${index}` });
  }
  assert.throws(() => store.remember(entry()), /Too many/u);
  assert.notEqual(store.get("permission:0"), undefined);
  assert.notEqual(store.get("permission:1023"), undefined);
  assert.equal(store.get(entry().requestId), undefined);
});

test("prunes expired entries before enforcing capacity and permits released capacity", () => {
  let now = NOW;
  const store = new ApprovalTextStore(() => now);
  for (let index = 0; index < 1_024; index += 1) {
    store.remember({ ...entry(), requestId: `permission:${index}`, expiresAt: NOW + 1 });
  }
  now += 1;
  store.remember(entry());
  assert.equal(store.get("permission:0"), undefined);
  assert.equal(store.get("permission:1023"), undefined);
  assert.notEqual(store.get(entry().requestId), undefined);
  store.forget(entry().requestId);
  store.remember(entry());
});
