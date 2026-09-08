import { isDeepStrictEqual } from "node:util";

import type { WorkspaceGitApprovalPlan } from "../../core/index.js";

const TERMINAL_OPERATION_STATUSES = new Set([
  "rejected",
  "expired",
  "executing",
  "applied",
  "executed",
  "partial",
  "failed",
  "outcome_uncertain",
]);

interface ApprovedExecutionWatch {
  readonly plan: WorkspaceGitApprovalPlan;
  readonly executeStartedItemIds: Set<string>;
  readonly executeCompletedItemIds: Set<string>;
  readonly executeFailedItemIds: Set<string>;
  readonly operationStatuses: Set<string>;
  continuationStarted: boolean;
  duplicateExecutionReported: boolean;
}

export type WorkspaceGitPlanBinding =
  | { readonly kind: "missing" }
  | { readonly kind: "exact"; readonly plan: WorkspaceGitApprovalPlan }
  | { readonly kind: "ambiguous" };

export type WorkspaceGitTurnCompletion =
  | { readonly kind: "not_approved" }
  | { readonly kind: "continue"; readonly plan: WorkspaceGitApprovalPlan }
  | { readonly kind: "executed" }
  | {
      readonly kind: "terminal_state_observed";
      readonly statuses: readonly string[];
    }
  | { readonly kind: "execution_incomplete" }
  | { readonly kind: "final_state_incomplete" }
  | { readonly kind: "execution_not_observed" };

export interface WorkspaceGitExecutionObservation {
  readonly duplicateExecutionDetected: boolean;
}

/**
 * Owns the process-local lifecycle of one exact workspace-git approval.
 *
 * It intentionally does not perform App Server I/O, Slack projection, private
 * approval recording, or persistence. Those remain separate trust boundaries.
 */
export class WorkspaceGitApprovalLifecycle {
  readonly #plansBySession = new Map<
    string,
    Map<string, readonly WorkspaceGitApprovalPlan[]>
  >();
  readonly #recoveryTurnsBySession = new Map<string, Set<string>>();
  readonly #invalidRequestTurnsBySession = new Map<string, Set<string>>();
  readonly #approvedExecutionsBySession = new Map<
    string,
    ApprovedExecutionWatch
  >();
  readonly #completedExecutionsBySession = new Map<
    string,
    Map<string, ApprovedExecutionWatch>
  >();

  rememberPlan(
    sessionId: string,
    turnId: string,
    plan: WorkspaceGitApprovalPlan,
  ): void {
    if (this.isRequestInvalid(sessionId, turnId)) return;
    const turns = this.#plansBySession.get(sessionId) ??
      new Map<string, readonly WorkspaceGitApprovalPlan[]>();
    const current = turns.get(turnId) ?? [];
    const duplicate = current.find((candidate) =>
      sameExactWorkspaceGitApprovalPlan(candidate, plan)
    );
    if (duplicate !== undefined) {
      this.#plansBySession.set(sessionId, turns);
      return;
    }
    // Every distinct private operation must remain available for fail-closed
    // settlement. Two plans are enough to make human binding ambiguous, but
    // dropping later plans would leave their private broker operations pending.
    turns.set(turnId, Object.freeze([...current, plan]));
    this.#plansBySession.set(sessionId, turns);
  }

  inspectPlanBinding(sessionId: string, turnId: string): WorkspaceGitPlanBinding {
    const plans = this.#plansBySession.get(sessionId)?.get(turnId) ?? [];
    if (plans.length === 0) return { kind: "missing" };
    if (plans.length !== 1) return { kind: "ambiguous" };
    return { kind: "exact", plan: plans[0]! };
  }

  consumeExactPlan(
    sessionId: string,
    turnId: string,
    expectedPlan: WorkspaceGitApprovalPlan,
  ): void {
    const turns = this.#plansBySession.get(sessionId);
    const plans = turns?.get(turnId) ?? [];
    if (
      plans.length !== 1 ||
      !sameExactWorkspaceGitApprovalPlan(plans[0]!, expectedPlan)
    ) {
      throw new Error("workspace-git plan binding changed before consumption");
    }
    turns!.delete(turnId);
    if (turns!.size === 0) this.#plansBySession.delete(sessionId);
  }

  discardTurnPlans(sessionId: string, turnId: string): number {
    return this.takeTurnPlans(sessionId, turnId).length;
  }

