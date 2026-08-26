import { CoreError } from "./errors.js";
import { normalizeKoeAddress } from "./koe-address.js";
import type {
  ActiveTurnContext,
  AgentDefinition,
  AgentId,
  AgentSessionRecord,
  AgentStatus,
  ConversationBinding,
  CoreStateSnapshot,
  PendingWorkspaceGitSystemRejection,
  SessionId,
  SlackChannelId,
  SlackRootThreadTs,
} from "./types.js";

function conversationKey(
  channelId: SlackChannelId,
  rootThreadTs: SlackRootThreadTs,
): string {
  return `${channelId}\u0000${rootThreadTs}`;
}

function gitSystemRejectionKey(
  record: Pick<PendingWorkspaceGitSystemRejection, "operationId" | "planHash">,
): string {
  return `${record.operationId}\u0000${record.planHash}`;
}

function isTerminalStatus(status: AgentStatus): boolean {
  return status === "idle" || status === "interrupted" || status === "failed";
}

function withoutActiveTurn(
  session: AgentSessionRecord,
  status: AgentStatus,
  updatedAt: string,
): AgentSessionRecord {
  const { activeTurn: _activeTurn, ...rest } = session;
  return { ...rest, status, updatedAt };
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new CoreError("INVALID_STATE_SNAPSHOT", `${label} must not be empty`);
  }
}

/**
 * Dependency-free runtime state. All records can be exported to a JSON-safe
 * snapshot and later hydrated by a file-backed store.
 */
export class InMemoryAgentRegistry {
  readonly #agents = new Map<AgentId, AgentDefinition>();
  readonly #agentIdsByNormalizedId = new Map<string, AgentId>();
  readonly #agentIdsByCallName = new Map<string, AgentId>();
  readonly #agentIdsByChannel = new Map<SlackChannelId, AgentId>();
  readonly #sessions = new Map<SessionId, AgentSessionRecord>();
  readonly #conversations = new Map<string, ConversationBinding>();
  readonly #conversationKeysBySession = new Map<SessionId, Set<string>>();
  readonly #primarySessionIds = new Map<AgentId, SessionId>();
  readonly #activeAgentTurnLeases = new Map<AgentId, symbol>();
  readonly #agentTurnWaiters = new Map<
    AgentId,
    Array<(release: () => void) => void>
  >();
  readonly #idleWaiters = new Set<() => void>();
  readonly #activatedSessionIds = new Set<SessionId>();
  readonly #handledDelegationResults = new Set<string>();
  readonly #usedContinuationDelegations = new Set<string>();
  readonly #handledSlackEvents = new Set<string>();
  readonly #pendingWorkspaceGitSystemRejections = new Map<
    string,
    PendingWorkspaceGitSystemRejection
  >();

  constructor(snapshot?: CoreStateSnapshot) {
    if (snapshot !== undefined) {
      this.#hydrate(snapshot);
    }
  }

  registerAgent(agent: AgentDefinition): void {
    assertNonEmpty(agent.id, "agent.id");
    if (agent.callName !== undefined) {
      assertNonEmpty(agent.callName, "agent.callName");
    }
    assertNonEmpty(agent.adapter, "agent.adapter");
    assertNonEmpty(agent.channelId, "agent.channelId");
    if (agent.slackPersona !== undefined) {
      assertNonEmpty(agent.slackPersona, "agent.slackPersona");
    }

    if (this.#agents.has(agent.id)) {
      throw new CoreError(
        "AGENT_ALREADY_REGISTERED",
        `Agent ${agent.id} is already registered`,
      );
    }

    const normalizedId = normalizeKoeAddress(agent.id);
    const normalizedIdOwner = this.#agentIdsByNormalizedId.get(normalizedId);
    const idCallNameOwner = this.#agentIdsByCallName.get(normalizedId);
    if (normalizedIdOwner !== undefined || idCallNameOwner !== undefined) {
      throw new CoreError(
        "AGENT_ADDRESS_ALREADY_REGISTERED",
        `Agent ID ${agent.id} conflicts with Koe ${normalizedIdOwner ?? idCallNameOwner}`,
      );
    }
    if (agent.callName !== undefined) {
      const normalizedCallName = normalizeKoeAddress(agent.callName);
      const callNameOwner = this.#agentIdsByCallName.get(normalizedCallName);
      const idOwner = this.#agentIdsByNormalizedId.get(normalizedCallName);
      if (
        normalizedCallName === normalizedId ||
        callNameOwner !== undefined ||
        idOwner !== undefined
      ) {
        throw new CoreError(
          "AGENT_ADDRESS_ALREADY_REGISTERED",
          `Call name ${agent.callName} conflicts with Koe ${callNameOwner ?? idOwner ?? agent.id}`,
        );
      }
    }

    const channelOwner = this.#agentIdsByChannel.get(agent.channelId);
    if (channelOwner !== undefined) {
      throw new CoreError(
        "CHANNEL_ALREADY_REGISTERED",
        `Slack channel ${agent.channelId} is already assigned to ${channelOwner}`,
      );
    }

    this.#agents.set(agent.id, agent);
    this.#agentIdsByNormalizedId.set(normalizedId, agent.id);
    if (agent.callName !== undefined) {
      this.#agentIdsByCallName.set(normalizeKoeAddress(agent.callName), agent.id);
    }
    this.#agentIdsByChannel.set(agent.channelId, agent.id);
  }

