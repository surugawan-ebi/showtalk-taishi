import { randomUUID } from "node:crypto";
import { access, constants, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { CodexAdapter } from "./adapters/codex/adapter.js";
import { CodexAppServerClient } from "./adapters/codex/app-server-client.js";
import { createWorkspaceGitDecisionBrokerFromEnvironment } from "./approvals/workspace-git-decision-broker.js";
import { WorkspaceGitSystemRejectionCoordinator } from "./approvals/workspace-git-system-rejection-coordinator.js";
import {
  CodexModelCatalog,
  type CodexModelCatalogSnapshot,
} from "./adapters/codex/model-catalog.js";
import { buildCodexMcpThreadConfig } from "./adapters/codex/mcp-config.js";
import type { TaishiConfig } from "./config/schema.js";
import {
  AgentScopedAdapter,
  AgentRouter,
  Gateway,
  InMemoryAgentRegistry,
  type AgentAdapter,
  type AgentDefinition,
  type AgentSessionRecord,
  type CoreStateSnapshot,
} from "./core/index.js";
import {
  AuthenticatedMcpHttpServer,
  RuntimeMcpService,
  type McpHttpEndpoint,
  type RuntimeSlackPort,
} from "./mcp/index.js";
import { SlackFrontend } from "./slack/frontend.js";
import { createSlackMessagePresentation } from "./slack/presentation.js";
import { FileStateStore, type RuntimeState } from "./state/file-state-store.js";
import { PermissionEngine } from "./permissions/engine.js";
import {
  PermissionApprovalCoordinator,
  type PermissionApprovalPresentation,
  type PermissionApprovalSettlement,
} from "./permissions/approval-coordinator.js";

const MCP_TOKEN_ENV_VAR = "SHOWTALK_TAISHI_MCP_TOKEN";

export interface RunningTaishi {
  readonly gateway: Gateway;
  readonly router: AgentRouter;
  readonly frontend: TaishiFrontend;
  readonly mcpEndpoint: McpHttpEndpoint;
  listModels(
    agentId: string,
    options?: { readonly refresh?: boolean },
  ): Promise<CodexModelCatalogSnapshot>;
  applyAgentModelSettings(settings: readonly RuntimeAgentModelSettings[]): void;
  start(): Promise<void>;
  beginRestart(): void;
  waitForIdle(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeAgentModelSettings {
  readonly id: string;
  readonly model?: string | undefined;
  readonly reasoning_effort?: string | undefined;
}

export interface TaishiFrontend extends RuntimeSlackPort {
  start(): Promise<void>;
  beginRestart(): void;
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
  stop(): Promise<void>;
  presentPermissionApproval(request: PermissionApprovalPresentation): Promise<void>;
  settlePermissionApproval(settlement: PermissionApprovalSettlement): Promise<void>;
}

export interface CreateRuntimeOptions {
  readonly frontendFactory?: (
    gateway: Gateway,
    options: ConstructorParameters<typeof SlackFrontend>[1],
  ) => TaishiFrontend;
  readonly onRestartRequested?: () => void;
}

export async function createRuntime(
  config: TaishiConfig,
  options: CreateRuntimeOptions = {},
): Promise<RunningTaishi> {
  const stateStore = new FileStateStore(config.gateway.state_file);
  await stateStore.acquireLock();
  try {
    return await createLockedRuntime(config, options, stateStore);
  } catch (error) {
    try {
      await stateStore.releaseLock();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "ShowTalk Taishi startup and state-lock cleanup both failed",
      );
    }
    throw error;
  }
}

async function createLockedRuntime(
  config: TaishiConfig,
  options: CreateRuntimeOptions,
  stateStore: FileStateStore,
): Promise<RunningTaishi> {
  const attachmentRoot = resolve(
    config.gateway.attachment_dir ??
      join(dirname(resolve(config.gateway.state_file)), "attachments"),
  );
  const state = await stateStore.load();
  const workspaceGitDecisionBroker =
    await createWorkspaceGitDecisionBrokerFromEnvironment(process.env);
  const registry = createRegistry(config, state);
  const persist = async () => {
    await stateStore.save({
      version: 1,
      core: registry.snapshot(),
    });
  };
  const clients: CodexAppServerClient[] = [];
  const codexAdapters: CodexAdapter[] = [];
  const permissions = new PermissionEngine(config.permissions, config.agents);
  const permissionApprovals = new PermissionApprovalCoordinator();
  const mcpService = new RuntimeMcpService(
    registry,
    permissions,
    permissionApprovals,
    {
      onProjectionError: (error) => {
        console.error(
          `ShowTalk Taishi could not project delegation activity to Slack: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      },
      ...(options.onRestartRequested === undefined
        ? {}
        : { onRestartRequested: options.onRestartRequested }),
    },
  );
  const mcpServer = new AuthenticatedMcpHttpServer(mcpService);
  let workspaceGitSystemRejections:
    | WorkspaceGitSystemRejectionCoordinator
    | undefined;

  try {
    const mcpEndpoint = await mcpServer.start();
    if (workspaceGitDecisionBroker !== undefined) {
      workspaceGitSystemRejections =
        new WorkspaceGitSystemRejectionCoordinator({
          broker: workspaceGitDecisionBroker,
          initialRecords:
            registry.listPendingWorkspaceGitSystemRejections(),
          persist: async (records) => {
            const previous =
              registry.listPendingWorkspaceGitSystemRejections();
            registry.replacePendingWorkspaceGitSystemRejections(records);
            try {
              await persist();
            } catch (error) {
              registry.replacePendingWorkspaceGitSystemRejections(previous);
              throw error;
            }
          },
          onRetryError: (error, record) => {
            console.error(
              "ShowTalk Taishi will retry a durable workspace-git rejection " +
                `for operation ${record.operationId}: ${
                  error instanceof Error ? error.message : "unknown error"
                }`,
            );
          },
        });
      workspaceGitSystemRejections.start();
    }
    const childrenByAdapter = new Map<string, Map<string, AgentAdapter>>();
    const codexAdaptersByAgent = new Map<string, CodexAdapter>();
    const modelCatalogsByAgent = new Map<string, CodexModelCatalog>();
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      const adapterConfig = config.adapters[agentConfig.adapter];
      if (adapterConfig === undefined) {
        throw new Error(`Koe ${agentId} references an unavailable adapter`);
      }
      const credential = await mcpServer.provisionAgent(agentId);
      const client = await CodexAppServerClient.spawn({
        command: adapterConfig.command,
        env: createCodexChildEnvironment(
          config,
          credential.token,
          process.env,
          adapterConfig.env_passthrough,
        ),
      });
      clients.push(client);
      modelCatalogsByAgent.set(agentId, new CodexModelCatalog(client));
      if (agentConfig.adapter_session_id !== undefined) {
        await validateConfiguredAdapterSession(
          client,
          agentId,
          agentConfig.adapter_session_id,
        );
      }
      const configuredModel = agentConfig.model ?? adapterConfig.model;
      const configuredReasoningEffort =
        agentConfig.reasoning_effort ?? adapterConfig.reasoning_effort;
      const child = new CodexAdapter(client, {
        kind: agentConfig.adapter,
        ...(configuredModel === undefined ? {} : { model: configuredModel }),
        ...(configuredReasoningEffort === undefined
          ? {}
          : { reasoningEffort: configuredReasoningEffort }),
        ...(adapterConfig.approval_policy === undefined
          ? {}
          : { approvalPolicy: adapterConfig.approval_policy }),
        ...(adapterConfig.approvals_reviewer === undefined
          ? {}
          : { approvalsReviewer: adapterConfig.approvals_reviewer }),
        ...(adapterConfig.sandbox === undefined
          ? {}
          : { sandbox: adapterConfig.sandbox }),
        threadConfig: buildCodexMcpThreadConfig({
          url: credential.url,
          bearerTokenEnvVar: MCP_TOKEN_ENV_VAR,
        }),
        ...(workspaceGitSystemRejections === undefined
          ? {}
          : {
              recordExternallyResolvedGitPlan: (
                plan: Parameters<
                  WorkspaceGitSystemRejectionCoordinator["recordRejection"]
                >[0],
              ) =>
                workspaceGitSystemRejections!.recordRejection(
                  plan,
                  "showtalk:external-app-server-resolution",
                ),
            }),
      });
      if (options.onRestartRequested !== undefined) {
        client.onClose(() => options.onRestartRequested?.());
      }
      codexAdapters.push(child);
      codexAdaptersByAgent.set(agentId, child);
      let children = childrenByAdapter.get(agentConfig.adapter);
      if (children === undefined) {
        children = new Map();
        childrenByAdapter.set(agentConfig.adapter, children);
      }
      children.set(agentId, child);
    }
    await stateStore.save({ version: 1, core: registry.snapshot() });
    const adapters = [...childrenByAdapter].map(
      ([kind, children]) => new AgentScopedAdapter(kind, children),
    );

    const gateway = new Gateway(registry, adapters, { onStateChanged: persist });
    const router = new AgentRouter(registry, adapters, {
      maxDelegationDepth: config.gateway.agent_message_max_hops,
      onStateChanged: persist,
      authorizeDelegation: async (source, target, signal) => {
        const sourceAgent = registry.requireAgent(source);
        return permissionApprovals.authorize(
          permissions.agentSend(source, target),
          {
            sourceAgentId: source,
            sourceChannelId: sourceAgent.channelId,
            operation: "agent.send",
            summary: `Send work from ${source} to ${target}`,
            grantKey: JSON.stringify(["agent.send", source, target]),
            ...permissionApprovalSlackContext(
              registry,
              source,
              sourceAgent.channelId,
            ),
          },
          signal,
        );
      },
    });
    const frontendOptions: ConstructorParameters<typeof SlackFrontend>[1] = {
      appToken: config.slack.app_token,
      botToken: config.slack.bot_token,
      approverUserIds: config.slack.approver_user_ids,
      agentChannelIds: Object.values(config.agents).map(
        (agent) => agent.slack.channel_id,
      ),
      agentIdsByChannel: Object.fromEntries(
        Object.entries(config.agents).map(([agentId, agent]) => [
          agent.slack.channel_id,
          agentId,
        ]),
      ),
      presentationsByChannel: Object.fromEntries(
        Object.values(config.agents).map((agent) => [
          agent.slack.channel_id,
          createSlackMessagePresentation(agent.slack),
        ]),
      ),
      attachmentRoot,
      permissionApprovals,
      ...(workspaceGitDecisionBroker === undefined
        ? {}
        : { workspaceGitDecisionBroker }),
      ...(workspaceGitSystemRejections === undefined
        ? {}
        : {
            workspaceGitSystemRejectionRecorder:
              workspaceGitSystemRejections,
          }),
      durableEventLedger: {
        has: (eventId) => registry.hasHandledSlackEvent(eventId),
        record: async (eventId) => {
          registry.recordHandledSlackEvent(eventId);
          await persist();
        },
      },
      ...(options.onRestartRequested === undefined
        ? {}
        : { requestRestart: options.onRestartRequested }),
    };
    const frontend =
      options.frontendFactory?.(gateway, frontendOptions) ??
      new SlackFrontend(gateway, frontendOptions);
    permissionApprovals.setPresenter((request) =>
      frontend.presentPermissionApproval(request),
    );
    permissionApprovals.setSettlementPresenter(async (settlement) => {
      await frontend.settlePermissionApproval(settlement).catch((error: unknown) => {
        console.error(
          `ShowTalk Taishi could not close a permission approval card: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        );
      });
    });
    mcpService.attach(router, gateway, frontend);

    let stopPromise: Promise<void> | undefined;
    return {
      gateway,
      router,
      frontend,
      mcpEndpoint,
      listModels: async (agentId, listOptions = {}) => {
        const catalog = modelCatalogsByAgent.get(agentId);
        if (catalog === undefined) throw new Error(`Unknown Koe: ${agentId}`);
        return catalog.list(listOptions);
      },
      applyAgentModelSettings: (settings) => {
        for (const setting of settings) {
          const adapter = codexAdaptersByAgent.get(setting.id);
          const agentConfig = config.agents[setting.id];
          if (adapter === undefined || agentConfig === undefined) continue;
          const adapterConfig = config.adapters[agentConfig.adapter];
          adapter.updateModelSettings({
            model: setting.model ?? adapterConfig?.model,
            reasoningEffort:
              setting.reasoning_effort ?? adapterConfig?.reasoning_effort,
          });
        }
      },
      start: async () => startFrontendWithStateRollback(frontend, stateStore, state),
      beginRestart: () => {
        frontend.beginRestart();
        mcpService.beginDrain();
        mcpServer.beginDrain();
      },
      waitForIdle: async () => {
        while (true) {
          await Promise.all([
            gateway.waitForIdle(),
            frontend.waitForIdle(),
            mcpService.waitForIdle(),
            mcpServer.waitForIdle(),
          ]);
          if (
            gateway.isIdle() &&
            frontend.isIdle() &&
            mcpService.isIdle() &&
            mcpServer.isIdle()
          ) return;
        }
      },
      stop: () => {
        stopPromise ??= shutdownRuntime({
          mcpService,
          mcpServer,
          permissionApprovals,
          frontend,
          codexAdapters,
          clients,
          stateStore,
          ...(workspaceGitSystemRejections === undefined
            ? {}
            : { workspaceGitSystemRejections }),
        });
        return stopPromise;
      },
    };
  } catch (error) {
    const errors: unknown[] = [error];
    mcpService.beginShutdown();
    for (const adapter of codexAdapters) adapter.shutdown();
    const rejectionResults = await Promise.allSettled(
      codexAdapters.map((adapter) => adapter.waitForSystemRejections()),
    );
    for (const result of rejectionResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    await workspaceGitSystemRejections?.close().catch((closeError: unknown) =>
      errors.push(closeError)
    );
    await permissionApprovals.close();
    await mcpServer.close().catch((closeError: unknown) => errors.push(closeError));
    const closeResults = await Promise.allSettled(
      clients.map((client) => client.close({ reportAsFailure: false })),
    );
    for (const result of closeResults) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "ShowTalk Taishi startup cleanup failed");
    }
    throw error;
  }
}

