import type {
  AgentChoiceQuestion,
} from "../../core/index.js";
import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
} from "./protocol.js";

const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 3;
const MAX_ID_LENGTH = 128;
const MAX_HEADER_LENGTH = 150;
const MAX_PROMPT_LENGTH = 2_000;
const MAX_LABEL_LENGTH = 75;
const MAX_DESCRIPTION_LENGTH = 1_000;
const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;

export interface ValidatedChoiceQuestion extends AgentChoiceQuestion {
  readonly appServerQuestionId: string;
  readonly options: readonly (AgentChoiceQuestion["options"][number] & {
    readonly appServerLabel: string;
  })[];
}

export interface ValidatedChoiceRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly questions: readonly ValidatedChoiceQuestion[];
  readonly autoResolutionMs?: number;
}

/**
 * Identifies the fixed workspace-git approval prompt from protocol-level
 * signals. Ordinary question prose may discuss Git approvals without itself
 * granting or requesting publication authority.
 */
export function looksLikeWorkspaceGitApproval(value: unknown): boolean {
  const params = asRecord(value);
  const questions = params?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return false;
  const question = asRecord(questions[0]);
  if (question === undefined) return false;
  if (question.id === "git_approval") return true;
  const options = question.options;
  if (!Array.isArray(options)) return false;
  return options.some((option) => {
    const label = asRecord(option)?.label;
    if (typeof label !== "string") return false;
    const normalized = normalizeApprovalLabel(label);
    return normalized === "承認して実行" || normalized === "拒否保留";
  });
}

export function validateOrdinaryChoiceRequest(
  value: unknown,
): ValidatedChoiceRequest {
  const params = requiredRecord(value, "structured input request");
  const threadId = boundedString(params.threadId, "thread ID", MAX_ID_LENGTH);
  const turnId = boundedString(params.turnId, "turn ID", MAX_ID_LENGTH);
  const itemId = boundedString(params.itemId, "item ID", MAX_ID_LENGTH);
  if (
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > MAX_QUESTIONS
  ) {
    throw new Error("Ordinary structured input requires between one and three questions");
  }

  const appServerQuestionIds = new Set<string>();
  const questions = params.questions.map((value, questionIndex) => {
    const question = requiredRecord(value, "structured input question") as unknown as
      ToolRequestUserInputQuestion;
    const appServerQuestionId = boundedString(
      question.id,
      "question ID",
      MAX_ID_LENGTH,
    );
    if (appServerQuestionIds.has(appServerQuestionId)) {
      throw new Error("Structured input question IDs must be unique");
    }
    appServerQuestionIds.add(appServerQuestionId);
    if (question.isSecret !== false) {
      throw new Error("Secret structured input is not supported in Slack");
    }
    if (typeof question.isOther !== "boolean") {
      throw new Error("Structured input Other option is invalid");
    }
    if (
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > MAX_OPTIONS
    ) {
      throw new Error("Ordinary structured input requires two or three fixed options");
    }
    const labels = new Set<string>();
    const options = question.options.map((option, optionIndex) => {
      const label = boundedString(option.label, "option label", MAX_LABEL_LENGTH);
      const normalizedLabel = normalizeApprovalLabel(label);
      if (normalizedLabel === "承認して実行" || normalizedLabel === "拒否保留") {
        throw new Error("Git approval choices cannot be used as ordinary structured input");
      }
      if (labels.has(label)) {
        throw new Error("Structured input option labels must be unique");
      }
      labels.add(label);
      return {
        id: `option_${optionIndex + 1}`,
        label,
        description: boundedString(
          option.description,
          "option description",
          MAX_DESCRIPTION_LENGTH,
          true,
        ),
        appServerLabel: label,
      };
    });
    return {
      id: `question_${questionIndex + 1}`,
      appServerQuestionId,
      header: boundedString(question.header, "question header", MAX_HEADER_LENGTH),
      prompt: boundedString(question.question, "question prompt", MAX_PROMPT_LENGTH),
      options: Object.freeze(options),
      allowsOther: question.isOther,
    } satisfies ValidatedChoiceQuestion;
  });

  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== null &&
    (typeof autoResolutionMs !== "number" ||
      !Number.isSafeInteger(autoResolutionMs) ||
      autoResolutionMs < MIN_AUTO_RESOLUTION_MS ||
      autoResolutionMs > MAX_AUTO_RESOLUTION_MS)
  ) {
    throw new Error("Structured input auto-resolution is invalid");
  }

  return {
    threadId,
    turnId,
    itemId,
    questions: Object.freeze(questions),
    ...(typeof autoResolutionMs === "number" ? { autoResolutionMs } : {}),
  } satisfies ValidatedChoiceRequest;
}

function normalizeApprovalLabel(value: string): string {
  return value.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new Error(`${label} must be an object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maxLength
  ) {
    throw new Error(`Structured input ${label} is invalid`);
  }
  return value;
}

// Compile-time guard: this parser intentionally follows the installed
// ToolRequestUserInputParams shape without exporting Codex protocol types.
const _paramsShape: ToolRequestUserInputParams | undefined = undefined;
void _paramsShape;
