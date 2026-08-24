import type {
  PermissionApprovalSettlement,
} from "../permissions/approval-coordinator.js";
import type { PermissionApprovalMessageRoute } from "./frontend.js";

/** Keeps one approval card retryable until its terminal Slack update succeeds. */
export class PermissionApprovalCardTracker {
  readonly #routes = new Map<string, PermissionApprovalMessageRoute>();
  readonly #settlements = new Map<string, PermissionApprovalSettlement>();

  rememberRoute(requestId: string, route: PermissionApprovalMessageRoute): void {
    this.#routes.set(requestId, route);
  }

  rememberSettlement(settlement: PermissionApprovalSettlement): void {
    this.#settlements.set(settlement.requestId, settlement);
  }

  routeFor(requestId: string): PermissionApprovalMessageRoute | undefined {
    return this.#routes.get(requestId);
  }

  settlementFor(requestId: string): PermissionApprovalSettlement | undefined {
    return this.#settlements.get(requestId);
  }

  discardUnroutedSettlement(requestId: string): void {
    if (!this.#routes.has(requestId)) this.#settlements.delete(requestId);
  }

  async apply(
    requestId: string,
    update: (
      route: PermissionApprovalMessageRoute,
      settlement: PermissionApprovalSettlement,
    ) => Promise<void>,
  ): Promise<boolean> {
    const route = this.#routes.get(requestId);
    const settlement = this.#settlements.get(requestId);
    if (route === undefined || settlement === undefined) return false;
    await update(route, settlement);
    this.#routes.delete(requestId);
    this.#settlements.delete(requestId);
    return true;
  }
}