function permissionApprovalSlackContext(
  registry: InMemoryAgentRegistry,
  agentId: string,
  expectedChannelId: string,
): { readonly slackContext: { readonly rootThreadTs: string; readonly slackUserId?: string } } | Record<string, never> {
  if (!registry.hasActiveAgentTurn(agentId)) return {};
  const turn = registry.getActiveSession(agentId)?.activeTurn;
  if (turn?.type !== "slack" || turn.channelId !== expectedChannelId) return {};
  return {
    slackContext: {
      rootThreadTs: turn.rootThreadTs,
      ...(turn.slackUserId === undefined ? {} : { slackUserId: turn.slackUserId }),
    },
  };
}

export async function startFrontendWithStateRollback(
  frontend: Pick<TaishiFrontend, "start">,
  stateStore: Pick<FileStateStore, "save" | "flush">,
  previousState: RuntimeState,
): Promise<void> {
  try {
    await frontend.start();
  } catch (error) {
    try {
      await stateStore.save(previousState);
      await stateStore.flush();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Slack startup failed and the canonical session update could not be rolled back",
      );
    }
    throw error;
  }
}

export async function validateConfiguredAdapterSession(
  client: Pick<CodexAppServerClient, "readThread">,
  agentId: string,
  adapterSessionId: string,
): Promise<void> {
  const thread = await client.readThread(adapterSessionId);
  if (thread.id !== adapterSessionId) {
    throw new Error(`Koe ${agentId} resolved a different configured adapter session`);
  }
  if (thread.ephemeral === true) {
    throw new Error(`Koe ${agentId} cannot bind an ephemeral configured adapter session`);
  }
}

