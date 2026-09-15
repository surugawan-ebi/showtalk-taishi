import assert from "node:assert/strict";
import test from "node:test";

import { createInteractionAudit } from "../../src/slack/interaction-audit.js";

test("writes timestamped interaction lifecycle records with only hashed routing refs", () => {
  const lines: string[] = [];
  const audit = createInteractionAudit(
    (line) => lines.push(line),
    () => Date.parse("2026-09-01T04:00:00.000Z"),
  );

  audit({
    event: "choice.controls_attached",
    requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
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
  for (const key of ["requestRef", "channelRef", "threadRef", "messageRef", "sessionRef"]) {
    assert.match(String(record[key]), /^[0-9a-f]{16}$/u);
  }
  assert.doesNotMatch(line, /codex-choice|C123456|123\.456|124\.567|session-secret/u);
});
