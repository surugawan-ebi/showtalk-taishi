import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkMonitoringAgentAdapter,
  WorkStoppageMonitor,
  createWorkAttentionAudit,
  type WorkAttentionDeliveryFailure,
  type WorkAttentionNotification,
} from "../../src/diagnostics/work-stoppage-monitor.js";
import type { AgentAdapter } from "../../src/core/adapter.js";

function notificationAt(
  notifications: readonly WorkAttentionNotification[],
  index: number,
): WorkAttentionNotification {
  const notification = notifications.at(index);
  assert.ok(notification);
  return notification;
}

test("detects callback-bound input with no Slack controls as a hidden wait", () => {
  let now = Date.parse("2026-10-06T00:00:00.000Z");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 1_000,
    notify: (notification) => { notifications.push(notification); },
  });

  monitor.observeTurnStarted("koe-1", "session-1", {
    channelId: "CSOURCE",
    rootThreadTs: "1791221976.640199",
  });
  monitor.observeAgentEvent("koe-1", "session-1", {
    type: "status.changed",
    status: "waiting_for_input",
  });
  monitor.observeInteractionAudit({
    event: "structured_input.callback_bound",
    requestId: "secret-request-id",
    sessionId: "session-1",
    outcome: "slack_choice_callback_bound",
  });

  now += 999;
  monitor.reconcile();
  assert.deepEqual(notifications, []);
  now += 1;
  monitor.reconcile();

  assert.equal(notifications.length, 1);
  assert.equal(notificationAt(notifications, 0).reason, "hidden_approval_wait");
  assert.equal(notificationAt(notifications, 0).state, "waiting_for_input");
  assert.equal(notificationAt(notifications, 0).nextAction, "check_slack_controls");
  assert.equal(notificationAt(notifications, 0).sourceChannelId, "CSOURCE");
  assert.equal(
    notificationAt(notifications, 0).sourceRootThreadTs,
    "1791221976.640199",
  );
  assert.doesNotMatch(JSON.stringify(notifications), /secret-request-id/u);

  monitor.reconcile();
  assert.equal(notifications.length, 1, "one incident is notified only once");
});

test("distinguishes displayed approval, recovery, and recurrence", () => {
  let now = Date.parse("2026-10-06T01:00:00.000Z");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 1_000,
    notify: (notification) => { notifications.push(notification); },
  });
  monitor.observeTurnStarted("koe-2", "session-2");
  monitor.observeInteractionAudit({
    event: "choice.request_received",
    requestId: "request-1",
    sessionId: "session-2",
  });
  monitor.observeInteractionAudit({
    event: "choice.controls_attached",
    requestId: "request-1",
    // Slack projection carries the Core session while adapter audit carries
    // the backend session; request correlation bridges that intentional split.
    sessionId: "core-session-2",
  });

  assert.deepEqual(
    notifications.map(({ event, reason }) => [event, reason]),
    [["attention_required", "visible_approval_wait"]],
  );

  now += 100;
  monitor.observeInteractionAudit({
    event: "choice.card_terminalized",
    requestId: "request-1",
    sessionId: "session-2",
    outcome: "answered_or_cleared",
  });
  assert.equal(notifications.at(-1)?.event, "recovered");
  assert.equal(notifications.at(-1)?.reason, "visible_approval_wait");

  now += 100;
  monitor.observeInteractionAudit({
    event: "choice.request_received",
    requestId: "request-2",
    sessionId: "session-2",
  });
  monitor.observeInteractionAudit({
    event: "choice.controls_attached",
    requestId: "request-2",
    sessionId: "session-2",
  });
  const visibleRequired = notifications.filter(
    ({ event, reason }) => event === "attention_required" &&
      reason === "visible_approval_wait",
  );
  assert.equal(visibleRequired.length, 2);
  assert.deepEqual(visibleRequired.map(({ occurrence }) => occurrence), [1, 2]);
  assert.notEqual(visibleRequired[0]?.incidentRef, visibleRequired[1]?.incidentRef);
});

