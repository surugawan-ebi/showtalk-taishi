import { createHash } from "node:crypto";

import type { WorkspaceGitApprovalPlan } from "../core/index.js";

export const WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION = 1 as const;

export type WorkspaceGitHumanDecision = "approve" | "reject";

export type WorkspaceGitHumanDecisionBrokerErrorCode =
  | "invalid_decision"
  | "operation_not_found"
  | "plan_mismatch"
  | "decision_replay"
  | "status_conflict"
  | "expired"
  | "decision_outcome_unknown"
  | "state_write_failed";

export class WorkspaceGitHumanDecisionBrokerError extends Error {
  readonly code: WorkspaceGitHumanDecisionBrokerErrorCode;

  constructor(code: WorkspaceGitHumanDecisionBrokerErrorCode) {
    super(publicHumanDecisionErrorMessage(code));
    this.name = "WorkspaceGitHumanDecisionBrokerError";
    this.code = code;
  }
}

export function isWorkspaceGitHumanDecisionBrokerError(
  value: unknown,
): value is WorkspaceGitHumanDecisionBrokerError {
  return value instanceof WorkspaceGitHumanDecisionBrokerError;
}

export interface WorkspaceGitHumanDecisionContext {
  readonly callerId: string;
  readonly koeId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly sessionId: string;
}

export interface WorkspaceGitHumanDecisionInput {
  readonly decision: WorkspaceGitHumanDecision;
  readonly plan: WorkspaceGitApprovalPlan;
  readonly deliveryId: string;
  readonly context: WorkspaceGitHumanDecisionContext;
}

/**
 * Minimal manual-only payload. workspace-git re-reads the private scope and
 * approval authority from its persisted exact operation. Neither value, nor
 * any automation/signing detail, crosses this boundary.
 */
export interface WorkspaceGitManualHumanDecisionV1Payload {
  readonly version: typeof WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION;
  readonly operation_id: string;
  readonly plan_hash: string;
  readonly approval_target: string;
  readonly repo_id: string;
  readonly expires_at: string;
  readonly decision: WorkspaceGitHumanDecision;
  readonly delivery_id: string;
  readonly caller_id: string;
  readonly koe_id: string;
  readonly channel_id: string;
  readonly root_thread_ts: string;
  readonly session_id: string;
}

export interface WorkspaceGitHumanDecisionTransport {
  recordHumanDecision(input: WorkspaceGitManualHumanDecisionV1Payload): Promise<{
    readonly status: string;
    readonly disposition: "transitioned" | "already_recorded_same_delivery";
  }>;
  close?(): Promise<void>;
}

export interface WorkspaceGitHumanDecisionBroker {
  readonly contract_version: typeof WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION;
  recordDecision(input: WorkspaceGitHumanDecisionInput): Promise<void>;
  close?(): Promise<void>;
}

/** Private composition seam; the standard OSS bootstrap does not supply one. */
export interface WorkspaceGitHumanDecisionBrokerFactory {
  readonly contract_version: typeof WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION;
  create():
    | WorkspaceGitHumanDecisionBroker
    | undefined
    | Promise<WorkspaceGitHumanDecisionBroker | undefined>;
}

export class PrivateWorkspaceGitHumanDecisionBroker
  implements WorkspaceGitHumanDecisionBroker
{
  readonly contract_version = WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION;
  readonly #transport: WorkspaceGitHumanDecisionTransport;

  constructor(transport: WorkspaceGitHumanDecisionTransport) {
    this.#transport = transport;
  }

  async recordDecision(input: WorkspaceGitHumanDecisionInput): Promise<void> {
    const payload = workspaceGitHumanDecisionPayload(input);
    let result: Awaited<
      ReturnType<WorkspaceGitHumanDecisionTransport["recordHumanDecision"]>
    >;
    try {
      result = await this.#transport.recordHumanDecision(payload);
    } catch (error) {
      throw normalizedTransportError(error);
    }
    const expectedStatus = input.decision === "approve" ? "approved" : "rejected";
    if (result.status !== expectedStatus) {
      throw new WorkspaceGitHumanDecisionBrokerError("status_conflict");
    }
    if (
      result.disposition !== "transitioned" &&
      result.disposition !== "already_recorded_same_delivery"
    ) {
      throw new WorkspaceGitHumanDecisionBrokerError("state_write_failed");
    }
  }

  async close(): Promise<void> {
    await this.#transport.close?.();
  }
}

export function createWorkspaceGitHumanDecisionDeliveryId(input: {
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly requestId: string;
  readonly userId: string;
  readonly decision: WorkspaceGitHumanDecision;
  readonly operationId: string;
  readonly planHash: string;
}): string {
  const hash = createHash("sha256");
  for (const part of [
    "manual-human-v1",
    input.channelId,
    input.rootThreadTs,
    input.messageTs,
    input.requestId,
    input.userId,
    input.decision,
    input.operationId,
    input.planHash,
  ]) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function workspaceGitHumanDecisionPayload(
  input: WorkspaceGitHumanDecisionInput,
): WorkspaceGitManualHumanDecisionV1Payload {
  if (input.decision !== "approve" && input.decision !== "reject") {
    throw new WorkspaceGitHumanDecisionBrokerError("invalid_decision");
  }
  if (!/^[0-9a-f]{64}$/u.test(input.deliveryId)) {
    throw new WorkspaceGitHumanDecisionBrokerError("invalid_decision");
  }
  if (input.plan.approvalScope === undefined) {
    throw new WorkspaceGitHumanDecisionBrokerError("plan_mismatch");
  }
  for (const value of [
    input.context.callerId,
    input.context.koeId,
    input.context.channelId,
    input.context.rootThreadTs,
    input.context.sessionId,
    input.plan.approvalTarget,
    input.plan.repoId,
  ]) {
    if (!safeIdentity(value, 512)) {
      throw new WorkspaceGitHumanDecisionBrokerError("invalid_decision");
    }
  }
  return Object.freeze({
    version: WORKSPACE_GIT_HUMAN_DECISION_CONTRACT_VERSION,
    operation_id: input.plan.operationId,
    plan_hash: input.plan.planHash,
    approval_target: input.plan.approvalTarget,
    repo_id: input.plan.repoId,
    expires_at: input.plan.expiresAt,
    decision: input.decision,
    delivery_id: input.deliveryId,
    caller_id: input.context.callerId,
    koe_id: input.context.koeId,
    channel_id: input.context.channelId,
    root_thread_ts: input.context.rootThreadTs,
    session_id: input.context.sessionId,
  });
}

function normalizedTransportError(
  error: unknown,
): WorkspaceGitHumanDecisionBrokerError {
  if (isWorkspaceGitHumanDecisionBrokerError(error)) return error;
  const record = asRecord(error);
  const candidate = typeof record?.code === "string"
    ? record.code
    : error instanceof Error
      ? error.message
      : undefined;
  return new WorkspaceGitHumanDecisionBrokerError(
    isBrokerErrorCode(candidate) ? candidate : "decision_outcome_unknown",
  );
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

function safeIdentity(value: string, maxLength: number): boolean {
  return value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function publicHumanDecisionErrorMessage(
  code: WorkspaceGitHumanDecisionBrokerErrorCode,
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
