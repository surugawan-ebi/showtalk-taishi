import { createHash } from "node:crypto";

export const WORKSPACE_GIT_AUTONOMY_CONTROL_CONTRACT_VERSION = 4 as const;

export interface WorkspaceGitAutonomyProfileCandidate {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly requestedTtlMinutes: number;
  readonly label?: string;
}

export interface WorkspaceGitAutonomyEnableInputV4 {
  readonly version: 4;
  readonly decision_id: string;
  readonly profile_id: string;
  readonly profile_revision: number;
  readonly team_id: string;
  readonly app_id: string;
  readonly koe_id: string;
  readonly koe_binding_revision: number;
  readonly principal_policy_revision: number;
  readonly activated_by_user_id: string;
  readonly requested_expires_at: string;
  readonly issued_from: {
    readonly channel_id: string;
    readonly root_thread_ts: string;
    readonly source_message_ts: string;
  };
}

export interface WorkspaceGitAutonomyEnableResultV4 {
  readonly version: 4;
  readonly activation_handle: string;
  readonly expires_at: string;
  readonly disposition: "created" | "already_enabled_same_decision";
}

export interface WorkspaceGitAutonomyDisableInputV4 {
  readonly version: 4;
  readonly activation_handle: string;
  readonly decision_id: string;
  readonly disabled_by_user_id: string;
}

export interface WorkspaceGitAutonomyDisableResultV4 {
  readonly version: 4;
  readonly activation_handle: string;
  readonly status: "disabled" | "already_disabled";
}

export interface WorkspaceGitAutonomyControlBrokerV4 {
  readonly contract_version: 4;
  enable(
    input: WorkspaceGitAutonomyEnableInputV4,
  ): Promise<WorkspaceGitAutonomyEnableResultV4>;
  disable(
    input: WorkspaceGitAutonomyDisableInputV4,
  ): Promise<WorkspaceGitAutonomyDisableResultV4>;
  close?(): Promise<void>;
}

export interface WorkspaceGitAutonomyControlBrokerFactoryV4 {
  readonly contract_version: 4;
  create():
    | WorkspaceGitAutonomyControlBrokerV4
    | Promise<WorkspaceGitAutonomyControlBrokerV4>;
}

export interface PersistedWorkspaceGitAutonomyActivation {
  readonly koeId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly activationHandle: string;
  readonly expiresAt: string;
  readonly state: "enabled" | "disabled";
  readonly updatedAt: string;
}

export interface WorkspaceGitAutonomyRuntimeSettings {
  readonly koeId: string;
  readonly channelId: string;
  readonly koeBindingRevision: number;
  readonly principalPolicyRevision: number;
  readonly candidate?: WorkspaceGitAutonomyProfileCandidate;
}

export interface WorkspaceGitAutonomyStatus {
  readonly koeId: string;
  readonly available: boolean;
  readonly state: "unconfigured" | "disabled" | "enabled" | "expired";
  readonly profileId?: string;
  readonly profileRevision?: number;
  readonly expiresAt?: string;
}

export function workspaceGitAutonomyDecisionId(input: {
  readonly operation: "enable" | "disable" | "hold";
  readonly token: string;
  readonly teamId: string;
  readonly appId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly userId: string;
  readonly koeId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly koeBindingRevision: number;
  readonly principalPolicyRevision: number;
}): string {
  const hash = createHash("sha256");
  for (const part of [
    "workspace-git-autonomy-v4",
    input.operation,
    input.token,
    input.teamId,
    input.appId,
    input.channelId,
    input.rootThreadTs,
    input.messageTs,
    input.userId,
    input.koeId,
    input.profileId,
    String(input.profileRevision),
    String(input.koeBindingRevision),
    String(input.principalPolicyRevision),
  ]) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function validateWorkspaceGitAutonomyEnableResult(
  value: unknown,
): WorkspaceGitAutonomyEnableResultV4 {
  const result = record(value);
  if (
    result?.version !== 4 ||
    !uuid(result.activation_handle) ||
    !timestamp(result.expires_at) ||
    (result.disposition !== "created" &&
      result.disposition !== "already_enabled_same_decision") ||
    Object.keys(result).length !== 4
  ) {
    throw new Error("workspace-git autonomy enable result is invalid");
  }
  return result as unknown as WorkspaceGitAutonomyEnableResultV4;
}

export function validateWorkspaceGitAutonomyDisableResult(
  value: unknown,
  expectedHandle: string,
): WorkspaceGitAutonomyDisableResultV4 {
  const result = record(value);
  if (
    result?.version !== 4 ||
    result.activation_handle !== expectedHandle ||
    (result.status !== "disabled" && result.status !== "already_disabled") ||
    Object.keys(result).length !== 3
  ) {
    throw new Error("workspace-git autonomy disable result is invalid");
  }
  return result as unknown as WorkspaceGitAutonomyDisableResultV4;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
