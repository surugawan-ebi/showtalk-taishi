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
const RESERVED_APPROVE_LABEL = "承認して実行";
const RESERVED_REJECT_LABEL = "拒否保留";
const CODEX_RECOMMENDED_SUFFIX = " (Recommended)";
const EXTERNAL_ACTION_APPROVAL_QUESTION_ID = "external_action_approval";
const EXTERNAL_ACTION_APPROVAL_DISPLAY_HEADER =
  "外部操作の最終確認（Git承認ではありません）";
const EXTERNAL_ACTION_APPROVE_DISPLAY_LABEL = "外部操作を承認（Git承認ではありません）";
const EXTERNAL_ACTION_REJECT_DISPLAY_LABEL = "外部操作を拒否・保留";

interface ExternalActionApprovalDetails {
  readonly target: string;
  readonly scope: string;
  readonly impact: string;
}

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

export class MalformedExternalActionApprovalError extends Error {
  constructor() {
    super(
      "External action approval requires exactly one question and the fixed " +
        "approve and reject choices in order, non-empty option descriptions, " +
        "explicit Target, Scope, and Impact lines, and blocking mode",
    );
    this.name = "MalformedExternalActionApprovalError";
  }
}

/**
 * Identifies the fixed workspace-git approval prompt from protocol-level
 * signals. Ordinary question prose may discuss Git approvals without itself
 * granting or requesting publication authority.
 */
export function looksLikeWorkspaceGitApproval(value: unknown): boolean {
  const params = asRecord(value);
  const questions = params?.questions;
  if (!Array.isArray(questions)) return false;
  return questions.some((value) => {
    const question = asRecord(value);
    if (question === undefined) return false;
    if (question.id === "git_approval") return true;
    const options = question.options;
    if (!Array.isArray(options)) return false;
    return options.some((option) => {
      const label = asRecord(option)?.label;
      if (typeof label !== "string") return false;
      const normalized = normalizeApprovalLabel(label);
      return normalized === RESERVED_APPROVE_LABEL || normalized === RESERVED_REJECT_LABEL;
    });
  });
}

/**
 * The question ID is an authority-bearing Git signal. Outside the dedicated
 * non-Git external-action ID, reserved labels keep a brief same-turn window
 * open and then fail closed unless an exact plan arrives.
 */
export function hasWorkspaceGitApprovalQuestionId(value: unknown): boolean {
  const params = asRecord(value);
  const questions = params?.questions;
  return Array.isArray(questions) &&
    questions.some((question) => asRecord(question)?.id === "git_approval");
}

/** Identifies any request that claims the dedicated non-Git approval ID. */
export function hasExternalActionApprovalQuestionId(value: unknown): boolean {
  const params = asRecord(value);
  const questions = params?.questions;
  return Array.isArray(questions) &&
    questions.some(
      (question) => asRecord(question)?.id === EXTERNAL_ACTION_APPROVAL_QUESTION_ID,
    );
}

