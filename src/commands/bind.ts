import { randomUUID } from "node:crypto";

import { CodexAppServerClient } from "../adapters/codex/app-server-client.js";
import { CodexRpcError } from "../adapters/codex/protocol.js";
import type { TaishiConfig } from "../config/schema.js";
import {
  InMemoryAgentRegistry,
  type AgentDefinition,
  type AgentSessionRecord,
} from "../core/index.js";
import { createCodexProbeEnvironment } from "../runtime.js";
import {
  FileStateStore,
  type RuntimeState,
} from "../state/file-state-store.js";

export interface BindCodexThreadInput {
  readonly channelId: string;
  readonly codexThreadId: string;
  readonly replace?: boolean;
}

export interface BindCodexThreadResult {
  readonly agentId: string;
  readonly channelId: string;
  readonly codexThreadId: string;
  readonly coreSessionId: string;
  readonly outcome: "created" | "unchanged" | "replaced";
  readonly stateChanged: boolean;
}

export interface BindStateResult {
  readonly state: RuntimeState;
  readonly result: BindCodexThreadResult;
}

interface BindStateStore {
  acquireLock(): Promise<void>;
  releaseLock(): Promise<void>;
  load(): Promise<RuntimeState>;
  save(state: RuntimeState): Promise<void>;
}

export interface BindCodexThreadDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly stateStoreFactory?: (path: string) => BindStateStore;
  readonly validateThread?: (
    config: TaishiConfig,
    agentId: string,
    codexThreadId: string,
  ) => Promise<void>;
}

/**
 * Validates an existing Codex task, then changes only Taishi's canonical local
 * binding. The exclusive state lock deliberately makes this an offline command.
 */
export async function bindCodexThread(
  config: TaishiConfig,
  input: BindCodexThreadInput,
  dependencies: BindCodexThreadDependencies = {},
): Promise<BindCodexThreadResult> {
  const agent = requireConfiguredAgent(config, input.channelId);
  assertChannelScopedBinding(agent);
  validateExternalId(input.codexThreadId, "Codex task ID");
  assertMatchesDeclaredSession(config, agent.id, input.codexThreadId);
  const store =
    dependencies.stateStoreFactory?.(config.gateway.state_file) ??
    new FileStateStore(config.gateway.state_file);

  try {
    await store.acquireLock();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Another ShowTalk Taishi process is using state file")
    ) {
      throw new Error(
        "Stop ShowTalk Taishi before changing a channel binding, then run taishi bind again",
        { cause: error },
      );
    }
    throw error;
  }

  return withRelease(store, async () => {
    const validateThread =
      dependencies.validateThread ??
      ((currentConfig, agentId, threadId) =>
        validateCodexThread(currentConfig, agentId, threadId, dependencies.environment));
    await validateThread(config, agent.id, input.codexThreadId);

    const current = await store.load();
    const bound = bindCodexThreadState(config, current, input, {
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.idFactory === undefined
        ? {}
        : { idFactory: dependencies.idFactory }),
    });
    if (bound.result.stateChanged) await store.save(bound.state);
    return bound.result;
  });
}

