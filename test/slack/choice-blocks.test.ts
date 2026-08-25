import assert from "node:assert/strict";
import test from "node:test";

import {
  CHOICE_OTHER_VIEW_CALLBACK_ID,
  buildChoiceBlocks,
  buildChoiceOtherModal,
  parseChoiceActionValue,
  parseChoiceOtherSubmission,
} from "../../src/slack/choice-blocks.js";
import { parseTrustedChoiceAction } from "../../src/slack/frontend.js";

const routing = {
  version: 1 as const,
  requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
  questionId: "question_1",
  channelId: "C0123456789",
  rootThreadTs: "1786654845.402859",
  messageTs: "1786654846.000100",
  responderUserId: "U0123456789",
};

function actionBody(userId = routing.responderUserId) {
  return {
    type: "block_actions",
    api_app_id: "A0123456789",
    team: { id: "T0123456789" },
    user: { id: userId },
    channel: { id: routing.channelId },
    message: { ts: routing.messageTs, thread_ts: routing.rootThreadTs },
    container: {
      type: "message",
      channel_id: routing.channelId,
      message_ts: routing.messageTs,
    },
  };
}

test("renders ordinary choices with opaque message-bound action payloads", () => {
  const blocks = buildChoiceBlocks(
    {
      id: "question_1",
      header: "地形",
      prompt: "どれを作りますか？",
      options: [
        { id: "option_1", label: "砂漠盆地", description: "中央が低い" },
        { id: "option_2", label: "乾燥岩盤平原", description: "岩盤中心" },
      ],
      allowsOther: true,
    },
    routing,
  );
  const encoded = JSON.stringify(blocks);
  assert.match(encoded, /砂漠盆地/u);
  assert.match(encoded, /その他を入力/u);
  assert.doesNotMatch(encoded, /git_plan|承認して実行|拒否・保留/u);

  const actions = (blocks[1] as { elements: Array<{ action_id: string; value: string }> })
    .elements;
  const first = actions[0]!;
  assert.equal(first.action_id, "taishi.choice.select.option_1");
  assert.equal(
    new Set(actions.map((action) => action.action_id)).size,
    actions.length,
  );
  assert.deepEqual(parseChoiceActionValue(first.value), {
    ...routing,
    optionId: "option_1",
  });
  assert.doesNotMatch(first.value, /砂漠盆地|中央が低い/u);
});

test("accepts a choice only from its bound Slack user and message", () => {
  const action = {
    action_id: "taishi.choice.select.option_2",
    value: JSON.stringify({ ...routing, optionId: "option_2" }),
  };
  assert.equal(
    parseTrustedChoiceAction(actionBody(), action, new Set()).routing.optionId,
    "option_2",
  );
  assert.throws(() =>
    parseTrustedChoiceAction(actionBody("U9999999999"), action, new Set()),
  );
  assert.throws(() =>
    parseTrustedChoiceAction(
      {
        ...actionBody(),
        message: { ts: "1786654999.000100", thread_ts: routing.rootThreadTs },
      },
      action,
      new Set(),
    ),
  );
});

test("rejects a fixed choice whose action ID and payload disagree", () => {
  assert.throws(() =>
    parseTrustedChoiceAction(
      actionBody(),
      {
        action_id: "taishi.choice.select.option_1",
        value: JSON.stringify({ ...routing, optionId: "option_2" }),
      },
      new Set(),
    ),
  );
});

test("allows a source-less Koe question only for a configured operator", () => {
  const { responderUserId: _responderUserId, ...delegatedRouting } = routing;
  const action = {
    action_id: "taishi.choice.select.option_1",
    value: JSON.stringify({ ...delegatedRouting, optionId: "option_1" }),
  };
  assert.equal(
    parseTrustedChoiceAction(
      actionBody("U9999999999"),
      action,
      new Set(["U9999999999"]),
    ).routing.optionId,
    "option_1",
  );
  assert.throws(() =>
    parseTrustedChoiceAction(actionBody("U9999999999"), action, new Set()),
  );
});

test("parses bounded free text only from the issued Other modal", () => {
  const modal = buildChoiceOtherModal(routing, "その他の回答");
  assert.equal(modal.callback_id, CHOICE_OTHER_VIEW_CALLBACK_ID);
  const parsed = parseChoiceOtherSubmission({
    type: "view_submission",
    user: { id: routing.responderUserId },
    view: {
      callback_id: CHOICE_OTHER_VIEW_CALLBACK_ID,
      private_metadata: modal.private_metadata,
      state: {
        values: {
          choice_other_answer: {
            choice_other_text: { type: "plain_text_input", value: "  風化した岩肌  " },
          },
        },
      },
    },
  });
  assert.deepEqual(parsed, {
    routing,
    userId: routing.responderUserId,
    answer: "風化した岩肌",
  });
});
