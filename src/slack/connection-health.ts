export type SlackConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "degraded"
  | "stopped";

export interface SocketConnectionPort {
  on(event: "connected" | "close" | "reconnecting", listener: () => void): unknown;
  off(event: "connected" | "close" | "reconnecting", listener: () => void): unknown;
  readonly websocket?: { isActive(): boolean };
}

export interface SlackConnectionHealthOptions {
  readonly now?: () => number;
  readonly degradedAfterMs?: number;
  readonly checkIntervalMs?: number;
  readonly log?: (line: string) => void;
}

/** Observes the Socket Mode handshake and socket, without logging Slack payloads. */
export class SlackConnectionHealth {
  readonly #client: SocketConnectionPort;
  readonly #now: () => number;
  readonly #degradedAfterMs: number;
  readonly #checkIntervalMs: number;
  readonly #log: (line: string) => void;
  readonly #onConnected = () => this.#connected();
  readonly #onClosed = () => this.#disconnected();
  #status: SlackConnectionStatus = "stopped";
  #startedAt = 0;
  #disconnectedAt: number | undefined;
  #everConnected = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(client: SocketConnectionPort, options: SlackConnectionHealthOptions = {}) {
    this.#client = client;
    this.#now = options.now ?? Date.now;
    this.#degradedAfterMs = options.degradedAfterMs ?? 3 * 60_000;
    this.#checkIntervalMs = options.checkIntervalMs ?? 30_000;
    this.#log = options.log ?? console.info;
    if (!Number.isSafeInteger(this.#degradedAfterMs) || this.#degradedAfterMs < 1 ||
        !Number.isSafeInteger(this.#checkIntervalMs) || this.#checkIntervalMs < 1) {
      throw new RangeError("Slack connection health intervals must be positive integers");
    }
  }

  start(): void {
    if (this.#status !== "stopped") return;
    this.#status = "connecting";
    this.#startedAt = this.#now();
    this.#disconnectedAt = undefined;
    this.#client.on("connected", this.#onConnected);
    this.#client.on("close", this.#onClosed);
    this.#client.on("reconnecting", this.#onClosed);
    this.#timer = setInterval(() => this.check(), this.#checkIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#status === "stopped") return;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#client.off("connected", this.#onConnected);
    this.#client.off("close", this.#onClosed);
    this.#client.off("reconnecting", this.#onClosed);
    this.#status = "stopped";
  }

  status(): SlackConnectionStatus {
    return this.#status;
  }

  check(): void {
    if (this.#status === "stopped") return;
    if (this.#status === "connected" && !this.#client.websocket?.isActive()) {
      this.#disconnected();
    }
    if (this.#status === "connecting" &&
        this.#now() - this.#startedAt >= this.#degradedAfterMs) {
      this.#disconnected();
    }
    if (this.#status === "disconnected" &&
        this.#now() - (this.#disconnectedAt ?? this.#startedAt) >= this.#degradedAfterMs) {
      this.#status = "degraded";
      this.#emit("degraded");
    }
  }

  #connected(): void {
    if (this.#status === "stopped") return;
    const recovered = this.#everConnected;
    this.#everConnected = true;
    this.#disconnectedAt = undefined;
    if (this.#status === "connected") return;
    this.#status = "connected";
    this.#emit(recovered ? "recovered" : "connected");
  }

  #disconnected(): void {
    if (this.#status === "stopped" || this.#status === "degraded" ||
        this.#status === "disconnected") return;
    this.#disconnectedAt = this.#status === "connecting"
      ? this.#startedAt : this.#now();
    this.#status = "disconnected";
    this.#emit("disconnected");
  }

  #emit(event: "connected" | "disconnected" | "degraded" | "recovered"): void {
    this.#log(JSON.stringify({ component: "showtalk.slack_connection", event }));
  }
}