export function validateOrdinaryChoiceRequest(
  value: unknown,
): ValidatedChoiceRequest {
  const params = requiredRecord(value, "structured input request");
  if (typeof params.isBlocking !== "boolean") {
    throw new Error("Structured input blocking mode is invalid");
  }
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

  const externalActionApproval = hasExternalActionApprovalQuestionId(params);
  let externalActionDetails: ExternalActionApprovalDetails | undefined;
  if (externalActionApproval) {
    const question = asRecord(params.questions[0]);
    const options = question?.options;
    const approveDescription = Array.isArray(options)
      ? asRecord(options[0])?.description
      : undefined;
    const rejectDescription = Array.isArray(options)
      ? asRecord(options[1])?.description
      : undefined;
    externalActionDetails = parseExternalActionApprovalDetails(question?.question);
    if (
      params.isBlocking !== true ||
      params.questions.length !== 1 ||
      question?.id !== EXTERNAL_ACTION_APPROVAL_QUESTION_ID ||
      !Array.isArray(options) ||
      options.length !== 2 ||
      !isCodexExternalActionApproveLabel(asRecord(options[0])?.label) ||
      asRecord(options[1])?.label !== "拒否・保留" ||
      !isSafeExternalActionText(approveDescription) ||
      !isSafeExternalActionText(rejectDescription) ||
      externalActionDetails === undefined
    ) {
      throw new MalformedExternalActionApprovalError();
    }
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
    const isSecret = question.isSecret ?? false;
    const isOther = question.isOther ?? false;
    if (isSecret !== false) {
      throw new Error("Secret structured input is not supported in Slack");
    }
    if (typeof isOther !== "boolean") {
      throw new Error("Structured input Other option is invalid");
    }
    const questionHeader = boundedString(
      question.header,
      "question header",
      MAX_HEADER_LENGTH,
    );
    const questionPrompt = boundedString(
      question.question,
      "question prompt",
      MAX_PROMPT_LENGTH,
    );
    if (
      !Array.isArray(question.options) ||
      question.options.length < 2 ||
      question.options.length > MAX_OPTIONS
    ) {
      throw new Error("Ordinary structured input requires two or three fixed options");
    }
    // Default-mode Codex currently normalizes request_user_input to
    // isOther=true even when the caller requested only fixed options. Keep
    // accepting that wire shape, but never expose or accept free text for an
    // authority-bearing external-action confirmation.
    const labels = new Set<string>();
    const validatedOptions = question.options.map((option, optionIndex) => {
      const wireLabel = boundedString(
        option.label,
        "option label",
        MAX_LABEL_LENGTH,
      );
      const appServerLabel = externalActionApproval && optionIndex === 0
        ? RESERVED_APPROVE_LABEL
        : wireLabel;
      const normalizedLabel = normalizeApprovalLabel(appServerLabel);
      const label = externalActionApproval
        ? normalizedLabel === RESERVED_APPROVE_LABEL
          ? EXTERNAL_ACTION_APPROVE_DISPLAY_LABEL
          : normalizedLabel === RESERVED_REJECT_LABEL
            ? EXTERNAL_ACTION_REJECT_DISPLAY_LABEL
            : appServerLabel
        : appServerLabel;
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
          !externalActionApproval,
        ),
        appServerLabel,
      };
    });
    return {
      id: `question_${questionIndex + 1}`,
      appServerQuestionId,
      purpose: externalActionApproval
        ? "external_action_confirmation"
        : "ordinary",
      header: externalActionApproval
        ? EXTERNAL_ACTION_APPROVAL_DISPLAY_HEADER
        : questionHeader,
      prompt: externalActionApproval && externalActionDetails !== undefined
        ? boundedString(
            renderExternalActionApprovalDetails(externalActionDetails),
            "question prompt",
            MAX_PROMPT_LENGTH,
          )
        : questionPrompt,
      options: Object.freeze(validatedOptions),
      allowsOther: externalActionApproval ? false : isOther,
    } satisfies ValidatedChoiceQuestion;
  });

  const autoResolutionMs = params.autoResolutionMs;
  if (
    autoResolutionMs !== undefined &&
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

/**
 * Codex's generic request_user_input contract asks the recommended option to
 * carry this suffix. It has no authority meaning: Slack renders the canonical
 * fixed label and the App Server receives the canonical fixed answer.
 */
function isCodexExternalActionApproveLabel(value: unknown): value is string {
  return value === RESERVED_APPROVE_LABEL ||
    value === `${RESERVED_APPROVE_LABEL}${CODEX_RECOMMENDED_SUFFIX}`;
}

function parseExternalActionApprovalDetails(
  value: unknown,
): ExternalActionApprovalDetails | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.split(/\r?\n/u);
  if (lines.length !== 3) return undefined;
  const values = new Map<string, string>();
  for (const line of lines) {
    const match = /^(Target|Scope|Impact):\s*(\S(?:.*\S)?)\s*$/u.exec(line);
    if (match === null) return undefined;
    const [, field, detail] = match;
    if (
      field === undefined ||
      !isSafeExternalActionText(detail) ||
      values.has(field)
    ) {
      return undefined;
    }
    values.set(field, detail);
  }
  const target = values.get("Target");
  const scope = values.get("Scope");
  const impact = values.get("Impact");
  return target === undefined || scope === undefined || impact === undefined
    ? undefined
    : { target, scope, impact };
}

function renderExternalActionApprovalDetails(
  details: ExternalActionApprovalDetails,
): string {
  return [
    `対象: ${details.target}`,
    `範囲: ${details.scope}`,
    `影響: ${details.impact}`,
  ].join("\n");
}

function isSafeExternalActionText(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\p{Cc}\p{Cf}]/u.test(value);
}

function normalizeApprovalLabel(value: string): string {
  return value.normalize("NFKC").replace(
    /[\s\p{P}\p{S}\p{Default_Ignorable_Code_Point}]+/gu,
    "",
  );
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
