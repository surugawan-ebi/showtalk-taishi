import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import type { WorkspaceGitApprovalPlan } from "../core/index.js";

const APPROVAL_MODULE_ENV_VAR = "SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE";
const LEGACY_APPROVAL_CLI_ENV_VAR = "SHOWTALK_WORKSPACE_GIT_APPROVAL_CLI";
const STATE_ROOT_ENV_VAR = "WORKSPACE_GIT_STATE_ROOT";
const WORKER_START_TIMEOUT_MS = 15_000;
const WORKER_REQUEST_TIMEOUT_MS = 10_000;

export type WorkspaceGitDecision = "approve" | "reject";

export type WorkspaceGitDecisionBrokerErrorCode =
  | "invalid_decision"
  | "operation_not_found"
  | "plan_mismatch"
  | "decision_replay"
  | "status_conflict"
  | "expired"
  | "decision_outcome_unknown"
  | "state_write_failed";

export class WorkspaceGitDecisionBrokerError extends Error {
  readonly code: WorkspaceGitDecisionBrokerErrorCode;

  constructor(code: WorkspaceGitDecisionBrokerErrorCode) {
    super(publicDecisionBrokerErrorMessage(code));
    this.name = "WorkspaceGitDecisionBrokerError";
    this.code = code;
  }
}

export function isWorkspaceGitDecisionBrokerError(
  value: unknown,
): value is WorkspaceGitDecisionBrokerError {
  return value instanceof WorkspaceGitDecisionBrokerError;
}

/** Minimum durable form used only by fail-closed system rejection retries. */
export interface WorkspaceGitDecisionPlan {
  readonly operationId: string;
  readonly planHash: string;
  readonly approvalTarget: string;
  readonly approvalAuthorityId?: string;
  readonly repoId: string;
  readonly expiresAt: string;
  readonly operation?: WorkspaceGitApprovalPlan["operation"];
}

export interface WorkspaceGitDecisionInput {
  readonly decision: WorkspaceGitDecision;
  readonly plan: WorkspaceGitDecisionPlan | WorkspaceGitApprovalPlan;
  readonly actor: string;
  readonly deliveryId?: string;
}

export interface WorkspaceGitDecisionBroker {
  recordDecision(input: WorkspaceGitDecisionInput): Promise<void>;
  close?(): Promise<void>;
}

export interface WorkspaceGitPrivateBrokerTransport {
  recordDecision(input: unknown): Promise<{
    readonly status: string;
    readonly disposition: "transitioned" | "already_recorded_same_delivery";
  }>;
  close?(): Promise<void>;
}

/**
 * Records one exact Slack decision through workspace-git's model-inaccessible
 * approval boundary. The caller authenticates and binds the Slack action first;
 * the local-mcp store performs the final exact comparison and atomic write.
 */
export class PrivateWorkspaceGitDecisionBroker
  implements WorkspaceGitDecisionBroker
{
  readonly #transport: WorkspaceGitPrivateBrokerTransport;

  constructor(transport: WorkspaceGitPrivateBrokerTransport) {
    this.#transport = transport;
  }

  async recordDecision(input: WorkspaceGitDecisionInput): Promise<void> {
    const actor = validatedActor(input.actor);
    const scope = privateApprovalScope(input.plan);
    const approvalAuthorityId = input.plan.approvalAuthorityId;
    if (
      (scope === undefined ||
        approvalAuthorityId === undefined ||
        !/^[0-9a-f]{64}$/u.test(approvalAuthorityId)) &&
      (input.decision !== "reject" || !actor.startsWith("showtalk:"))
    ) {
      throw new Error("Human workspace-git decisions require an exact plan");
    }
    const deliveryId = input.deliveryId ?? systemDecisionDeliveryId(input, actor);
    if (!/^[0-9a-f]{64}$/u.test(deliveryId)) {
      throw new Error("workspace-git decision delivery is invalid");
    }
    if (!actor.startsWith("showtalk:") && input.deliveryId === undefined) {
      throw new Error("Human workspace-git decisions require a bound delivery");
    }
    const result = await this.#transport.recordDecision({
      version: 1,
      decision: input.decision,
      actor,
      operation_id: input.plan.operationId,
      plan_hash: input.plan.planHash,
      approval_target: input.plan.approvalTarget,
      ...(approvalAuthorityId === undefined
        ? {}
        : { approval_authority_id: approvalAuthorityId }),
      repo_id: input.plan.repoId,
      expires_at: input.plan.expiresAt,
      decision_delivery_id: deliveryId,
      ...(scope === undefined ? {} : { scope }),
    });
    const expectedStatus = input.decision === "approve" ? "approved" : "rejected";
    if (result.status !== expectedStatus) {
      throw new Error(
        `workspace-git did not record the private decision: ${result.status}`,
      );
    }
    if (
      result.disposition !== "transitioned" &&
      result.disposition !== "already_recorded_same_delivery"
    ) {
      throw new Error("workspace-git returned an invalid private decision result");
    }
  }

  async close(): Promise<void> {
    await this.#transport.close?.();
  }
}