async function shutdownRuntime(input: {
  readonly mcpService: RuntimeMcpService;
  readonly mcpServer: AuthenticatedMcpHttpServer;
  readonly permissionApprovals: PermissionApprovalCoordinator;
  readonly frontend: TaishiFrontend;
  readonly codexAdapters: readonly CodexAdapter[];
  readonly clients: readonly CodexAppServerClient[];
  readonly stateStore: FileStateStore;
  readonly workspaceGitSystemRejections?: WorkspaceGitSystemRejectionCoordinator;
}): Promise<void> {
  const errors: unknown[] = [];
  input.mcpService.beginShutdown();
  for (const adapter of input.codexAdapters) adapter.shutdown();
  const rejectionResults = await Promise.allSettled(
    input.codexAdapters.map((adapter) => adapter.waitForSystemRejections()),
  );
  for (const result of rejectionResults) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  await input.workspaceGitSystemRejections
    ?.close()
    .catch((error: unknown) => errors.push(error));
  await input.permissionApprovals.close().catch((error: unknown) => errors.push(error));

  await input.mcpServer.close().catch((error: unknown) => errors.push(error));
  const componentResults = await Promise.allSettled([
    input.frontend.stop(),
    ...input.clients.map((client) => client.close({ reportAsFailure: false })),
  ]);
  for (const result of componentResults) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  await input.stateStore.flush().catch((error: unknown) => errors.push(error));
  await input.stateStore.releaseLock().catch((error: unknown) => errors.push(error));

  if (errors.length > 0) {
    throw new AggregateError(errors, "ShowTalk Taishi shutdown did not complete cleanly");
  }
}

