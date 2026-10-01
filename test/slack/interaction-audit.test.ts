import assert from "node:assert/strict";
import test from "node:test";

import {
  createInteractionAudit,
  type InteractionAuditInput,
} from "../../src/slack/interaction-audit.js";

test("writes timestamped interaction lifecycle records with only hashed routing refs", () => {
  const lines: string[] = [];
  const audit = createInteractionAudit(
    (line) => lines.push(line),
    () => Date.parse("2026-09-01T04:00:00.000Z"),
    {
      workerId: "worker-secret-looking-value",
      buildIdentity: "showtalk-taishi@test-build",
    },
  );

  audit({
    event: "choice.controls_attached",
    requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
    rpcId: 42,
    turnId: "turn-secret-looking-value",
    channelId: "C123456",
    rootThreadTs: "123.456",
    messageTs: "124.567",
    sessionId: "session-secret-looking-value",
    outcome: "interactive",
  });

  assert.equal(lines.length, 1);
  const line = lines[0]!;
  const record = JSON.parse(line) as Record<string, unknown>;
  assert.equal(record.component, "showtalk.interaction_audit");
  assert.equal(record.timestamp, "2026-09-01T04:00:00.000Z");
  assert.equal(record.event, "choice.controls_attached");
  assert.equal(record.outcome, "interactive");
  assert.equal(record.buildIdentity, "showtalk-taishi@test-build");
  for (const key of [
    "workerRef",
    "requestRef",
    "rpcRef",
    "turnRef",
    "channelRef",
    "threadRef",
    "messageRef",
    "sessionRef",
  ]) {
    assert.match(String(record[key]), /^[0-9a-f]{16}$/u);
  }
  assert.deepEqual(Object.keys(record).sort(), [
    "buildIdentity",
    "channelRef",
    "component",
    "event",
    "messageRef",
    "outcome",
    "requestRef",
    "rpcRef",
    "sessionRef",
    "threadRef",
    "timestamp",
    "turnRef",
    "workerRef",
  ]);
  assert.doesNotMatch(
    line,
    /codex-choice|C123456|123\.456|124\.567|session-secret|turn-secret|worker-secret/u,
  );
});

test("normalizes adapter and Slack request prefixes to one anonymous correlation", () => {
  const lines: string[] = [];
  const audit = createInteractionAudit(
    (line) => lines.push(line),
    () => 0,
    { workerId: "worker", buildIdentity: "build" },
  );
  audit({
    event: "structured_input.request_received",
    requestId: "11111111-1111-4111-8111-111111111111",
    outcome: "direct_server_request",
  });
  audit({
    event: "choice.card_posted",
    requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
  });
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records[0]?.requestRef, records[1]?.requestRef);
});

test("replaces non-allowlisted outcomes including secret-like tokens", () => {
  const lines: string[] = [];
  const audit = createInteractionAudit(
    (line) => lines.push(line),
    () => 0,
    { workerId: "worker", buildIdentity: "build" },
  );
  const unsafeAudit = audit as (input: {
    readonly event: "choice.action_failed";
    readonly outcome: string;
  }) => void;
  unsafeAudit({
    event: "choice.action_failed",
    outcome: "secret_token_123",
  });
  assert.equal(
    (JSON.parse(lines[0] ?? "null") as { outcome?: string }).outcome,
    "invalid_outcome_classifier",
  );
  assert.doesNotMatch(lines[0] ?? "", /secret_token_123/u);
});

test("allows only fixed external-action repair classifiers without wire content", () => {
  const lines: string[] = [];
  const syntheticSecret = "synthetic-secret-value-never-log";
  const audit = createInteractionAudit(
    (line) => lines.push(line),
    () => 0,
    { workerId: "worker", buildIdentity: "build" },
  );
  const unsafeAudit = audit as (input: InteractionAuditInput & {
    readonly isBlocking: boolean;
    readonly questions: readonly unknown[];
  }) => void;
  const outcomes = [
    "external_action_blocking_required",
    "external_action_description_invalid",
    "external_action_details_invalid",
    "external_action_option_shape_invalid",
    "external_action_question_shape_invalid",
    "external_action_request_invalid",
  ] as const satisfies readonly InteractionAuditInput["outcome"][];

  for (const outcome of outcomes) {
    unsafeAudit({
      event: "structured_input.request_rejected",
      requestId: syntheticSecret,
      rpcId: syntheticSecret,
      turnId: syntheticSecret,
      channelId: syntheticSecret,
      rootThreadTs: syntheticSecret,
      messageTs: syntheticSecret,
      sessionId: syntheticSecret,
      outcome,
      isBlocking: false,
      questions: [{ prompt: syntheticSecret }],
    });
  }

  assert.equal(lines.length, outcomes.length);
  for (const [index, line] of lines.entries()) {
    const record = JSON.parse(line) as Record<string, unknown>;
    assert.equal(record.outcome, outcomes[index]);
    assert.deepEqual(Object.keys(record).sort(), [
      "buildIdentity",
      "channelRef",
      "component",
      "event",
      "messageRef",
      "outcome",
      "requestRef",
      "rpcRef",
      "sessionRef",
      "threadRef",
      "timestamp",
      "turnRef",
      "workerRef",
    ]);
    assert.equal(line.includes(syntheticSecret), false);
  }
});
