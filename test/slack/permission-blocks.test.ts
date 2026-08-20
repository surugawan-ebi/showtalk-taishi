import assert from "node:assert/strict";
import test from "node:test";

import {
  PERMISSION_ACTION_PREFIX,
  buildPermissionApprovalBlocks,
  parsePermissionActionValue,
  parsePermissionDecision,
} from "../../src/slack/permission-blocks.js";

test("builds policy approval controls bound to one request and channel", () => {
  const blocks = buildPermissionApprovalBlocks({
    requestId: "permission:abc",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    operation: "agent.send",
    summary: "Send to reviewer",
    expiresAt: "2026-08-12T00:10:00.000Z",
    sourceSlackUserId: "U123",
  });
  assert.equal(blocks.length, 3);
  const actions = blocks[2];
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;
  assert.equal(actions.elements.length, 4);
  assert.match(JSON.stringify(blocks[0]), /<@U123>/u);
  assert.match(JSON.stringify(blocks[0]), /implementer Koe requests permission/u);
});

test("omits session approval for an operation that requires a fresh decision", () => {
  const blocks = buildPermissionApprovalBlocks({
    requestId: "permission:restart",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    operation: "gateway.restart",
    summary: "Gateway Worker restart",
    expiresAt: "2026-08-12T00:10:00.000Z",
    allowSessionGrant: false,
  });
  const actions = blocks[2];
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;
  assert.equal(actions.elements.length, 3);
  assert.doesNotMatch(JSON.stringify(actions), /allow_session|Allow session/u);
});

test("bounds policy approval section text after Slack escaping", () => {
  const blocks = buildPermissionApprovalBlocks({
    requestId: "permission:bounded",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    operation: "slack.write",
    summary: "<>&".repeat(5_000),
    expiresAt: "2026-08-12T00:10:00.000Z",
  });
  const section = blocks[0];
  assert.equal(section?.type, "section");
  if (section?.type !== "section" || !("text" in section)) return;
  assert.ok(section.text.text.length <= 3_000);
  assert.doesNotMatch(section.text.text, /<>/u);
});

test("parses only known permission decisions", () => {
  assert.equal(
    parsePermissionDecision(`${PERMISSION_ACTION_PREFIX}allow_session`),
    "allow_session",
  );
  assert.equal(parsePermissionDecision(`${PERMISSION_ACTION_PREFIX}root`), undefined);
});

test("rejects malformed, oversized, and extended action values", () => {
  assert.deepEqual(
    parsePermissionActionValue(
      JSON.stringify({ requestId: "permission:abc", channelId: "C1" }),
    ),
    { requestId: "permission:abc", channelId: "C1" },
  );
  assert.throws(() => parsePermissionActionValue("[]"));
  assert.throws(() =>
    parsePermissionActionValue(
      '{"requestId":"permission:a","requestId":"permission:b","channelId":"C1"}',
    ),
  );
  assert.throws(() =>
    parsePermissionActionValue(
      JSON.stringify({ requestId: "permission:abc", channelId: "C1", agentId: "evil" }),
    ),
  );
  assert.throws(() => parsePermissionActionValue("x".repeat(2_001)));
});