  takeTurnPlans(
    sessionId: string,
    turnId: string,
  ): readonly WorkspaceGitApprovalPlan[] {
    const turns = this.#plansBySession.get(sessionId);
    const plans = turns?.get(turnId) ?? [];
    if (plans.length === 0) return Object.freeze([]);
    turns!.delete(turnId);
    if (turns!.size === 0) this.#plansBySession.delete(sessionId);
    return plans;
  }

  markRecoveryRequired(sessionId: string, turnId: string): boolean {
    const turns = this.#recoveryTurnsBySession.get(sessionId) ?? new Set();
    if (turns.has(turnId)) return false;
    turns.add(turnId);
    this.#recoveryTurnsBySession.set(sessionId, turns);
    return true;
  }

  markRequestInvalid(sessionId: string, turnId: string): boolean {
    const turns = this.#invalidRequestTurnsBySession.get(sessionId) ?? new Set();
    if (turns.has(turnId)) return false;
    turns.add(turnId);
    this.#invalidRequestTurnsBySession.set(sessionId, turns);
    return true;
  }

  isRequestInvalid(sessionId: string, turnId: string): boolean {
    return this.#invalidRequestTurnsBySession.get(sessionId)?.has(turnId) === true;
  }

  beginApprovedExecution(
    sessionId: string,
    plan: WorkspaceGitApprovalPlan,
  ): void {
    const current = this.#approvedExecutionsBySession.get(sessionId);
    if (current !== undefined) {
      if (!executionSucceeded(current)) {
        throw new Error("workspace-git approved execution is already active");
      }
      const completed = this.#completedExecutionsBySession.get(sessionId) ??
        new Map<string, ApprovedExecutionWatch>();
      completed.set(current.plan.operationId, current);
      this.#completedExecutionsBySession.set(sessionId, completed);
      this.#approvedExecutionsBySession.delete(sessionId);
    }
    if (
      this.#completedExecutionsBySession.get(sessionId)?.has(plan.operationId) ===
        true
    ) {
      throw new Error("workspace-git approved execution has already completed");
    }
    this.#approvedExecutionsBySession.set(sessionId, {
      plan,
      executeStartedItemIds: new Set(),
      executeCompletedItemIds: new Set(),
      executeFailedItemIds: new Set(),
      operationStatuses: new Set(),
      continuationStarted: false,
      duplicateExecutionReported: false,
    });
  }

  approvedPlan(sessionId: string): WorkspaceGitApprovalPlan | undefined {
    const watch = this.#approvedExecutionsBySession.get(sessionId);
    return watch === undefined || executionSucceeded(watch)
      ? undefined
      : watch.plan;
  }

  hasExecutionWatch(sessionId: string): boolean {
    return this.#approvedExecutionsBySession.has(sessionId) ||
      (this.#completedExecutionsBySession.get(sessionId)?.size ?? 0) > 0;
  }

  isCompletedOperation(sessionId: string, operationId: string): boolean {
    const active = this.#approvedExecutionsBySession.get(sessionId);
    if (
      active?.plan.operationId === operationId &&
      executionSucceeded(active)
    ) {
      return true;
    }
    return this.#completedExecutionsBySession.get(sessionId)?.has(operationId) ===
      true;
  }

  clearApprovedExecution(
    sessionId: string,
    expectedPlan?: WorkspaceGitApprovalPlan,
  ): boolean {
    const watch = this.#approvedExecutionsBySession.get(sessionId);
    if (
      watch === undefined ||
      (expectedPlan !== undefined &&
        !sameExactWorkspaceGitApprovalPlan(watch.plan, expectedPlan))
    ) {
      return false;
    }
    this.#approvedExecutionsBySession.delete(sessionId);
    return true;
  }

  observeItem(
    sessionId: string,
    item: Record<string, unknown>,
  ): WorkspaceGitExecutionObservation {
    const watch = this.#approvedExecutionsBySession.get(sessionId);
    let duplicateExecutionDetected = watch === undefined
      ? false
      : observeApprovedItem(watch, item).duplicateExecutionDetected;
    for (const completed of this.#completedExecutionsBySession.get(sessionId)?.values() ?? []) {
      duplicateExecutionDetected ||=
        observeApprovedItem(completed, item).duplicateExecutionDetected;
    }
    return { duplicateExecutionDetected };
  }

  observeTurnSnapshot(
    sessionId: string,
    turn: Record<string, unknown> | undefined,
  ): WorkspaceGitExecutionObservation {
    if (!hasFullTurnItems(turn)) {
      return { duplicateExecutionDetected: false };
    }
    const items = turn?.items;
    if (!Array.isArray(items)) return { duplicateExecutionDetected: false };
    let duplicateExecutionDetected = false;
    for (const candidate of items) {
      const item = asRecord(candidate);
      if (item === undefined) continue;
      const observation = this.observeItem(sessionId, item);
      duplicateExecutionDetected ||= observation.duplicateExecutionDetected;
    }
    return { duplicateExecutionDetected };
  }

  assessTurnCompletion(
    sessionId: string,
    status: string,
    finalItemsComplete: boolean,
  ): WorkspaceGitTurnCompletion {
    const watch = this.#approvedExecutionsBySession.get(sessionId);
    if (watch === undefined) return { kind: "not_approved" };
    const executeCompleted = watch.executeCompletedItemIds.size > 0;
    const executeFailedOrIncomplete =
      watch.executeFailedItemIds.size > 0 ||
      [...watch.executeStartedItemIds].some(
        (itemId) =>
          !watch.executeCompletedItemIds.has(itemId) &&
          !watch.executeFailedItemIds.has(itemId),
      );
    const terminalStatuses = [...watch.operationStatuses]
      .filter((operationStatus) => TERMINAL_OPERATION_STATUSES.has(operationStatus))
      .sort();
    const operationTerminal = terminalStatuses.length > 0;
    if (
      status === "idle" &&
      !executeCompleted &&
      !executeFailedOrIncomplete &&
      !operationTerminal &&
      finalItemsComplete &&
      !watch.continuationStarted
    ) {
      watch.continuationStarted = true;
      return { kind: "continue", plan: watch.plan };
    }
    if (executeFailedOrIncomplete) return { kind: "execution_incomplete" };
    if (!executeCompleted && !operationTerminal && !finalItemsComplete) {
      return { kind: "final_state_incomplete" };
    }
    if (!executeCompleted && !operationTerminal) {
      return { kind: "execution_not_observed" };
    }
    if (executeCompleted) return { kind: "executed" };
    return {
      kind: "terminal_state_observed",
      statuses: Object.freeze(terminalStatuses),
    };
  }

  clearTurnArtifacts(sessionId: string): void {
    this.#plansBySession.delete(sessionId);
    this.#recoveryTurnsBySession.delete(sessionId);
    this.#invalidRequestTurnsBySession.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    this.clearTurnArtifacts(sessionId);
    this.clearApprovedExecution(sessionId);
    this.#completedExecutionsBySession.delete(sessionId);
  }

  clearAll(): void {
    this.#plansBySession.clear();
    this.#recoveryTurnsBySession.clear();
    this.#invalidRequestTurnsBySession.clear();
    this.#approvedExecutionsBySession.clear();
    this.#completedExecutionsBySession.clear();
  }
}

