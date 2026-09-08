import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  PrivateWorkspaceGitHumanDecisionBroker,
  WorkspaceGitHumanDecisionBrokerError,
  type WorkspaceGitHumanDecisionBroker,
  type WorkspaceGitHumanDecisionBrokerErrorCode,
  type WorkspaceGitHumanDecisionTransport,
  type WorkspaceGitManualHumanDecisionV1Payload,
} from "./workspace-git-human-decision-broker.js";

const APPROVAL_MODULE_ENV_VAR = "SHOWTALK_WORKSPACE_GIT_APPROVAL_MODULE";
const STATE_ROOT_ENV_VAR = "WORKSPACE_GIT_STATE_ROOT";
const WORKER_START_TIMEOUT_MS = 15_000;
const WORKER_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Loads only local-mcp's exported manual composition in an isolated worker.
 * Absence is an intentional fail-closed manual configuration: Slack can show
 * the plan, but no decision is recorded until an operator configures a module.
 */
export async function createWorkspaceGitHumanDecisionBrokerFromEnvironment(
  environment: NodeJS.ProcessEnv,
  options: { readonly requestTimeoutMs?: number } = {},
): Promise<WorkspaceGitHumanDecisionBroker | undefined> {
  const configuredModule = environment[APPROVAL_MODULE_ENV_VAR]?.trim();
  if (!configuredModule) return undefined;
  if (!isAbsolute(configuredModule)) {
    throw new Error(`${APPROVAL_MODULE_ENV_VAR} must be an absolute file path`);
  }
  const modulePath = resolve(configuredModule);
  await assertSafeManualModule(modulePath);

  const configuredStateRoot = environment[STATE_ROOT_ENV_VAR]?.trim();
  if (!configuredStateRoot || !isAbsolute(configuredStateRoot)) {
    throw new Error(
      `${STATE_ROOT_ENV_VAR} must be set to an absolute private state directory`,
    );
  }
  const transport = new WorkerManualHumanDecisionTransport(
    modulePath,
    resolve(configuredStateRoot),
    validatedRequestTimeout(options.requestTimeoutMs),
  );
  try {
    await transport.ready();
    return new PrivateWorkspaceGitHumanDecisionBroker(transport);
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function assertSafeManualModule(modulePath: string): Promise<void> {
  const metadata = await lstat(modulePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${APPROVAL_MODULE_ENV_VAR} must name a real regular file`);
  }
  const currentUser = process.getuid?.();
  if (currentUser !== undefined && metadata.uid !== currentUser) {
    throw new Error(`${APPROVAL_MODULE_ENV_VAR} must be owned by the current user`);
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error(`${APPROVAL_MODULE_ENV_VAR} must not be group/world writable`);
  }
}

function validatedRequestTimeout(value: number | undefined): number {
  const timeout = value ?? WORKER_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 25 || timeout > 60_000) {
    throw new Error("workspace-git manual decision timeout is invalid");
  }
  return timeout;
}

interface WorkerReply {
  readonly type: "ready" | "result";
  readonly requestId?: number;
  readonly ok?: boolean;
  readonly status?: string;
  readonly disposition?: string;
  readonly errorCode?: string;
}

class WorkerManualHumanDecisionTransport
  implements WorkspaceGitHumanDecisionTransport
{
  readonly #worker: Worker;
  readonly #readyPromise: Promise<void>;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (
        value: Awaited<
          ReturnType<WorkspaceGitHumanDecisionTransport["recordHumanDecision"]>
        >,
      ) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: NodeJS.Timeout;
    }
  >();
  #resolveReady!: () => void;
  #rejectReady!: (error: Error) => void;
  #nextRequestId = 1;
  #readySettled = false;
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
      this.#fail(new Error("workspace-git manual decision worker failed"));
    });
    this.#worker.once("exit", () => {
      if (!this.#closed) {
        this.#fail(new Error("workspace-git manual decision worker exited"));
      }
    });
  }

  async ready(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#readyPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("workspace-git manual decision worker timed out")),
            WORKER_START_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  recordHumanDecision(
    input: WorkspaceGitManualHumanDecisionV1Payload,
  ): Promise<{
    readonly status: string;
    readonly disposition: "transitioned" | "already_recorded_same_delivery";
  }> {
    if (this.#closed) {
      return Promise.reject(
        new WorkspaceGitHumanDecisionBrokerError("decision_outcome_unknown"),
      );
    }
    const requestId = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new WorkspaceGitHumanDecisionBrokerError("decision_outcome_unknown"));
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { resolve, reject, timeout });
      this.#worker.postMessage({ type: "manual_human_decision_v1", requestId, input });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new WorkspaceGitHumanDecisionBrokerError("decision_outcome_unknown"));
    await this.#worker.terminate();
  }

  #onMessage(message: unknown): void {
    const reply = asRecord(message) as WorkerReply | undefined;
    if (reply?.type === "ready") {
      if (!this.#readySettled) {
        this.#readySettled = true;
        this.#resolveReady();
      }
      return;
    }
    if (reply?.type !== "result" || !Number.isSafeInteger(reply.requestId)) return;
    const requestId = reply.requestId as number;
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timeout);
    if (reply.ok !== true) {
      pending.reject(new WorkspaceGitHumanDecisionBrokerError(
        isBrokerErrorCode(reply.errorCode) ? reply.errorCode : "state_write_failed",
      ));
      return;
    }
    if (
      typeof reply.status !== "string" ||
      (reply.disposition !== "transitioned" &&
        reply.disposition !== "already_recorded_same_delivery")
    ) {
      pending.reject(new WorkspaceGitHumanDecisionBrokerError("state_write_failed"));
      return;
    }
    pending.resolve({ status: reply.status, disposition: reply.disposition });
  }

  #fail(error: Error): void {
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#rejectReady(error);
    }
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isBrokerErrorCode(
  value: string | undefined,
): value is WorkspaceGitHumanDecisionBrokerErrorCode {
  return value === "invalid_decision" ||
    value === "operation_not_found" ||
    value === "plan_mismatch" ||
    value === "decision_replay" ||
    value === "status_conflict" ||
    value === "expired" ||
    value === "decision_outcome_unknown" ||
    value === "state_write_failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
