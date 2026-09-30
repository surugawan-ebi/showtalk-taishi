import type { RpcId } from "./protocol.js";

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

/**
 * Keeps only short-lived, opaque correlation receipts for structured-input
 * responses. Raw stderr, prompts, answers, and RPC payloads never leave this
 * classifier.
 */
export class UserInputDeliveryTracker<T> {
  readonly #receipts = new Map<string, {
    readonly rpcId: RpcId;
    readonly receipt: T;
  }>();
  #stderrRemainder = "";

  record(rpcId: RpcId, receipt: T): void {
    const key = rpcKey(rpcId);
    if (this.#receipts.has(key)) {
      throw new Error("Structured-input delivery receipt already exists");
    }
    this.#receipts.set(key, { rpcId, receipt });
  }

  markServerResolved(rpcId: RpcId): T | undefined {
    return this.#receipts.get(rpcKey(rpcId))?.receipt;
  }

  remove(rpcId: RpcId): T | undefined {
    const key = rpcKey(rpcId);
    const current = this.#receipts.get(key);
    this.#receipts.delete(key);
    return current?.receipt;
  }

  removeWhere(predicate: (receipt: T) => boolean): void {
    for (const [key, current] of this.#receipts) {
      if (predicate(current.receipt)) this.#receipts.delete(key);
    }
  }

  observeStderr(chunk: string): readonly UserInputDeliveryObservation<T>[] {
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
