import type { AgentApproval } from "../core/index.js";
import type { ChoiceActionRouting } from "./choice-blocks.js";
import type { UserInputActionValue } from "./user-input-blocks.js";

const MAX_ENTRIES = 1_024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const CHANNEL_ID = /^[CGD][A-Z0-9]{1,127}$/u;
const USER_ID = /^[UW][A-Z0-9]{1,127}$/u;
const TIMESTAMP = /^[0-9]{1,20}\.[0-9]{1,20}$/u;
const NATIVE_DECISIONS = new Set<AgentApproval["decision"]>([
  "allow_once", "allow_session", "allow_command_rule", "deny", "cancel",
]);

interface ApprovalTextRoute {
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly expiresAt: number;
}

export type TextApprovalEntry = ApprovalTextRoute & (
  | {
    readonly kind: "native";
    readonly sessionId?: string;
    readonly availableDecisions: readonly AgentApproval["decision"][];
  }
  | { readonly kind: "git"; readonly routing: UserInputActionValue }
  | {
    readonly kind: "external";
    readonly routing: ChoiceActionRouting;
    readonly approveOptionId: string;
    readonly rejectOptionId: string;
  }
  | { readonly kind: "permission" }
);

interface ApprovalTextCommandRoute {
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly userId: string;
  readonly messageTs: string;
}

interface StoredApproval {
  readonly expiresAt: number;
  // A duplicate ID leaves a bounded tombstone until expiry, so a subsequent
  // post cannot revive the ambiguous request.
  readonly entry?: TextApprovalEntry;
}

/**
 * Process-local routes for successfully displayed approval cards only.
 * Callers register after Slack posting succeeds and remove terminal requests.
 * Backend approval stores remain responsible for one-shot settlement.
 */
export class ApprovalTextStore {
  readonly #entries = new Map<string, StoredApproval>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  remember(entry: TextApprovalEntry): void {
    const now = this.#currentTime();
    this.#prune(now);
    validateEntry(entry, now);
    const existing = this.#entries.get(entry.requestId);
    if (existing !== undefined) {
      this.#entries.set(entry.requestId, {
        expiresAt: Math.max(existing.expiresAt, entry.expiresAt),
      });
      throw new Error("Duplicate active approval request ID");
    }
    if (this.#entries.size >= MAX_ENTRIES) {
      throw new Error("Too many displayed approval requests");
    }
    this.#entries.set(entry.requestId, {
      expiresAt: entry.expiresAt,
      entry: freezeEntry(entry),
    });
  }

  forget(requestId: string): void {
    this.#entries.delete(requestId);
  }

  get(requestId: string): TextApprovalEntry | undefined {
    this.#prune(this.#currentTime());
    return this.#entries.get(requestId)?.entry;
  }

  getForCommand(
    command: ApprovalTextCommandRoute,
    approvers: ReadonlySet<string>,
  ): TextApprovalEntry {
    validateCommand(command);
    const entry = this.get(command.requestId);
    if (entry === undefined) {
      throw new Error("Displayed approval request is unavailable or expired");
    }
    if (
      command.channelId !== entry.channelId ||
      command.rootThreadTs !== entry.rootThreadTs
    ) {
      throw new Error("Approval reply does not match the displayed card route");
    }
    if (!approvers.has(command.userId)) {
      throw new Error("Approval reply author is not a configured approver");
    }
    if (
      entry.kind === "external" &&
      entry.routing.responderUserId !== undefined &&
      entry.routing.responderUserId !== command.userId
    ) {
      throw new Error("Approval reply author is not the bound responder");
    }
    if (compareTimestamps(command.messageTs, entry.messageTs) <= 0) {
      throw new Error("Approval reply must follow the displayed card");
    }
    if (timestampMillis(command.messageTs) >= entry.expiresAt) {
      throw new Error("Approval reply was sent after the approval expired");
    }
    return entry;
  }

  #currentTime(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new Error("Invalid approval clock");
    return now;
  }

  #prune(now: number): void {
    for (const [requestId, stored] of this.#entries) {
      if (now >= stored.expiresAt) this.#entries.delete(requestId);
    }
  }
}

