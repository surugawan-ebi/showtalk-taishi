import type { AgentAdapter } from "./adapter.js";
import { CoreError } from "./errors.js";
import type {
  AdapterSession,
  AgentApproval,
  AgentCapabilities,
  AgentEvent,
  AgentStatus,
  AgentUserInputResponse,
} from "./types.js";
import type {
  CreateSessionRequest,
  ResumeSessionRequest,
  SendMessageRequest,
} from "./adapter.js";

const AGENT_ID_STATE_KEY = "showtalkTaishiAgentId";

/**
 * Keeps one isolated backend adapter instance per Agent while exposing one
 * configured adapter kind to Gateway Core. This is especially important for
 * per-Agent MCP credentials: one Codex process never receives another Agent's
 * bearer token.
 */
export class AgentScopedAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities;
  readonly #adapters: ReadonlyMap<string, AgentAdapter>;
  readonly #activeAgentIds = new Set<string>();

  constructor(kind: string, adapters: ReadonlyMap<string, AgentAdapter>) {
    if (kind.trim().length === 0) throw new TypeError("Adapter kind must not be empty");
    if (adapters.size === 0) {
      throw new TypeError(`Scoped adapter ${kind} requires at least one Agent`);
    }
    this.kind = kind;
    this.#adapters = new Map(adapters);
    const values = [...adapters.values()];
    this.capabilities = {
      streaming: values.every((adapter) => adapter.capabilities.streaming),
      approval: values.every((adapter) => adapter.capabilities.approval),
      interrupt: values.every((adapter) => adapter.capabilities.interrupt),
      resume: values.every((adapter) => adapter.capabilities.resume),
      toolEvents: values.every((adapter) => adapter.capabilities.toolEvents),
      structuredInput: values.every(
        (adapter) => adapter.capabilities.structuredInput === true,
      ),
      imageInput: values.every((adapter) => adapter.capabilities.imageInput === true),
      audioFileInput: values.every(
        (adapter) => adapter.capabilities.audioFileInput === true,
      ),
    };
  }

  async createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    const adapter = this.#requireAgentAdapter(request.agent.id);
    return withAgentId(await adapter.createSession(request), request.agent.id);
  }

  async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    const adapter = this.#requireAgentAdapter(request.agent.id);
    if (!adapter.capabilities.resume || adapter.resumeSession === undefined) {
      throw new CoreError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${this.kind} cannot resume Agent ${request.agent.id}`,
      );
    }
    return withAgentId(await adapter.resumeSession(request), request.agent.id);
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    const agentId = this.#requireSessionAgentId(session);
    const adapter = this.#requireAgentAdapter(agentId);
    if (this.#activeAgentIds.has(agentId)) {
      throw new CoreError(
        "AGENT_BUSY",
        `Agent ${agentId} already has an active turn`,
      );
    }
    this.#activeAgentIds.add(agentId);
    try {
      yield* adapter.sendMessage(session, request);
    } finally {
      this.#activeAgentIds.delete(agentId);
    }
  }

  async interrupt(session: AdapterSession): Promise<void> {
    const adapter = this.#requireSessionAdapter(session);
    if (!adapter.capabilities.interrupt || adapter.interrupt === undefined) {
      throw new CoreError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${this.kind} does not support interrupt`,
      );
    }
    await adapter.interrupt(session);
  }

  async approve(session: AdapterSession, approval: AgentApproval): Promise<void> {
    const adapter = this.#requireSessionAdapter(session);
    if (!adapter.capabilities.approval || adapter.approve === undefined) {
      throw new CoreError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${this.kind} does not support approvals`,
      );
    }
    await adapter.approve(session, approval);
  }

  async respondToUserInput(
    session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void> {
    const adapter = this.#requireSessionAdapter(session);
    if (
      adapter.capabilities.structuredInput !== true ||
      adapter.respondToUserInput === undefined
    ) {
      throw new CoreError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        `Adapter ${this.kind} does not support structured input`,
      );
    }
    await adapter.respondToUserInput(session, response);
  }

  async status(session: AdapterSession): Promise<AgentStatus> {
    const adapter = this.#requireSessionAdapter(session);
    return adapter.status === undefined ? "idle" : adapter.status(session);
  }

  #requireSessionAdapter(session: AdapterSession): AgentAdapter {
    return this.#requireAgentAdapter(this.#requireSessionAgentId(session));
  }

  #requireSessionAgentId(session: AdapterSession): string {
    const agentId = session.state?.[AGENT_ID_STATE_KEY];
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      throw new CoreError(
        "INVALID_ADAPTER_SESSION",
        `Session ${session.id} is missing its scoped Agent identity`,
      );
    }
    return agentId;
  }

  #requireAgentAdapter(agentId: string): AgentAdapter {
    const adapter = this.#adapters.get(agentId);
    if (adapter === undefined) {
      throw new CoreError(
        "ADAPTER_NOT_REGISTERED",
        `Adapter ${this.kind} is not configured for Agent ${agentId}`,
      );
    }
    return adapter;
  }
}

function withAgentId(session: AdapterSession, agentId: string): AdapterSession {
  return {
    ...session,
    state: {
      ...(session.state ?? {}),
      [AGENT_ID_STATE_KEY]: agentId,
    },
  };
}
