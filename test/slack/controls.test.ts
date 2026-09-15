import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_CONTROL_ACTION_PREFIX,
  buildConversationControlBlocks,
  parseConversationControlAction,
  parseConversationControlActionValue,
} from "../../src/slack/controls.js";

const routing = {
  channelId: "C012ABCDEF",
  rootThreadTs: "1723456789.123456",
  messageTs: "1723456789.123457",
};

test("builds status, interrupt, and restart controls for the channel-wide Koe session", () => {
  const blocks = buildConversationControlBlocks(routing);
  assert.equal(blocks.length, 1);

  const actions = blocks[0];
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;

  assert.equal(actions.elements.length, 3);
  assert.deepEqual(
    actions.elements.map((element) =>
      element.type === "button" ? element.action_id : undefined,
    ),
    [
      `${CONVERSATION_CONTROL_ACTION_PREFIX}status`,
      `${CONVERSATION_CONTROL_ACTION_PREFIX}interrupt`,
      `${CONVERSATION_CONTROL_ACTION_PREFIX}restart`,
    ],
  );

  for (const element of actions.elements) {
    assert.equal(element.type, "button");
    if (element.type !== "button") continue;
    assert.equal(typeof element.value, "string");
    assert.deepEqual(parseConversationControlActionValue(element.value ?? ""), routing);
  }
});

test("interrupt confirmation describes the current Koe turn", () => {
  const [actions] = buildConversationControlBlocks(routing);
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;

  const interrupt = actions.elements[1];
  assert.equal(interrupt?.type, "button");
  if (interrupt?.type !== "button") return;

  const confirmation = interrupt.confirm?.text.text;
  assert.match(confirmation ?? "", /Koe/u);
  assert.match(confirmation ?? "", /active turn/);
});

test("restart confirmation describes draining and loading the latest code", () => {
  const [actions] = buildConversationControlBlocks(routing);
  assert.equal(actions?.type, "actions");
  if (actions?.type !== "actions") return;

  const restart = actions.elements[2];
  assert.equal(restart?.type, "button");
  if (restart?.type !== "button") return;
  assert.match(restart.confirm?.text.text ?? "", /active turns will finish/iu);
  assert.match(restart.confirm?.text.text ?? "", /Koe/u);
  assert.match(restart.confirm?.text.text ?? "", /latest local code/u);
});

test("parses only exact conversation control action IDs", () => {
  assert.equal(
    parseConversationControlAction(`${CONVERSATION_CONTROL_ACTION_PREFIX}status`),
    "status",
  );
  assert.equal(
    parseConversationControlAction(`${CONVERSATION_CONTROL_ACTION_PREFIX}interrupt`),
    "interrupt",
  );
  assert.equal(
    parseConversationControlAction(`${CONVERSATION_CONTROL_ACTION_PREFIX}restart`),
    "restart",
  );
  assert.equal(
    parseConversationControlAction(`${CONVERSATION_CONTROL_ACTION_PREFIX}new_session`),
    undefined,
  );
  assert.equal(parseConversationControlAction("taishi.approval.status"), undefined);
  assert.equal(
    parseConversationControlAction(`${CONVERSATION_CONTROL_ACTION_PREFIX}status.extra`),
    undefined,
  );
  assert.equal(
    parseConversationControlAction(`${CONVERSATION_CONTROL_ACTION_PREFIX}STATUS`),
    undefined,
  );
});

test("accepts exact routing keys in either order", () => {
  assert.deepEqual(
    parseConversationControlActionValue(JSON.stringify(routing)),
    routing,
  );
  assert.deepEqual(
    parseConversationControlActionValue(
      JSON.stringify({
        messageTs: routing.messageTs,
        rootThreadTs: routing.rootThreadTs,
        channelId: routing.channelId,
      }),
    ),
    routing,
  );
});

test("rejects malformed, extended, duplicate, and oversized payloads", () => {
  const invalidPayloads = [
    "",
    "not-json",
    "null",
    "[]",
    JSON.stringify({ channelId: routing.channelId }),
    JSON.stringify({ ...routing, userId: "UATTACKER" }),
    JSON.stringify({ channelId: 1, rootThreadTs: routing.rootThreadTs }),
    `{"channelId":"C1","channelId":"C2","rootThreadTs":"1.1"}`,
    "x".repeat(513),
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () => parseConversationControlActionValue(payload),
      /Invalid conversation control action payload/,
    );
  }
});

test("rejects empty, unbounded, and hostile Slack coordinates", () => {
  const invalidValues = [
    { channelId: "", rootThreadTs: "1.1" },
    { channelId: "C", rootThreadTs: "1.1" },
    { channelId: `C${"A".repeat(128)}`, rootThreadTs: "1.1" },
    { channelId: "c123", rootThreadTs: "1.1" },
    { channelId: "C123/../../", rootThreadTs: "1.1" },
    { channelId: "C123", rootThreadTs: "" },
    { channelId: "C123", rootThreadTs: "123" },
    { channelId: "C123", rootThreadTs: "1.1;rm -rf" },
    { channelId: "C123", rootThreadTs: `${"1".repeat(21)}.1` },
  ];

  for (const value of invalidValues) {
    assert.throws(
      () => parseConversationControlActionValue(JSON.stringify(value)),
      /Invalid conversation control action payload/,
    );
  }
});

test("rejects invalid routing coordinates before rendering blocks", () => {
  assert.throws(
    () =>
      buildConversationControlBlocks({
        channelId: "C123<script>",
        rootThreadTs: routing.rootThreadTs,
        messageTs: routing.messageTs,
      }),
    /Invalid conversation control action payload/,
  );
});
