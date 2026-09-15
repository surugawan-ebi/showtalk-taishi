import type { PendingWorkspaceGitSystemRejection } from "../core/index.js";
import type {
  WorkspaceGitDecisionBroker,
  WorkspaceGitDecisionPlan,
} from "./workspace-git-decision-broker.js";
import { isWorkspaceGitDecisionBrokerError } from "./workspace-git-decision-broker.js";

const MAX_PENDING_REJECTIONS = 1_024;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000] as const;

export type WorkspaceGitSystemRejectionActor =
  PendingWorkspaceGitSystemRejection["actor"];

export interface WorkspaceGitSystemRejectionRecorder {
  recordRejection(
    plan: WorkspaceGitDecisionPlan,
    actor: WorkspaceGitSystemRejectionActor,
  ): Promise<void>;
}

interface CoordinatorOptions {
  readonly broker: WorkspaceGitDecisionBroker;
  readonly initialRecords?: readonly PendingWorkspaceGitSystemRejection[];
  readonly persist: (
    records: readonly PendingWorkspaceGitSystemRejection[],
  ) => Promise<void>;
  readonly now?: () => number;
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
  readonly onRetryError?: (
    error: unknown,
    record: PendingWorkspaceGitSystemRejection,
  ) => void;
}

interface RejectionAttemptOutcome {
  readonly conflictingError?: unknown;
}

/**
 * Durably writes a fail-closed intent before releasing an invisible App Server
 * approval request. Transient broker failures are retried across turns and
 * process restarts until the exact workspace-git plan expires.
 */
export class WorkspaceGitSystemRejectionCoordinator
  implements WorkspaceGitSystemRejectionRecorder
{
  readonly #broker: WorkspaceGitDecisionBroker;
  readonly #persist: CoordinatorOptions["persist"];
  readonly #now: () => number;
  readonly #scheduleTask: NonNullable<CoordinatorOptions["schedule"]>;
  readonly #onRetryError: CoordinatorOptions["onRetryError"];
  readonly #records = new Map<string, PendingWorkspaceGitSystemRejection>();
  readonly #cancelRetry = new Map<string, () => void>();
  readonly #attempts = new Map<string, number>();
  readonly #running = new Map<string, Promise<RejectionAttemptOutcome>>();
  #mutationQueue: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: CoordinatorOptions) {
    this.#broker = options.broker;
    this.#persist = options.persist;
    this.#now = options.now ?? Date.now;
    this.#scheduleTask = options.schedule ?? defaultSchedule;
    this.#onRetryError = options.onRetryError;
    for (const record of options.initialRecords ?? []) {
      this.#remember(record);
    }
  }

  start(): void {
    if (this.#closed) return;
    for (const key of this.#records.keys()) this.#schedule(key, 0);
  }

  async recordRejection(
    plan: WorkspaceGitDecisionPlan,
    actor: WorkspaceGitSystemRejectionActor,
  ): Promise<void> {
    if (this.#closed) {
      throw new Error("workspace-git system rejection coordinator is closed");
    }
    const record = rejectionRecord(plan, actor);
    const key = rejectionKey(record);
    await this.#mutate(async () => {
      const existing = this.#records.get(key);
      if (existing !== undefined && !sameRejection(existing, record)) {
        throw new Error(
          "Conflicting workspace-git system rejection is already queued",
        );
      }
      if (existing === undefined) {
        if (this.#records.size >= MAX_PENDING_REJECTIONS) {
          throw new Error("Too many workspace-git system rejections are pending");
        }
        this.#records.set(key, record);
        try {
          await this.#persistSnapshot();
        } catch (error) {
          this.#records.delete(key);
          throw error;
        }
      }
    });

    // Once the intent is durable, a transient private-broker failure must not
    // strand or abort the Codex turn. The queued record owns subsequent retry.
    await this.#attempt(key, true);
  }

  listPending(): readonly PendingWorkspaceGitSystemRejection[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const cancel of this.#cancelRetry.values()) cancel();
    this.#cancelRetry.clear();
    await Promise.allSettled(this.#running.values());
    await this.#mutationQueue;
  }

  async #attempt(
    key: string,
    surfaceConflictingFailure = false,
  ): Promise<void> {
    let active = this.#running.get(key);
    if (active === undefined) {
      active = this.#runAttempt(key).finally(() => {
        this.#running.delete(key);
      });
      this.#running.set(key, active);
    }
    const outcome = await active;
    if (
      surfaceConflictingFailure &&
      outcome.conflictingError !== undefined
    ) {
      throw outcome.conflictingError;
    }
  }

  async #runAttempt(key: string): Promise<RejectionAttemptOutcome> {
    const record = this.#records.get(key);
    if (record === undefined || this.#closed) return {};
    if (Date.parse(record.expiresAt) <= this.#now()) {
      await this.#remove(key);
      return {};
    }
    try {
      await this.#broker.recordDecision({
        decision: "reject",
        plan: record,
        actor: record.actor,
      });
    } catch (error) {
      this.#onRetryError?.(error, record);
      if (isPermanentDecisionFailure(error)) {
        // The exact private operation can no longer transition, so keeping
        // the intent would create an endless retry loop. A conflicting status
        // can mean another path already approved the operation; surface it to
        // the synchronous caller so App Server remains pending.
        await this.#remove(key);
        return isConflictingDecisionFailure(error)
          ? { conflictingError: error }
          : {};
      }
      this.#scheduleNext(key, record);
      return {};
    }
    await this.#remove(key);
    return {};
  }

  async #remove(key: string): Promise<void> {
    await this.#mutate(async () => {
      const record = this.#records.get(key);
      if (record === undefined) return;
      this.#records.delete(key);
      try {
        await this.#persistSnapshot();
        this.#attempts.delete(key);
        this.#cancelRetry.get(key)?.();
        this.#cancelRetry.delete(key);
      } catch (error) {
        // Keeping the record causes an idempotent retry after this process or a
        // restarted process can persist the completed removal.
        this.#records.set(key, record);
        this.#onRetryError?.(error, record);
        this.#scheduleNext(key, record);
      }
    });
  }

  #scheduleNext(
    key: string,
    record: PendingWorkspaceGitSystemRejection,
  ): void {
    const attempt = this.#attempts.get(key) ?? 0;
    this.#attempts.set(key, attempt + 1);
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!;
    const remaining = Math.max(0, Date.parse(record.expiresAt) - this.#now());
    this.#schedule(key, Math.min(delay, remaining));
  }

  #schedule(key: string, delayMs: number): void {
    if (this.#closed || this.#cancelRetry.has(key)) return;
    const cancel = this.#scheduleTask(() => {
      this.#cancelRetry.delete(key);
      void this.#attempt(key);
    }, delayMs);
    this.#cancelRetry.set(key, cancel);
  }

  #remember(record: PendingWorkspaceGitSystemRejection): void {
    const normalized = rejectionRecord(record, record.actor);
    const key = rejectionKey(normalized);
    const existing = this.#records.get(key);
    if (existing !== undefined && !sameRejection(existing, normalized)) {
      throw new Error("Conflicting persisted workspace-git system rejection");
    }
    if (existing === undefined && this.#records.size >= MAX_PENDING_REJECTIONS) {
      throw new Error("Too many persisted workspace-git system rejections");
    }
    this.#records.set(key, normalized);
  }

  #persistSnapshot(): Promise<void> {
    return this.#persist(this.listPending());
  }

  #mutate<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(task);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isPermanentDecisionFailure(error: unknown): boolean {
  return isWorkspaceGitDecisionBrokerError(error) &&
    error.code !== "state_write_failed" &&
    error.code !== "decision_outcome_unknown";
}