export function createCodexChildEnvironment(
  config: TaishiConfig,
  mcpToken: string,
  environment: NodeJS.ProcessEnv = process.env,
  passthrough: readonly string[] = [],
): NodeJS.ProcessEnv {
  const childEnvironment = createCodexProbeEnvironment(
    config,
    environment,
    passthrough,
  );
  childEnvironment[MCP_TOKEN_ENV_VAR] = mcpToken;
  return childEnvironment;
}

/** Removes Gateway-only credentials before any Codex App Server subprocess. */
export function createCodexProbeEnvironment(
  config: TaishiConfig,
  environment: NodeJS.ProcessEnv = process.env,
  passthrough: readonly string[] = [],
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  const allowedNames = new Set([...CODEX_ENVIRONMENT_ALLOWLIST, ...passthrough]);
  for (const name of allowedNames) {
    const value = environment[name];
    if (value === undefined) continue;
    if (isGatewayCredential(config, name, value)) continue;
    childEnvironment[name] = value;
  }
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && /^LC_[A-Z0-9_]+$/u.test(name)) {
      childEnvironment[name] = value;
    }
  }
  return childEnvironment;
}

const CODEX_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "CODEX_HOME",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

function isGatewayCredential(
  config: TaishiConfig,
  name: string,
  value: string,
): boolean {
  return (
    value === config.slack.app_token ||
    value === config.slack.bot_token ||
    /^SLACK_.*TOKEN$/iu.test(name) ||
    name.toUpperCase() === MCP_TOKEN_ENV_VAR
  );
}

