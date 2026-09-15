import { randomUUID } from "node:crypto";

import type { ActionsBlock, KnownBlock, ModalView } from "@slack/types";

import type {
  AgentChoiceCompletedAnswer,
  AgentChoiceQuestion,
} from "../core/index.js";

export const CHOICE_CONTINUATION_ACTION_PREFIX = "taishi.choice_continue.";
export const CHOICE_CONTINUATION_VIEW_CALLBACK_ID = "taishi.choice_continue.other";
const OTHER_BLOCK_ID = "choice_continue_other_answer";
const OTHER_ACTION_ID = "choice_continue_other_text";
const MAX_RETAINED = 256;

export interface StructuredChoiceDisplay {
  readonly requestId: string;
  readonly sessionId: string;
  readonly question: AgentChoiceQuestion;
  readonly completedAnswers: readonly AgentChoiceCompletedAnswer[];
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly responderUserId?: string;
  readonly expiresAt: number;
}

export interface StructuredChoiceContinuation extends StructuredChoiceDisplay {
  readonly continuationId: string;
  state: "pending" | "in_progress" | "consumed";
}

export class StructuredChoiceContinuationStore {
  readonly #displayedByRequestId = new Map<string, StructuredChoiceDisplay>();
  readonly #continuationsById = new Map<string, StructuredChoiceContinuation>();
  readonly #continuationIdByRequestId = new Map<string, string>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  rememberDisplayed(display: StructuredChoiceDisplay): void {
    this.#prune();
    this.#displayedByRequestId.set(display.requestId, freezeDisplay(display));
  }

  forgetDisplayed(requestId: string, messageTs?: string): void {
    const current = this.#displayedByRequestId.get(requestId);
    if (current === undefined) return;
    if (messageTs !== undefined && current.messageTs !== messageTs) return;
    this.#displayedByRequestId.delete(requestId);
  }

  getDisplayed(requestId: string): StructuredChoiceDisplay | undefined {
    this.#prune();
    return this.#displayedByRequestId.get(requestId);
  }

  resolveExternally(requestId: string): StructuredChoiceContinuation | undefined {
    this.#prune();
    const existingId = this.#continuationIdByRequestId.get(requestId);
    if (existingId !== undefined) return this.#continuationsById.get(existingId);
    const display = this.#displayedByRequestId.get(requestId);
    if (display === undefined || display.expiresAt <= this.#now()) return undefined;
    this.#displayedByRequestId.delete(requestId);
    if (display.question.purpose === "external_action_confirmation") {
      return undefined;
    }
    const continuation: StructuredChoiceContinuation = {
      ...display,
      continuationId: `choice-continuation:${randomUUID()}`,
      state: "pending",
    };
    this.#continuationsById.set(continuation.continuationId, continuation);
    this.#continuationIdByRequestId.set(requestId, continuation.continuationId);
    this.#prune();
    return continuation;
  }

  get(continuationId: string): StructuredChoiceContinuation | undefined {
    this.#prune();
    return this.#continuationsById.get(continuationId);
  }

  getForOriginalRequest(requestId: string): StructuredChoiceContinuation | undefined {
    this.#prune();
    const continuationId = this.#continuationIdByRequestId.get(requestId);
    return continuationId === undefined
      ? undefined
      : this.#continuationsById.get(continuationId);
  }

  begin(continuationId: string): StructuredChoiceContinuation {
    const continuation = this.get(continuationId);
    if (continuation === undefined) {
      throw new Error("This structured choice continuation is unavailable or expired");
    }
    if (continuation.state !== "pending") {
      throw new Error("This structured choice continuation was already handled");
    }
    continuation.state = "in_progress";
    return continuation;
  }

  consume(continuationId: string): void {
    const continuation = this.#continuationsById.get(continuationId);
    if (continuation !== undefined) continuation.state = "consumed";
  }

  #prune(): void {
    const now = this.#now();
    for (const [requestId, display] of this.#displayedByRequestId) {
      if (display.expiresAt <= now) this.#displayedByRequestId.delete(requestId);
    }
    for (const [continuationId, continuation] of this.#continuationsById) {
      if (continuation.expiresAt > now) continue;
      this.#continuationsById.delete(continuationId);
      this.#continuationIdByRequestId.delete(continuation.requestId);
    }
    while (this.#displayedByRequestId.size > MAX_RETAINED) {
      const oldestRequestId = this.#displayedByRequestId.keys().next().value as
        | string
        | undefined;
      if (oldestRequestId === undefined) break;
      this.#displayedByRequestId.delete(oldestRequestId);
    }
    while (this.#continuationsById.size > MAX_RETAINED) {
      const oldestId = this.#continuationsById.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      const oldest = this.#continuationsById.get(oldestId);
      this.#continuationsById.delete(oldestId);
      if (oldest !== undefined) this.#continuationIdByRequestId.delete(oldest.requestId);
    }
  }
}

