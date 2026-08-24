import { randomUUID } from "node:crypto";

import { CoreError } from "../core/index.js";
import type { PolicyDecision } from "../config/schema.js";

export type PermissionApprovalDecision =
  | "allow_once"
  | "allow_session"
  | "deny"
  | "cancel";

export type PermissionApprovalSettlementReason =
  | PermissionApprovalDecision
  | "expired"
  | "caller_cancelled"
  | "coordinator_closed";

export interface PermissionApprovalSettlement {
  readonly requestId: string;
  readonly reason: PermissionApprovalSettlementReason;
  readonly resolvedBySlackUserId?: string;
}

export interface PermissionApprovalResolutionContext {
  readonly resolvedBySlackUserId?: string;
}

export interface PermissionApprovalPresentation {
  readonly requestId: string;
  readonly sourceAgentId: string;
  readonly sourceChannelId: string;
  readonly sourceRootThreadTs?: string;
  readonly sourceSlackUserId?: string;
  readonly operation: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly allowSessionGrant?: boolean;
}

export interface PermissionApprovalSlackContext {
  readonly rootThreadTs: string;
  readonly slackUserId?: string;
}

export interface PermissionApprovalRequest {
  readonly sourceAgentId: string;
  readonly sourceChannelId: string;
  readonly operation: string;
  readonly summary: string;
  /** Stable, host-generated scope. It is never accepted from an Agent tool call. */
  readonly grantKey: string;
  /** Set false for high-impact operations that must be approved every time. */
  readonly allowSessionGrant?: boolean;
  /** Exact process-owned Slack turn that initiated this operation. */
  readonly slackContext?: PermissionApprovalSlackContext;
}

export interface PermissionApprovalCoordinatorOptions {
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

interface PendingApproval {
  readonly request: PermissionApprovalRequest;
  readonly expiresAtMs: number;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (decision: "allow" | "deny") => void;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
}

/**
 * Converts a policy's `approval` outcome into one single-use Slack decision.
 * Session grants live only for the current Taishi process and never rewrite
 * config.yaml or survive a restart.
 */
export class PermissionApprovalCoordinator {
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #pending = new Map<string, PendingApproval>();
  readonly #sessionGrants = new Set<string>();
  #presenter:
    | ((request: PermissionApprovalPresentation) => Promise<void>)
    | undefined;
  #settlementPresenter:
    | ((settlement: PermissionApprovalSettlement) => Promise<void>)
    | undefined;
  readonly #settlementTasks = new Set<Promise<void>>();
  #closed = false;

  constructor(options: PermissionApprovalCoordinatorOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new TypeError("Permission approval timeout must be a positive integer");
    }
  }