test("coalesces adapter-prefixed and audit request IDs for one visible wait", () => {
  let now = Date.parse("2026-10-06T17:43:02.000Z");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 1_000,
    notify: (notification) => { notifications.push(notification); },
  });

  monitor.observeTurnStarted("showtalk", "backend-session");
  monitor.observeInteractionAudit({
    event: "structured_input.request_received",
    requestId: "request-1",
    sessionId: "backend-session",
  });
  monitor.observeInteractionAudit({
    event: "structured_input.callback_bound",
    requestId: "request-1",
    sessionId: "backend-session",
  });
  monitor.observeAgentEvent("showtalk", "backend-session", {
    type: "status.changed",
    status: "waiting_for_input",
  });
  monitor.observeAgentEvent("showtalk", "backend-session", {
    type: "choice.requested",
    requestId: "codex-choice:request-1",
    expiresAt: "2026-10-06T18:13:02.000Z",
    question: {
      id: "external_action_approval",
      header: "Confirm",
      prompt: "Target: marker\nScope: create and delete\nImpact: temporary file",
      purpose: "external_action_confirmation",
      options: [
        { id: "approve", label: "承認して実行", description: "Run the bounded check." },
        { id: "reject", label: "拒否・保留", description: "Keep current state." },
      ],
      allowsOther: false,
    },
    completedAnswers: [],
  });
  monitor.observeInteractionAudit({
    event: "choice.controls_attached",
    requestId: "request-1",
    sessionId: "core-session",
  });

  now += 2_000;
  monitor.observeAgentEvent("showtalk", "backend-session", {
    type: "choice.answer_dispatched",
    requestId: "codex-choice:request-1",
  });
  now += 2_000;
  monitor.reconcile();

  assert.deepEqual(
    notifications.map(({ event, reason }) => [event, reason]),
    [
      ["attention_required", "visible_approval_wait"],
      ["recovered", "visible_approval_wait"],
    ],
  );
});

test("treats an explicit choice expiry as terminal, not a hidden display wait", () => {
  let now = Date.parse("2026-10-06T03:11:28.000+09:00");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 1_000,
    notify: (notification) => { notifications.push(notification); },
  });
  monitor.observeTurnStarted("koe-expiry", "session-expiry");
  monitor.observeInteractionAudit({
    event: "choice.request_received",
    requestId: "request-expiry",
    sessionId: "session-expiry",
  });
  monitor.observeInteractionAudit({
    event: "choice.controls_attached",
    requestId: "request-expiry",
    sessionId: "session-expiry",
  });
  assert.equal(notifications.at(-1)?.reason, "visible_approval_wait");

  now = Date.parse("2026-10-06T03:41:25.000+09:00");
  monitor.observeAgentEvent("koe-expiry", "session-expiry", {
    type: "choice.expired",
    requestId: "request-expiry",
  });
  assert.equal(notifications.at(-1)?.event, "recovered");
  assert.equal(notifications.at(-1)?.reason, "visible_approval_wait");

  now += 60_000;
  monitor.reconcile();
  assert.equal(
    notifications.some(({ reason }) => reason === "hidden_approval_wait"),
    false,
  );
});

test("keeps a long-running tool healthy until its dedicated threshold", () => {
  let now = Date.parse("2026-10-06T02:00:00.000Z");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    runningStallMs: 1_000,
    toolStallMs: 10_000,
    notify: (notification) => { notifications.push(notification); },
  });
  monitor.observeTurnStarted("koe-tool", "session-tool");
  monitor.observeAgentEvent("koe-tool", "session-tool", {
    type: "tool.started",
    toolCallId: "tool-1",
    name: "bounded-operation",
    input: { secret: "must-not-be-emitted" },
  });
  now += 9_999;
  monitor.reconcile();
  assert.deepEqual(notifications, []);
  assert.equal(monitor.state("koe-tool")?.state, "tool_running");

  now += 1;
  monitor.reconcile();
  assert.equal(
    notificationAt(notifications, 0).reason,
    "tool_progress_stall_suspected",
  );
  assert.doesNotMatch(JSON.stringify(notifications), /must-not-be-emitted/u);

  now += 1;
  monitor.observeAgentEvent("koe-tool", "session-tool", {
    type: "tool.completed",
    toolCallId: "tool-1",
  });
  assert.equal(notificationAt(notifications, -1).event, "recovered");
});

test("classifies queued, running, failed, terminal, and unknown states", () => {
  let now = Date.parse("2026-10-06T03:00:00.000Z");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    queuedStallMs: 100,
    runningStallMs: 100,
    notify: (notification) => { notifications.push(notification); },
  });

  monitor.reconcileRuntime([{ agentId: "koe-state", state: "queued" }]);
  assert.equal(monitor.state("koe-state")?.state, "queued");
  now += 100;
  monitor.reconcile();
  assert.equal(notifications.at(-1)?.reason, "queued_progress_stall_suspected");

  monitor.observeTurnStarted("koe-state", "session-state");
  assert.equal(monitor.state("koe-state")?.state, "running");
  assert.equal(notifications.at(-1)?.event, "recovered");

  monitor.reconcileRuntime([{ agentId: "koe-state", state: "unknown" }]);
  assert.equal(monitor.state("koe-state")?.state, "unknown");
  monitor.observeTurnStarted("koe-state", "session-state");

  monitor.observeAgentEvent("koe-state", "session-state", {
    type: "status.changed",
    status: "failed",
  });
  assert.equal(monitor.state("koe-state")?.state, "failed");
  assert.equal(notifications.at(-1)?.reason, "execution_failed");

  monitor.observeTurnTerminal("koe-state", false);
  assert.equal(monitor.state("koe-state")?.state, "terminal");
  assert.equal(notifications.at(-1)?.event, "recovered");

  monitor.observeConnection("koe-state", false);
  assert.equal(monitor.state("koe-state")?.state, "unknown");
});