function isConflictingDecisionFailure(error: unknown): boolean {
  return isWorkspaceGitDecisionBrokerError(error) &&
    (
      error.code === "invalid_decision" ||
      error.code === "decision_replay" ||
      error.code === "status_conflict"
    );
}

function rejectionRecord(
  plan: WorkspaceGitDecisionPlan,
  actor: WorkspaceGitSystemRejectionActor,
): PendingWorkspaceGitSystemRejection {
  assertBoundedPlanString(plan.operationId, "operation ID", 64);
  if (!/^[0-9a-f]{64}$/u.test(plan.planHash)) {
    throw new Error("workspace-git system rejection plan hash is invalid");
  }
  assertBoundedPlanString(plan.approvalTarget, "approval target", 256);
  assertBoundedPlanString(plan.repoId, "repository ID", 128);
  assertBoundedPlanString(plan.expiresAt, "expiry", 64);
  if (!Number.isFinite(Date.parse(plan.expiresAt))) {
    throw new Error("workspace-git system rejection expiry is invalid");
  }
  return {
    operationId: plan.operationId,
    planHash: plan.planHash,
    approvalTarget: plan.approvalTarget,
    ...(plan.approvalAuthorityId === undefined
      ? {}
      : { approvalAuthorityId: plan.approvalAuthorityId }),
    repoId: plan.repoId,
    expiresAt: plan.expiresAt,
    actor,
  };
}

function assertBoundedPlanString(
  value: string,
  label: string,
  maxLength: number,
): void {
  if (
    value.length < 1 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`workspace-git system rejection ${label} is invalid`);
  }
}

function rejectionKey(
  record: Pick<PendingWorkspaceGitSystemRejection, "operationId" | "planHash">,
): string {
  return `${record.operationId}\u0000${record.planHash}`;
}

function sameRejection(
  left: PendingWorkspaceGitSystemRejection,
  right: PendingWorkspaceGitSystemRejection,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.planHash === right.planHash &&
    left.approvalTarget === right.approvalTarget &&
    left.approvalAuthorityId === right.approvalAuthorityId &&
    left.repoId === right.repoId &&
    left.expiresAt === right.expiresAt
  );
}

function defaultSchedule(task: () => void, delayMs: number): () => void {
  const timer = setTimeout(task, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}
