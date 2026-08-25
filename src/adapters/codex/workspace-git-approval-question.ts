import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
} from "./protocol.js";

const APPROVE_LABEL = "承認して実行";
const REJECT_LABEL = "拒否・保留";
const MIN_AUTO_RESOLUTION_MS = 60_000;
const MAX_AUTO_RESOLUTION_MS = 240_000;

export interface ValidatedPlanQuestion {
  readonly questionId: string;
  readonly prompt: string;
  readonly approveLabel: typeof APPROVE_LABEL;
  readonly rejectLabel: typeof REJECT_LABEL;
  readonly autoResolutionMs?: number;
}

/** Validates the fixed App Server question used for one exact Git plan. */
export function validateWorkspaceGitPlanQuestion(
  value: unknown,
): ValidatedPlanQuestion {
  const params = requiredRecord(value, "user input request");
  const questions = params.questions;
  if (!Array.isArray(questions) || questions.length !== 1) {
    throw new Error("Git plan approval requires exactly one structured question");
  }
  const question = requiredRecord(questions[0], "question") as unknown as
    ToolRequestUserInputQuestion;
  if (
    typeof question.id !== "string" ||
    question.id.length < 1 ||
    question.id.length > 128 ||
    typeof question.question !== "string" ||
    question.question.length < 1 ||
    question.question.length > 2_000 ||
    typeof question.isOther !== "boolean" ||
    question.isSecret !== false ||
    !Array.isArray(question.options) ||
    question.options.length !== 2 ||
    question.options[0]?.label !== APPROVE_LABEL ||
    question.options[1]?.label !== REJECT_LABEL
  ) {
    throw new Error("Git plan approval question has unsupported choices");
  }
  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== null &&
    (typeof autoResolutionMs !== "number" ||
      !Number.isSafeInteger(autoResolutionMs) ||
      autoResolutionMs < MIN_AUTO_RESOLUTION_MS ||
      autoResolutionMs > MAX_AUTO_RESOLUTION_MS)
  ) {
    throw new Error("Git plan approval auto-resolution is invalid");
  }
  return {
    questionId: question.id,
    prompt: question.question,
    approveLabel: APPROVE_LABEL,
    rejectLabel: REJECT_LABEL,
    ...(typeof autoResolutionMs === "number" ? { autoResolutionMs } : {}),
  };
}

/** Reads only the App Server turn identity needed by the approval binder. */
export function toolRequestUserInputParams(
  value: unknown,
): ToolRequestUserInputParams {
  const params = requiredRecord(value, "user input request");
  if (
    typeof params.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.itemId !== "string"
  ) {
    throw new Error("Structured input request is missing its turn identity");
  }
  return params as unknown as ToolRequestUserInputParams;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`workspace-git ${label} is invalid`);
  }
  return value as Record<string, unknown>;
}