test("clears a previous Slack source when a later turn has no Slack origin", () => {
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    runningStallMs: 0,
    notify: (notification) => { notifications.push(notification); },
  });

  monitor.observeTurnStarted("koe-source", "session-source", {
    channelId: "CSOURCE",
    rootThreadTs: "1791221976.640199",
  });
  monitor.observeTurnTerminal("koe-source", false);
  monitor.observeTurnStarted("koe-source", "session-source");

  const latest = notificationAt(notifications, -1);
  assert.equal(latest.reason, "running_progress_stall_suspected");
  assert.equal(latest.sourceChannelId, undefined);
  assert.equal(latest.sourceRootThreadTs, undefined);
});

test("distinguishes connection loss and recovery", () => {
  let now = Date.parse("2026-10-06T04:00:00.000Z");
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    connectionGraceMs: 1_000,
    notify: (notification) => { notifications.push(notification); },
  });
  monitor.observeConnection("koe-connection", true);
  monitor.observeConnection("koe-connection", false);
  now += 999;
  monitor.reconcile();
  assert.deepEqual(notifications, []);
  now += 1;
  monitor.reconcile();
  assert.equal(notificationAt(notifications, -1).reason, "connection_lost");
  monitor.observeConnection("koe-connection", true);
  assert.equal(notificationAt(notifications, -1).event, "recovered");
});

test("preserves incident dedupe across restart and allows later recurrence", () => {
  let now = Date.parse("2026-10-06T05:00:00.000Z");
  const firstNotifications: WorkAttentionNotification[] = [];
  const first = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 0,
    notify: (notification) => { firstNotifications.push(notification); },
  });
  first.observeTurnStarted("koe-restart", "session-restart");
  first.observeInteractionAudit({
    event: "structured_input.callback_bound",
    requestId: "request-before-restart",
    sessionId: "session-restart",
  });
  assert.equal(firstNotifications.length, 1);

  const afterRestart: WorkAttentionNotification[] = [];
  const restored = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 0,
    snapshot: first.snapshot(),
    notify: (notification) => { afterRestart.push(notification); },
  });
  restored.reconcileRuntime([{
    agentId: "koe-restart",
    state: "terminal",
    sessionId: "session-restart",
    updatedAt: new Date(now).toISOString(),
  }]);
  assert.deepEqual(
    afterRestart.map(({ event, reason }) => [event, reason]),
    [["recovered", "hidden_approval_wait"]],
  );

  now += 1;
  restored.observeTurnStarted("koe-restart", "session-restart-2");
  restored.observeInteractionAudit({
    event: "structured_input.callback_bound",
    requestId: "request-after-restart",
    sessionId: "session-restart-2",
  });
  assert.equal(afterRestart.at(-1)?.event, "attention_required");
  assert.equal(afterRestart.at(-1)?.occurrence, 2);
});

test("coalesces same-tick duplicate triggers before asynchronous delivery settles", () => {
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    hiddenWaitGraceMs: 0,
    notify: async (notification) => {
      notifications.push(notification);
      await Promise.resolve();
    },
  });
  monitor.observeTurnStarted("koe-concurrent", "session-concurrent");
  monitor.observeInteractionAudit({
    event: "structured_input.callback_bound",
    requestId: "request-concurrent",
    sessionId: "session-concurrent",
  });
  monitor.observeAgentEvent("koe-concurrent", "session-concurrent", {
    type: "status.changed",
    status: "waiting_for_input",
  });
  monitor.reconcile();

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.event, "attention_required");
  assert.equal(
    monitor.snapshot().incidents.filter((incident) => incident.active).length,
    1,
  );
});