export function buildChoiceContinuationBlocks(
  continuation: StructuredChoiceContinuation,
): KnownBlock[] {
  if (continuation.question.purpose === "external_action_confirmation") {
    throw new Error("External action approval cannot continue as an ordinary turn");
  }
  const body = [
    "*Codex側の元の質問は先に終了しました*",
    continuation.completedAnswers.length === 0
      ? "この選択を通常の新しいターンとして送信できます。"
      : `先に回答した${continuation.completedAnswers.length}件も保持して、通常の新しいターンとして送信できます。`,
    `*${escapeSlack(continuation.question.header)}*`,
    escapeSlack(continuation.question.prompt),
  ].join("\n\n");
  const elements: ActionsBlock["elements"] = continuation.question.options.map(
    (option) => ({
      type: "button",
      text: { type: "plain_text", text: truncate(option.label, 75), emoji: true },
      action_id: `${CHOICE_CONTINUATION_ACTION_PREFIX}select.${option.id}`,
      value: continuation.continuationId,
    }),
  );
  if (continuation.question.allowsOther) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "その他を入力", emoji: true },
      action_id: `${CHOICE_CONTINUATION_ACTION_PREFIX}other`,
      value: continuation.continuationId,
    });
  }
  return [
    { type: "section", text: { type: "mrkdwn", text: truncate(body, 2_900) } },
    { type: "actions", elements },
  ];
}

export function parseChoiceContinuationActionId(actionId: string):
  | { readonly kind: "select"; readonly optionId: string }
  | { readonly kind: "other" }
  | undefined {
  if (!actionId.startsWith(CHOICE_CONTINUATION_ACTION_PREFIX)) return undefined;
  const value = actionId.slice(CHOICE_CONTINUATION_ACTION_PREFIX.length);
  if (value === "other") return { kind: "other" };
  const selected = /^select\.(option_[1-3])$/u.exec(value);
  return selected === null
    ? undefined
    : { kind: "select", optionId: selected[1]! };
}

export function parseChoiceContinuationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^choice-continuation:[0-9a-f-]{36}$/iu.test(value)
  ) {
    throw new Error("Invalid structured choice continuation");
  }
  return value;
}

export function buildChoiceContinuationOtherModal(
  continuationId: string,
  header: string,
): ModalView {
  return {
    type: "modal",
    callback_id: CHOICE_CONTINUATION_VIEW_CALLBACK_ID,
    private_metadata: parseChoiceContinuationId(continuationId),
    title: { type: "plain_text", text: truncate(header, 24), emoji: true },
    submit: { type: "plain_text", text: "回答する", emoji: true },
    close: { type: "plain_text", text: "戻る", emoji: true },
    blocks: [{
      type: "input",
      block_id: OTHER_BLOCK_ID,
      label: { type: "plain_text", text: "その他の回答", emoji: true },
      element: {
        type: "plain_text_input",
        action_id: OTHER_ACTION_ID,
        multiline: true,
        min_length: 1,
        max_length: 1_000,
      },
    }],
  };
}

export function parseChoiceContinuationOtherSubmission(body: unknown): {
  readonly continuationId: string;
  readonly userId: string;
  readonly answer: string;
} {
  const record = requiredRecord(body);
  if (record.type !== "view_submission") throw new Error("Slack interaction type is not trusted");
  const userId = requiredString(requiredRecord(record.user).id);
  const view = requiredRecord(record.view);
  if (view.callback_id !== CHOICE_CONTINUATION_VIEW_CALLBACK_ID) {
    throw new Error("Unexpected structured choice continuation modal");
  }
  const continuationId = parseChoiceContinuationId(view.private_metadata);
  const values = requiredRecord(requiredRecord(view.state).values);
  const answer = requiredString(
    requiredRecord(requiredRecord(values[OTHER_BLOCK_ID])[OTHER_ACTION_ID]).value,
  ).trim();
  if (answer.length < 1 || answer.length > 1_000) {
    throw new Error("Structured choice continuation text is invalid");
  }
  return { continuationId, userId, answer };
}

function freezeDisplay(display: StructuredChoiceDisplay): StructuredChoiceDisplay {
  return Object.freeze({
    ...display,
    completedAnswers: Object.freeze(display.completedAnswers.map((completed) =>
      Object.freeze({
        ...completed,
        answers: Object.freeze([...completed.answers]),
      })
    )),
    question: Object.freeze({
      ...display.question,
      options: Object.freeze(display.question.options.map((option) => Object.freeze({ ...option }))),
    }),
  });
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Slack structured choice continuation is incomplete");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_000) {
    throw new Error("Slack structured choice continuation is incomplete");
  }
  return value;
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
