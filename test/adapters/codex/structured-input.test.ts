import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExternalActionApprovalQuestionId,
  hasWorkspaceGitApprovalQuestionId,
  looksLikeWorkspaceGitApproval,
  MalformedExternalActionApprovalError,
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

test("accepts reserved labels only as a visibly non-Git external action", () => {
  const value = request(null);
  const question = value.questions[0];
  assert.ok(question);
  question.id = "external_action_approval";
  question.header = "Gateway restart";
  question.question = [
    "Target: ShowTalk Taishi Gateway worker",
    "Scope: 現在稼働中のworkerを1回だけ置換",
    "Impact: 短時間Slack応答が停止",
  ].join("\n");
  question.isOther = true;
  question.options = [
    { label: "承認して実行", description: "main保護を設定する" },
    { label: "拒否・保留", description: "今回は変更しない" },
  ];

  const validated = validateOrdinaryChoiceRequest(value);
  assert.equal(hasExternalActionApprovalQuestionId(value), true);
  assert.equal(validated.questions[0]?.purpose, "external_action_confirmation");
  assert.equal(validated.questions[0]?.allowsOther, false);
  assert.equal(
    validated.questions[0]?.header,
    "外部操作の最終確認（Git承認ではありません）",
  );
  assert.equal(
    validated.questions[0]?.prompt,
    [
      "対象: ShowTalk Taishi Gateway worker",
      "範囲: 現在稼働中のworkerを1回だけ置換",
      "影響: 短時間Slack応答が停止",
    ].join("\n"),
  );
  assert.deepEqual(
    validated.questions[0]?.options.map((option) => ({
      label: option.label,
      appServerLabel: option.appServerLabel,
    })),
    [
      {
        label: "外部操作を承認（Git承認ではありません）",
        appServerLabel: "承認して実行",
      },
      {
        label: "外部操作を拒否・保留",
        appServerLabel: "拒否・保留",
      },
    ],
  );
  assert.throws(
    () => validateOrdinaryChoiceRequest({ ...value, isBlocking: false }),
    MalformedExternalActionApprovalError,
  );
});

test("canonicalizes the Codex-recommended external-action approval label", () => {
  const value = request(null);
  const question = value.questions[0];
  assert.ok(question);
  question.id = "external_action_approval";
  question.question = [
    "Target: ShowTalk Taishi Gateway worker",
    "Scope: 現在稼働中のworkerを1回だけ置換",
    "Impact: 短時間Slack応答が停止",
  ].join("\n");
  question.options = [
    {
      label: "承認して実行 (Recommended)",
      description: "指定workerを再検証して1回再起動する",
    },
    { label: "拒否・保留", description: "workerを再起動しない" },
  ];

  const validated = validateOrdinaryChoiceRequest(value);
  assert.equal(
    validated.questions[0]?.options[0]?.label,
    "外部操作を承認（Git承認ではありません）",
  );
  assert.equal(
    validated.questions[0]?.options[0]?.appServerLabel,
    "承認して実行",
  );
});