  getAgent(agentId: AgentId): AgentDefinition | undefined {
    return this.#agents.get(agentId);
  }

  getAgentByAddress(address: string): AgentDefinition | undefined {
    const exact = this.getAgent(address);
    if (exact !== undefined) return exact;
    const agentId = this.#agentIdsByCallName.get(normalizeKoeAddress(address));
    return agentId === undefined ? undefined : this.#agents.get(agentId);
  }

  requireAgentByAddress(address: string): AgentDefinition {
    const agent = this.getAgentByAddress(address);
    if (agent === undefined) {
      throw new CoreError("UNKNOWN_AGENT", `Unknown agent or call name: ${address}`);
    }
    return agent;
  }

  requireAgent(agentId: AgentId): AgentDefinition {
    const agent = this.getAgent(agentId);
    if (agent === undefined) {
      throw new CoreError("UNKNOWN_AGENT", `Unknown agent: ${agentId}`);
    }
    return agent;
  }

  getAgentByChannel(channelId: SlackChannelId): AgentDefinition | undefined {
    const agentId = this.#agentIdsByChannel.get(channelId);
    return agentId === undefined ? undefined : this.#agents.get(agentId);
  }

  requireAgentByChannel(channelId: SlackChannelId): AgentDefinition {
    const agent = this.getAgentByChannel(channelId);
    if (agent === undefined) {
      throw new CoreError(
        "UNKNOWN_CHANNEL",
        `No agent is assigned to Slack channel ${channelId}`,
      );
    }
    return agent;
  }

