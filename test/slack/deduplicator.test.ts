import assert from "node:assert/strict";
import test from "node:test";

import { SlackEventDeduplicator } from "../../src/slack/deduplicator.js";

test("rejects Slack retries while allowing an event again after the TTL", () => {
  let now = 1_000;
  const deduplicator = new SlackEventDeduplicator({
    ttlMs: 100,
    now: () => now,
  });
  assert.equal(deduplicator.accept("Ev1"), true);
  assert.equal(deduplicator.accept("Ev1"), false);
  now += 101;
  assert.equal(deduplicator.accept("Ev1"), true);
});