export function hasFullTurnItems(
  turn: Record<string, unknown> | undefined,
): boolean {
  return turn?.itemsView === "full" && Array.isArray(turn.items);
}

function observeApprovedItem(
  watch: ApprovedExecutionWatch,
  item: Record<string, unknown>,
): WorkspaceGitExecutionObservation {
  if (isExactWorkspaceGitExecution(item, watch.plan)) {
    if (typeof item.id !== "string") {
      return { duplicateExecutionDetected: false };
    }
    const outcome = exactWorkspaceGitExecutionOutcome(item, watch.plan);
    const completedResultMatches =
      item.status !== "completed" || outcome.resultMatches;
    if (
      item.status === "completed" &&
      item.error == null &&
      completedResultMatches &&
      (outcome.status === "succeeded" ||
        outcome.status === "applied" ||
        outcome.status === "executed")
    ) {
      watch.executeCompletedItemIds.add(item.id);
    } else if (
      item.status === "failed" ||
      item.error != null ||
      !completedResultMatches ||
      outcome.status === "partial" ||
      outcome.status === "failed" ||
      outcome.status === "outcome_uncertain"
    ) {
      watch.executeFailedItemIds.add(item.id);
    } else {
      watch.executeStartedItemIds.add(item.id);
    }
    const executionIds = new Set([
      ...watch.executeStartedItemIds,
      ...watch.executeCompletedItemIds,
      ...watch.executeFailedItemIds,
    ]);
    if (executionIds.size <= 1 || watch.duplicateExecutionReported) {
      return { duplicateExecutionDetected: false };
    }
    watch.duplicateExecutionReported = true;
    return { duplicateExecutionDetected: true };
  }
  const operationStatus = exactWorkspaceGitOperationStatus(item, watch.plan);
  if (operationStatus !== undefined) watch.operationStatuses.add(operationStatus);
  return { duplicateExecutionDetected: false };
}