export function bindCodexThreadState(
  config: TaishiConfig,
  state: RuntimeState,
  input: BindCodexThreadInput,
  options: {
    readonly now?: () => Date;
    readonly idFactory?: () => string;
  } = {},
): BindStateResult {
  const agent = requireConfiguredAgent(config, input.channelId);
  assertChannelScopedBinding(agent);
  validateExternalId(input.codexThreadId, "Codex task ID");
  assertMatchesDeclaredSession(config, agent.id, input.codexThreadId);
  const registry = createValidatedRegistry(config, state);
  const sessions = registry.listSessions();
  const matchingSessions = sessions.filter(
    (session) => session.adapterSession.id === input.codexThreadId,
  );
  const foreign = matchingSessions.find((session) => session.agentId !== agent.id);
  if (foreign !== undefined) {
    throw new Error(
      `Codex task ${input.codexThreadId} is already recorded for Koe ${foreign.agentId}`,
    );
  }
  if (matchingSessions.length > 1) {
    throw new Error(
      `Runtime state contains duplicate records for Codex task ${input.codexThreadId}`,
    );
  }

  const target = matchingSessions[0];
  const current = findCanonicalSession(registry, agent.id);
  const hasExistingState = registry.listSessions(agent.id).length > 0;
  const alreadyCanonical = current.session?.adapterSession.id === input.codexThreadId;

  if (!alreadyCanonical && (current.session !== undefined || current.ambiguous)) {
    if (input.replace !== true) {
      throw new Error(
        `Slack channel ${input.channelId} already has a different or ambiguous Codex task; rerun with --replace to select ${input.codexThreadId}`,
      );
    }
  } else if (!alreadyCanonical && hasExistingState && input.replace !== true) {
    throw new Error(
      `Koe ${agent.id} has existing unbound sessions; rerun with --replace to select ${input.codexThreadId}`,
    );
  }

  let selected = target;
  if (selected === undefined) {
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const coreSessionId = (options.idFactory ?? (() => randomUUID()))();
    validateExternalId(coreSessionId, "Core session ID");
    if (registry.getSession(coreSessionId) !== undefined) {
      throw new Error(`Generated Core session ID is already in use: ${coreSessionId}`);
    }
    selected = {
      id: coreSessionId,
      agentId: agent.id,
      adapter: agent.adapter,
      adapterSession: { id: input.codexThreadId },
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    registry.addSession(selected);
  }

  registry.setPrimarySession(agent.id, selected.id);
  const before = registry.snapshot();
  for (const binding of before.conversations) {
    if (binding.agentId !== agent.id || binding.sessionId === selected.id) continue;
    registry.replaceConversation({ ...binding, sessionId: selected.id });
  }

  const next: RuntimeState = { version: 1, core: registry.snapshot() };
  const stateChanged = JSON.stringify(next) !== JSON.stringify(state);
  const outcome = alreadyCanonical
    ? "unchanged"
    : hasExistingState
      ? "replaced"
      : "created";
  return {
    state: next,
    result: {
      agentId: agent.id,
      channelId: input.channelId,
      codexThreadId: input.codexThreadId,
      coreSessionId: selected.id,
      outcome,
      stateChanged,
    },
  };
}

async function validateCodexThread(
  config: TaishiConfig,
  agentId: string,
  codexThreadId: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const agent = config.agents[agentId];
  if (agent === undefined) throw new Error(`Unknown Koe: ${agentId}`);
  const adapter = config.adapters[agent.adapter];
  if (adapter === undefined) {
    throw new Error(`Koe ${agentId} references an unavailable adapter`);
  }

  let client: CodexAppServerClient | undefined;
  let reportedError: Error | undefined;
  try {
    client = await CodexAppServerClient.spawn({
      command: adapter.command,
      env: createCodexProbeEnvironment(
        config,
        environment,
        adapter.env_passthrough,
      ),
      requestTimeoutMs: 10_000,
    });
    const thread = await client.readThread(codexThreadId);
    if (thread.id !== codexThreadId) {
      throw new SafeCodexValidationError(
        "Codex App Server returned a different task ID",
      );
    }
    if (thread.ephemeral === true) {
      throw new SafeCodexValidationError(
        "An ephemeral Codex task cannot be used as a persistent binding",
      );
    }
  } catch (error) {
    reportedError = classifyCodexValidationError(
      error,
      codexThreadId,
      client !== undefined,
    );
    throw reportedError;
  } finally {
    try {
      await client?.close();
    } catch (closeError) {
      const safeCloseError = new Error(
        `Codex App Server cleanup failed after validating task ${codexThreadId}`,
        { cause: closeError },
      );
      if (reportedError !== undefined) {
        throw new AggregateError(
          [reportedError, safeCloseError],
          `Codex task ${codexThreadId} validation and App Server cleanup both failed`,
        );
      }
      throw safeCloseError;
    }
  }
}

class SafeCodexValidationError extends Error {}

function classifyCodexValidationError(
  error: unknown,
  codexThreadId: string,
  appServerStarted: boolean,
): Error {
  if (error instanceof SafeCodexValidationError) return error;
  if (!appServerStarted) {
    return new Error("Codex App Server could not be started", { cause: error });
  }
  if (error instanceof CodexRpcError) {
    return new Error(
      `Codex App Server rejected task ${codexThreadId} (RPC ${error.code})`,
      { cause: error },
    );
  }
  if (error instanceof Error && error.message.includes("timed out")) {
    return new Error(`Timed out while validating Codex task ${codexThreadId}`, {
      cause: error,
    });
  }
  if (error instanceof Error && error.message.includes("transport closed")) {
    return new Error(
      `Codex App Server closed while validating task ${codexThreadId}`,
      { cause: error },
    );
  }
  return new Error(`Codex task ${codexThreadId} could not be validated`, {
    cause: error,
  });
}

function createValidatedRegistry(
  config: TaishiConfig,
  state: RuntimeState,
): InMemoryAgentRegistry {
  const configuredAgents = configuredAgentDefinitions(config);
  const configuredById = new Map(configuredAgents.map((agent) => [agent.id, agent]));
  for (const persisted of state.core.agents) {
    const configured = configuredById.get(persisted.id);
    if (configured === undefined) {
      throw new Error(
        `Runtime state contains Koe ${persisted.id}, but it is missing from config`,
      );
    }
    if (
      configured.adapter !== persisted.adapter ||
      configured.channelId !== persisted.channelId
    ) {
      throw new Error(
        `Koe ${persisted.id} changed adapter or channel; use a new state file`,
      );
    }
  }
  return new InMemoryAgentRegistry({
    ...state.core,
    agents: configuredAgents,
  });
}

function configuredAgentDefinitions(config: TaishiConfig): AgentDefinition[] {
  return Object.entries(config.agents).map(([id, agent]) => ({
    id,
    ...(agent.slack.call_name === undefined
      ? {}
      : { callName: agent.slack.call_name }),
    adapter: agent.adapter,
    channelId: agent.slack.channel_id,
    conversationScope: agent.slack.conversation_scope,
    ...(agent.slack.persona === undefined
      ? {}
      : { slackPersona: agent.slack.persona }),
    role: agent.role,
    metadata: { workspacePath: agent.workspace.path },
  }));
}

function requireConfiguredAgent(
  config: TaishiConfig,
  channelId: string,
): AgentDefinition {
  validateExternalId(channelId, "Slack channel ID");
  for (const [id, configured] of Object.entries(config.agents)) {
    if (configured.slack.channel_id !== channelId) continue;
    return {
      id,
      ...(configured.slack.call_name === undefined
        ? {}
        : { callName: configured.slack.call_name }),
      adapter: configured.adapter,
      channelId,
      conversationScope: configured.slack.conversation_scope,
      ...(configured.slack.persona === undefined
        ? {}
        : { slackPersona: configured.slack.persona }),
      role: configured.role,
      metadata: { workspacePath: configured.workspace.path },
    };
  }
  throw new Error(`No configured Koe uses Slack channel ${channelId}`);
}

function assertChannelScopedBinding(agent: AgentDefinition): void {
  if (agent.conversationScope !== "slack_thread") return;
  throw new Error(
    `Koe ${agent.id} uses slack_thread conversation scope; taishi bind only supports a single channel-scoped backend thread`,
  );
}

function assertMatchesDeclaredSession(
  config: TaishiConfig,
  agentId: string,
  adapterSessionId: string,
): void {
  const declared = config.agents[agentId]?.adapter_session_id;
  if (declared === undefined || declared === adapterSessionId) return;
  throw new Error(
    `Koe ${agentId} declares adapter session ${declared}; update or remove adapter_session_id before binding ${adapterSessionId}`,
  );
}

function findCanonicalSession(
  registry: InMemoryAgentRegistry,
  agentId: string,
): { readonly session?: AgentSessionRecord; readonly ambiguous: boolean } {
  const explicit = registry.getPrimarySession(agentId);
  const snapshot = registry.snapshot();
  const referencedIds = new Set(
    snapshot.conversations
      .filter((binding) => binding.agentId === agentId)
      .map((binding) => binding.sessionId),
  );
  if (explicit !== undefined) referencedIds.add(explicit.id);
  if (referencedIds.size === 1) {
    return {
      session: registry.requireSession([...referencedIds][0]!),
      ambiguous: false,
    };
  }
  if (referencedIds.size > 1) return { ambiguous: true };

  const sessions = registry.listSessions(agentId);
  if (sessions.length === 1) return { session: sessions[0]!, ambiguous: false };
  return { ambiguous: sessions.length > 1 };
}

function validateExternalId(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new Error(`${label} has an invalid format`);
  }
}

async function withRelease<T>(
  store: BindStateStore,
  operation: () => Promise<T>,
): Promise<T> {
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await store.releaseLock();
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          "Channel binding failed and state-lock cleanup also failed",
        );
      }
      throw releaseError;
    }
  }
}
