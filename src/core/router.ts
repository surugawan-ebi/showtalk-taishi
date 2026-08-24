import { randomUUID } from "node:crypto";

import type { AgentAdapter } from "./adapter.js";
import { CoreError } from "./errors.js";
import { InMemoryAgentRegistry } from "./registry.js";
import type {
  AgentEvent,
  AgentId,
  AgentSessionRecord,
  JsonValue,
} from "./types.js";

export interface DelegationRequest {
  readonly sourceAgentId: AgentId;
  readonly targetAgentId: AgentId;
  readonly message: string;
  /** Trusted Slack reply destination of the source turn, when it has one. */
  readonly sourceRootThreadTs?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly signal?: AbortSignal;
}

/** Host-owned causation data. This must not be exposed as agent.send tool input. */
export interface DelegationContext {
  readonly depth: number;
  readonly parentDelegationId?: string;
}

interface DelegationActivityBase {
  readonly delegationId: string;
  readonly parentDelegationId?: string;
  readonly sourceAgentId: AgentId;
  readonly sourceChannelId: string;
  readonly sourceRootThreadTs?: string;
  readonly targetAgentId: AgentId;
  readonly targetChannelId: string;
  readonly targetSessionId: string;
  readonly depth: number;
  readonly timestamp: string;
}

export type DelegationActivity =
  | (DelegationActivityBase & {
      readonly type: "delegation.started";
      readonly message: string;
    })
  | (DelegationActivityBase & {
      readonly type: "delegation.agent_event";
      readonly event: AgentEvent;
    })
  | (DelegationActivityBase & {
      readonly type: "delegation.completed";
    })
  | (DelegationActivityBase & {
      readonly type: "delegation.failed";
      readonly error: { readonly name: string; readonly message: string };
    });

export interface AgentRouterOptions {
  readonly maxDelegationDepth?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly onStateChanged?: () => Promise<void>;
  readonly authorizeDelegation?: (
    sourceAgentId: AgentId,
    targetAgentId: AgentId,
    signal?: AbortSignal,
  ) => "allow" | "deny" | "approval" | Promise<"allow" | "deny" | "approval">;
}

/** Routes agent.send directly to an adapter session and emits UI-neutral activity. */
export class AgentRouter {
  readonly #registry: InMemoryAgentRegistry;
  readonly #adapters: ReadonlyMap<string, AgentAdapter>;
  readonly #maxDelegationDepth: number;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #onStateChanged: () => Promise<void>;
  readonly #authorizeDelegation: NonNullable<
    AgentRouterOptions["authorizeDelegation"]
  >;
  readonly #sessionCreationByAgent = new Map<
    AgentId,
    Promise<AgentSessionRecord>
  >();
  readonly #activeDelegationsByAgent = new Map<
    AgentId,
    { readonly delegationId: string; readonly depth: number }
  >();
  readonly #reservedContinuationDelegationIds = new Set<string>();