export function createRegistry(
  config: TaishiConfig,
  state: RuntimeState,
  now: () => Date = () => new Date(),
  idFactory: () => string = randomUUID,
): InMemoryAgentRegistry {
  const configuredAgents = Object.entries(config.agents).map(
    ([id, agent]): AgentDefinition => ({
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
      role: configuredKoeRole(id, config),
      metadata: { workspacePath: agent.workspace.path },
    }),
  );
  const configuredById = new Map(configuredAgents.map((agent) => [agent.id, agent]));
  const persistedById = new Map(
    state.core.agents.map((agent) => [agent.id, agent]),
  );

  for (const persisted of state.core.agents) {
    const configured = configuredById.get(persisted.id);
    if (configured === undefined) {
      throw new Error(
        `Runtime state contains Koe ${persisted.id}, but it is missing from config`,
      );
    }
    if (configured.adapter !== persisted.adapter) {
      throw new Error(
        `Koe ${persisted.id} changed adapter; start with a new state file`,
      );
    }
  }

  const channelChangedAgentIds = new Set(
    configuredAgents
      .filter((agent) => {
        const persisted = persistedById.get(agent.id);
        return persisted !== undefined && persisted.channelId !== agent.channelId;
      })
      .map((agent) => agent.id),
  );
  const workspaceChangedAgentIds = new Set(
    configuredAgents
      .filter((agent) => {
        const persistedWorkspace = persistedById.get(agent.id)?.metadata?.workspacePath;
        const configuredWorkspace = agent.metadata?.workspacePath;
        return (
          typeof persistedWorkspace === "string" &&
          typeof configuredWorkspace === "string" &&
          persistedWorkspace !== configuredWorkspace
        );
      })
      .map((agent) => agent.id),
  );

  const declaredSessionAgentIds = new Set(
    Object.entries(config.agents)
      .filter(([, agent]) => agent.adapter_session_id !== undefined)
      .map(([agentId]) => agentId),
  );
  const slackThreadAgentIds = new Set(
    configuredAgents
      .filter((agent) => agent.conversationScope === "slack_thread")
      .map((agent) => agent.id),
  );
  const transitionedToSlackThreadAgentIds = new Set(
    configuredAgents
      .filter((agent) => {
        const persisted = persistedById.get(agent.id);
        return (
          agent.conversationScope === "slack_thread" &&
          persisted !== undefined &&
          (persisted.conversationScope ?? "channel") !== "slack_thread"
        );
      })
      .map((agent) => agent.id),
  );
  const canonicalSessionIds = selectCanonicalSessionIds(
    configuredAgents.filter(
      (agent) =>
        !declaredSessionAgentIds.has(agent.id) &&
        !slackThreadAgentIds.has(agent.id) &&
        !channelChangedAgentIds.has(agent.id) &&
        !workspaceChangedAgentIds.has(agent.id),
    ),
    state.core,
  );
  const snapshot: CoreStateSnapshot = {
    ...state.core,
    agents: configuredAgents,
    sessions: state.core.sessions.map((session) =>
      normalizeSessionAfterRestart(session, now),
    ),
    conversations: state.core.conversations.filter(
      (binding) =>
        !transitionedToSlackThreadAgentIds.has(binding.agentId) &&
        !channelChangedAgentIds.has(binding.agentId) &&
        !workspaceChangedAgentIds.has(binding.agentId),
    ),
    primarySessions: state.core.primarySessions.filter(
      (binding) =>
        !slackThreadAgentIds.has(binding.agentId) &&
        !channelChangedAgentIds.has(binding.agentId) &&
        !workspaceChangedAgentIds.has(binding.agentId),
    ),
  };
  const registry = new InMemoryAgentRegistry(snapshot);

  // A declared adapter session is the canonical continuation point for that
  // Koe. This lets a supervised restart apply channel/session bindings without
  // editing the locked state file while a Slack turn is still being delivered.
  // Older sessions stay in state so changing the declaration never deletes
  // backend history.
  for (const agent of configuredAgents) {
    if (agent.conversationScope === "slack_thread") continue;
    const declaredSessionId = config.agents[agent.id]?.adapter_session_id;
    const canonicalId =
      declaredSessionId === undefined
        ? canonicalSessionIds.get(agent.id)
        : selectOrCreateDeclaredSession(
            registry,
            agent,
            declaredSessionId,
            now,
            idFactory,
          );
    if (canonicalId === undefined) continue;
    registry.setPrimarySession(agent.id, canonicalId);
    for (const binding of registry.snapshot().conversations) {
      if (binding.agentId !== agent.id || binding.sessionId === canonicalId) continue;
      registry.replaceConversation({ ...binding, sessionId: canonicalId });
    }
  }

  return registry;
}