function validateEntry(entry: TextApprovalEntry, now: number): void {
  if (
    !matches(entry.requestId, REQUEST_ID) ||
    !matches(entry.channelId, CHANNEL_ID) ||
    !isTimestamp(entry.rootThreadTs) ||
    !isTimestamp(entry.messageTs) ||
    !Number.isFinite(entry.expiresAt) ||
    entry.expiresAt <= now ||
    timestampMillis(entry.messageTs) >= entry.expiresAt ||
    compareTimestamps(entry.messageTs, entry.rootThreadTs) < 0
  ) {
    throw new Error("Invalid displayed approval route or expiry");
  }
  if (entry.kind === "native") {
    if (
      (entry.sessionId !== undefined && !matches(entry.sessionId, REQUEST_ID)) ||
      !Array.isArray(entry.availableDecisions) ||
      entry.availableDecisions.length < 1 ||
      entry.availableDecisions.length > NATIVE_DECISIONS.size ||
      entry.availableDecisions.some((decision) => !NATIVE_DECISIONS.has(decision)) ||
      new Set(entry.availableDecisions).size !== entry.availableDecisions.length
    ) {
      throw new Error("Invalid native approval decisions or session");
    }
    return;
  }
  if (entry.kind === "permission") return;
  if (entry.kind !== "git" && entry.kind !== "external") {
    throw new Error("Invalid displayed approval kind");
  }
  const routing = entry.routing;
  if (
    routing === undefined ||
    routing.version !== 1 ||
    routing.requestId !== entry.requestId ||
    routing.channelId !== entry.channelId ||
    routing.rootThreadTs !== entry.rootThreadTs ||
    routing.messageTs !== entry.messageTs
  ) {
    throw new Error("Displayed approval routing is inconsistent");
  }
  if (entry.kind === "external") {
    if (
      entry.routing.purpose !== "external_action_confirmation" ||
      !matches(entry.routing.questionId, /^question_[1-3]$/u) ||
      !matches(entry.approveOptionId, /^option_[1-3]$/u) ||
      !matches(entry.rejectOptionId, /^option_[1-3]$/u) ||
      entry.approveOptionId === entry.rejectOptionId ||
      (entry.routing.responderUserId !== undefined &&
        !matches(entry.routing.responderUserId, USER_ID))
    ) {
      throw new Error("Invalid external approval routing or options");
    }
  }
}

function validateCommand(command: ApprovalTextCommandRoute): void {
  if (
    !matches(command.requestId, REQUEST_ID) ||
    !matches(command.channelId, CHANNEL_ID) ||
    !matches(command.userId, USER_ID) ||
    !isTimestamp(command.rootThreadTs) ||
    !isTimestamp(command.messageTs)
  ) {
    throw new Error("Invalid approval reply route");
  }
}

function freezeEntry(entry: TextApprovalEntry): TextApprovalEntry {
  switch (entry.kind) {
    case "native":
      return Object.freeze({
        ...entry,
        availableDecisions: Object.freeze([...entry.availableDecisions]),
      });
    case "git":
      return Object.freeze({ ...entry, routing: Object.freeze({ ...entry.routing }) });
    case "external":
      return Object.freeze({ ...entry, routing: Object.freeze({ ...entry.routing }) });
    case "permission":
      return Object.freeze({ ...entry });
  }
}

function matches(value: unknown, pattern: RegExp): value is string {
  // Unlike RegExp.test, full-match equality excludes a trailing newline even
  // when JavaScript's `$` anchor would accept it.
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && matches(value, TIMESTAMP);
}

function timestampMillis(value: string): number {
  return Number(value) * 1_000;
}

function compareTimestamps(left: string, right: string): number {
  const [leftSeconds, leftFraction] = left.split(".") as [string, string];
  const [rightSeconds, rightFraction] = right.split(".") as [string, string];
  const secondsDifference = BigInt(leftSeconds) - BigInt(rightSeconds);
  if (secondsDifference !== 0n) return secondsDifference > 0n ? 1 : -1;
  const fractionsDifference =
    BigInt(leftFraction.padEnd(20, "0")) - BigInt(rightFraction.padEnd(20, "0"));
  return fractionsDifference === 0n ? 0 : fractionsDifference > 0n ? 1 : -1;
}
