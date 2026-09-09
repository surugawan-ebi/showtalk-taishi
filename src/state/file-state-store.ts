import { randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { CoreStateSnapshot } from "../core/index.js";
import type { PersistedPermissionApprovalCard } from "../slack/permission-card-tracker.js";
import type { PersistedWorkspaceGitAutonomyActivation } from "../approvals/workspace-git-autonomy-control.js";
import {
  validateGatewayRestartReceipt,
  type RecentGatewayRestartReceipt,
} from "./gateway-restart-replay-guard.js";

export interface RuntimeState {
  version: 1;
  core: CoreStateSnapshot;
  /** Bounded replay guard kept outside protocol-neutral core state. */
  recentGatewayRestartReceipts?: readonly RecentGatewayRestartReceipt[];
  /** Durable Slack terminal-update outbox kept outside protocol-neutral core state. */
  permissionApprovalCards?: readonly PersistedPermissionApprovalCard[];
  /** Opaque correlation handles for user-controlled autonomy disable actions. */
  workspaceGitAutonomyActivations?: readonly PersistedWorkspaceGitAutonomyActivation[];
  /** Monotonic generation preventing config-revision ABA from reviving authority. */
  workspaceGitAutonomyRevisionState?: WorkspaceGitAutonomyRevisionState;
}

export interface WorkspaceGitAutonomyRevisionState {
  readonly fingerprint: string;
  readonly revision: number;
}

export function emptyRuntimeState(): RuntimeState {
  return {
    version: 1,
    core: {
      version: 1,
      agents: [],
      sessions: [],
      conversations: [],
      primarySessions: [],
      handledDelegationResults: [],
      usedContinuationDelegations: [],
      handledSlackEvents: [],
      pendingWorkspaceGitSystemRejections: [],
    },
    recentGatewayRestartReceipts: [],
    permissionApprovalCards: [],
    workspaceGitAutonomyActivations: [],
  };
}

export class FileStateStore {
  #writeQueue: Promise<void> = Promise.resolve();
  #lockHandle: FileHandle | undefined;
  #lockNonce: string | undefined;

  constructor(readonly path: string) {}

  async acquireLock(): Promise<void> {
    if (this.#lockHandle !== undefined) {
      throw new Error("ShowTalk Taishi state lock is already held by this store");
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = this.#lockPath();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = randomUUID();
      const temporaryLockPath = `${lockPath}.${process.pid}.${nonce}.tmp`;
      let handle: FileHandle | undefined;
      try {
        handle = await open(temporaryLockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({ version: 1, pid: process.pid, nonce })}\n`,
          "utf8",
        );
        await handle.sync();
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryLockPath).catch(() => undefined);
        throw error;
      }
      try {
        // A hard-link install is an atomic no-clobber operation. Other
        // processes can therefore observe only a complete lock record—never
        // the open-before-write window of the old implementation.
        await link(temporaryLockPath, lockPath);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(temporaryLockPath).catch(() => undefined);
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (!(await this.#removeStaleLock())) {
          throw new Error(
            `Another ShowTalk Taishi process is using state file: ${this.path}`,
          );
        }
        continue;
      }
      await unlink(temporaryLockPath).catch(() => undefined);
      try {
        this.#lockHandle = handle;
        this.#lockNonce = nonce;
        return;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    }
    throw new Error(`Could not acquire ShowTalk Taishi state lock: ${this.path}`);
  }

  async releaseLock(): Promise<void> {
    const handle = this.#lockHandle;
    const nonce = this.#lockNonce;
    if (handle === undefined || nonce === undefined) return;
    this.#lockHandle = undefined;
    this.#lockNonce = undefined;
    let releaseError: unknown;
    try {
      const lock = await readLock(this.#lockPath());
      if (lock?.nonce === nonce) {
        await unlink(this.#lockPath());
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") releaseError = error;
    } finally {
      await handle.close().catch((error: unknown) => {
        releaseError ??= error;
      });
    }
    if (releaseError !== undefined) throw releaseError;
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  async load(): Promise<RuntimeState> {
    try {
      const raw = await readFile(this.path, "utf8");
      return validateRuntimeState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyRuntimeState();
      throw error;
    }
  }

  save(state: RuntimeState): Promise<void> {
    const snapshot = structuredClone(validateRuntimeState(state));
    const nextWrite = this.#writeQueue
      .catch(() => undefined)
      .then(() => this.#writeAtomically(snapshot));
    this.#writeQueue = nextWrite;
    return nextWrite;
  }

  async #writeAtomically(state: RuntimeState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.path);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  #lockPath(): string {
    return `${this.path}.lock`;
  }

  async #removeStaleLock(): Promise<boolean> {
    const lockPath = this.#lockPath();
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryHandle: FileHandle;
    try {
      recoveryHandle = await open(recoveryPath, "wx", 0o600);
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `ShowTalk Taishi state lock recovery is already in progress: ${this.path}`,
        );
      }
      throw error;
    }
    try {
      let lock: StateLock;
      try {
        const parsed = await readLock(lockPath);
        if (parsed === undefined) return true;
        lock = parsed;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return true;
        throw new Error(
          `ShowTalk Taishi state lock is invalid and must be inspected: ${lockPath}`,
          { cause: error },
        );
      }
      if (processIsAlive(lock.pid)) return false;
      try {
        await unlink(lockPath);
        return true;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return true;
        throw error;
      }
    } finally {
      await recoveryHandle.close().catch(() => undefined);
      await unlink(recoveryPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }
}

interface StateLock {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
}

async function readLock(path: string): Promise<StateLock | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.nonce)
  ) {
    throw new Error("Invalid ShowTalk Taishi state lock");
  }
  return value as StateLock;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}

function validateRuntimeState(value: unknown): RuntimeState {
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("core" in value) ||
    value.core === null ||
    typeof value.core !== "object"
  ) {
    throw new Error("Unsupported or corrupt ShowTalk Taishi runtime state");
  }
  const core = value.core as Record<string, unknown>;
  const runtime = value as Record<string, unknown>;
  if (
    core.version !== 1 ||
    !Array.isArray(core.agents) ||
    !Array.isArray(core.sessions) ||
    !Array.isArray(core.conversations) ||
    !Array.isArray(core.primarySessions) ||
    (core.handledDelegationResults !== undefined &&
      (!Array.isArray(core.handledDelegationResults) ||
        !core.handledDelegationResults.every(
          (item) => typeof item === "string" && item.trim().length > 0,
        ))) ||
    (core.usedContinuationDelegations !== undefined &&
      (!Array.isArray(core.usedContinuationDelegations) ||
        !core.usedContinuationDelegations.every(
          (item) => typeof item === "string" && item.trim().length > 0,
        ))) ||
    (core.handledSlackEvents !== undefined &&
      (!Array.isArray(core.handledSlackEvents) ||
        core.handledSlackEvents.length > 10_000 ||
        !core.handledSlackEvents.every(
          (item) => typeof item === "string" && item.trim().length > 0,
        ))) ||
    (core.pendingWorkspaceGitSystemRejections !== undefined &&
      (!Array.isArray(core.pendingWorkspaceGitSystemRejections) ||
        core.pendingWorkspaceGitSystemRejections.length > 1_024 ||
        !core.pendingWorkspaceGitSystemRejections.every(
          isPendingWorkspaceGitSystemRejection,
        ))) ||
    (runtime.recentGatewayRestartReceipts !== undefined &&
      (!Array.isArray(runtime.recentGatewayRestartReceipts) ||
        runtime.recentGatewayRestartReceipts.length > 32 ||
        !runtime.recentGatewayRestartReceipts.every(isGatewayRestartReceipt))) ||
    (runtime.permissionApprovalCards !== undefined &&
      (!Array.isArray(runtime.permissionApprovalCards) ||
        runtime.permissionApprovalCards.length > 128 ||
        !runtime.permissionApprovalCards.every(isPersistedPermissionApprovalCard))) ||
    (runtime.workspaceGitAutonomyActivations !== undefined &&
      (!Array.isArray(runtime.workspaceGitAutonomyActivations) ||
        runtime.workspaceGitAutonomyActivations.length > 256 ||
        !runtime.workspaceGitAutonomyActivations.every(
          isPersistedWorkspaceGitAutonomyActivation,
        ) ||
        new Set(
          runtime.workspaceGitAutonomyActivations.map((activation) =>
            (activation as PersistedWorkspaceGitAutonomyActivation).koeId
          ),
        ).size !== runtime.workspaceGitAutonomyActivations.length)) ||
    (runtime.workspaceGitAutonomyRevisionState !== undefined &&
      !isWorkspaceGitAutonomyRevisionState(
        runtime.workspaceGitAutonomyRevisionState,
      ))
  ) {
    throw new Error("Unsupported or corrupt ShowTalk Taishi runtime state");
  }
  return value as RuntimeState;
}

function isWorkspaceGitAutonomyRevisionState(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join("\u0000") ===
      ["fingerprint", "revision"].sort().join("\u0000") &&
    typeof record.fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(record.fingerprint) &&
    Number.isSafeInteger(record.revision) &&
    Number(record.revision) >= 1
  );
}

function isPersistedWorkspaceGitAutonomyActivation(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\u0000") !==
      [
        "activationHandle",
        "expiresAt",
        "koeId",
        "profileId",
        "profileRevision",
        "state",
        "updatedAt",
      ].sort().join("\u0000")
  ) {
    return false;
  }
  return (
    boundedStateString(record.koeId, 128) &&
    typeof record.profileId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.profileId) &&
    Number.isSafeInteger(record.profileRevision) &&
    Number(record.profileRevision) >= 1 &&
    typeof record.activationHandle === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(record.activationHandle) &&
    boundedStateString(record.expiresAt, 64) &&
    Number.isFinite(Date.parse(record.expiresAt as string)) &&
    (record.state === "enabled" || record.state === "disabled") &&
    boundedStateString(record.updatedAt, 64) &&
    Number.isFinite(Date.parse(record.updatedAt as string))
  );
}

function isGatewayRestartReceipt(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\u0000") !==
    ["expiresAt", "keyHash", "originInstanceId"].sort().join("\u0000")
  ) {
    return false;
  }
  try {
    validateGatewayRestartReceipt(record as unknown as RecentGatewayRestartReceipt);
    return true;
  } catch {
    return false;
  }
}

function isPersistedPermissionApprovalCard(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const route = record.route;
  const settlement = record.settlement;
  if (
    Object.keys(record).some(
      (key) => key !== "requestId" && key !== "route" && key !== "settlement",
    ) ||
    !boundedStateString(record.requestId, 256) ||
    !record.requestId.startsWith("permission:") ||
    route === null ||
    typeof route !== "object" ||
    Array.isArray(route)
  ) {
    return false;
  }
  const routeRecord = route as Record<string, unknown>;
  if (
    Object.keys(routeRecord).some(
      (key) =>
        key !== "channelId" &&
        key !== "messageTs" &&
        key !== "rootThreadTs" &&
        key !== "operation",
    ) ||
    typeof routeRecord.channelId !== "string" ||
    !/^[CGD][A-Z0-9]{1,127}$/u.test(routeRecord.channelId) ||
    typeof routeRecord.messageTs !== "string" ||
    !/^\d{1,20}\.\d{1,20}$/u.test(routeRecord.messageTs) ||
    (routeRecord.rootThreadTs !== undefined &&
      (typeof routeRecord.rootThreadTs !== "string" ||
        !/^\d{1,20}\.\d{1,20}$/u.test(routeRecord.rootThreadTs))) ||
    !boundedStateString(routeRecord.operation, 256)
  ) {
    return false;
  }
  if (settlement === undefined) return true;
  if (settlement === null || typeof settlement !== "object" || Array.isArray(settlement)) {
    return false;
  }
  const settlementRecord = settlement as Record<string, unknown>;
  return (
    Object.keys(settlementRecord).every(
      (key) =>
        key === "requestId" || key === "reason" || key === "resolvedBySlackUserId",
    ) &&
    settlementRecord.requestId === record.requestId &&
    (settlementRecord.reason === "allow_once" ||
      settlementRecord.reason === "allow_session" ||
      settlementRecord.reason === "deny" ||
      settlementRecord.reason === "cancel" ||
      settlementRecord.reason === "expired" ||
      settlementRecord.reason === "caller_cancelled" ||
      settlementRecord.reason === "coordinator_closed") &&
    (settlementRecord.resolvedBySlackUserId === undefined ||
      (typeof settlementRecord.resolvedBySlackUserId === "string" &&
        /^[UW][A-Z0-9]{1,127}$/u.test(settlementRecord.resolvedBySlackUserId)))
  );
}

function isPendingWorkspaceGitSystemRejection(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const oldKeys = [
      "actor",
      "approvalTarget",
      "expiresAt",
      "operationId",
      "planHash",
      "repoId",
    ].sort().join("\u0000");
  const currentKeys = [
    "actor",
    "approvalAuthorityId",
    "approvalTarget",
    "expiresAt",
    "operationId",
    "planHash",
    "repoId",
  ].sort().join("\u0000");
  if (
    keys.join("\u0000") !== oldKeys &&
    keys.join("\u0000") !== currentKeys
  ) {
    return false;
  }
  return (
    boundedStateString(record.operationId, 64) &&
    typeof record.planHash === "string" &&
    /^[0-9a-f]{64}$/u.test(record.planHash) &&
    boundedStateString(record.approvalTarget, 256) &&
    (record.approvalAuthorityId === undefined ||
      (typeof record.approvalAuthorityId === "string" &&
        /^[0-9a-f]{64}$/u.test(record.approvalAuthorityId))) &&
    boundedStateString(record.repoId, 128) &&
    boundedStateString(record.expiresAt, 64) &&
    Number.isFinite(Date.parse(record.expiresAt as string)) &&
    (record.actor === "showtalk:slack-projection-failure" ||
      record.actor === "showtalk:external-app-server-resolution" ||
      record.actor === "showtalk:private-decision-failure")
  );
}

function boundedStateString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
