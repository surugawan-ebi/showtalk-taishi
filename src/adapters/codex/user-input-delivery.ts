import type { RpcId, ToolRequestUserInputResponse } from "./protocol.js";

export type UserInputDeliveryFailureReason =
  | "transport_write_failed"
  | "client_error"
  | "response_receiver_dropped"
  | "response_deserialize_failed";

export type UserInputDeliveryObservation<T> = {
  readonly receipt: T;
  readonly reason: Exclude<
    UserInputDeliveryFailureReason,
    "transport_write_failed"
  >;
} | {
  readonly receipt?: undefined;
  readonly reason: Exclude<
    UserInputDeliveryFailureReason,
    "transport_write_failed"
  >;
};

const DEFAULT_RECEIPT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_RECEIPT_LIMIT = 1_024;

export interface UserInputDeliveryTrackerOptions {
  /** Correlation window measured from the successful response write attempt. */
  readonly receiptTtlMs?: number;
  /** Hard cap across all still-correlatable response receipts. */
  readonly receiptLimit?: number;
  /** Test seam for deterministic expiry checks. */
  readonly now?: () => number;
}

/**
 * Keeps only short-lived, opaque correlation receipts for structured-input
 * responses. Raw stderr, prompts, answers, and RPC payloads never leave this
 * classifier.
 */
export class UserInputDeliveryTracker<T> {
  readonly #receipts = new Map<string, {
    readonly rpcId: RpcId;
    readonly receipt: T;
    readonly expiresAt: number;
  }>();
  readonly #receiptTtlMs: number;
  readonly #receiptLimit: number;
  readonly #now: () => number;
  #stderrRemainder = "";

  constructor(options: UserInputDeliveryTrackerOptions = {}) {
    this.#receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.#receiptLimit = options.receiptLimit ?? DEFAULT_RECEIPT_LIMIT;
    this.#now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.#receiptTtlMs) ||
      this.#receiptTtlMs < 1 ||
      !Number.isSafeInteger(this.#receiptLimit) ||
      this.#receiptLimit < 1
    ) {
      throw new TypeError(
        "Structured-input delivery receipt bounds must be positive integers",
      );
    }
  }

  record(rpcId: RpcId, receipt: T): void {
    const now = this.#now();
    this.#pruneExpired(now);
    const key = rpcKey(rpcId);
    if (this.#receipts.has(key)) {
      throw new Error("Structured-input delivery receipt already exists");
    }
    this.#receipts.set(key, {
      rpcId,
      receipt,
      expiresAt: now + this.#receiptTtlMs,
    });
    while (this.#receipts.size > this.#receiptLimit) {
      const oldest = this.#receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#receipts.delete(oldest);
    }
  }

  markServerResolved(rpcId: RpcId): T | undefined {
    this.#pruneExpired(this.#now());
    return this.#receipts.get(rpcKey(rpcId))?.receipt;
  }

  remove(rpcId: RpcId): T | undefined {
    const key = rpcKey(rpcId);
    const current = this.#receipts.get(key);
    this.#receipts.delete(key);
    return current?.receipt;
  }

  removeWhere(predicate: (receipt: T) => boolean): void {
    this.#pruneExpired(this.#now());
    for (const [key, current] of this.#receipts) {
      if (predicate(current.receipt)) this.#receipts.delete(key);
    }
  }

  observeStderr(chunk: string): readonly UserInputDeliveryObservation<T>[] {
    this.#pruneExpired(this.#now());
    if (chunk.length === 0) return [];
    const bounded = `${this.#stderrRemainder}${chunk}`.slice(-16_384);
    const lines = bounded.split(/\r?\n/u);
    this.#stderrRemainder = lines.pop() ?? "";
    return lines.flatMap((line) => {
      const reason = classifyUserInputDeliveryFailure(line);
      if (reason === undefined) return [];
      const current = this.#correlate(line);
      if (current === undefined) return [{ reason }];
      this.#receipts.delete(rpcKey(current.rpcId));
      return [{ receipt: current.receipt, reason }];
    });
  }

  #correlate(line: string): {
    readonly rpcId: RpcId;
    readonly receipt: T;
  } | undefined {
    const receipts = [...this.#receipts.values()];
    const explicitlyMatched = receipts.filter(({ rpcId }) =>
      stderrMentionsRpcId(line, rpcId)
    );
    if (explicitlyMatched.length === 1) return explicitlyMatched[0];
    return undefined;
  }

  #pruneExpired(now: number): void {
    for (const [key, current] of this.#receipts) {
      if (current.expiresAt <= now) this.#receipts.delete(key);
    }
  }
}

export function classifyUserInputDeliveryFailure(
  line: string,
): UserInputDeliveryObservation<unknown>["reason"] | undefined {
  if (line.includes("failed to deserialize ToolRequestUserInputResponse")) {
    return "response_deserialize_failed";
  }
  if (
    line.includes("could not notify callback for") &&
    line.includes("receiver dropped")
  ) {
    return "response_receiver_dropped";
  }
  if (
    line.includes("client responded with error for") &&
    (line.includes("item/tool/requestUserInput") ||
      line.includes("ToolRequestUserInput"))
  ) {
    return "client_error";
  }
  return undefined;
}

/**
 * Classifies only the response shape. Question IDs and answer values are never
 * returned or logged by this diagnostic boundary.
 */
export function classifyUserInputResponseShape(
  response: ToolRequestUserInputResponse,
): "answers_nonempty" | "answers_empty" {
  const entries = Object.values(response.answers);
  return entries.length > 0 &&
      entries.every((answer) => answer.answers.length > 0)
    ? "answers_nonempty"
    : "answers_empty";
}

function stderrMentionsRpcId(line: string, rpcId: RpcId): boolean {
  const id = escapeRegExp(String(rpcId));
  return new RegExp(
    "(?:callback\\s+for|request(?:_?id)?\\s*[=:])\\s*[\"']?" +
      id +
      "(?=[\"':,}\\]\\s]|$)",
    "iu",
  ).test(line);
}

function rpcKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]{}\\]/gu, "\\$&");
}