function isExactWorkspaceGitExecution(
  item: Record<string, unknown>,
  plan: WorkspaceGitApprovalPlan,
): boolean {
  if (
    item.type !== "mcpToolCall" ||
    !isWorkspaceGitServer(item.server) ||
    item.tool !== exactExecutionTool(plan)
  ) {
    return false;
  }
  return asRecord(item.arguments)?.operation_id === plan.operationId;
}

function exactWorkspaceGitExecutionOutcome(
  item: Record<string, unknown>,
  plan: WorkspaceGitApprovalPlan,
): { readonly resultMatches: boolean; readonly status?: string } {
  if (!isExactWorkspaceGitExecution(item, plan)) {
    return { resultMatches: false };
  }
  const structuredContent = asRecord(asRecord(item.result)?.structuredContent);
  if (structuredContent?.operation_id !== plan.operationId) {
    return { resultMatches: false };
  }
  return {
    resultMatches: true,
    ...(typeof structuredContent.status === "string"
      ? { status: structuredContent.status }
      : {}),
  };
}

function exactWorkspaceGitOperationStatus(
  item: Record<string, unknown>,
  plan: WorkspaceGitApprovalPlan,
): string | undefined {
  if (
    item.type !== "mcpToolCall" ||
    !isWorkspaceGitServer(item.server) ||
    item.tool !== "get_git_operation_status" ||
    item.status !== "completed" ||
    asRecord(item.arguments)?.operation_id !== plan.operationId
  ) {
    return undefined;
  }
  const structuredContent = asRecord(asRecord(item.result)?.structuredContent);
  if (structuredContent?.operation_id !== plan.operationId) return undefined;
  return typeof structuredContent.status === "string"
    ? structuredContent.status
    : undefined;
}

export function sameExactWorkspaceGitApprovalPlan(
  left: WorkspaceGitApprovalPlan,
  right: WorkspaceGitApprovalPlan,
): boolean {
  if (
    left.operation === "existing_pull_request_update" ||
    right.operation === "existing_pull_request_update"
  ) {
    return left.operation === "existing_pull_request_update" &&
      right.operation === "existing_pull_request_update" &&
      sameExistingPullRequestUpdatePlan(left, right);
  }
  const commonMatches = left.operationId === right.operationId &&
    left.planHash === right.planHash &&
    isDeepStrictEqual(left.approvalScope, right.approvalScope) &&
    left.approvalTarget === right.approvalTarget &&
    left.operation === right.operation &&
    left.repoId === right.repoId &&
    left.mode === right.mode &&
    left.branch === right.branch &&
    sameStrings(left.paths, right.paths) &&
    left.expectedHead === right.expectedHead &&
    left.expectedSnapshotId === right.expectedSnapshotId &&
    left.worktreeId === right.worktreeId &&
    left.commitMessage === right.commitMessage &&
    left.pushTarget === right.pushTarget &&
    left.pullRequestTitle === right.pullRequestTitle &&
    left.pullRequestBody === right.pullRequestBody &&
    left.pullRequestBaseBranch === right.pullRequestBaseBranch &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.pullRequestUrl === right.pullRequestUrl &&
    left.baseBranch === right.baseBranch &&
    left.mergeMethod === right.mergeMethod &&
    left.expiresAt === right.expiresAt;
  if (!commonMatches) return false;
  if (
    left.operation === "pull_request_ready" ||
    left.operation === "pull_request_merge" ||
    right.operation === "pull_request_ready" ||
    right.operation === "pull_request_merge"
  ) {
    return (left.operation === "pull_request_ready" ||
        left.operation === "pull_request_merge") &&
      (right.operation === "pull_request_ready" ||
        right.operation === "pull_request_merge") &&
      left.targetPullRequestTitle === right.targetPullRequestTitle &&
      left.basePolicy === right.basePolicy &&
      left.baseSha === right.baseSha &&
      left.autoMergeEnabled === right.autoMergeEnabled &&
      left.headRepositoryOwner === right.headRepositoryOwner &&
      left.expectedIsDraft === right.expectedIsDraft &&
      left.parentPullRequestNumber === right.parentPullRequestNumber &&
      left.parentPullRequestUrl === right.parentPullRequestUrl &&
      left.parentHeadRefName === right.parentHeadRefName &&
      left.parentHeadSha === right.parentHeadSha &&
      left.parentHeadRepositoryOwner === right.parentHeadRepositoryOwner &&
      left.parentState === right.parentState &&
      left.parentIsDraft === right.parentIsDraft &&
      left.parentAutoMergeEnabled === right.parentAutoMergeEnabled;
  }
  if (
    left.operation === "github_repository_settings" ||
    right.operation === "github_repository_settings"
  ) {
    return left.operation === "github_repository_settings" &&
      right.operation === "github_repository_settings" &&
      sameRepositorySettingsState(
        left.repositorySettingsBefore,
        right.repositorySettingsBefore,
      ) &&
      sameRepositorySettingsDesired(
        left.repositorySettingsDesired,
        right.repositorySettingsDesired,
      ) &&
      sameRepositorySettingsState(
        left.repositorySettingsResultingState,
        right.repositorySettingsResultingState,
      );
  }
  return true;
}

