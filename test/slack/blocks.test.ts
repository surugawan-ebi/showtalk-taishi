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
    messageTs: "100.2",
    sessionId: "session-1",
  };
  const blocks = buildApprovalBlocks("Run npm test", value);
  assert.equal(blocks.length, 2);
  assert.match(JSON.stringify(blocks[0]), /Koe requests permission/u);
  const encoded = JSON.stringify(value);
  assert.deepEqual(parseApprovalActionValue(encoded), value);
  assert.equal(parseApprovalDecision("taishi.approval.allow_session"), "allow_session");
  assert.equal(
    parseApprovalDecision("taishi.approval.allow_command_rule"),
    "allow_command_rule",
  );
  assert.equal(parseApprovalDecision("something.else"), undefined);
});

test("bounds approval section text after Slack escaping", () => {
  const blocks = buildApprovalBlocks("<>&".repeat(5_000), {
    requestId: "codex:n:8",
    channelId: "C123",
    rootThreadTs: "100.1",
    messageTs: "100.2",
  });
  const section = blocks[0];
  assert.equal(section?.type, "section");
  if (section?.type !== "section" || !("text" in section)) return;
  assert.ok(section.text.text.length <= 3_000);
  assert.doesNotMatch(section.text.text, /<>/u);
});

test("renders only approval decisions offered by Codex", () => {
  const blocks = buildApprovalBlocks(
    "Run npm test",
    {
      requestId: "codex:n:9",
      channelId: "C123",
      rootThreadTs: "100.1",
      messageTs: "100.2",
    },
    ["allow_once", "cancel"],
  );
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /taishi\.approval\.allow_once/u);
  assert.match(rendered, /taishi\.approval\.cancel/u);
  assert.doesNotMatch(rendered, /allow_session|taishi\.approval\.deny/u);
});

test("renders a confirmed exact-command-rule action without embedding the rule", () => {
  const value = {
    requestId: "codex:n:10",
    channelId: "C123",
    rootThreadTs: "100.1",
    messageTs: "100.2",
    sessionId: "session-1",
  };
  const blocks = buildApprovalBlocks(
    'Rule: ["/usr/bin/open","-n","-a","Godot"]',
    value,
    ["allow_once", "allow_command_rule", "cancel"],
  );
  const actions = blocks[1];
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;
  const ruleButton = actions.elements.find(
    (element) =>
      "action_id" in element &&
      element.action_id === "taishi.approval.allow_command_rule",
  );
  assert.ok(ruleButton !== undefined && "value" in ruleButton);
  assert.equal(ruleButton.value, JSON.stringify(value));
  assert.doesNotMatch(ruleButton.value, /Godot|execpolicy|\/usr\/bin\/open/u);
  assert.match(JSON.stringify(ruleButton), /今後も許可しますか/u);
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
        messageTs: "1.2",
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
        messageTs: "1.2",
        targetAgentId: "attacker",
      }),
    ),
  );
});
