import type { ActionsBlock, KnownBlock, ModalView } from "@slack/types";

import type { AgentChoiceQuestion } from "../core/index.js";

export const CHOICE_ACTION_PREFIX = "taishi.choice.";
export const CHOICE_OTHER_VIEW_CALLBACK_ID = "taishi.choice.other";
const CHOICE_OTHER_BLOCK_ID = "choice_other_answer";
const CHOICE_OTHER_ACTION_ID = "choice_other_text";

export interface ChoiceActionRouting {
  readonly version: 1;
  readonly requestId: string;
  readonly questionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly responderUserId?: string;
}

export interface ChoiceActionValue extends ChoiceActionRouting {
  readonly optionId?: string;
}

export type ChoiceActionKind = "select" | "other";

export function buildChoiceBlocks(
  question: AgentChoiceQuestion,
  routing: ChoiceActionRouting,
): KnownBlock[] {
  const optionDetails = question.options
    .map((option) => {
      const description = option.description.trim();
      return description.length === 0
        ? `• *${escapeSlack(option.label)}*`
        : `• *${escapeSlack(option.label)}* — ${escapeSlack(description)}`;
    })
    .join("\n");
  const body = [
    `*${escapeSlack(question.header)}*`,
    escapeSlack(question.prompt),
    optionDetails,
  ].filter((value) => value.length > 0).join("\n\n");
  const elements: ActionsBlock["elements"] = question.options.map((option) => ({
      type: "button",
      text: {
        type: "plain_text",
        text: truncate(option.label, 75),
        emoji: true,
      },
      action_id: `${CHOICE_ACTION_PREFIX}select`,
      value: encodeChoiceActionValue({ ...routing, optionId: option.id }),
    }));
  if (question.allowsOther) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "その他を入力", emoji: true },
      action_id: `${CHOICE_ACTION_PREFIX}other`,
      value: encodeChoiceActionValue(routing),
    });
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(body, 2_900),
      },
    },
    {
      type: "actions",
      elements,
    },
  ];
}

export function buildChoiceOtherModal(
  routing: ChoiceActionRouting,
  header: string,
): ModalView {
  return {
    type: "modal",
    callback_id: CHOICE_OTHER_VIEW_CALLBACK_ID,
    private_metadata: encodeChoiceActionValue(routing),
    title: { type: "plain_text", text: truncate(header, 24), emoji: true },
    submit: { type: "plain_text", text: "回答する", emoji: true },
    close: { type: "plain_text", text: "戻る", emoji: true },
    blocks: [
      {
        type: "input",
        block_id: CHOICE_OTHER_BLOCK_ID,
        label: { type: "plain_text", text: "その他の回答", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: CHOICE_OTHER_ACTION_ID,
          multiline: true,
          min_length: 1,
          max_length: 1_000,
        },
      },
    ],
  };
}

export function parseChoiceActionKind(actionId: string): ChoiceActionKind | undefined {
  if (!actionId.startsWith(CHOICE_ACTION_PREFIX)) return undefined;
  const value = actionId.slice(CHOICE_ACTION_PREFIX.length);
  return value === "select" || value === "other" ? value : undefined;
}

export function parseChoiceActionValue(value: string): ChoiceActionValue {
  if (value.length < 1 || value.length > 1_200) {
    throw new Error("Invalid structured choice action payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid structured choice action payload");
  }
  const record = asRecord(parsed);
  const expectedKeys =
    6 +
    (record?.responderUserId === undefined ? 0 : 1) +
    (record?.optionId === undefined ? 0 : 1);
  if (
    record === undefined ||
    record.version !== 1 ||
    typeof record.requestId !== "string" ||
    !/^codex-choice:[0-9a-f-]{36}$/iu.test(record.requestId) ||
    typeof record.questionId !== "string" ||
    !/^question_[1-3]$/u.test(record.questionId) ||
    typeof record.channelId !== "string" ||
    !/^[CDG][A-Z0-9]{1,127}$/u.test(record.channelId) ||
    !isSlackTs(record.rootThreadTs) ||
    !isSlackTs(record.messageTs) ||
    (record.optionId !== undefined &&
      (typeof record.optionId !== "string" || !/^option_[1-3]$/u.test(record.optionId))) ||
    (record.responderUserId !== undefined &&
      (typeof record.responderUserId !== "string" ||
        !/^[UW][A-Z0-9]{1,127}$/u.test(record.responderUserId))) ||
    Object.keys(record).length !== expectedKeys
  ) {
    throw new Error("Invalid structured choice action payload");
  }
  for (const key of Object.keys(record)) {
    if (countLiteralKey(value, key) !== 1) {
      throw new Error("Ambiguous structured choice action payload");
    }
  }
  return record as unknown as ChoiceActionValue;
}

export function parseChoiceOtherSubmission(body: unknown): {
  readonly routing: ChoiceActionRouting;
  readonly userId: string;
  readonly answer: string;
} {
  const record = requiredRecord(body);
  if (record.type !== "view_submission") {
    throw new Error("Slack interaction type is not trusted");
  }
  const userId = requiredString(requiredRecord(record.user).id);
  const view = requiredRecord(record.view);
  if (view.callback_id !== CHOICE_OTHER_VIEW_CALLBACK_ID) {
    throw new Error("Unexpected structured choice modal");
  }
  const routing = parseChoiceActionValue(requiredString(view.private_metadata));
  if (routing.optionId !== undefined) {
    throw new Error("Free-text choice metadata contains a fixed option");
  }
  const state = requiredRecord(view.state);
  const values = requiredRecord(state.values);
  const block = requiredRecord(values[CHOICE_OTHER_BLOCK_ID]);
  const input = requiredRecord(block[CHOICE_OTHER_ACTION_ID]);
  const answer = requiredString(input.value).trim();
  if (answer.length < 1 || answer.length > 1_000) {
    throw new Error("Structured choice free text is invalid");
  }
  return { routing, userId, answer };
}

function encodeChoiceActionValue(value: ChoiceActionValue): string {
  return JSON.stringify(value);
}

function isSlackTs(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}\.\d{1,20}$/u.test(value);
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new Error("Slack structured choice is incomplete");
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000) {
    throw new Error("Slack structured choice is incomplete");
  }
  return value;
}

function countLiteralKey(value: string, key: string): number {
  const needle = JSON.stringify(key);
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