function sameExistingPullRequestUpdatePlan(
  left: Extract<WorkspaceGitApprovalPlan, {
    operation: "existing_pull_request_update";
  }>,
  right: Extract<WorkspaceGitApprovalPlan, {
    operation: "existing_pull_request_update";
  }>,
): boolean {
  return left.operationId === right.operationId &&
    left.planHash === right.planHash &&
    isDeepStrictEqual(left.approvalScope, right.approvalScope) &&
    left.approvalTarget === right.approvalTarget &&
    left.repoId === right.repoId &&
    left.mode === right.mode &&
    left.branch === right.branch &&
    sameStrings(left.paths, right.paths) &&
    left.expectedHead === right.expectedHead &&
    left.expectedSnapshotId === right.expectedSnapshotId &&
    left.temporaryWorkspaceId === right.temporaryWorkspaceId &&
    left.commitMessage === right.commitMessage &&
    left.pushTarget === right.pushTarget &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.pullRequestUrl === right.pullRequestUrl &&
    left.baseBranch === right.baseBranch &&
    left.expectedPullRequestHead === right.expectedPullRequestHead &&
    left.expectedRemoteHead === right.expectedRemoteHead &&
    left.expectedTree === right.expectedTree &&
    left.cloneIdentity === right.cloneIdentity &&
    left.configuredRootIdentity === right.configuredRootIdentity &&
    left.relativePath === right.relativePath &&
    left.pushRef === right.pushRef &&
    left.expiresAt === right.expiresAt;
}

function exactExecutionTool(plan: WorkspaceGitApprovalPlan): string {
  switch (plan.operation) {
    case "git_publication":
      return "execute_approved_git_publication";
    case "pull_request_ready":
    case "pull_request_merge":
      return "execute_approved_pull_request_operation";
    case "existing_pull_request_update":
      return "execute_approved_existing_pull_request_update";
    case "github_repository_settings":
      return "execute_approved_github_repository_settings";
  }
}

function executionSucceeded(watch: ApprovedExecutionWatch): boolean {
  return watch.executeCompletedItemIds.size > 0 &&
    watch.executeFailedItemIds.size === 0 &&
    [...watch.executeStartedItemIds].every((itemId) =>
      watch.executeCompletedItemIds.has(itemId)
    );
}

function sameRepositorySettingsState(
  left: Extract<WorkspaceGitApprovalPlan, {
    operation: "github_repository_settings";
  }>["repositorySettingsBefore"],
  right: Extract<WorkspaceGitApprovalPlan, {
    operation: "github_repository_settings";
  }>["repositorySettingsBefore"],
): boolean {
  return left.description === right.description &&
    sameStrings(left.topics, right.topics) &&
    left.dependabotSecurityUpdates === right.dependabotSecurityUpdates;
}

function sameRepositorySettingsDesired(
  left: Extract<WorkspaceGitApprovalPlan, {
    operation: "github_repository_settings";
  }>["repositorySettingsDesired"],
  right: Extract<WorkspaceGitApprovalPlan, {
    operation: "github_repository_settings";
  }>["repositorySettingsDesired"],
): boolean {
  return left.description === right.description &&
    (left.topics === undefined
      ? right.topics === undefined
      : right.topics !== undefined && sameStrings(left.topics, right.topics)) &&
    left.dependabotSecurityUpdates === right.dependabotSecurityUpdates &&
    Object.hasOwn(left, "description") === Object.hasOwn(right, "description") &&
    Object.hasOwn(left, "topics") === Object.hasOwn(right, "topics") &&
    Object.hasOwn(left, "dependabotSecurityUpdates") ===
      Object.hasOwn(right, "dependabotSecurityUpdates");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function isWorkspaceGitServer(value: unknown): boolean {
  return value === "workspace-git" || value === "workspace_git";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