/** Builds the private broker only when the operator opted in via the .env file. */
export async function createWorkspaceGitDecisionBrokerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { readonly requestTimeoutMs?: number } = {},
): Promise<WorkspaceGitDecisionBroker | undefined> {
  const modulePath = configuredApprovalModulePath(environment);
  if (modulePath === undefined) return undefined;
  await assertSafeApprovalModule(modulePath);

  const stateRoot = environment[STATE_ROOT_ENV_VAR];
  if (stateRoot === undefined || !isAbsolute(stateRoot)) {
    throw new Error(
      `${STATE_ROOT_ENV_VAR} must be set to an absolute private state directory`,
    );
  }
  const transport = new WorkerPrivateApprovalTransport(
    modulePath,
    resolve(stateRoot),
    validatedRequestTimeout(options.requestTimeoutMs),
  );
  try {
    await transport.ready();
    return new PrivateWorkspaceGitDecisionBroker(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

function validatedRequestTimeout(value: number | undefined): number {
  const timeout = value ?? WORKER_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 25 || timeout > 60_000) {
    throw new Error("workspace-git private approval request timeout is invalid");
  }
  return timeout;
}

function configuredApprovalModulePath(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const configuredModule = environment[APPROVAL_MODULE_ENV_VAR];
  if (configuredModule !== undefined && configuredModule.length > 0) {
    if (!isAbsolute(configuredModule)) {
      throw new Error(`${APPROVAL_MODULE_ENV_VAR} must be an absolute file path`);
    }
    return resolve(configuredModule);
  }
  const legacyCli = environment[LEGACY_APPROVAL_CLI_ENV_VAR];
  if (legacyCli === undefined || legacyCli.length === 0) return undefined;
  if (!isAbsolute(legacyCli)) {
    throw new Error(`${LEGACY_APPROVAL_CLI_ENV_VAR} must be an absolute file path`);
  }
  // Backwards-compatible configuration migration only. The CLI is never run.
  return resolve(
    dirname(resolve(legacyCli)),
    "../approval/private-approval-broker.js",
  );
}

async function assertSafeApprovalModule(modulePath: string): Promise<void> {
  const metadata = await lstat(modulePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${APPROVAL_MODULE_ENV_VAR} must name a real regular file`);
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && metadata.uid !== currentUser) {
    throw new Error(`${APPROVAL_MODULE_ENV_VAR} must be owned by the current user`);
  }
}

interface WorkerReply {
  readonly type: "ready" | "result";
  readonly requestId?: number;
  readonly ok?: boolean;
  readonly status?: string;
  readonly disposition?: string;
  readonly errorCode?: string;
}

type PrivateDecisionResponse = Awaited<
  ReturnType<WorkspaceGitPrivateBrokerTransport["recordDecision"]>
>;
interface PrivateDecisionInspection {
  readonly status: string;
  readonly disposition: "recorded" | "pending";
}

class WorkerPrivateApprovalTransport
  implements WorkspaceGitPrivateBrokerTransport
{
  readonly #worker: Worker;
  readonly #readyPromise: Promise<void>;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: PrivateDecisionResponse) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  readonly #inspections = new Map<
    number,
    {
      readonly resolve: (value: PrivateDecisionInspection) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #nextRequestId = 1;
  #settledReady = false;
  #closed = false;
  readonly #requestTimeoutMs: number;

  constructor(modulePath: string, stateRoot: string, requestTimeoutMs: number) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady;
      this.#rejectReady = rejectReady;
    });
    this.#worker = new Worker(
      new URL("./workspace-git-decision-worker.js", import.meta.url),
      {
        workerData: { modulePath, stateRoot },
        env: { [STATE_ROOT_ENV_VAR]: stateRoot },
      },
    );
    this.#worker.on("message", (message: unknown) => this.#onMessage(message));
    this.#worker.once("error", () => {
      this.#fail(new Error("workspace-git private approval worker failed"));
    });
    this.#worker.once("exit", () => {
      if (!this.#closed) {
        this.#fail(new Error("workspace-git private approval worker exited"));
      }
    });
  }

  async ready(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#readyPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("workspace-git private approval worker timed out")),
            WORKER_START_TIMEOUT_MS,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async recordDecision(input: unknown): Promise<PrivateDecisionResponse> {
    await this.ready();
    if (this.#closed) {
      throw new Error("workspace-git private approval worker is closed");
    }
    const requestId = this.#nextRequestId++;
    const response = new Promise<PrivateDecisionResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#pending.delete(requestId)) return;
        void this.#reconcileTimedOutDecision(input).then(
          (inspection) => {
            if (inspection.disposition === "recorded") {
              resolve({
                status: inspection.status,
                disposition: "already_recorded_same_delivery",
              });
              return;
            }
            reject(new WorkspaceGitDecisionBrokerError(
              "decision_outcome_unknown",
            ));
          },
          (error: unknown) => {
            if (
              isWorkspaceGitDecisionBrokerError(error) &&
              error.code !== "state_write_failed"
            ) {
              reject(error);
              return;
            }
            reject(new WorkspaceGitDecisionBrokerError(
              "decision_outcome_unknown",
            ));
          },
        );
      }, this.#requestTimeoutMs);
      timeout.unref();
      this.#pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.#worker.postMessage({ type: "decision", requestId, input });
    return response;
  }

  async #reconcileTimedOutDecision(
    input: unknown,
  ): Promise<PrivateDecisionInspection> {
    if (this.#closed) {
      throw new WorkspaceGitDecisionBrokerError("decision_outcome_unknown");
    }
    const requestId = this.#nextRequestId++;
    const response = new Promise<PrivateDecisionInspection>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.#inspections.delete(requestId)) return;
        reject(new WorkspaceGitDecisionBrokerError("state_write_failed"));
      }, this.#requestTimeoutMs);
      timeout.unref();
      this.#inspections.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.#worker.postMessage({ type: "inspect", requestId, input });
    return response;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new Error("workspace-git private approval worker is closed"));
    await this.#worker.terminate();
  }

  #onMessage(message: unknown): void {
    const reply = asRecord(message) as WorkerReply | undefined;
    if (reply?.type === "ready") {
      if (!this.#settledReady) {
        this.#settledReady = true;
        this.#resolveReady();
      }
      return;
    }
    if (
      reply?.type !== "result" ||
      !Number.isSafeInteger(reply.requestId)
    ) {
      this.#fail(new Error("workspace-git private approval worker returned invalid data"));
      return;
    }
    const requestId = reply.requestId as number;
    const pending = this.#pending.get(requestId);
    const inspection = this.#inspections.get(requestId);
    if (pending === undefined && inspection === undefined) return;
    this.#pending.delete(requestId);
    this.#inspections.delete(requestId);
    if (
      reply.ok === true &&
      typeof reply.status === "string" &&
      (reply.disposition === "transitioned" ||
        reply.disposition === "already_recorded_same_delivery")
    ) {
      if (pending === undefined) {
        this.#fail(new Error("workspace-git private approval worker returned invalid data"));
        return;
      }
      pending.resolve({
        status: reply.status,
        disposition: reply.disposition,
      });
    } else if (
      reply.ok === true &&
      typeof reply.status === "string" &&
      (reply.disposition === "recorded" || reply.disposition === "pending")
    ) {
      if (inspection === undefined) {
        this.#fail(new Error("workspace-git private approval worker returned invalid data"));
        return;
      }
      inspection.resolve({
        status: reply.status,
        disposition: reply.disposition,
      });
    } else {
      (pending ?? inspection)?.reject(new WorkspaceGitDecisionBrokerError(
        parseDecisionBrokerErrorCode(reply.errorCode),
      ));
    }
  }

  #fail(error: Error): void {
    const shouldTerminate = !this.#closed;
    this.#closed = true;
    if (!this.#settledReady) {
      this.#settledReady = true;
      this.#rejectReady(error);
    }
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const pending of this.#inspections.values()) pending.reject(error);
    this.#inspections.clear();
    if (shouldTerminate) void this.#worker.terminate();
  }
}

function parseDecisionBrokerErrorCode(
  value: unknown,
): WorkspaceGitDecisionBrokerErrorCode {
  switch (value) {
    case "invalid_decision":
    case "operation_not_found":
    case "plan_mismatch":
    case "decision_replay":
    case "status_conflict":
    case "expired":
    case "decision_outcome_unknown":
    case "state_write_failed":
      return value;
    default:
      return "state_write_failed";
  }
}

function publicDecisionBrokerErrorMessage(
  code: WorkspaceGitDecisionBrokerErrorCode,
): string {
  switch (code) {
    case "invalid_decision":
      return "Git承認の入力が不正です。操作は未承認のままです。";
    case "operation_not_found":
      return "Git承認対象が現在のworkspace-git stateに見つかりません。";
    case "plan_mismatch":
      return "Slackに表示したGit計画とworkspace-gitの承認対象が一致しません。";
    case "decision_replay":
      return "別のSlack操作として処理済みのGit承認は再利用できません。";
    case "status_conflict":
      return "Git計画は承認待ちではないため、このボタンでは処理できません。";
    case "expired":
      return "Git操作の承認期限が切れています。";
    case "decision_outcome_unknown":
      return "Git承認の保存結果を確定できませんでした。App Serverは保留したままです。同じボタンで再確認してください。";
    case "state_write_failed":
      return "workspace-gitのprivate承認状態を書き込めませんでした。";
  }
}

function privateApprovalScope(
  plan: WorkspaceGitDecisionPlan | WorkspaceGitApprovalPlan,
): Record<string, unknown> | undefined {
  if (!isExactWorkspaceGitPlan(plan)) return undefined;
  return plan.approvalScope as Record<string, unknown>;
}

function isExactWorkspaceGitPlan(
  plan: WorkspaceGitDecisionPlan | WorkspaceGitApprovalPlan,
): plan is WorkspaceGitApprovalPlan {
  return plan.operation !== undefined && "mode" in plan;
}

export function createWorkspaceGitDecisionDeliveryId(input: {
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly requestId: string;
  readonly userId: string;
  readonly decision: WorkspaceGitDecision;
  readonly operationId: string;
  readonly planHash: string;
}): string {
  return hashDecisionDelivery([
    "human",
    input.channelId,
    input.rootThreadTs,
    input.messageTs,
    input.requestId,
    input.userId,
    input.decision,
    input.operationId,
    input.planHash,
  ]);
}

function systemDecisionDeliveryId(
  input: WorkspaceGitDecisionInput,
  actor: string,
): string {
  return hashDecisionDelivery([
    "system",
    actor,
    input.decision,
    input.plan.operationId,
    input.plan.planHash,
    input.plan.approvalTarget,
  ]);
}

function hashDecisionDelivery(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function validatedActor(value: string): string {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("workspace-git decision actor is invalid");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
