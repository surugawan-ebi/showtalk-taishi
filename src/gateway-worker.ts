import { dirname } from "node:path";

import {
  loadOrCreateAdminAccessToken,
  LocalAdminServer,
  YamlAdminConfigRepository,
} from "./admin/index.js";
import { loadConfig } from "./config/loader.js";
import {
  createRuntime,
  type CreateRuntimeOptions,
  validateRuntimePrerequisites,
} from "./runtime.js";
import {
  WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION,
  workspaceGitHumanDecisionPayload,
  WorkspaceGitHumanDecisionBrokerError,
  type WorkspaceGitHumanDecisionBroker,
  type WorkspaceGitHumanDecisionBrokerFactory,
  type WorkspaceGitManualHumanDecisionV1Payload,
} from "./approvals/workspace-git-human-decision-broker.js";
import type {
  WorkspaceGitAutomationProviderFactoryAny,
} from "./approvals/workspace-git-automation-provider.js";
import {
  type WorkspaceGitAutonomyControlBrokerFactoryV4,
} from "./approvals/workspace-git-autonomy-control.js";
import { GATEWAY_RESTART_EXIT_CODE } from "./supervisor.js";

export {
  isGatewayWorker,
  superviseGatewayWorker,
} from "./supervisor.js";

export interface GatewayWorkerComposition {
  /** Optional local-mcp structural composition marker. */
  readonly contract_version?: 1 | 4;
  readonly workspaceGitHumanDecisionBrokerFactory?:
    CreateRuntimeOptions["workspaceGitHumanDecisionBrokerFactory"];
  readonly workspaceGitAutomationProviderFactory?:
    CreateRuntimeOptions["workspaceGitAutomationProviderFactory"];
  readonly workspaceGitAutonomyControlBrokerFactory?:
    CreateRuntimeOptions["workspaceGitAutonomyControlBrokerFactory"];
  /** Exact local-mcp private composition spelling. */
  readonly human_decision_broker_factory?: WorkspaceGitPrivateHumanDecisionBrokerFactory;
  /** Exact local-mcp private composition spelling. */
  readonly automation_provider_factory?: WorkspaceGitAutomationProviderFactoryAny;
  readonly autonomy_control_broker_factory?: WorkspaceGitAutonomyControlBrokerFactoryV4;
  close?(): Promise<void>;
}

interface WorkspaceGitPrivateHumanDecisionResult {
  readonly version: 1;
  readonly status: "approved" | "rejected";
  readonly disposition: "transitioned" | "already_recorded_same_delivery";
}

interface WorkspaceGitPrivateHumanDecisionBroker {
  readonly contract_version: 1;
  recordDecision(
    input: WorkspaceGitManualHumanDecisionV1Payload,
  ): Promise<WorkspaceGitPrivateHumanDecisionResult>;
}

interface WorkspaceGitPrivateHumanDecisionBrokerFactory {
  readonly contract_version: 1;
  create():
    | WorkspaceGitPrivateHumanDecisionBroker
    | Promise<WorkspaceGitPrivateHumanDecisionBroker>;
}

/**
 * Public host seam for an owner-controlled manual composition entrypoint.
 * The standard CLI can also load the same human-only v1 contract in an
 * isolated worker; automation factories remain rejected.
 */
