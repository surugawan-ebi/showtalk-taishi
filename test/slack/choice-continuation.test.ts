import assert from "node:assert/strict";
import test from "node:test";

import {
  StructuredChoiceContinuationStore,
  buildChoiceContinuationBlocks,
  parseChoiceContinuationActionId,
  parseChoiceContinuationId,
} from "../../src/slack/choice-continuation.js";

function displayed(expiresAt: number) {
  return {
    requestId: "codex-choice:11111111-1111-4111-8111-111111111111",
    sessionId: "session_1",
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    messageTs: "1786654846.000100",
    responderUserId: "U0123456789",
    expiresAt,
    completedAnswers: [],
    question: {
      id: "question_1",
      header: "公開設定",
      prompt: "main保護を設定しますか？",
      options: [
        { id: "option_1", label: "承認して実行", description: "設定する" },
        { id: "option_2", label: "拒否・保留", description: "設定しない" },
      ],
      allowsOther: false,
    },
  } as const;
}

test("creates one opaque continuation and rejects concurrent replay", () => {
  let now = 1_000;
  const store = new StructuredChoiceContinuationStore(() => now);
  const display = displayed(now + 60_000);
  store.rememberDisplayed(display);

  const continuation = store.resolveExternally(display.requestId);
  assert.ok(continuation);
  assert.match(
    continuation.continuationId,
    /^choice-continuation:[0-9a-f-]{36}$/u,
  );
  assert.equal(
    store.resolveExternally(display.requestId)?.continuationId,
    continuation.continuationId,
  );
  assert.equal(store.begin(continuation.continuationId).state, "in_progress");
  assert.throws(
    () => store.begin(continuation.continuationId),
    /already handled/u,
  );
  store.consume(continuation.continuationId);
  assert.throws(
    () => store.begin(continuation.continuationId),
    /already handled/u,
  );

  now += 60_001;
  assert.equal(store.get(continuation.continuationId), undefined);
});

test("does not create a continuation after the original choice expires", () => {
  const store = new StructuredChoiceContinuationStore(() => 2_000);
  const display = displayed(1_999);
  store.rememberDisplayed(display);
  assert.equal(store.resolveExternally(display.requestId), undefined);
});

test("renders continuation actions without exposing the original RPC request", () => {
  const store = new StructuredChoiceContinuationStore(() => 1_000);
  const display = displayed(60_000);
  store.rememberDisplayed(display);
  const continuation = store.resolveExternally(display.requestId);
  assert.ok(continuation);
  const rendered = JSON.stringify(buildChoiceContinuationBlocks(continuation));
  assert.match(rendered, /taishi\.choice_continue\.select\.option_1/u);
  assert.match(rendered, /承認して実行/u);
  assert.doesNotMatch(rendered, /codex-choice:/u);
  assert.deepEqual(
    parseChoiceContinuationActionId("taishi.choice_continue.select.option_2"),
    { kind: "select", optionId: "option_2" },
  );
  assert.equal(
    parseChoiceContinuationId(continuation.continuationId),
    continuation.continuationId,
  );
});

test("retains earlier answers from one multi-question request", () => {
  const store = new StructuredChoiceContinuationStore(() => 1_000);
  const display = {
    ...displayed(60_000),
    completedAnswers: [{
      header: "公開先",
      prompt: "どこへ公開しますか？",
      answers: ["GitHub"],
    }],
  } as const;
  store.rememberDisplayed(display);
  const continuation = store.resolveExternally(display.requestId);
  assert.ok(continuation);
  assert.deepEqual(continuation.completedAnswers, display.completedAnswers);
  assert.match(
    JSON.stringify(buildChoiceContinuationBlocks(continuation)),
    /先に回答した1件も保持/u,
  );
});
