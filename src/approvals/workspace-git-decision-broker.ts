import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const APPROVAL_CLI_ENV_VAR = "SHOWTALK_WORKSPACE_GIT_APPROVAL_CLI";
const STATE_ROOT_ENV_VAR = "WORKSPACE_GIT_STATE_ROOT";
const MAX_CLI_OUTPUT_BYTES = 512 * 1_024;
const CLI_TIMEOUT_MS = 15_000;

export type WorkspaceGitDecision = "approve" | "reject";

export interface WorkspaceGitDecisionPlan {
  readonly operationId: string;
  readonly planHash: string;
  readonly approvalTarget: string;
  readonly repoId: string;
  readonly expiresAt: string;
}

export interface WorkspaceGitDecisionInput {
  readonly decision: WorkspaceGitDecision;
  readonly plan: WorkspaceGitDecisionPlan;
  readonly actor: string;
}

export interface WorkspaceGitDecisionBroker {
  recordDecision(input: WorkspaceGitDecisionInput): Promise<void>;
}

export type WorkspaceGitApprovalCliRunner = (
  arguments_: readonly string[],
) => Promise<unknown>;

interface WorkspaceGitApprovalStatus {
  readonly operationId: string;
  readonly planHash: string;
  readonly approvalTarget: string;
  readonly repoId: string;
  readonly expiresAt: string;
  readonly status: string;
}

/**
 * Records one exact Slack decision through workspace-git's model-inaccessible
 * approval boundary. The caller must authenticate and bind the Slack action
 * before invoking this class.
 */
export class PrivateWorkspaceGitDecisionBroker
  implements WorkspaceGitDecisionBroker
{
  readonly #runCli: WorkspaceGitApprovalCliRunner;

  constructor(runCli: WorkspaceGitApprovalCliRunner) {
    this.#runCli = runCli;
  }

  async recordDecision(input: WorkspaceGitDecisionInput): Promise<void> {
    const actor = validatedActor(input.actor);
    const before = parseApprovalStatus(
      await this.#runCli(["status", input.plan.operationId]),
    );
    assertExactPlan(before, input.plan);

    const expectedStatus = input.decision === "approve" ? "approved" : "rejected";
    if (before.status === expectedStatus) return;
    if (before.status !== "awaiting_human_approval") {
      throw new Error(
        `workspace-git operation cannot accept this decision: ${before.status}`,
      );
    }
    if (Date.parse(before.expiresAt) <= Date.now()) {
      throw new Error("workspace-git approval has expired");
    }

    const arguments_ = input.decision === "approve"
      ? [
          "approve",
          input.plan.operationId,
          input.plan.planHash,
          input.plan.approvalTarget,
          actor,
        ]
      : ["reject", input.plan.operationId];
    const after = parseApprovalStatus(await this.#runCli(arguments_));
    assertExactPlan(after, input.plan);
    if (after.status !== expectedStatus) {
      throw new Error(
        `workspace-git did not record the decision: ${after.status}`,
      );
    }
  }
}

/** Builds the private broker only when the operator opted in via the .env file. */
export async function createWorkspaceGitDecisionBrokerFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<WorkspaceGitDecisionBroker | undefined> {
  const configuredCli = environment[APPROVAL_CLI_ENV_VAR];
  if (configuredCli === undefined || configuredCli.length === 0) return undefined;
  if (!isAbsolute(configuredCli)) {
    throw new Error(`${APPROVAL_CLI_ENV_VAR} must be an absolute file path`);
  }
  const cliPath = resolve(configuredCli);
  const cliMetadata = await lstat(cliPath);
  if (!cliMetadata.isFile() || cliMetadata.isSymbolicLink()) {
    throw new Error(`${APPROVAL_CLI_ENV_VAR} must name a real regular file`);
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && cliMetadata.uid !== currentUser) {
    throw new Error(`${APPROVAL_CLI_ENV_VAR} must be owned by the current user`);
  }

  const stateRoot = environment[STATE_ROOT_ENV_VAR];
  if (stateRoot === undefined || !isAbsolute(stateRoot)) {
    throw new Error(
      `${STATE_ROOT_ENV_VAR} must be set to an absolute private state directory`,
    );
  }
  const commandEnvironment: NodeJS.ProcessEnv = {
    [STATE_ROOT_ENV_VAR]: resolve(stateRoot),
    ...(environment.PATH === undefined ? {} : { PATH: environment.PATH }),
  };
  return new PrivateWorkspaceGitDecisionBroker(async (arguments_) => {
    const stdout = await runApprovalCli(cliPath, arguments_, commandEnvironment);
    try {
      return JSON.parse(stdout) as unknown;
    } catch {
      throw new Error("workspace-git approval broker returned invalid JSON");
    }
  });
}

function runApprovalCli(
  cliPath: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      process.execPath,
      [cliPath, ...arguments_],
      {
        env: environment,
        encoding: "utf8",
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(
            new Error("workspace-git private approval command failed", {
              cause: error,
            }),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function parseApprovalStatus(value: unknown): WorkspaceGitApprovalStatus {
  const record = asRecord(value);
  if (record === undefined) {
    throw new Error("workspace-git approval broker returned an invalid response");
  }
  return {
    operationId: requiredString(record.operation_id, "operation ID", 64),
    planHash: requiredString(record.plan_hash, "plan hash", 64),
    approvalTarget: requiredString(
      record.approval_target,
      "approval target",
      256,
    ),
    repoId: requiredString(record.repo_id, "repository ID", 128),
    expiresAt: requiredString(record.expires_at, "expiry", 64),
    status: requiredString(record.status, "status", 64),
  };
}

function assertExactPlan(
  status: WorkspaceGitApprovalStatus,
  plan: WorkspaceGitDecisionPlan,
): void {
  if (
    status.operationId !== plan.operationId ||
    status.planHash !== plan.planHash ||
    status.approvalTarget !== plan.approvalTarget ||
    status.repoId !== plan.repoId ||
    status.expiresAt !== plan.expiresAt
  ) {
    throw new Error("workspace-git private approval state does not match the Slack plan");
  }
}

function validatedActor(value: string): string {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("workspace-git approving actor is invalid");
  }
  return value;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`workspace-git approval broker returned an invalid ${label}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
