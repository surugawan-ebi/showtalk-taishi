import type {
  PermissionApprovalSettlement,
} from "../permissions/approval-coordinator.js";
import type { PermissionApprovalMessageRoute } from "./frontend.js";

const MAX_DURABLE_PERMISSION_CARDS = 128;

export interface PersistedPermissionApprovalCard {
  readonly requestId: string;
  readonly route: PermissionApprovalMessageRoute;
  readonly settlement?: PermissionApprovalSettlement;
}

export interface PermissionApprovalCardTrackerOptions {
  readonly initialCards?: readonly PersistedPermissionApprovalCard[];
  readonly persist?: (
    cards: readonly PersistedPermissionApprovalCard[],
  ) => Promise<void>;
}

/** Keeps approval cards durable and retryable until terminal Slack updates succeed. */
export class PermissionApprovalCardTracker {
  readonly #routes = new Map<string, PermissionApprovalMessageRoute>();
  readonly #settlements = new Map<string, PermissionApprovalSettlement>();
  readonly #persist: PermissionApprovalCardTrackerOptions["persist"];
  readonly #applyTasks = new Map<string, Promise<boolean>>();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: PermissionApprovalCardTrackerOptions = {}) {
    this.#persist = options.persist;
    for (const card of options.initialCards ?? []) {
      this.#routes.set(card.requestId, structuredClone(card.route));
      if (card.settlement !== undefined) {
        this.#settlements.set(card.requestId, structuredClone(card.settlement));
      }
    }
  }

  async rememberRoute(
    requestId: string,
    route: PermissionApprovalMessageRoute,
  ): Promise<void> {
    await this.#mutate(async () => {
      if (
        !this.#routes.has(requestId) &&
        this.#routes.size >= MAX_DURABLE_PERMISSION_CARDS
      ) {
        throw new Error("Too many pending permission approval cards");
      }
      const previous = this.list();
      this.#routes.set(requestId, route);
      await this.#persistOrRollback(previous);
    });
  }

  async rememberSettlement(
    settlement: PermissionApprovalSettlement,
  ): Promise<void> {
    await this.#mutate(async () => {
      const previous = this.list();
      this.#settlements.set(settlement.requestId, settlement);
      await this.#persistOrRollback(previous);
    });
  }

  routeFor(requestId: string): PermissionApprovalMessageRoute | undefined {
    return this.#routes.get(requestId);
  }

  settlementFor(requestId: string): PermissionApprovalSettlement | undefined {
    return this.#settlements.get(requestId);
  }

  async discardUnroutedSettlement(requestId: string): Promise<void> {
    await this.#mutate(async () => {
      if (this.#routes.has(requestId) || !this.#settlements.has(requestId)) return;
      const previous = this.list();
      this.#settlements.delete(requestId);
      await this.#persistOrRollback(previous);
    });
  }

  list(): readonly PersistedPermissionApprovalCard[] {
    return [...this.#routes].map(([requestId, route]) => ({
      requestId,
      route: structuredClone(route),
      ...(this.#settlements.get(requestId) === undefined
        ? {}
        : { settlement: structuredClone(this.#settlements.get(requestId)!) }),
    }));
  }

  async closeUnsettled(): Promise<void> {
    await this.#mutate(async () => {
      const previous = this.list();
      let changed = false;
      for (const requestId of this.#routes.keys()) {
        if (this.#settlements.has(requestId)) continue;
        this.#settlements.set(requestId, {
          requestId,
          reason: "coordinator_closed",
        });
        changed = true;
      }
      if (changed) await this.#persistOrRollback(previous);
    });
  }

  async apply(
    requestId: string,
    update: (
      route: PermissionApprovalMessageRoute,
      settlement: PermissionApprovalSettlement,
    ) => Promise<void>,
  ): Promise<boolean> {
    const existing = this.#applyTasks.get(requestId);
    if (existing !== undefined) return existing;
    const task = this.#applyOnce(requestId, update).finally(() => {
      if (this.#applyTasks.get(requestId) === task) {
        this.#applyTasks.delete(requestId);
      }
    });
    this.#applyTasks.set(requestId, task);
    return task;
  }

  async #applyOnce(
    requestId: string,
    update: (
      route: PermissionApprovalMessageRoute,
      settlement: PermissionApprovalSettlement,
    ) => Promise<void>,
  ): Promise<boolean> {
    await this.#mutationQueue;
    const route = this.#routes.get(requestId);
    const settlement = this.#settlements.get(requestId);
    if (route === undefined || settlement === undefined) return false;
    await update(route, settlement);
    await this.#mutate(async () => {
      const currentRoute = this.#routes.get(requestId);
      const currentSettlement = this.#settlements.get(requestId);
      if (
        currentRoute === undefined ||
        currentSettlement === undefined ||
        !sameRoute(currentRoute, route) ||
        !sameSettlement(currentSettlement, settlement)
      ) {
        return;
      }
      const previous = this.list();
      this.#routes.delete(requestId);
      this.#settlements.delete(requestId);
      await this.#persistOrRollback(previous);
    });
    return true;
  }

  #mutate(operation: () => Promise<void>): Promise<void> {
    const task = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = task.catch(() => undefined);
    return task;
  }

  async #persistOrRollback(
    previous: readonly PersistedPermissionApprovalCard[],
  ): Promise<void> {
    if (this.#persist === undefined) return;
    try {
      await this.#persist(this.list());
    } catch (error) {
      this.#replace(previous);
      throw error;
    }
  }

  #replace(cards: readonly PersistedPermissionApprovalCard[]): void {
    this.#routes.clear();
    this.#settlements.clear();
    for (const card of cards) {
      this.#routes.set(card.requestId, structuredClone(card.route));
      if (card.settlement !== undefined) {
        this.#settlements.set(card.requestId, structuredClone(card.settlement));
      }
    }
  }
}

function sameRoute(
  left: PermissionApprovalMessageRoute,
  right: PermissionApprovalMessageRoute,
): boolean {
  return (
    left.channelId === right.channelId &&
    left.messageTs === right.messageTs &&
    left.rootThreadTs === right.rootThreadTs &&
    left.operation === right.operation
  );
}

function sameSettlement(
  left: PermissionApprovalSettlement,
  right: PermissionApprovalSettlement,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.reason === right.reason &&
    left.resolvedBySlackUserId === right.resolvedBySlackUserId
  );
}