test("rejects malformed dedicated external-action confirmations", () => {
  const value = request(null);
  const question = value.questions[0];
  assert.ok(question);
  question.id = "external_action_approval";
  question.question = [
    "Target: ShowTalk Taishi Gateway worker",
    "Scope: 現在稼働中のworkerを1回だけ置換",
    "Impact: 短時間Slack応答が停止",
  ].join("\n");
  question.options = [
    { label: "拒否・保留", description: "保留する" },
    { label: "承認して実行", description: "実行する" },
  ];
  assert.throws(
    () => validateOrdinaryChoiceRequest(value),
    MalformedExternalActionApprovalError,
  );
  assert.throws(
    () => validateOrdinaryChoiceRequest({
      ...value,
      questions: [{
        ...question,
        question: "Gatewayを再起動しますか？",
        options: [
          { label: "承認して実行", description: "" },
          { label: "拒否・保留", description: "保留する" },
        ],
      }],
    }),
    MalformedExternalActionApprovalError,
  );
  assert.throws(
    () => validateOrdinaryChoiceRequest({
      ...value,
      questions: [{
        ...question,
        options: [
          { label: "承認 して実行", description: "実行する" },
          { label: "拒否・保留", description: "保留する" },
        ],
      }],
    }),
    MalformedExternalActionApprovalError,
  );
  assert.throws(
    () => validateOrdinaryChoiceRequest({
      ...value,
      questions: [{
        ...question,
        options: [
          { label: "承認して実行 (Recommended)", description: "実行する" },
          { label: "拒否・保留", description: "保留する" },
          { label: "あとで決める", description: "判断を延期する" },
        ],
      }],
    }),
    MalformedExternalActionApprovalError,
  );
  assert.throws(
    () => validateOrdinaryChoiceRequest({
      ...value,
      questions: [
        { ...request(null).questions[0]!, id: "terrain" },
        {
          ...question,
          options: [
            { label: "承認して実行", description: "実行する" },
            { label: "拒否・保留", description: "保留する" },
          ],
        },
      ],
    }),
    MalformedExternalActionApprovalError,
  );
});

test("rejects hidden external-action details and control characters", () => {
  const value = request(null);
  const question = value.questions[0];
  assert.ok(question);
  const external = {
    ...question,
    id: "external_action_approval",
    question: [
      "Target: ShowTalk Taishi Gateway worker",
      "Scope: 現在稼働中のworkerを1回だけ置換",
      "Impact: 短時間Slack応答が停止",
    ].join("\n"),
    options: [
      { label: "承認して実行", description: "workerを再起動する" },
      { label: "拒否・保留", description: "今回は変更しない" },
    ],
  };
  const cases = [
    {
      ...external,
      question: `${external.question}\nActual action: production全削除`,
    },
    {
      ...external,
      question: external.question.replace(
        "Gateway worker",
        "Gateway worker\u202Eproduction",
      ),
    },
    {
      ...external,
      options: [
        { label: "承認して実行", description: "再起動\u2066production\u2069" },
        { label: "拒否・保留", description: "今回は変更しない" },
      ],
    },
    {
      ...external,
      options: [
        { label: "承認して実行", description: "workerを再起動する" },
        { label: "拒否・保留", description: "今回は\u0007変更しない" },
      ],
    },
  ];

  for (const candidate of cases) {
    assert.throws(
      () => validateOrdinaryChoiceRequest({
        ...value,
        questions: [candidate],
      }),
      MalformedExternalActionApprovalError,
    );
  }
});

test("detects reserved Git labels anywhere in a multi-question request", () => {
  const value = request(null);
  const reserved = {
    ...value.questions[0]!,
    id: "main_protection",
    options: [
      { label: "承認\u200Bして実行", description: "実行する" },
      { label: "拒否\u2060・保留", description: "保留する" },
    ],
  };
  const multiple = { ...value, questions: [value.questions[0]!, reserved] };
  assert.equal(looksLikeWorkspaceGitApproval(multiple), true);
  assert.equal(hasWorkspaceGitApprovalQuestionId(multiple), false);
  assert.equal(hasExternalActionApprovalQuestionId(multiple), false);
});

test("detects visually reserved labels containing default-ignorable Unicode", () => {
  for (const invisible of ["\u200B", "\u2060", "\uFE0F", "\u00AD"]) {
    const value = request(null);
    const question = value.questions[0];
    assert.ok(question);
    question.id = "main_protection";
    question.options = [
      { label: `承認${invisible}して実行`, description: "実行する" },
      { label: `拒否${invisible}・保留`, description: "保留する" },
    ];
    assert.equal(
      looksLikeWorkspaceGitApproval(value),
      true,
      `U+${invisible.codePointAt(0)?.toString(16) ?? "unknown"}`,
    );
  }
});
