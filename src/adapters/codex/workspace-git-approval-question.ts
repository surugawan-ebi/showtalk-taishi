import type {
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
} from "./protocol.js";

const APPROVE_LABEL = "承認して実行";
const REJECT_LABEL = "拒否・保留";
const CODEX_RECOMMENDED_SUFFIX = " (Recommended)";
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
  if (params.isBlocking !== true) {
    throw new Error("Git plan approval must use blocking mode");
  }
  const questions = params.questions;
  if (!Array.isArray(questions) || questions.length !== 1) {
    throw new Error("Git plan approval requires exactly one structured question");
  }
  const question = requiredRecord(questions[0], "question") as unknown as
    ToolRequestUserInputQuestion;
  // Codex can normalize request_user_input questions to isOther=true. ShowTalk
  // never exposes or accepts free-form Git approval, and the authority-bearing
  // request itself must remain blocking until Slack returns one fixed answer.
  const isOther = question.isOther ?? false;
  const isSecret = question.isSecret ?? false;
  if (
    question.id !== "git_approval" ||
    typeof question.question !== "string" ||
    question.question.length < 1 ||
    question.question.length > 2_000 ||
    typeof isOther !== "boolean" ||
    isSecret !== false ||
    !Array.isArray(question.options) ||
    question.options.length !== 2 ||
    !isApproveLabel(question.options[0]?.label) ||
    question.options[1]?.label !== REJECT_LABEL
  ) {
    throw new Error("Git plan approval question has unsupported choices");
  }
  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== undefined &&
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

function isApproveLabel(value: unknown): value is string {
  return value === APPROVE_LABEL ||
    value === `${APPROVE_LABEL}${CODEX_RECOMMENDED_SUFFIX}`;
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
