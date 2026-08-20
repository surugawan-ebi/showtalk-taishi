import { randomUUID } from "node:crypto";

import type { AgentAdapter } from "./adapter.js";
import type { AgentInputAttachment, SendMessageRequest } from "./adapter.js";
import { CoreError } from "./errors.js";
import { InMemoryAgentRegistry } from "./registry.js";
import type {
  ActiveTurnContext,
  AgentApproval,
  AgentDefinition,
  AgentUserInputResponse,
  AgentEvent,
  AgentSessionRecord,
  ConversationBinding,
} from "./types.js";

export interface HumanMessage {
  readonly channelId: string;
  readonly rootThreadTs: string;
  /** Exact Slack message that started this turn; rootThreadTs is only its reply destination. */
  readonly messageTs?: string;
  readonly text: string;
  readonly attachments?: readonly AgentInputAttachment[];
  readonly slackUserId?: string;
}

/** A completed routed turn that must be delivered after its caller turn ended. */
export interface DelegationResultMessage {
  readonly delegationId: string;
  readonly sourceAgentId: string;
  readonly sourceChannelId: string;
  readonly sourceRootThreadTs: string;
  readonly sourceMessageTs: string;
  readonly sourceSlackUserId?: string;
  readonly sourceSessionId: string;
  readonly sourceAdapterSessionId: string;
  readonly targetAgentId: string;
  readonly depth: number;
  readonly result: string;
}

export interface GatewayAgentEvent {
  readonly agentId: string;
  readonly sessionId: string;
  readonly conversation: ConversationBinding;
  readonly event: AgentEvent;
}

export interface GatewayOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly onStateChanged?: () => Promise<void>;
}

export interface ConversationRuntimeStatus {
  readonly agentId: string;
  readonly sessionId?: string;
  readonly status: "not_started" | AgentSessionRecord["status"];
  readonly activeTurn?: ActiveTurnContext;
  readonly activeTurnRelation?:
    | "exact_request"
    | "same_slack_thread"
    | "other_slack_thread"
    | "agent_delegation"
    | "external_or_unknown";
}

export class Gateway {
  readonly #registry: InMemoryAgentRegistry;
  readonly #adapters: ReadonlyMap<string, AgentAdapter>;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #onStateChanged: () => Promise<void>;
  readonly #activeDelegationResultIds = new Set<string>();

  constructor(
    registry: InMemoryAgentRegistry,
    adapters: Iterable<AgentAdapter>,
    options: GatewayOptions = {},
  ) {
    this.#registry = registry;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#onStateChanged = options.onStateChanged ?? (async () => undefined);
    const adapterMap = new Map<string, AgentAdapter>();
    for (const adapter of adapters) adapterMap.set(adapter.kind, adapter);
    this.#adapters = adapterMap;
  }