  constructor(
    registry: InMemoryAgentRegistry,
    adapters: Iterable<AgentAdapter>,
    options: AgentRouterOptions = {},
  ) {
    this.#registry = registry;
    this.#maxDelegationDepth = options.maxDelegationDepth ?? 4;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#onStateChanged = options.onStateChanged ?? (async () => undefined);
    this.#authorizeDelegation =
      options.authorizeDelegation ?? (() => "deny" as const);

    if (
      !Number.isSafeInteger(this.#maxDelegationDepth) ||
      this.#maxDelegationDepth < 1
    ) {
      throw new CoreError(
        "INVALID_DELEGATION_DEPTH",
        "maxDelegationDepth must be a positive integer",
      );
    }

    const adapterMap = new Map<string, AgentAdapter>();
    for (const adapter of adapters) {
      if (adapterMap.has(adapter.kind)) {
        throw new CoreError(
          "ADAPTER_KIND_MISMATCH",
          `Adapter kind ${adapter.kind} is registered more than once`,
        );
      }
      adapterMap.set(adapter.kind, adapter);
    }
    this.#adapters = adapterMap;
  }

  async *send(
    request: DelegationRequest,
    context: DelegationContext = { depth: 1 },
  ): AsyncIterable<DelegationActivity> {
    const source = this.#registry.requireAgent(request.sourceAgentId);
    const target = this.#registry.requireAgent(request.targetAgentId);
    const depth = context.depth;

    if (request.message.trim().length === 0) {
      throw new TypeError("Delegation message must not be empty");
    }
    if (
      request.sourceRootThreadTs !== undefined &&
      !/^\d{1,20}\.\d{1,20}$/u.test(request.sourceRootThreadTs)
    ) {
      throw new TypeError("Source Slack root thread timestamp is invalid");
    }
    throwIfCancelled(request.signal);

    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new CoreError(
        "INVALID_DELEGATION_DEPTH",
        "Delegation depth must be a positive integer",
      );
    }
    if (depth > this.#maxDelegationDepth) {
      throw new CoreError(
        "DELEGATION_DEPTH_EXCEEDED",
        `Delegation depth ${depth} exceeds limit ${this.#maxDelegationDepth}`,
      );
    }
    if (source.id === target.id && source.allowSelfDelegation !== true) {
      throw new CoreError(
        "SELF_DELEGATION_DENIED",
        `Koe ${source.id} is not allowed to send to itself`,
      );
    }
    const permission = await this.#authorizeDelegation(
      source.id,
      target.id,
      request.signal,
    );
    throwIfCancelled(request.signal);
    if (permission === "deny") {
      throw new CoreError(
        "PERMISSION_DENIED",
        `Koe ${source.id} may not send to ${target.id}`,
      );
    }
    if (permission === "approval") {
      throw new CoreError(
        "PERMISSION_APPROVAL_REQUIRED",
        `Koe ${source.id} requires human approval to send to ${target.id}`,
      );
    }

    const adapter = this.#adapters.get(target.adapter);
    if (adapter === undefined) {
      throw new CoreError(
        "ADAPTER_NOT_REGISTERED",
        `No adapter is registered for kind ${target.adapter}`,
      );
    }
    const delegationId = this.#idFactory();
    const releaseAgentTurn = this.#registry.reserveAgentTurn(target.id);

    try {
      const session =
        (target.conversationScope ?? "channel") === "slack_thread"
          ? await this.#createSession(target.id, adapter, false)
          : await this.#getOrCreatePrimarySession(target.id, adapter);
      throwIfCancelled(request.signal);
      const base = {
        delegationId,
        ...(context.parentDelegationId === undefined
          ? {}
          : { parentDelegationId: context.parentDelegationId }),
        sourceAgentId: source.id,
        sourceChannelId: source.channelId,
        ...(request.sourceRootThreadTs === undefined
          ? {}
          : { sourceRootThreadTs: request.sourceRootThreadTs }),
        targetAgentId: target.id,
        targetChannelId: target.channelId,
        targetSessionId: session.id,
        depth,
      };

      if (this.#activeDelegationsByAgent.has(target.id)) {
        throw new CoreError(
          "AGENT_BUSY",
          `Koe ${target.id} is already handling another routed turn`,
        );
      }
      this.#activeDelegationsByAgent.set(target.id, { delegationId, depth });

      let turnStarted = false;
      try {
        const startedAt = this.#timestamp();
        this.#registry.beginSessionTurn(session.id, {
          type: "agent",
          sourceAgentId: source.id,
          delegationId,
          startedAt,
        }, startedAt);
        turnStarted = true;
        await this.#onStateChanged();
        yield {
          ...base,
          type: "delegation.started",
          message: request.message,
          timestamp: this.#timestamp(),
        };
        throwIfCancelled(request.signal);