export function configuredKoeRole(
  agentId: string,
  config: TaishiConfig,
): string {
  const agent = config.agents[agentId];
  if (agent === undefined) throw new Error(`Unknown configured Koe: ${agentId}`);
  const consultations = Object.entries(agent.consultations ?? {});
  const directory =
    consultations.length === 0
      ? [
          "Configured Koe consultations: none.",
          "Do not call agent.send from this Koe.",
        ]
      : [
          "Configured Koe consultations (the only allowed agent.send targets):",
          ...consultations.map(([target, rule]) => {
            const targetConfig = config.agents[target];
            const targetChannel = targetConfig?.slack.channel_id;
            const callName = targetConfig?.slack.call_name;
            return `- ${callName === undefined ? target : `${callName} [${target}]`} (Slack channel ${targetChannel ?? "unknown"}): ${rule.scope}`;
          }),
          "A configured call name and its bracketed Koe ID identify the same target. Pass either exact value to agent.send; never infer an unlisted name.",
          "For an ordered multi-Koe request, delegate one step at a time and use each returned result to decide and formulate the next configured delegation.",
          "Delayed delegation results continue the original request. Do not repeat the completed delegation_id, and bound review/fix retries instead of looping indefinitely.",
        ];
  return [agent.role.trim(), ...directory].join("\n\n");
}

