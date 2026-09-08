export const WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION = 1 as const;
export const WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4 = 4 as const;

export type WorkspaceGitAutomationCapability =
  | "commit"
  | "push"
  | "draft_pr"
  | "force_push"
  | "main_commit"
  | "main_update"
  | "ready"
  | "merge"
  | "admin_merge"
  | "release"
  | "deploy"
  | "production_release"
  | "production_deploy";

export interface WorkspaceGitPreparedPlan {
  readonly operation_id: string;
  readonly plan_hash: string;
  readonly approval_target: string;
  readonly repo_id: string;
  readonly expires_at: string;
  readonly environment: string;
  readonly capabilities: readonly WorkspaceGitAutomationCapability[];
  readonly branch: string;
  readonly paths: readonly string[];
  readonly expected_head: string | null;
  readonly expected_snapshot_id: string;
}

export interface WorkspaceGitAutomationContext {
  readonly invocation_id: string;
  readonly deadline_at: string;
  /** Authenticated Koe identity supplied by the runtime, never model text. */
  readonly koe_id: string;
  readonly app_server: {
    readonly method: "item/tool/requestUserInput";
    readonly rpc_request_id: string | number;
    readonly thread_id: string;
    readonly turn_id: string;
    readonly item_id: string;
    readonly question_id: "git_approval";
    readonly is_blocking: true;
  };
  readonly slack: {
    readonly team_id: string;
    readonly app_id: string;
    readonly channel_id: string;
    readonly root_thread_ts: string;
    readonly source_message_ts: string;
    readonly user_id: string;
  };
}

export interface WorkspaceGitAutomationContextV4
  extends WorkspaceGitAutomationContext {
  readonly koe_binding_revision: number;
  readonly principal_policy_revision: number;
}

export interface WorkspaceGitAutomationInput {
  readonly contract_version: typeof WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION;
  readonly plan: WorkspaceGitPreparedPlan;
  readonly context: WorkspaceGitAutomationContext;
  readonly signal?: AbortSignal;
}

export interface WorkspaceGitAutomationInputV4 {
  readonly contract_version: typeof WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4;
  readonly plan: WorkspaceGitPreparedPlan;
  readonly context: WorkspaceGitAutomationContextV4;
  readonly signal?: AbortSignal;
}

export type WorkspaceGitAutomationResult =
  | {
      readonly status: "manual";
      readonly operation_id: string;
      readonly plan_hash: string;
      readonly reason:
        | "not_configured"
        | "human_approval_required"
        | "capability_not_automatable";
    }
  | {
      readonly status: "terminal_executed";
      readonly operation_id: string;
      readonly plan_hash: string;
      /** Correlation only; never accepted as authority. */
      readonly receipt_id: string;
    }
  | {
      readonly status: "blocked";
      readonly operation_id: string;
      readonly plan_hash: string;
      readonly reason:
        | "contract_mismatch"
        | "policy_blocked"
        | "provider_unavailable"
        | "outcome_uncertain"
        | "outcome_unknown";
    };

export type WorkspaceGitAutomationResultV4 =
  | {
      readonly status: "manual";
      readonly operation_id: string;
      readonly plan_hash: string;
      readonly reason:
        | "not_configured"
        | "human_approval_required"
        | "capability_not_automatable";
    }
  | {
      readonly status: "terminal_executed";
      readonly operation_id: string;
      readonly plan_hash: string;
      readonly receipt_id: string;
    }
  | {
      readonly status: "blocked";
      readonly operation_id: string;
      readonly plan_hash: string;
      readonly reason:
        | "activation_ambiguous"
        | "activation_scope_mismatch"
        | "activation_revision_mismatch"
        | "activation_digest_mismatch"
        | "activation_expired"
        | "activation_security_revoked"
        | "profile_scope_mismatch"
        | "quota_exhausted"
        | "gateway_fence_mismatch"
        | "outcome_uncertain"
        | "provider_unavailable";
    };

export interface WorkspaceGitAutomationProvider {
  readonly contract_version: typeof WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION;
  readonly id: string;
  executePreparedPlan(
    input: WorkspaceGitAutomationInput,
  ): Promise<WorkspaceGitAutomationResult>;
  close?(): Promise<void>;
}

export interface WorkspaceGitAutomationProviderV4 {
  readonly contract_version: typeof WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4;
  readonly id: string;
  executePreparedPlan(
    input: WorkspaceGitAutomationInputV4,
  ): Promise<WorkspaceGitAutomationResultV4>;
  close?(): Promise<void>;
}

export type WorkspaceGitAutomationProviderAny =
  | WorkspaceGitAutomationProvider
  | WorkspaceGitAutomationProviderV4;

/**
 * OSS composition seam. A private host may inject an opaque local-mcp client;
 * ShowTalk never receives profiles, signatures, socket paths, or authority.
 */
export interface WorkspaceGitAutomationProviderFactory {
  readonly contract_version: typeof WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION;
  create():
    | WorkspaceGitAutomationProvider
    | undefined
    | Promise<WorkspaceGitAutomationProvider | undefined>;
}

export interface WorkspaceGitAutomationProviderFactoryV4 {
  readonly contract_version: typeof WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4;
  create():
    | WorkspaceGitAutomationProviderV4
    | undefined
    | Promise<WorkspaceGitAutomationProviderV4 | undefined>;
}