test("observes notification delivery failure without automatic retry", async () => {
  let now = Date.parse("2026-10-06T06:00:00.000Z");
  let attempts = 0;
  const attemptedEvents: WorkAttentionNotification["event"][] = [];
  const failures: WorkAttentionDeliveryFailure[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    hiddenWaitGraceMs: 0,
    notify: async (notification) => {
      attempts += 1;
      attemptedEvents.push(notification.event);
      throw new Error("private transport detail");
    },
    observeDeliveryFailure: (failure) => failures.push(failure),
  });
  monitor.observeTurnStarted("koe-notify", "session-notify");
  monitor.observeInteractionAudit({
    event: "structured_input.callback_bound",
    requestId: "request-notify",
    sessionId: "session-notify",
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(attempts, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.event, "notification_delivery_failed");
  assert.doesNotMatch(JSON.stringify(failures), /private transport detail|request-notify/u);
  monitor.reconcile();
  assert.equal(attempts, 1, "reconciliation does not indiscriminately retry delivery");
  assert.deepEqual(
    attemptedEvents,
    ["attention_required"],
    "delivery failure alone is not classified as recovery",
  );

  monitor.observeInteractionAudit({
    event: "structured_input.request_terminalized",
    requestId: "request-notify",
    sessionId: "session-notify",
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    attemptedEvents,
    ["attention_required", "recovered"],
    "recovery is emitted only after the monitored wait clears",
  );
});

test("machine-readable audit contains only the sanitized notification contract", () => {
  const lines: string[] = [];
  const audit = createWorkAttentionAudit((line) => lines.push(line));
  audit.notify({
    component: "showtalk.work_attention",
    version: 1,
    event: "attention_required",
    incidentRef: "0123456789abcdef",
    occurrence: 1,
    agentId: "koe-safe",
    state: "waiting_for_input",
    reason: "hidden_approval_wait",
    lastProgressAt: "2026-10-06T00:00:00.000Z",
    detectedAt: "2026-10-06T00:00:30.000Z",
    nextAction: "check_slack_controls",
  });
  assert.deepEqual(JSON.parse(lines[0]!), {
    component: "showtalk.work_attention",
    version: 1,
    event: "attention_required",
    incidentRef: "0123456789abcdef",
    occurrence: 1,
    agentId: "koe-safe",
    state: "waiting_for_input",
    reason: "hidden_approval_wait",
    lastProgressAt: "2026-10-06T00:00:00.000Z",
    detectedAt: "2026-10-06T00:00:30.000Z",
    nextAction: "check_slack_controls",
  });
});

test("keeps a yielded adapter error failed after the event stream closes", async () => {
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    notify: (notification) => { notifications.push(notification); },
  });
  const delegate: AgentAdapter = {
    kind: "fake",
    capabilities: {
      streaming: true,
      approval: false,
      interrupt: false,
      resume: false,
      toolEvents: true,
      structuredInput: false,
    },
    createSession: async () => ({ id: "session-error" }),
    async *sendMessage() {
      yield { type: "error", message: "synthetic failure" };
    },
  };
  const adapter = new WorkMonitoringAgentAdapter("koe-error", delegate, monitor);

  for await (const _event of adapter.sendMessage(
    { id: "session-error" },
    { text: "test", source: { type: "human" } },
  )) {
    // Consume the complete stream so the wrapper's terminal path runs.
  }

  assert.equal(monitor.state("koe-error")?.state, "failed");
  assert.deepEqual(
    notifications.map(({ event, reason }) => [event, reason]),
    [["attention_required", "execution_failed"]],
  );
});

test("repeated queued observations retain their accepted-at progress baseline", () => {
  let now = Date.parse("2026-10-06T07:00:00.000Z");
  const acceptedAt = new Date(now).toISOString();
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => now,
    queuedStallMs: 1_000,
    notify: (notification) => { notifications.push(notification); },
  });

  monitor.reconcileRuntime([{
    agentId: "koe-queued",
    state: "queued",
    updatedAt: acceptedAt,
  }]);
  now += 999;
  monitor.reconcileRuntime([{
    agentId: "koe-queued",
    state: "queued",
    updatedAt: "2026-10-06T06:59:00.000Z",
  }]);
  assert.deepEqual(notifications, []);

  now += 1;
  monitor.reconcileRuntime([{
    agentId: "koe-queued",
    state: "queued",
    updatedAt: "2026-10-06T06:59:00.000Z",
  }]);
  assert.equal(notifications.length, 1);
  assert.equal(
    notificationAt(notifications, 0).reason,
    "queued_progress_stall_suspected",
  );
  assert.equal(notificationAt(notifications, 0).lastProgressAt, acceptedAt);
});

test("a late first queued observation uses the accepted-at baseline", () => {
  const acceptedAt = "2026-10-06T07:00:00.000Z";
  const notifications: WorkAttentionNotification[] = [];
  const monitor = new WorkStoppageMonitor({
    now: () => Date.parse("2026-10-06T07:10:00.000Z"),
    queuedStallMs: 5 * 60_000,
    notify: (notification) => { notifications.push(notification); },
  });

  monitor.reconcileRuntime([{
    agentId: "koe-late-queued",
    state: "queued",
    updatedAt: acceptedAt,
  }]);

  assert.equal(notifications.length, 1);
  assert.equal(
    notificationAt(notifications, 0).reason,
    "queued_progress_stall_suspected",
  );
  assert.equal(notificationAt(notifications, 0).lastProgressAt, acceptedAt);
});

