export interface RecentGatewayRestartReceipt {
  readonly keyHash: string;
  readonly originInstanceId: string;
  readonly expiresAt: string;
}

export interface GatewayRestartReplayGuardOptions {
  readonly initialReceipts?: readonly RecentGatewayRestartReceipt[];
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxReceipts?: number;
  readonly persist: (
    receipts: readonly RecentGatewayRestartReceipt[],
  ) => Promise<void>;
}

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_RECEIPTS = 32;

/** Durable, bounded replay guard for one accepted Gateway restart request. */
export class GatewayRestartReplayGuard {
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #maxReceipts: number;
  readonly #persist: GatewayRestartReplayGuardOptions["persist"];
  readonly #receipts = new Map<string, RecentGatewayRestartReceipt>();
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: GatewayRestartReplayGuardOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.#persist = options.persist;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new TypeError("Gateway restart receipt TTL must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxReceipts) || this.#maxReceipts < 1) {
      throw new TypeError("Gateway restart receipt limit must be a positive integer");
    }
    for (const receipt of options.initialReceipts ?? []) {
      validateGatewayRestartReceipt(receipt);
      this.#receipts.set(receipt.keyHash, Object.freeze({ ...receipt }));
    }
    this.#pruneExpired();
    this.#trimToLimit();
  }

  has(keyHash: string): boolean {
    validateKeyHash(keyHash);
    this.#pruneExpired();
    return this.#receipts.has(keyHash);
  }

  async record(keyHash: string, originInstanceId: string): Promise<void> {
    validateKeyHash(keyHash);
    validateInstanceId(originInstanceId);
    await this.#mutate(async () => {
      const previous = this.list();
      const now = this.#now().getTime();
      this.#pruneExpired(now);
      this.#receipts.delete(keyHash);
      this.#receipts.set(keyHash, Object.freeze({
        keyHash,
        originInstanceId,
        expiresAt: new Date(now + this.#ttlMs).toISOString(),
      }));
      this.#trimToLimit();
      try {
        await this.#persist(this.list());
      } catch (error) {
        this.#replace(previous);
        throw error;
      }
    });
  }

  async consume(keyHash: string): Promise<boolean> {
    validateKeyHash(keyHash);
    let consumed = false;
    await this.#mutate(async () => {
      this.#pruneExpired();
      if (!this.#receipts.has(keyHash)) return;
      const previous = this.list();
      this.#receipts.delete(keyHash);
      try {
        await this.#persist(this.list());
        consumed = true;
      } catch (error) {
        this.#replace(previous);
        throw error;
      }
    });
    return consumed;
  }

  #mutate(operation: () => Promise<void>): Promise<void> {
    const task = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = task.catch(() => undefined);
    return task;
  }

  list(): readonly RecentGatewayRestartReceipt[] {
    this.#pruneExpired();
    return [...this.#receipts.values()].map((receipt) => ({ ...receipt }));
  }

  #pruneExpired(now = this.#now().getTime()): void {
    for (const [key, receipt] of this.#receipts) {
      if (Date.parse(receipt.expiresAt) <= now) this.#receipts.delete(key);
    }
  }

  #trimToLimit(): void {
    while (this.#receipts.size > this.#maxReceipts) {
      const oldest = this.#receipts.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#receipts.delete(oldest);
    }
  }

  #replace(receipts: readonly RecentGatewayRestartReceipt[]): void {
    this.#receipts.clear();
    for (const receipt of receipts) this.#receipts.set(receipt.keyHash, receipt);
  }
}

export function validateGatewayRestartReceipt(
  value: RecentGatewayRestartReceipt,
): void {
  validateKeyHash(value.keyHash);
  validateInstanceId(value.originInstanceId);
  if (
    typeof value.expiresAt !== "string" ||
    value.expiresAt.length > 64 ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new TypeError("Gateway restart receipt expiry is invalid");
  }
}

function validateKeyHash(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("Gateway restart receipt key is invalid");
  }
}

function validateInstanceId(value: string): void {
  if (!/^[0-9a-f-]{36}$/u.test(value)) {
    throw new TypeError("Gateway runtime instance ID is invalid");
  }
}
