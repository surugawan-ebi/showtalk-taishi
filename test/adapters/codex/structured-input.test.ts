import assert from "node:assert/strict";
import test from "node:test";

import {
  hasWorkspaceGitApprovalQuestionId,
  looksLikeWorkspaceGitApproval,
  validateOrdinaryChoiceRequest,
} from "../../../src/adapters/codex/structured-input.js";

function request(autoResolutionMs: number | null) {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "item_1",
    questions: [
      {
        id: "terrain",
        header: "地形",
        question: "どれを作りますか？",
        isOther: false,
        isSecret: false,
        options: [
          { label: "砂漠", description: "乾いた地形" },
          { label: "岩場", description: "険しい地形" },
        ],
      },
    ],
    isBlocking: true,
    autoResolutionMs,
  };
}

test("accepts only the documented structured-input auto-resolution window", () => {
  assert.equal(validateOrdinaryChoiceRequest(request(null)).autoResolutionMs, undefined);
  const omittedDefaults = request(null);
  const omittedQuestion = omittedDefaults.questions[0];
  assert.ok(omittedQuestion);
  assert.equal(
    validateOrdinaryChoiceRequest({
      ...omittedDefaults,
      autoResolutionMs: undefined,
      questions: [{
        ...omittedQuestion,
        isOther: undefined,
        isSecret: undefined,
      }],
    }).questions[0]?.allowsOther,
    false,
  );
  assert.equal(
    validateOrdinaryChoiceRequest(request(60_000)).autoResolutionMs,
    60_000,
  );
  assert.equal(
    validateOrdinaryChoiceRequest(request(240_000)).autoResolutionMs,
    240_000,
  );
  for (const value of [1, 59_999, 240_001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => validateOrdinaryChoiceRequest(request(value)),
      /auto-resolution/u,
    );
  }
  assert.deepEqual(
    validateOrdinaryChoiceRequest({ ...request(null), isBlocking: false })
      .questions[0]?.options.map((option) => option.label),
    ["砂漠", "岩場"],
  );
  assert.throws(
    () => validateOrdinaryChoiceRequest({ ...request(null), isBlocking: "yes" }),
    /blocking mode/u,
  );
});

test("does not classify ordinary question prose as workspace-git approval", () => {
  for (const text of [
    "Git承認の説明を公開してよいですか？",
    "Git公開の運用についてコメントしてください。",
    "Git publicationの方針を選んでください。",
    "workspace-git approvalの仕様を確認しますか？",
  ]) {
    const value = request(null);
    const question = value.questions[0];
    assert.ok(question);
    question.header = text;
    question.question = text;
    assert.equal(looksLikeWorkspaceGitApproval(value), false, text);
  }
});

test("keeps strong workspace-git approval identifiers fail-closed", () => {
  const identified = request(null);
  const identifiedQuestion = identified.questions[0];
  assert.ok(identifiedQuestion);
  identifiedQuestion.id = "git_approval";
  assert.equal(looksLikeWorkspaceGitApproval(identified), true);
  assert.equal(hasWorkspaceGitApprovalQuestionId(identified), true);

  const fixedChoices = request(null);
  const fixedChoiceQuestion = fixedChoices.questions[0];
  assert.ok(fixedChoiceQuestion);
  fixedChoiceQuestion.options = [
    { label: "承認して実行", description: "固定された計画を実行する" },
    { label: "拒否・保留", description: "固定された計画を実行しない" },
  ];
  assert.equal(looksLikeWorkspaceGitApproval(fixedChoices), true);
  assert.equal(hasWorkspaceGitApprovalQuestionId(fixedChoices), false);
});

test("accepts reserved labels as ordinary choices without granting Git identity", () => {
  const value = request(null);
  const question = value.questions[0];
  assert.ok(question);
  question.id = "main_protection";
  question.options = [
    { label: "承認して実行", description: "main保護を設定する" },
    { label: "拒否・保留", description: "今回は変更しない" },
  ];

  const validated = validateOrdinaryChoiceRequest(value);
  assert.deepEqual(
    validated.questions[0]?.options.map((option) => ({
      label: option.label,
      appServerLabel: option.appServerLabel,
    })),
    [
      { label: "承認して実行", appServerLabel: "承認して実行" },
      { label: "拒否・保留", appServerLabel: "拒否・保留" },
    ],
  );
});
