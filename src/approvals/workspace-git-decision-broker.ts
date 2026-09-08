import type { WorkspaceGitApprovalPlan } from "../core/index.js";

/**
 * Internal fail-closed system-rejection contract. It is intentionally not the
 * manual human-decision path and has no production transport of its own.
 */
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
    super(`workspace-git system decision failed: ${code}`);
    this.name = "WorkspaceGitDecisionBrokerError";
    this.code = code;
  }
}

export function isWorkspaceGitDecisionBrokerError(
  value: unknown,
): value is WorkspaceGitDecisionBrokerError {
  return value instanceof WorkspaceGitDecisionBrokerError;
}

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
