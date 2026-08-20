import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApprovalBlocks,
  parseApprovalActionValue,
  parseApprovalDecision,
} from "../../src/slack/blocks.js";

test("builds single-use approval actions with scoped routing data", () => {
  const value = {
    requestId: "codex:n:7",
    channelId: "C123",
    rootThreadTs: "100.1",
    sessionId: "session-1",
  };
  const blocks = buildApprovalBlocks("Run npm test", value);
  assert.equal(blocks.length, 2);
  assert.match(JSON.stringify(blocks[0]), /Koe requests permission/u);
  const encoded = JSON.stringify(value);
  assert.deepEqual(parseApprovalActionValue(encoded), value);
  assert.equal(parseApprovalDecision("taishi.approval.allow_session"), "allow_session");
  assert.equal(parseApprovalDecision("something.else"), undefined);
});

test("bounds approval section text after Slack escaping", () => {
  const blocks = buildApprovalBlocks("<>&".repeat(5_000), {
    requestId: "codex:n:8",
    channelId: "C123",
    rootThreadTs: "100.1",
  });
  const section = blocks[0];
  assert.equal(section?.type, "section");
  if (section?.type !== "section" || !("text" in section)) return;
  assert.ok(section.text.text.length <= 3_000);
  assert.doesNotMatch(section.text.text, /<>/u);
});

test("rejects forged or ambiguous approval routing payloads", () => {
  assert.throws(() =>
    parseApprovalActionValue(
      '{"requestId":"a","requestId":"b","channelId":"C1","rootThreadTs":"1.1"}',
    ),
  );
  assert.throws(() =>
    parseApprovalActionValue(
      JSON.stringify({
        requestId: "a",
        channelId: "C1",
        rootThreadTs: "1.1",
        sessionId: 7,
      }),
    ),
  );
  assert.throws(() =>
    parseApprovalActionValue(
      JSON.stringify({
        requestId: "a",
        channelId: "C1",
        rootThreadTs: "1.1",
        targetAgentId: "attacker",
      }),
    ),
  );
});
