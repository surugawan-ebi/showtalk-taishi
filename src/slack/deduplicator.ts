export class SlackEventDeduplicator {
  readonly #seen = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#ttlMs = options.ttlMs ?? 10 * 60 * 1_000;
    this.#maxEntries = options.maxEntries ?? 2_048;
    this.#now = options.now ?? Date.now;
  }

  accept(eventId: string): boolean {
    const now = this.#now();
    this.#prune(now);
    if (this.#seen.has(eventId)) return false;
    this.#seen.set(eventId, now);
    while (this.#seen.size > this.#maxEntries) {
      const oldest = this.#seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#seen.delete(oldest);
    }
    return true;
  }

  #prune(now: number): void {
    for (const [eventId, seenAt] of this.#seen) {
      if (now - seenAt <= this.#ttlMs) break;
      this.#seen.delete(eventId);
    }
  }
}