function selectOrCreateDeclaredSession(
  registry: InMemoryAgentRegistry,
  agent: AgentDefinition,
  adapterSessionId: string,
  now: () => Date,
  idFactory: () => string,
): string {
  const matches = registry
    .listSessions()
    .filter((session) => session.adapterSession.id === adapterSessionId);
  const foreign = matches.find((session) => session.agentId !== agent.id);
  if (foreign !== undefined) {
    throw new Error(
      `Configured adapter session ${adapterSessionId} for Koe ${agent.id} is already recorded for Koe ${foreign.agentId}`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Runtime state contains duplicate records for configured adapter session ${adapterSessionId}`,
    );
  }
  if (matches[0] !== undefined) return matches[0].id;

  const coreSessionId = idFactory();
  if (registry.getSession(coreSessionId) !== undefined) {
    throw new Error(`Generated Core session ID is already in use: ${coreSessionId}`);
  }
  const timestamp = now().toISOString();
  registry.addSession({
    id: coreSessionId,
    agentId: agent.id,
    adapter: agent.adapter,
    adapterSession: { id: adapterSessionId },
    status: "idle",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return coreSessionId;
}

function selectCanonicalSessionIds(
  agents: readonly AgentDefinition[],
  state: CoreStateSnapshot,
): ReadonlyMap<string, string> {
  const selected = new Map<string, string>();
  const explicit = new Map(
    state.primarySessions.map((binding) => [binding.agentId, binding.sessionId]),
  );

  for (const agent of agents) {
    const explicitId = explicit.get(agent.id);
    const referencedIds = new Set(
      state.conversations
        .filter((binding) => binding.agentId === agent.id)
        .map((binding) => binding.sessionId),
    );
    if (explicitId !== undefined) referencedIds.add(explicitId);
    if (referencedIds.size === 1) {
      selected.set(agent.id, [...referencedIds][0]!);
      continue;
    }
    if (referencedIds.size > 1) {
      throw new Error(
        `Runtime state has multiple Codex threads for Koe ${agent.id}; ` +
          "select one canonical primary session before upgrading",
      );
    }
    const sessionIds = state.sessions
      .filter((session) => session.agentId === agent.id)
      .map((session) => session.id);
    if (sessionIds.length === 1) selected.set(agent.id, sessionIds[0]!);
    if (sessionIds.length > 1) {
      throw new Error(
        `Runtime state has multiple unbound Codex threads for Koe ${agent.id}; ` +
          "select one canonical primary session before upgrading",
      );
    }
  }
  return selected;
}

function isVolatileSessionStatus(
  status: CoreStateSnapshot["sessions"][number]["status"],
): boolean {
  return (
    status === "starting" ||
    status === "running" ||
    status === "waiting_for_approval" ||
    status === "waiting_for_input"
  );
}

function normalizeSessionAfterRestart(
  session: AgentSessionRecord,
  now: () => Date,
): AgentSessionRecord {
  const { activeTurn: _activeTurn, ...rest } = session;
  if (!isVolatileSessionStatus(session.status)) return rest;
  return {
    ...rest,
    status: "interrupted",
    updatedAt: now().toISOString(),
  };
}

export async function validateRuntimePrerequisites(
  config: TaishiConfig,
): Promise<readonly string[]> {
  const checks: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    const workspace = resolve(agent.workspace.path);
    const info = await stat(workspace);
    if (!info.isDirectory()) throw new Error(`Koe ${name} workspace is not a directory`);
    await access(workspace, constants.R_OK | constants.W_OK);
    checks.push(`agent:${name}:workspace`);
  }
  await access(await nearestExistingDirectory(dirname(resolve(config.gateway.state_file))), constants.W_OK);
  checks.push("gateway:state-directory");
  const attachmentRoot = resolve(
    config.gateway.attachment_dir ??
      join(dirname(resolve(config.gateway.state_file)), "attachments"),
  );
  await access(await nearestExistingDirectory(attachmentRoot), constants.W_OK);
  checks.push("gateway:attachment-directory");
  return checks;
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let current = path;
  while (true) {
    try {
      if ((await stat(current)).isDirectory()) return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`No writable parent for state file: ${path}`);
      current = parent;
    }
  }
}