  async *handleHumanMessage(message: HumanMessage): AsyncIterable<GatewayAgentEvent> {
    const attachments = message.attachments ?? [];
    if (message.text.trim().length === 0 && attachments.length === 0) return;

    yield* this.#handleSlackBoundTurn(message, {
      text:
        message.text.trim().length === 0
          ? "The Slack user attached files without a text message. Inspect the attachments and respond appropriately."
          : message.text,
      ...(attachments.length === 0 ? {} : { attachments }),
      source: {
        type: "human",
        ...(message.slackUserId === undefined
          ? {}
          : { slackUserId: message.slackUserId }),
      },
    });
  }

  /** Reopens the exact source conversation after a routed result arrives late. */
  async *handleDelegationResult(
    message: DelegationResultMessage,
  ): AsyncIterable<GatewayAgentEvent> {
    const source = this.#registry.requireAgent(message.sourceAgentId);
    this.#registry.requireAgent(message.targetAgentId);
    if (source.channelId !== message.sourceChannelId) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Koe ${source.id} is not assigned to Slack channel ${message.sourceChannelId}`,
      );
    }
    if (message.result.trim().length === 0) {
      throw new TypeError("Delegation result must not be empty");
    }
    if (
      this.#activeDelegationResultIds.has(message.delegationId) ||
      this.#registry.hasHandledDelegationResult(message.delegationId)
    ) {
      throw new CoreError(
        "DELEGATION_RESULT_ALREADY_HANDLED",
        `Delegation result ${message.delegationId} was already delivered`,
      );
    }

    this.#activeDelegationResultIds.add(message.delegationId);
    this.#registry.recordHandledDelegationResult(message.delegationId);
    try {
      try {
        await this.#onStateChanged();
      } catch (error) {
        this.#registry.removeHandledDelegationResult(message.delegationId);
        throw error;
      }
      yield* this.#handleSlackBoundTurn(
        {
          channelId: message.sourceChannelId,
          rootThreadTs: message.sourceRootThreadTs,
          messageTs: message.sourceMessageTs,
          text: delegationResultPrompt(message),
          ...(message.sourceSlackUserId === undefined
            ? {}
            : { slackUserId: message.sourceSlackUserId }),
        },
        {
          text: delegationResultPrompt(message),
          source: {
            type: "agent",
            agentId: message.targetAgentId,
            delegationId: message.delegationId,
            depth: message.depth,
          },
          metadata: {
            origin: "delegation.result",
            delegationId: message.delegationId,
            targetAgentId: message.targetAgentId,
          },
        },
        {
          sourceSessionId: message.sourceSessionId,
          sourceAdapterSessionId: message.sourceAdapterSessionId,
          continuationDelegationId: message.delegationId,
          continuationDepth: message.depth,
        },
      );
    } finally {
      this.#activeDelegationResultIds.delete(message.delegationId);
    }
  }

  async *#handleSlackBoundTurn(
    message: HumanMessage,
    request: SendMessageRequest,
    expected?: {
      readonly sourceSessionId: string;
      readonly sourceAdapterSessionId: string;
      readonly continuationDelegationId: string;
      readonly continuationDepth: number;
    },
  ): AsyncIterable<GatewayAgentEvent> {
    const attachments = request.attachments ?? [];

    let session: AgentSessionRecord | undefined;
    let releaseAgentTurn: (() => void) | undefined;
    let completedNormally = false;
    try {
      const agent = this.#registry.requireAgentByChannel(message.channelId);
      releaseAgentTurn = await this.#registry.waitForAgentTurn(agent.id);
      if (expected !== undefined) {
        const current = this.#sessionForSlackRoot(
          agent,
          message.channelId,
          message.rootThreadTs,
        );
        if (
          current?.id !== expected.sourceSessionId ||
          current.adapterSession.id !== expected.sourceAdapterSessionId
        ) {
          throw new CoreError(
            "SESSION_AGENT_MISMATCH",
            `Koe ${agent.id} changed its canonical session before the delayed result could be delivered`,
          );
        }
      }
      const adapter = this.#requireAdapter(agent.adapter);
      assertAttachmentCapabilities(adapter, attachments);
      const ensured = await this.#ensureConversation(
        message.channelId,
        message.rootThreadTs,
        adapter,
      );
      session = ensured.session;
      const startedAt = this.#timestamp();
      this.#registry.beginSessionTurn(session.id, {
        type: "slack",
        channelId: message.channelId,
        rootThreadTs: message.rootThreadTs,
        messageTs: message.messageTs ?? message.rootThreadTs,
        ...(message.slackUserId === undefined
          ? {}
          : { slackUserId: message.slackUserId }),
        ...(expected === undefined
          ? {}
          : {
              continuationDelegationId: expected.continuationDelegationId,
              continuationDepth: expected.continuationDepth,
            }),
        startedAt,
      }, startedAt);
      await this.#onStateChanged();

      for await (const event of adapter.sendMessage(session.adapterSession, request)) {
        if (event.type === "status.changed") {
          this.#registry.updateSessionStatus(session.id, event.status, this.#timestamp());
          await this.#onStateChanged();
        }
        yield {
          agentId: agent.id,
          sessionId: session.id,
          conversation: ensured.conversation,
          event,
        };
      }
      completedNormally = true;
    } catch (error) {
      if (
        session !== undefined &&
        !(error instanceof CoreError && error.code === "AGENT_BUSY")
      ) {
        this.#registry.updateSessionStatus(session.id, "failed", this.#timestamp());
        await this.#onStateChanged();
      }
      throw error;
    } finally {
      try {
        if (session !== undefined && completedNormally) {
          const current = this.#registry.requireSession(session.id);
          if (
            current.status === "starting" ||
            current.status === "running" ||
            current.status === "waiting_for_approval"
          ) {
            this.#registry.updateSessionStatus(session.id, "idle", this.#timestamp());
            await this.#onStateChanged();
          }
        }
      } finally {
        releaseAgentTurn?.();
      }
    }
  }

  async interrupt(channelId: string, rootThreadTs: string): Promise<void> {
    const { adapter, session } = await this.#requireActiveConversation(
      channelId,
      rootThreadTs,
    );
    if (!adapter.capabilities.interrupt || adapter.interrupt === undefined) {
      throw new Error(`Adapter ${adapter.kind} does not support interrupt`);
    }
    await adapter.interrupt(session.adapterSession);
  }

  /** Binds a routed visit's newly posted Slack root to its fresh backend session. */
  async bindDelegationConversation(
    channelId: string,
    rootThreadTs: string,
    agentId: string,
    sessionId: string,
  ): Promise<void> {
    const agent = this.#registry.requireAgentByChannel(channelId);
    const session = this.#registry.requireSession(sessionId);
    if (agent.id !== agentId || session.agentId !== agentId) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        `Delegation conversation ${channelId}/${rootThreadTs} does not belong to Koe ${agentId}`,
      );
    }
    const current = this.#registry.getConversation(channelId, rootThreadTs);
    if (current !== undefined) {
      if (current.agentId === agentId && current.sessionId === sessionId) return;
      throw new CoreError(
        "CONVERSATION_ALREADY_BOUND",
        `Slack conversation ${channelId}/${rootThreadTs} is already bound`,
      );
    }
    this.#registry.bindConversation({ channelId, rootThreadTs, agentId, sessionId });
    await this.#onStateChanged();
  }

  isIdle(): boolean {
    return this.#registry.isTurnQueueIdle();
  }

  waitForIdle(): Promise<void> {
    return this.#registry.waitForTurnQueueIdle();
  }

  async status(
    channelId: string,
    rootThreadTs: string,
    messageTs?: string,
  ): Promise<ConversationRuntimeStatus> {
    const agent = this.#registry.requireAgentByChannel(channelId);
    const session = this.#sessionForSlackRoot(agent, channelId, rootThreadTs);
    if (session === undefined) {
      return { agentId: agent.id, status: "not_started" };
    }
    const adapter = this.#requireAdapter(session.adapter);
    const activated = await this.#activateSession(session, adapter);
    const observedStatus =
      adapter.status === undefined
        ? activated.status
        : await adapter.status(activated.adapterSession);
    const gatewayOwnsTurn = this.#registry.hasActiveAgentTurn(agent.id);
    const gatewayOwnsThisTurn =
      gatewayOwnsTurn && this.#registry.getActiveSession(agent.id)?.id === activated.id;
    // App Server can briefly report idle between turn/start and turn/started.
    // The process-local lease is authoritative while this Gateway owns a turn.
    const status = gatewayOwnsThisTurn && observedStatus === "idle"
      ? activated.status === "idle" ? "running" : activated.status
      : observedStatus;
    if (status !== activated.status) {
      this.#registry.updateSessionStatus(activated.id, status, this.#timestamp());
      await this.#onStateChanged();
    }
    const current = this.#registry.requireSession(activated.id);
    const activeTurn = gatewayOwnsThisTurn ? current.activeTurn : undefined;
    const activeTurnRelation = classifyActiveTurn(
      status,
      gatewayOwnsThisTurn,
      activeTurn,
      channelId,
      rootThreadTs,
      messageTs,
    );
    return {
      agentId: agent.id,
      sessionId: activated.id,
      status,
      ...(activeTurn === undefined ? {} : { activeTurn }),
      ...(activeTurnRelation === undefined ? {} : { activeTurnRelation }),
    };
  }

  async resolveApproval(
    channelId: string,
    rootThreadTs: string,
    approval: AgentApproval,
  ): Promise<void> {
    const { adapter, session } = await this.#requireActiveConversation(
      channelId,
      rootThreadTs,
    );
    if (!adapter.capabilities.approval || adapter.approve === undefined) {
      throw new Error(`Adapter ${adapter.kind} does not support approvals`);
    }
    await adapter.approve(session.adapterSession, approval);
  }

  /** Resolves approvals for both Slack-bound and direct delegation sessions. */
  async resolveSessionApproval(
    sessionId: string,
    approval: AgentApproval,
  ): Promise<void> {
    const session = this.#registry.requireSession(sessionId);
    const adapter = this.#requireAdapter(session.adapter);
    if (!adapter.capabilities.approval || adapter.approve === undefined) {
      throw new Error(`Adapter ${adapter.kind} does not support approvals`);
    }
    // A pending approval proves this live session is already activated by the
    // Gateway or Agent Router. Resuming here could mutate an in-flight turn.
    await adapter.approve(session.adapterSession, approval);
  }

  /** Resolves one host-bound structured choice for an active adapter session. */
  async resolveSessionUserInput(
    sessionId: string,
    response: AgentUserInputResponse,
  ): Promise<void> {
    const session = this.#registry.requireSession(sessionId);
    const adapter = this.#requireAdapter(session.adapter);
    if (
      adapter.capabilities.structuredInput !== true ||
      adapter.respondToUserInput === undefined
    ) {
      throw new Error(`Adapter ${adapter.kind} does not support structured input`);
    }
    await adapter.respondToUserInput(session.adapterSession, response);
  }

  async resolveUserInput(
    channelId: string,
    rootThreadTs: string,
    response: AgentUserInputResponse,
  ): Promise<void> {
    const { adapter, session } = await this.#requireActiveConversation(
      channelId,
      rootThreadTs,
    );
    if (
      adapter.capabilities.structuredInput !== true ||
      adapter.respondToUserInput === undefined
    ) {
      throw new Error(`Adapter ${adapter.kind} does not support structured input`);
    }
    await adapter.respondToUserInput(session.adapterSession, response);
  }

  async #ensureConversation(
    channelId: string,
    rootThreadTs: string,
    adapter: AgentAdapter,
  ): Promise<{ conversation: ConversationBinding; session: AgentSessionRecord }> {
    const agent = this.#registry.requireAgentByChannel(channelId);
    const current = this.#registry.getConversation(channelId, rootThreadTs);
    if (conversationScope(agent) === "slack_thread") {
      let session: AgentSessionRecord;
      if (current === undefined) {
        session = await this.#createSession(agent, adapter, channelId);
        const conversation = {
          channelId,
          rootThreadTs,
          agentId: agent.id,
          sessionId: session.id,
        };
        this.#registry.bindConversation(conversation);
        await this.#onStateChanged();
        return { conversation, session };
      }
      session = this.#registry.requireSession(current.sessionId);
      if (session.adapter !== adapter.kind) {
        throw new CoreError(
          "ADAPTER_KIND_MISMATCH",
          `Conversation session ${session.id} does not use adapter ${adapter.kind}`,
        );
      }
      return {
        conversation: current,
        session: await this.#activateSession(session, adapter),
      };
    }

    let session = this.#registry.getPrimarySession(agent.id);
    let stateChanged = false;

    if (session === undefined && current !== undefined) {
      session = this.#registry.requireSession(current.sessionId);
      this.#registry.setPrimarySession(agent.id, session.id);
      stateChanged = true;
    }

    if (session === undefined) {
      session = await this.#createSession(agent, adapter, channelId);
      this.#registry.setPrimarySession(agent.id, session.id);
      stateChanged = true;
    } else if (session.adapter !== adapter.kind) {
      throw new CoreError(
        "ADAPTER_KIND_MISMATCH",
        `Primary session ${session.id} does not use adapter ${adapter.kind}`,
      );
    }

    let conversation: ConversationBinding = {
      channelId,
      rootThreadTs,
      agentId: agent.id,
      sessionId: session.id,
    };
    if (current === undefined) {
      this.#registry.bindConversation(conversation);
      stateChanged = true;
    } else if (current.sessionId !== session.id) {
      conversation = this.#registry.replaceConversation(conversation);
      stateChanged = true;
    } else {
      conversation = current;
    }

    if (stateChanged) await this.#onStateChanged();
    return { conversation, session: await this.#activateSession(session, adapter) };
  }

  async #createSession(
    agent: AgentDefinition,
    adapter: AgentAdapter,
    channelId: string,
  ): Promise<AgentSessionRecord> {
    const adapterSession = await adapter.createSession({
      agent,
      reason: "slack_conversation",
      metadata: { slackChannelId: channelId },
    });
    const timestamp = this.#timestamp();
    const session = {
      id: this.#idFactory(),
      agentId: agent.id,
      adapter: adapter.kind,
      adapterSession,
      status: "idle" as const,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#registry.addSession(session);
    this.#registry.markSessionActivated(session.id);
    return session;
  }

  async #activateSession(
    session: AgentSessionRecord,
    adapter: AgentAdapter,
  ): Promise<AgentSessionRecord> {
    if (this.#registry.isSessionActivated(session.id)) return session;
    if (!adapter.capabilities.resume || adapter.resumeSession === undefined) {
      throw new Error(`Adapter ${adapter.kind} cannot resume session ${session.id}`);
    }
    const agent = this.#registry.requireAgent(session.agentId);
    const adapterSession = await adapter.resumeSession({
      agent,
      adapterSessionId: session.adapterSession.id,
      ...(session.adapterSession.state === undefined
        ? {}
        : { state: session.adapterSession.state }),
    });
    const resumed = this.#registry.replaceAdapterSession(
      session.id,
      adapterSession,
      this.#timestamp(),
    );
    this.#registry.markSessionActivated(session.id);
    await this.#onStateChanged();
    return resumed;
  }

  async #requireActiveConversation(
    channelId: string,
    rootThreadTs: string,
  ): Promise<{ adapter: AgentAdapter; session: AgentSessionRecord }> {
    const agent = this.#registry.requireAgentByChannel(channelId);
    const session = this.#sessionForSlackRoot(agent, channelId, rootThreadTs);
    if (session === undefined) {
      throw new Error("This Slack conversation has not started a session yet");
    }
    const adapter = this.#requireAdapter(session.adapter);
    return { adapter, session: await this.#activateSession(session, adapter) };
  }

  #sessionForSlackRoot(
    agent: AgentDefinition,
    channelId: string,
    rootThreadTs: string,
  ): AgentSessionRecord | undefined {
    if (conversationScope(agent) === "channel") {
      return this.#registry.getPrimarySession(agent.id);
    }
    const binding = this.#registry.getConversation(channelId, rootThreadTs);
    return binding === undefined
      ? undefined
      : this.#registry.requireSession(binding.sessionId);
  }

  #requireAdapter(kind: string): AgentAdapter {
    const adapter = this.#adapters.get(kind);
    if (adapter === undefined) {
      throw new CoreError("ADAPTER_NOT_REGISTERED", `No adapter registered for ${kind}`);
    }
    return adapter;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function conversationScope(agent: AgentDefinition): "channel" | "slack_thread" {
  return agent.conversationScope ?? "channel";
}

function delegationResultPrompt(message: DelegationResultMessage): string {
  const payload = JSON.stringify(
    {
      delegation_id: message.delegationId,
      from_koe: message.targetAgentId,
      result: message.result,
    },
    null,
    2,
  );
  return (
    "ShowTalk Taishiからの遅延返答です。以前のターンで依頼したKoeの作業が完了しました。\n" +
    "同じ永続会話の元依頼を続け、下の結果を根拠に、元依頼で明示された次のKoe工程が残っていれば許可済みの相談先へ一工程だけ進めてください。\n" +
    "全工程が完了した場合、または安全に継続できない場合は、ユーザーへ結論・変更内容・次の操作を簡潔に返答してください。\n" +
    "このdelegation_idについてagent.sendを繰り返さず、結果にない作業を完了したと断定しないでください。\n\n" +
    payload
  );
}

function classifyActiveTurn(
  status: AgentSessionRecord["status"],
  gatewayOwnsTurn: boolean,
  activeTurn: ActiveTurnContext | undefined,
  channelId: string,
  rootThreadTs: string,
  messageTs: string | undefined,
): ConversationRuntimeStatus["activeTurnRelation"] {
  if (
    status !== "starting" &&
    status !== "running" &&
    status !== "waiting_for_approval"
  ) {
    return undefined;
  }
  if (!gatewayOwnsTurn || activeTurn === undefined) return "external_or_unknown";
  if (activeTurn.type === "agent") return "agent_delegation";
  if (
    activeTurn.channelId !== channelId ||
    activeTurn.rootThreadTs !== rootThreadTs
  ) {
    return "other_slack_thread";
  }
  if (messageTs !== undefined && activeTurn.messageTs === messageTs) {
    return "exact_request";
  }
  return "same_slack_thread";
}

function assertAttachmentCapabilities(
  adapter: AgentAdapter,
  attachments: readonly AgentInputAttachment[],
): void {
  if (
    attachments.some((attachment) => attachment.kind === "image") &&
    adapter.capabilities.imageInput !== true
  ) {
    throw new CoreError(
      "ADAPTER_CAPABILITY_UNAVAILABLE",
      `Adapter ${adapter.kind} does not support image input`,
    );
  }
  if (
    attachments.some((attachment) => attachment.kind === "audio") &&
    adapter.capabilities.audioFileInput !== true
  ) {
    throw new CoreError(
      "ADAPTER_CAPABILITY_UNAVAILABLE",
      `Adapter ${adapter.kind} does not support audio file input`,
    );
  }
}