export type WorkspaceGitAutomationProviderFactoryAny =
  | WorkspaceGitAutomationProviderFactory
  | WorkspaceGitAutomationProviderFactoryV4;

export class ManualWorkspaceGitAutomationProvider
  implements WorkspaceGitAutomationProvider
{
  readonly contract_version = WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION;
  readonly id = "manual";

  async executePreparedPlan(
    input: WorkspaceGitAutomationInput,
  ): Promise<WorkspaceGitAutomationResult> {
    return {
      status: "manual",
      operation_id: input.plan.operation_id,
      plan_hash: input.plan.plan_hash,
      reason: "not_configured",
    };
  }
}

/** Rejects authorization-only and mismatched terminal responses. */
export function validateWorkspaceGitAutomationResult(
  input: WorkspaceGitAutomationInput,
  value: unknown,
): WorkspaceGitAutomationResult {
  const result = asRecord(value);
  if (result === undefined) {
    throw new Error("workspace-git automation provider returned an invalid result");
  }
  const status = result?.status;
  if (
    status !== "manual" &&
    status !== "terminal_executed" &&
    status !== "blocked"
  ) {
    throw new Error(
      "workspace-git automation provider returned a non-terminal result",
    );
  }
  if (
    result.operation_id !== input.plan.operation_id ||
    result.plan_hash !== input.plan.plan_hash
  ) {
    throw new Error(
      "workspace-git automation provider changed the exact plan identity",
    );
  }
  if (status === "terminal_executed") {
    return Object.freeze({
      status,
      operation_id: input.plan.operation_id,
      plan_hash: input.plan.plan_hash,
      receipt_id: boundedText(result.receipt_id, "receipt ID", 256),
    });
  }
  if (status === "manual") {
    if (
      result.reason !== "not_configured" &&
      result.reason !== "human_approval_required" &&
      result.reason !== "capability_not_automatable"
    ) {
      throw new Error("workspace-git automation manual reason is invalid");
    }
    return Object.freeze({
      status,
      operation_id: input.plan.operation_id,
      plan_hash: input.plan.plan_hash,
      reason: result.reason,
    });
  }
  if (
    result.reason !== "contract_mismatch" &&
    result.reason !== "policy_blocked" &&
    result.reason !== "provider_unavailable" &&
    result.reason !== "outcome_uncertain" &&
    result.reason !== "outcome_unknown"
  ) {
    throw new Error("workspace-git automation block reason is invalid");
  }
  return Object.freeze({
    status,
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    reason: result.reason,
  });
}

const WORKSPACE_GIT_AUTOMATION_V4_BLOCKED_REASONS = new Set([
  "activation_ambiguous",
  "activation_scope_mismatch",
  "activation_revision_mismatch",
  "activation_digest_mismatch",
  "activation_expired",
  "activation_security_revoked",
  "profile_scope_mismatch",
  "quota_exhausted",
  "gateway_fence_mismatch",
  "outcome_uncertain",
  "provider_unavailable",
]);

export function validateWorkspaceGitAutomationResultV4(
  input: WorkspaceGitAutomationInputV4,
  value: unknown,
): WorkspaceGitAutomationResultV4 {
  const result = asRecord(value);
  if (result === undefined) {
    throw new Error("workspace-git v4 automation provider returned an invalid result");
  }
  if (
    result.operation_id !== input.plan.operation_id ||
    result.plan_hash !== input.plan.plan_hash
  ) {
    throw new Error(
      "workspace-git v4 automation provider changed the exact plan identity",
    );
  }
  if (result.status === "terminal_executed") {
    assertExactKeys(result, ["status", "operation_id", "plan_hash", "receipt_id"]);
    return Object.freeze({
      status: "terminal_executed",
      operation_id: input.plan.operation_id,
      plan_hash: input.plan.plan_hash,
      receipt_id: boundedText(result.receipt_id, "receipt ID", 256),
    });
  }
  if (result.status === "manual") {
    assertExactKeys(result, ["status", "operation_id", "plan_hash", "reason"]);
    if (
      result.reason !== "not_configured" &&
      result.reason !== "human_approval_required" &&
      result.reason !== "capability_not_automatable"
    ) {
      throw new Error("workspace-git v4 automation manual reason is invalid");
    }
    return Object.freeze({
      status: "manual",
      operation_id: input.plan.operation_id,
      plan_hash: input.plan.plan_hash,
      reason: result.reason,
    });
  }
  if (
    result.status !== "blocked" ||
    typeof result.reason !== "string" ||
    !WORKSPACE_GIT_AUTOMATION_V4_BLOCKED_REASONS.has(result.reason)
  ) {
    throw new Error("workspace-git v4 automation blocked reason is invalid");
  }
  assertExactKeys(result, ["status", "operation_id", "plan_hash", "reason"]);
  return Object.freeze({
    status: "blocked",
    operation_id: input.plan.operation_id,
    plan_hash: input.plan.plan_hash,
    reason: result.reason as Extract<
      WorkspaceGitAutomationResultV4,
      { readonly status: "blocked" }
    >["reason"],
  });
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("workspace-git automation result contains unexpected fields");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`workspace-git automation ${label} is invalid`);
  }
  return value;
}