  listAgents(): readonly AgentDefinition[] {
    return [...this.#agents.values()];
  }

  hasHandledDelegationResult(delegationId: string): boolean {
    return this.#handledDelegationResults.has(delegationId);
  }

  recordHandledDelegationResult(delegationId: string): void {
    assertNonEmpty(delegationId, "delegationId");
    this.#handledDelegationResults.add(delegationId);
  }

  removeHandledDelegationResult(delegationId: string): void {
    this.#handledDelegationResults.delete(delegationId);
  }

  hasUsedContinuationDelegation(delegationId: string): boolean {
    return this.#usedContinuationDelegations.has(delegationId);
  }

  recordUsedContinuationDelegation(delegationId: string): void {
    assertNonEmpty(delegationId, "delegationId");
    this.#usedContinuationDelegations.add(delegationId);
  }

  removeUsedContinuationDelegation(delegationId: string): void {
    this.#usedContinuationDelegations.delete(delegationId);
  }

  hasHandledSlackEvent(eventId: string): boolean {
    return this.#handledSlackEvents.has(eventId);
  }

  recordHandledSlackEvent(eventId: string): void {
    assertNonEmpty(eventId, "eventId");
    this.#handledSlackEvents.delete(eventId);
    this.#handledSlackEvents.add(eventId);
    while (this.#handledSlackEvents.size > 10_000) {
      const oldest = this.#handledSlackEvents.values().next().value;
      if (typeof oldest !== "string") break;
      this.#handledSlackEvents.delete(oldest);
    }
  }

  listPendingWorkspaceGitSystemRejections(): readonly PendingWorkspaceGitSystemRejection[] {
    return [...this.#pendingWorkspaceGitSystemRejections.values()];
  }

  replacePendingWorkspaceGitSystemRejections(
    records: readonly PendingWorkspaceGitSystemRejection[],
  ): void {
    if (records.length > 1_024) {
      throw new CoreError(
        "INVALID_STATE_SNAPSHOT",
        "Too many pending workspace-git system rejections",
      );
    }
    const replacement = new Map<string, PendingWorkspaceGitSystemRejection>();
    for (const record of records) {
      const key = gitSystemRejectionKey(record);
      const existing = replacement.get(key);
      if (existing !== undefined && !sameGitSystemRejection(existing, record)) {
        throw new CoreError(
          "INVALID_STATE_SNAPSHOT",
          "Conflicting pending workspace-git system rejection",
        );
      }
      replacement.set(key, structuredClone(record));
    }
    this.#pendingWorkspaceGitSystemRejections.clear();
    for (const [key, record] of replacement) {
      this.#pendingWorkspaceGitSystemRejections.set(key, record);
    }
  }

  /** Process-local lease shared by human and delegated turns for one Agent. */
  reserveAgentTurn(agentId: AgentId): () => void {
    this.requireAgent(agentId);
    if (this.#activeAgentTurnLeases.has(agentId)) {
      throw new CoreError("AGENT_BUSY", `Agent ${agentId} already has an active turn`);
    }
    return this.#grantAgentTurn(agentId);
  }

  /** FIFO lease used by human messages so rapid Slack posts are not dropped. */
  async waitForAgentTurn(agentId: AgentId): Promise<() => void> {
    this.requireAgent(agentId);
    if (!this.#activeAgentTurnLeases.has(agentId)) {
      return this.#grantAgentTurn(agentId);
    }
    return new Promise<() => void>((resolve) => {
      const waiters = this.#agentTurnWaiters.get(agentId) ?? [];
      waiters.push(resolve);
      this.#agentTurnWaiters.set(agentId, waiters);
    });
  }

  /** True only while this Gateway process owns a turn for the Agent. */
  hasActiveAgentTurn(agentId: AgentId): boolean {
    this.requireAgent(agentId);
    return this.#activeAgentTurnLeases.has(agentId);
  }

  /** True only when no active or queued turn remains in this process. */
  isTurnQueueIdle(): boolean {
    return this.#activeAgentTurnLeases.size === 0 && this.#agentTurnWaiters.size === 0;
  }

  /** Resolves after all active and FIFO-queued turns have released their leases. */
  waitForTurnQueueIdle(): Promise<void> {
    if (this.isTurnQueueIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#idleWaiters.add(resolve);
    });
  }

  isSessionActivated(sessionId: SessionId): boolean {
    this.requireSession(sessionId);
    return this.#activatedSessionIds.has(sessionId);
  }

  markSessionActivated(sessionId: SessionId): void {
    this.requireSession(sessionId);
    this.#activatedSessionIds.add(sessionId);
  }

  #grantAgentTurn(agentId: AgentId): () => void {
    const lease = Symbol(agentId);
    this.#activeAgentTurnLeases.set(agentId, lease);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#activeAgentTurnLeases.get(agentId) === lease) {
        this.#activeAgentTurnLeases.delete(agentId);
        const waiters = this.#agentTurnWaiters.get(agentId);
        const next = waiters?.shift();
        if (waiters !== undefined && waiters.length === 0) {
          this.#agentTurnWaiters.delete(agentId);
        }
        if (next !== undefined) {
          next(this.#grantAgentTurn(agentId));
        } else {
          this.#resolveIdleWaitersIfIdle();
        }
      }
    };
  }

  #resolveIdleWaitersIfIdle(): void {
    if (!this.isTurnQueueIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  addSession(session: AgentSessionRecord): void {
    assertNonEmpty(session.id, "session.id");
    assertNonEmpty(session.adapterSession.id, "session.adapterSession.id");
    const agent = this.requireAgent(session.agentId);

    if (this.#sessions.has(session.id)) {
      throw new CoreError(
        "SESSION_ALREADY_REGISTERED",
        `Session ${session.id} is already registered`,
      );
    }
    if (agent.adapter !== session.adapter) {
      throw new CoreError(
        "ADAPTER_KIND_MISMATCH",
        `Session ${session.id} uses ${session.adapter}, but ${agent.id} uses ${agent.adapter}`,
      );
    }
    const existingOwner = [...this.#sessions.values()].find(
      (existing) =>
        existing.adapterSession.id === session.adapterSession.id,
    );
    if (existingOwner !== undefined) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Adapter session ${session.adapterSession.id} is already owned by Core session ${existingOwner.id}`,
      );
    }

    this.#sessions.set(session.id, session);
  }

  getSession(sessionId: SessionId): AgentSessionRecord | undefined {
    return this.#sessions.get(sessionId);
  }

  requireSession(sessionId: SessionId): AgentSessionRecord {
    const session = this.getSession(sessionId);
    if (session === undefined) {
      throw new CoreError("UNKNOWN_SESSION", `Unknown session: ${sessionId}`);
    }
    return session;
  }

  listSessions(agentId?: AgentId): readonly AgentSessionRecord[] {
    const sessions = [...this.#sessions.values()];
    return agentId === undefined
      ? sessions
      : sessions.filter((session) => session.agentId === agentId);
  }

  updateSessionStatus(
    sessionId: SessionId,
    status: AgentStatus,
    updatedAt: string,
  ): AgentSessionRecord {
    const current = this.requireSession(sessionId);
    const updated = isTerminalStatus(status)
      ? withoutActiveTurn(current, status, updatedAt)
      : { ...current, status, updatedAt };
    this.#sessions.set(sessionId, updated);
    return updated;
  }

  beginSessionTurn(
    sessionId: SessionId,
    activeTurn: ActiveTurnContext,
    updatedAt: string,
  ): AgentSessionRecord {
    const current = this.requireSession(sessionId);
    const updated = {
      ...current,
      status: "running" as const,
      activeTurn,
      updatedAt,
    };
    this.#sessions.set(sessionId, updated);
    return updated;
  }

  replaceAdapterSession(
    sessionId: SessionId,
    adapterSession: AgentSessionRecord["adapterSession"],
    updatedAt: string,
  ): AgentSessionRecord {
    assertNonEmpty(adapterSession.id, "adapterSession.id");
    const current = this.requireSession(sessionId);
    const existingOwner = [...this.#sessions.values()].find(
      (session) =>
        session.id !== sessionId &&
        session.adapterSession.id === adapterSession.id,
    );
    if (existingOwner !== undefined) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Adapter session ${adapterSession.id} is already owned by Core session ${existingOwner.id}`,
      );
    }
    const updated = { ...current, adapterSession, updatedAt };
    this.#sessions.set(sessionId, updated);
    return updated;
  }

  setPrimarySession(agentId: AgentId, sessionId: SessionId): void {
    this.requireAgent(agentId);
    const session = this.requireSession(sessionId);
    if (session.agentId !== agentId) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Session ${sessionId} belongs to ${session.agentId}, not ${agentId}`,
      );
    }
    this.#primarySessionIds.set(agentId, sessionId);
  }

  getPrimarySession(agentId: AgentId): AgentSessionRecord | undefined {
    const sessionId = this.#primarySessionIds.get(agentId);
    return sessionId === undefined ? undefined : this.#sessions.get(sessionId);
  }

  /** Returns the one process-local session currently holding this Koe's turn. */
  getActiveSession(agentId: AgentId): AgentSessionRecord | undefined {
    this.requireAgent(agentId);
    const active = this.listSessions(agentId).filter(
      (session) => session.activeTurn !== undefined,
    );
    if (active.length > 1) {
      throw new CoreError(
        "INVALID_STATE_SNAPSHOT",
        `Koe ${agentId} has more than one active session`,
      );
    }
    return active[0];
  }

  bindConversation(binding: ConversationBinding): void {
    const channelAgent = this.requireAgentByChannel(binding.channelId);
    const session = this.requireSession(binding.sessionId);

    if (binding.agentId !== channelAgent.id || session.agentId !== binding.agentId) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Conversation ${binding.channelId}/${binding.rootThreadTs} does not match agent ${binding.agentId}`,
      );
    }

    const key = conversationKey(binding.channelId, binding.rootThreadTs);
    const current = this.#conversations.get(key);
    if (current !== undefined) {
      if (
        current.agentId === binding.agentId &&
        current.sessionId === binding.sessionId
      ) {
        return;
      }
      throw new CoreError(
        "CONVERSATION_ALREADY_BOUND",
        `Slack conversation ${binding.channelId}/${binding.rootThreadTs} is already bound`,
      );
    }
    if ((channelAgent.conversationScope ?? "channel") === "slack_thread") {
      const existingKeys = this.#conversationKeysBySession.get(binding.sessionId);
      if (existingKeys !== undefined && existingKeys.size > 0) {
        throw new CoreError(
          "SESSION_ALREADY_BOUND",
          `Thread-scoped session ${binding.sessionId} is already bound to another Slack root`,
        );
      }
    }

    this.#conversations.set(key, binding);
    const sessionKeys = this.#conversationKeysBySession.get(binding.sessionId) ?? new Set();
    sessionKeys.add(key);
    this.#conversationKeysBySession.set(binding.sessionId, sessionKeys);
  }

  /** Rebinds a Slack reply location to the Agent's canonical session. */
  replaceConversation(binding: ConversationBinding): ConversationBinding {
    const channelAgent = this.requireAgentByChannel(binding.channelId);
    const session = this.requireSession(binding.sessionId);
    if (binding.agentId !== channelAgent.id || session.agentId !== binding.agentId) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Conversation ${binding.channelId}/${binding.rootThreadTs} does not match agent ${binding.agentId}`,
      );
    }

    const key = conversationKey(binding.channelId, binding.rootThreadTs);
    const current = this.#conversations.get(key);
    if (current === undefined) {
      throw new CoreError(
        "UNKNOWN_CONVERSATION",
        `Slack conversation ${binding.channelId}/${binding.rootThreadTs} is not bound`,
      );
    }
    if ((channelAgent.conversationScope ?? "channel") === "slack_thread") {
      const existingKeys = this.#conversationKeysBySession.get(binding.sessionId);
      if (
        existingKeys !== undefined &&
        [...existingKeys].some((existingKey) => existingKey !== key)
      ) {
        throw new CoreError(
          "SESSION_ALREADY_BOUND",
          `Thread-scoped session ${binding.sessionId} is already bound to another Slack root`,
        );
      }
    }
    const currentKeys = this.#conversationKeysBySession.get(current.sessionId);
    currentKeys?.delete(key);
    if (currentKeys?.size === 0) this.#conversationKeysBySession.delete(current.sessionId);
    this.#conversations.set(key, binding);
    const nextKeys = this.#conversationKeysBySession.get(binding.sessionId) ?? new Set();
    nextKeys.add(key);
    this.#conversationKeysBySession.set(binding.sessionId, nextKeys);
    return binding;
  }

  getConversation(
    channelId: SlackChannelId,
    rootThreadTs: SlackRootThreadTs,
  ): ConversationBinding | undefined {
    return this.#conversations.get(conversationKey(channelId, rootThreadTs));
  }

  listConversationsForSession(sessionId: SessionId): readonly ConversationBinding[] {
    const keys = this.#conversationKeysBySession.get(sessionId);
    return keys === undefined
      ? []
      : [...keys]
          .map((key) => this.#conversations.get(key))
          .filter((binding): binding is ConversationBinding => binding !== undefined);
  }

  snapshot(): CoreStateSnapshot {
    return {
      version: 1,
      agents: [...this.#agents.values()],
      sessions: [...this.#sessions.values()],
      conversations: [...this.#conversations.values()],
      primarySessions: [...this.#primarySessionIds].map(
        ([agentId, sessionId]) => ({ agentId, sessionId }),
      ),
      handledDelegationResults: [...this.#handledDelegationResults],
      usedContinuationDelegations: [...this.#usedContinuationDelegations],
      handledSlackEvents: [...this.#handledSlackEvents],
      pendingWorkspaceGitSystemRejections:
        this.listPendingWorkspaceGitSystemRejections(),
    };
  }

  #hydrate(snapshot: CoreStateSnapshot): void {
    if (snapshot.version !== 1) {
      throw new CoreError(
        "INVALID_STATE_SNAPSHOT",
        `Unsupported state snapshot version: ${String(snapshot.version)}`,
      );
    }

    for (const agent of snapshot.agents) {
      this.registerAgent(agent);
    }
    for (const session of snapshot.sessions) {
      this.addSession(session);
    }
    for (const binding of snapshot.conversations) {
      this.bindConversation(binding);
    }
    for (const primary of snapshot.primarySessions) {
      this.setPrimarySession(primary.agentId, primary.sessionId);
    }
    for (const delegationId of snapshot.handledDelegationResults ?? []) {
      this.recordHandledDelegationResult(delegationId);
    }
    for (const delegationId of snapshot.usedContinuationDelegations ?? []) {
      this.recordUsedContinuationDelegation(delegationId);
    }
    for (const eventId of snapshot.handledSlackEvents ?? []) {
      this.recordHandledSlackEvent(eventId);
    }
    this.replacePendingWorkspaceGitSystemRejections(
      snapshot.pendingWorkspaceGitSystemRejections ?? [],
    );
  }
}

function sameGitSystemRejection(
  left: PendingWorkspaceGitSystemRejection,
  right: PendingWorkspaceGitSystemRejection,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.planHash === right.planHash &&
    left.approvalTarget === right.approvalTarget &&
    left.repoId === right.repoId &&
    left.expiresAt === right.expiresAt &&
    left.actor === right.actor
  );
}