  setPresenter(
    presenter: (request: PermissionApprovalPresentation) => Promise<void>,
  ): void {
    if (this.#closed) throw new Error("Permission approval coordinator is closed");
    this.#presenter = presenter;
  }

  setSettlementPresenter(
    presenter: (settlement: PermissionApprovalSettlement) => Promise<void>,
  ): void {
    if (this.#closed) throw new Error("Permission approval coordinator is closed");
    this.#settlementPresenter = presenter;
  }

  async authorize(
    policy: PolicyDecision,
    request: PermissionApprovalRequest,
    signal?: AbortSignal,
  ): Promise<"allow" | "deny"> {
    if (isAborted(signal)) return "deny";
    if (policy === "allow" || policy === "deny") return policy;
    if (this.#closed) return "deny";
    if (
      request.allowSessionGrant !== false &&
      this.#sessionGrants.has(request.grantKey)
    ) {
      return "allow";
    }
    const slackContext = validateSlackContext(request.slackContext);
    const presenter = this.#presenter;
    if (presenter === undefined) {
      throw new CoreError(
        "PERMISSION_APPROVAL_REQUIRED",
        "Human approval is required, but no Slack approval presenter is available",
      );
    }

    const requestId = `permission:${this.#idFactory()}`;
    const expiresAtMs = this.#now().getTime() + this.#timeoutMs;
    let resolveDecision!: (decision: "allow" | "deny") => void;
    const result = new Promise<"allow" | "deny">((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(
      () => this.#settle(requestId, "deny", "expired"),
      this.#timeoutMs,
    );
    const abortListener =
      signal === undefined
        ? undefined
        : () => this.#settle(requestId, "deny", "caller_cancelled");
    this.#pending.set(requestId, {
      request,
      expiresAtMs,
      timer,
      resolve: resolveDecision,
      ...(signal === undefined ? {} : { signal }),
      ...(abortListener === undefined ? {} : { abortListener }),
    });
    signal?.addEventListener("abort", abortListener ?? (() => undefined), {
      once: true,
    });
    if (isAborted(signal)) {
      this.#settle(requestId, "deny", "caller_cancelled");
      return result;
    }

    try {
      await presenter({
        requestId,
        sourceAgentId: request.sourceAgentId,
        sourceChannelId: request.sourceChannelId,
        ...(slackContext === undefined
          ? {}
          : {
              sourceRootThreadTs: slackContext.rootThreadTs,
              ...(slackContext.slackUserId === undefined
                ? {}
                : { sourceSlackUserId: slackContext.slackUserId }),
            }),
        operation: request.operation,
        summary: request.summary,
        expiresAt: new Date(expiresAtMs).toISOString(),
        allowSessionGrant: request.allowSessionGrant !== false,
      });
    } catch (error) {
      this.#settle(requestId, "deny", "caller_cancelled", undefined, false);
      if (isAborted(signal)) return result;
      throw error;
    }
    return result;
  }

  resolve(
    requestId: string,
    decision: PermissionApprovalDecision,
    context: PermissionApprovalResolutionContext = {},
  ): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      throw new CoreError(
        "UNKNOWN_APPROVAL_REQUEST",
        `Unknown or expired permission approval: ${requestId}`,
      );
    }
    if (this.#now().getTime() >= pending.expiresAtMs) {
      this.#settle(requestId, "deny", "expired");
      throw new CoreError(
        "UNKNOWN_APPROVAL_REQUEST",
        `Permission approval has expired: ${requestId}`,
      );
    }
    if (decision === "allow_session") {
      if (pending.request.allowSessionGrant === false) {
        throw new CoreError(
          "PERMISSION_DENIED",
          `Session approval is not allowed for ${pending.request.operation}`,
        );
      }
      this.#sessionGrants.add(pending.request.grantKey);
    }
    this.#settle(
      requestId,
      decision === "allow_once" || decision === "allow_session" ? "allow" : "deny",
      decision,
      context.resolvedBySlackUserId,
    );
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const requestId of [...this.#pending.keys()]) {
        this.#settle(requestId, "deny", "coordinator_closed");
      }
      this.#sessionGrants.clear();
    }
    await Promise.allSettled([...this.#settlementTasks]);
  }

  #settle(
    requestId: string,
    result: "allow" | "deny",
    reason: PermissionApprovalSettlementReason,
    resolvedBySlackUserId?: string,
    notify = true,
  ): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.abortListener !== undefined) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    this.#pending.delete(requestId);
    pending.resolve(result);
    if (notify) {
      this.#notifySettlement({
        requestId,
        reason,
        ...(resolvedBySlackUserId === undefined ? {} : { resolvedBySlackUserId }),
      });
    }
  }

  #notifySettlement(settlement: PermissionApprovalSettlement): void {
    const presenter = this.#settlementPresenter;
    if (presenter === undefined) return;
    const task = presenter(settlement)
      .catch(() => undefined)
      .finally(() => this.#settlementTasks.delete(task));
    this.#settlementTasks.add(task);
  }
}

function validateSlackContext(
  context: PermissionApprovalSlackContext | undefined,
): PermissionApprovalSlackContext | undefined {
  if (context === undefined) return undefined;
  if (!/^\d{1,20}\.\d{1,20}$/u.test(context.rootThreadTs)) {
    throw new TypeError("Slack root thread timestamp has an invalid format");
  }
  if (
    context.slackUserId !== undefined &&
    !/^[UW][A-Z0-9]{1,127}$/u.test(context.slackUserId)
  ) {
    throw new TypeError("Slack user ID has an invalid format");
  }
  return Object.freeze({ ...context });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