        try {
          for await (const event of adapter.sendMessage(session.adapterSession, {
            text: request.message,
            source: {
              type: "agent",
              agentId: source.id,
              delegationId,
              depth,
            },
            ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
          })) {
            if (event.type === "status.changed") {
              this.#registry.updateSessionStatus(session.id, event.status, this.#timestamp());
              await this.#onStateChanged();
            }
            yield {
              ...base,
              type: "delegation.agent_event",
              event,
              timestamp: this.#timestamp(),
            };
            throwIfCancelled(request.signal);
          }

          const completedSession = this.#registry.requireSession(session.id);
          if (
            completedSession.status === "starting" ||
            completedSession.status === "running" ||
            completedSession.status === "waiting_for_approval" ||
            completedSession.status === "waiting_for_input"
          ) {
            this.#registry.updateSessionStatus(session.id, "idle", this.#timestamp());
            await this.#onStateChanged();
          }

          yield {
            ...base,
            type: "delegation.completed",
            timestamp: this.#timestamp(),
          };
        } catch (error) {
          this.#registry.updateSessionStatus(session.id, "failed", this.#timestamp());
          await this.#onStateChanged();
          const normalized = normalizeError(error);
          yield {
            ...base,
            type: "delegation.failed",
            error: normalized,
            timestamp: this.#timestamp(),
          };
          throw error;
        }
      } finally {
        const active = this.#activeDelegationsByAgent.get(target.id);
        if (active?.delegationId === delegationId) {
          this.#activeDelegationsByAgent.delete(target.id);
        }
        const current = this.#registry.requireSession(session.id);
        if (
          turnStarted &&
          (current.status === "starting" ||
            current.status === "running" ||
            current.status === "waiting_for_approval" ||
            current.status === "waiting_for_input")
        ) {
          this.#registry.updateSessionStatus(session.id, "failed", this.#timestamp());
          await this.#onStateChanged();
        }
      }
    } finally {
      releaseAgentTurn();
    }
  }

  /**
   * Agent-facing entry point. Delegation depth and causation are derived from
   * host-owned active routing state, never accepted from MCP tool arguments.
   */
  async *sendFromAgent(
    request: DelegationRequest,
  ): AsyncIterable<DelegationActivity> {
    const parent = this.#activeDelegationsByAgent.get(request.sourceAgentId);
    const sourceTurn = this.#registry.hasActiveAgentTurn(request.sourceAgentId)
      ? this.#registry.getActiveSession(request.sourceAgentId)?.activeTurn
      : undefined;
    const continuation =
      sourceTurn?.type === "slack" &&
      sourceTurn.continuationDelegationId !== undefined &&
      sourceTurn.continuationDepth !== undefined
        ? {
            delegationId: sourceTurn.continuationDelegationId,
            depth: sourceTurn.continuationDepth,
          }
        : undefined;
    const context: DelegationContext =
      parent === undefined && continuation === undefined
        ? { depth: 1 }
        : {
            depth: (parent?.depth ?? continuation!.depth) + 1,
            parentDelegationId:
              parent?.delegationId ?? continuation!.delegationId,
          };
    const continuationDelegationId =
      parent === undefined ? continuation?.delegationId : undefined;
    if (continuationDelegationId === undefined) {
      yield* this.send(request, context);
      return;
    }
    if (
      this.#reservedContinuationDelegationIds.has(continuationDelegationId) ||
      this.#registry.hasUsedContinuationDelegation(continuationDelegationId)
    ) {
      throw new CoreError(
        "DELEGATION_CONTINUATION_ALREADY_USED",
        `Delayed delegation result ${continuationDelegationId} already started its next Koe step`,
      );
    }

    this.#reservedContinuationDelegationIds.add(continuationDelegationId);
    let started = false;
    try {
      for await (const activity of this.send(request, context)) {
        if (!started && activity.type === "delegation.started") {
          started = true;
          this.#reservedContinuationDelegationIds.delete(
            continuationDelegationId,
          );
          this.#registry.recordUsedContinuationDelegation(
            continuationDelegationId,
          );
          try {
            await this.#onStateChanged();
          } catch (error) {
            this.#registry.removeUsedContinuationDelegation(
              continuationDelegationId,
            );
            throw error;
          }
        }
        yield activity;
      }
    } finally {
      this.#reservedContinuationDelegationIds.delete(continuationDelegationId);
    }
  }

  /** Interrupts the direct-routing session for an Agent, if it is active. */
  async interrupt(agentId: AgentId): Promise<void> {
    const agent = this.#registry.requireAgent(agentId);
    const session =
      this.#registry.getActiveSession(agent.id) ??
      this.#registry.getPrimarySession(agent.id);
    if (session === undefined) return;
    const adapter = this.#adapters.get(session.adapter);
    if (
      adapter === undefined ||
      !adapter.capabilities.interrupt ||
      adapter.interrupt === undefined
    ) {
      return;
    }
    await adapter.interrupt(session.adapterSession);
  }

  /** Interrupts only when this Router still owns the exact delegated turn. */
  async interruptDelegation(
    agentId: AgentId,
    delegationId: string,
  ): Promise<boolean> {
    const active = this.#activeDelegationsByAgent.get(agentId);
    if (active?.delegationId !== delegationId) return false;
    await this.interrupt(agentId);
    return true;
  }

  async #getOrCreatePrimarySession(
    agentId: AgentId,
    adapter: AgentAdapter,
  ): Promise<AgentSessionRecord> {
    const pending = this.#sessionCreationByAgent.get(agentId);
    if (pending !== undefined) return pending;

    const current = this.#registry.getPrimarySession(agentId);
    if (current !== undefined) {
      if (current.adapter !== adapter.kind) {
        throw new CoreError(
          "ADAPTER_KIND_MISMATCH",
          `Primary session ${current.id} does not use adapter ${adapter.kind}`,
        );
      }
      if (this.#registry.isSessionActivated(current.id)) return current;
      const activation = this.#resumePrimarySession(current, adapter);
      this.#sessionCreationByAgent.set(agentId, activation);
      try {
        return await activation;
      } finally {
        this.#sessionCreationByAgent.delete(agentId);
      }
    }

    const creation = this.#createSession(agentId, adapter, true);
    this.#sessionCreationByAgent.set(agentId, creation);
    try {
      return await creation;
    } finally {
      this.#sessionCreationByAgent.delete(agentId);
    }
  }

  async #resumePrimarySession(
    current: AgentSessionRecord,
    adapter: AgentAdapter,
  ): Promise<AgentSessionRecord> {
    if (!adapter.capabilities.resume || adapter.resumeSession === undefined) {
      throw new Error(
        `Adapter ${adapter.kind} cannot resume primary session ${current.id}`,
      );
    }
    const agent = this.#registry.requireAgent(current.agentId);
    const adapterSession = await adapter.resumeSession({
      agent,
      adapterSessionId: current.adapterSession.id,
      ...(current.adapterSession.state === undefined
        ? {}
        : { state: current.adapterSession.state }),
    });
    const resumed = this.#registry.replaceAdapterSession(
      current.id,
      adapterSession,
      this.#timestamp(),
    );
    this.#registry.markSessionActivated(current.id);
    await this.#onStateChanged();
    return resumed;
  }

  async #createSession(
    agentId: AgentId,
    adapter: AgentAdapter,
    makePrimary: boolean,
  ): Promise<AgentSessionRecord> {
    const agent = this.#registry.requireAgent(agentId);
    const adapterSession = await adapter.createSession({
      agent,
      reason: "delegation",
    });
    const timestamp = this.#timestamp();
    const session: AgentSessionRecord = {
      id: this.#idFactory(),
      agentId,
      adapter: adapter.kind,
      adapterSession,
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#registry.addSession(session);
    if (makePrimary) this.#registry.setPrimarySession(agentId, session.id);
    this.#registry.markSessionActivated(session.id);
    await this.#onStateChanged();
    return session;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new CoreError("REQUEST_CANCELLED", "The Koe request was cancelled");
  }
}