export async function runGatewayWorker(
  path: string,
  composition: GatewayWorkerComposition = {},
): Promise<number> {
  const config = await loadConfig(path);
  await validateRuntimePrerequisites(config, { checkWorkspaces: false });
  let requestRestart: (() => void) | undefined;
  const restartRequested = new Promise<void>((resolve) => {
    requestRestart = resolve;
  });
  const adminAccess = config.gateway.admin_ui.enabled
    ? await loadOrCreateAdminAccessToken(config.gateway.state_file)
    : undefined;
  let compositionStopped = false;
  const stopComposition = async () => {
    if (compositionStopped) return;
    compositionStopped = true;
    await composition.close?.();
  };
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  try {
    const workspaceGitOptions = workspaceGitRuntimeOptionsFromComposition(composition);
    runtime = await createRuntime(config, {
      onRestartRequested: () => requestRestart?.(),
      ...workspaceGitOptions,
    });
  } catch (error) {
    await stopComposition().catch(() => undefined);
    throw error;
  }
  const adminRepository = adminAccess === undefined
    ? undefined
    : new YamlAdminConfigRepository(path);
  const adminToken = adminAccess?.token;
  const adminServer = adminAccess === undefined
    ? undefined
    : new LocalAdminServer({
        port: config.gateway.admin_ui.port,
        accessToken: adminToken!,
        repository: adminRepository!,
        modelCatalog: {
          list: async (agentId, listOptions = {}) => {
            const catalog = await runtime.listModels(agentId, listOptions);
            return {
              agent_id: agentId,
              fetched_at: catalog.fetchedAt,
              models: catalog.models.map((model) => ({
                id: model.id,
                model: model.model,
                display_name: model.displayName,
                description: model.description,
                is_default: model.isDefault,
                default_reasoning_effort: model.defaultReasoningEffort,
                supported_reasoning_efforts: model.supportedReasoningEfforts.map(
                  (effort) => ({
                    value: effort.reasoningEffort,
                    description: effort.description,
                  }),
                ),
                input_modalities: [...(model.inputModalities ?? ["text", "image"])],
              })),
            };
          },
        },
        onConfigSaved: (snapshot) =>
          runtime.applyAgentModelSettings(snapshot.agents),
        onRestartRequested: () => requestRestart?.(),
        onError: (error) => {
          console.error(
            `ShowTalk Taishi admin UI error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      });
  let resolveStop: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const requestStopSignal = () => {
    resolveStop?.();
  };
  process.once("SIGINT", requestStopSignal);
  process.once("SIGTERM", requestStopSignal);

  let runtimeStopped = false;
  let adminStopped = false;
  const stopAdmin = async () => {
    if (adminStopped) return;
    adminStopped = true;
    await adminServer?.stop();
  };
  const stopRuntime = async () => {
    if (runtimeStopped) return;
    runtimeStopped = true;
    await runtime.stop();
  };

  try {
    await runtime.start();
    console.log("ShowTalk Taishi is connected to Slack via Socket Mode.");
    if (adminServer !== undefined) {
      const adminUrl = await adminServer.start();
      console.log(
        `ShowTalk Taishi admin UI: ${adminUiUrlForLog(adminUrl)}`,
      );
    }
    const outcome = await Promise.race([
      stopRequested.then(() => "stop" as const),
      restartRequested.then(() => "restart" as const),
    ]);
    if (outcome === "stop") {
      await stopAdmin();
      await stopRuntime();
      return 0;
    }

    runtime.beginRestart();
    await stopAdmin();
    console.log("ShowTalk Taishi is draining active work before restart.");
    const drainOutcome = await Promise.race([
      runtime.waitForIdle().then(() => "idle" as const),
      stopRequested.then(() => "stop" as const),
    ]);
    await stopRuntime();
    return drainOutcome === "idle" ? GATEWAY_RESTART_EXIT_CODE : 0;
  } finally {
    process.off("SIGINT", requestStopSignal);
    process.off("SIGTERM", requestStopSignal);
    await stopAdmin();
    await stopRuntime();
    await stopComposition();
  }
}

export function workspaceGitRuntimeOptionsFromComposition(
  composition: GatewayWorkerComposition,
): Pick<
  CreateRuntimeOptions,
  "workspaceGitHumanDecisionBrokerFactory"
> {
  if (
    composition.contract_version !== undefined &&
    composition.contract_version !== 1 &&
    composition.contract_version !== 4
  ) {
    throw new Error("Unsupported workspace-git private composition contract");
  }
  if (
    composition.contract_version === 4 ||
    composition.workspaceGitAutomationProviderFactory !== undefined ||
    composition.automation_provider_factory !== undefined ||
    composition.workspaceGitAutonomyControlBrokerFactory !== undefined ||
    composition.autonomy_control_broker_factory !== undefined
  ) {
    throw new Error(
      "Workspace Git automation is retired; manual approval is required",
    );
  }
  const humanDecisionBrokerFactory = resolveHumanDecisionBrokerFactory(composition);
  return {
    ...(humanDecisionBrokerFactory === undefined
      ? {}
      : { workspaceGitHumanDecisionBrokerFactory: humanDecisionBrokerFactory }),
  };
}

function resolveHumanDecisionBrokerFactory(
  composition: GatewayWorkerComposition,
): WorkspaceGitHumanDecisionBrokerFactory | undefined {
  if (
    composition.workspaceGitHumanDecisionBrokerFactory !== undefined &&
    composition.human_decision_broker_factory !== undefined
  ) {
    throw new Error("Workspace-git human decision factory was supplied twice");
  }
  if (composition.workspaceGitHumanDecisionBrokerFactory !== undefined) {
    return composition.workspaceGitHumanDecisionBrokerFactory;
  }
  const externalFactory = composition.human_decision_broker_factory;
  if (externalFactory === undefined) return undefined;
  if (
    externalFactory.contract_version !==
    WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION
  ) {
    throw new Error("Unsupported workspace-git private human decision contract");
  }
  return {
    contract_version: WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION,
    create: async (): Promise<WorkspaceGitHumanDecisionBroker> => {
      const external = await externalFactory.create();
      if (
        external.contract_version !==
        WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION
      ) {
        throw new Error("Unsupported workspace-git private human broker contract");
      }
      return {
        contract_version: WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION,
        recordDecision: async (input) => {
          const result = await external.recordDecision(
            workspaceGitHumanDecisionPayload(input),
          );
          const expected = input.decision === "approve" ? "approved" : "rejected";
          if (result.version !== 1 || result.status !== expected) {
            throw new WorkspaceGitHumanDecisionBrokerError("status_conflict");
          }
          if (
            result.disposition !== "transitioned" &&
            result.disposition !== "already_recorded_same_delivery"
          ) {
            throw new WorkspaceGitHumanDecisionBrokerError("state_write_failed");
          }
        },
      };
    },
  };
}

export function adminUiUrlForLog(adminUrl: string): string {
  const parsed = new URL(adminUrl);
  return `${parsed.origin}${parsed.pathname}`;
}
