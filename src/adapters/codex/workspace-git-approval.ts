import type {
  WorkspaceGitApprovalPlan,
  WorkspaceGitPublicationMode,
} from "../../core/index.js";

const WORKSPACE_GIT_SERVERS = new Set(["workspace-git", "workspace_git"]);
const PUBLICATION_MODES = new Set<WorkspaceGitPublicationMode>([
  "commit_only",
  "push_existing",
  "commit_and_push",
  "push_existing_and_open_draft_pr",
  "commit_push_and_open_draft_pr",
  "initial_commit_and_push",
  "initial_push_existing",
]);
const MERGE_METHODS = new Set(["merge", "squash", "rebase"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SNAPSHOT = /^[0-9a-f]{64}$/u;
const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 1_024;
const MAX_TOTAL_PATH_LENGTH = 30_000;

export interface WorkspaceGitPlanCapture {
  readonly turnId: string;
  readonly plan: WorkspaceGitApprovalPlan;
}

/**
 * Reads only the bounded, public prepare result plus its original MCP inputs.
 * Absolute repository paths and private workspace-git state are never copied.
 */
export function normalizeWorkspaceGitPrepareCompletion(
  notification: unknown,
  startedItem?: Readonly<Record<string, unknown>>,
): WorkspaceGitPlanCapture | undefined {
  const outer = asRecord(notification);
  const item = asRecord(outer?.item);
  if (
    item?.type !== "mcpToolCall" ||
    typeof item.server !== "string" ||
    !WORKSPACE_GIT_SERVERS.has(item.server) ||
    (item.tool !== "prepare_git_publication" &&
      item.tool !== "prepare_pull_request_operation")
  ) {
    return undefined;
  }
  if (item.status !== "completed") return undefined;
  if (
    startedItem !== undefined &&
    (startedItem.id !== item.id ||
      startedItem.server !== item.server ||
      startedItem.tool !== item.tool)
  ) {
    throw new Error("workspace-git started and completed tool identities do not match");
  }
  const turnId = boundedString(outer?.turnId, 256, "turn ID");
  const result = asRecord(item.result);
  const output = asRecord(result?.structuredContent);
  if (output?.status !== "awaiting_human_approval") return undefined;
  const expectedExecuteTool =
    item.tool === "prepare_git_publication"
      ? "execute_approved_git_publication"
      : "execute_approved_pull_request_operation";
  if (output.execute_tool !== expectedExecuteTool || output.external_write !== false) {
    throw new Error("workspace-git returned an invalid approval execution boundary");
  }
  const operationId = boundedString(output.operation_id, 64, "operation ID");
  const planHash = boundedString(output.plan_hash, 64, "plan hash");
  const expiresAt = boundedString(output.approval_expires_at, 64, "expiry");
  if (!UUID.test(operationId) || !SHA256.test(planHash) || !isTimestamp(expiresAt)) {
    throw new Error("workspace-git returned an invalid pending plan identity");
  }
  const scope = requiredRecord(output.scope, "scope");
  const argumentsRecord = requiredRecord(
    startedItem?.arguments ?? item.arguments,
    "arguments",
  );
  const repoId = boundedString(scope.repo_id, 128, "repository ID");
  if (repoId !== boundedString(argumentsRecord.repo_id, 128, "repository input")) {
    throw new Error("workspace-git pending plan repository does not match its input");
  }

  if (item.tool === "prepare_git_publication") {
    const modeValue = boundedString(scope.mode, 64, "publication mode");
    if (!isPublicationMode(modeValue)) {
      throw new Error("workspace-git returned an invalid publication scope");
    }
    const mode = modeValue;
    const branch = boundedString(scope.branch, 256, "branch");
    const worktreeId = boundedString(scope.worktree_id, 256, "worktree ID");
    const temporaryWorkspaceId = optionalBoundedString(
      argumentsRecord.temporary_workspace_id,
      256,
    );
    const inputWorktreeId = optionalBoundedString(
      argumentsRecord.worktree_id,
      256,
    );
    if (temporaryWorkspaceId !== undefined && inputWorktreeId !== undefined) {
      throw new Error("workspace-git publication target inputs are ambiguous");
    }
    if (
      temporaryWorkspaceId === undefined &&
      worktreeId !== (inputWorktreeId ?? "primary")
    ) {
      throw new Error("workspace-git pending plan worktree does not match its input");
    }
    const expectedApprovalTarget = temporaryWorkspaceId ?? worktreeId;
    const explicitApprovalTarget = output.approval_target === undefined
      ? undefined
      : boundedString(output.approval_target, 256, "approval target");
    if (
      explicitApprovalTarget !== undefined &&
      explicitApprovalTarget !== expectedApprovalTarget
    ) {
      throw new Error(
        "workspace-git approval target does not match its publication scope",
      );
    }
    // workspace-git publication plans historically exposed the exact target
    // through the validated worktree/temporary-workspace inputs and private
    // status CLI, but not as a top-level prepare field. Preserve compatibility
    // without parsing the human-readable approval command.
    const approvalTarget = explicitApprovalTarget ?? expectedApprovalTarget;
    const expectedHead = argumentsRecord.expected_head === null
      ? null
      : boundedString(argumentsRecord.expected_head, 40, "expected HEAD");
    const expectedSnapshotId = boundedString(
      argumentsRecord.expected_snapshot_id,
      64,
      "expected snapshot",
    );
    const isInitialCommit = mode === "initial_commit_and_push";
    const isInitialPublication = isInitialCommit || mode === "initial_push_existing";
    if (
      mode !== argumentsRecord.mode ||
      (isInitialCommit
        ? expectedHead !== null
        : expectedHead === null || !GIT_SHA.test(expectedHead)) ||
      !SNAPSHOT.test(expectedSnapshotId)
    ) {
      throw new Error("workspace-git returned an invalid publication scope");
    }
    if (
      isInitialPublication &&
      (branch !== "main" ||
        worktreeId !== "primary" ||
        argumentsRecord.temporary_workspace_id !== undefined)
    ) {
      throw new Error("workspace-git returned an invalid initial publication scope");
    }
    const paths = validatedPaths(scope.paths);
    const inputPaths = argumentsRecord.paths === undefined
      ? undefined
      : validatedPaths(argumentsRecord.paths);
    if (isInitialCommit) {
      if (
        paths.length === 0 ||
        inputPaths === undefined ||
        !sameStrings(paths, inputPaths) ||
        argumentsRecord.pr !== undefined ||
        argumentsRecord.pr_base_branch !== undefined
      ) {
        throw new Error("workspace-git returned invalid initial commit inputs");
      }
    } else if (mode === "initial_push_existing") {
      if (
        paths.length !== 0 ||
        (inputPaths !== undefined && inputPaths.length !== 0) ||
        argumentsRecord.commit_message !== undefined ||
        argumentsRecord.pr !== undefined ||
        argumentsRecord.pr_base_branch !== undefined
      ) {
        throw new Error("workspace-git returned invalid initial push inputs");
      }
    }
    const needsCommit = mode === "commit_only" ||
      mode === "commit_and_push" ||
      mode === "commit_push_and_open_draft_pr" ||
      mode === "initial_commit_and_push";
    const needsPush = mode !== "commit_only";
    const needsPullRequest =
      mode === "push_existing_and_open_draft_pr" ||
      mode === "commit_push_and_open_draft_pr";
    const commitMessage = needsCommit
      ? boundedTrimmedString(argumentsRecord.commit_message, 500, "commit message")
      : undefined;
    let pullRequestTitle: string | undefined;
    let pullRequestBody: string | undefined;
    let pullRequestBaseBranch: string | undefined;
    if (needsPullRequest) {
      const pullRequest = requiredRecord(argumentsRecord.pr, "Pull Request input");
      pullRequestTitle = boundedTrimmedString(
        pullRequest.title,
        200,
        "Pull Request title",
      );
      pullRequestBody = boundedTrimmedString(
        pullRequest.body,
        20_000,
        "Pull Request body",
      );
      // workspace-git resolves an omitted base through its private catalog,
      // which Taishi cannot inspect. Require it explicitly before offering a
      // Slack informed-approval surface.
      pullRequestBaseBranch = boundedString(
        argumentsRecord.pr_base_branch,
        96,
        "Pull Request base branch",
      );
    }
    const commonPlan = {
      operationId,
      planHash,
      approvalTarget,
      operation: "git_publication" as const,
      repoId,
      expectedSnapshotId,
      expiresAt,
    };
    if (mode === "initial_commit_and_push") {
      if (expectedHead !== null || commitMessage === undefined) {
        throw new Error("workspace-git returned invalid initial commit inputs");
      }
      return {
        turnId,
        plan: freezePlan({
          ...commonPlan,
          mode,
          branch: "main",
          paths,
          expectedHead: null,
          worktreeId: "primary",
          commitMessage,
          pushTarget: "origin/main",
        }),
      };
    }
    if (mode === "initial_push_existing") {
      if (expectedHead === null) {
        throw new Error("workspace-git returned invalid initial push inputs");
      }
      return {
        turnId,
        plan: freezePlan({
          ...commonPlan,
          mode,
          branch: "main",
          paths: [] as const,
          expectedHead,
          worktreeId: "primary",
          pushTarget: "origin/main",
        }),
      };
    }
    if (expectedHead === null) {
      throw new Error("workspace-git returned an invalid publication scope");
    }
    return {
      turnId,
      plan: freezePlan({
        ...commonPlan,
        mode,
        branch,
        paths,
        expectedHead,
        worktreeId,
        ...(commitMessage === undefined ? {} : { commitMessage }),
        ...(needsPush ? { pushTarget: `origin/${branch}` } : {}),
        ...(pullRequestTitle === undefined ? {} : { pullRequestTitle }),
        ...(pullRequestBody === undefined ? {} : { pullRequestBody }),
        ...(pullRequestBaseBranch === undefined
          ? {}
          : { pullRequestBaseBranch }),
      }),
    };
  }

  const action = boundedString(scope.action, 64, "Pull Request action");
  const pullRequestNumber = positiveInteger(
    scope.pull_request_number,
    "Pull Request number",
  );
  const approvalTarget = boundedString(
    output.approval_target,
    256,
    "approval target",
  );
  if (approvalTarget !== `pr_${pullRequestNumber}`) {
    throw new Error("workspace-git approval target does not match its Pull Request");
  }
  const expectedHead = boundedString(scope.expected_head_sha, 40, "expected HEAD");
  const branch = boundedString(scope.head_ref_name, 256, "head branch");
  const baseBranch = boundedString(scope.base_ref_name, 256, "base branch");
  const pullRequestUrl = boundedHttpsUrl(scope.pull_request_url);
  if (
    (action !== "mark_ready_for_review" && action !== "merge") ||
    action !== argumentsRecord.action ||
    pullRequestNumber !== argumentsRecord.pull_request_number ||
    !GIT_SHA.test(expectedHead)
  ) {
    throw new Error("workspace-git returned an invalid Pull Request scope");
  }
  const mergeMethod = optionalBoundedString(scope.merge_method, 16);
  const inputMergeMethod = optionalBoundedString(argumentsRecord.merge_method, 16);
  if (action === "merge" && !isMergeMethod(mergeMethod)) {
    throw new Error("workspace-git merge plan is missing its merge method");
  }
  if (action !== "merge" && mergeMethod !== undefined) {
    throw new Error("workspace-git Ready plan unexpectedly specifies a merge method");
  }
  if (mergeMethod !== inputMergeMethod) {
    throw new Error("workspace-git merge method does not match its input");
  }
  return {
    turnId,
    plan: freezePlan({
      operationId,
      planHash,
      approvalTarget,
      operation:
        action === "merge" ? "pull_request_merge" : "pull_request_ready",
      repoId,
      mode: action,
      branch,
      paths: [],
      expectedHead,
      pullRequestNumber,
      pullRequestUrl,
      baseBranch,
      ...(action === "merge"
        ? { mergeMethod: mergeMethod as "merge" | "squash" | "rebase" }
        : {}),
      expiresAt,
    }),
  };
}

/** Backwards-compatible name for tests and downstream imports. */
export const captureWorkspaceGitPlan = normalizeWorkspaceGitPrepareCompletion;

export {
  toolRequestUserInputParams,
  validateWorkspaceGitPlanQuestion,
} from "./workspace-git-approval-question.js";
export type { ValidatedPlanQuestion } from "./workspace-git-approval-question.js";

function validatedPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS) {
    throw new Error("workspace-git returned invalid publication paths");
  }
  let total = 0;
  const paths = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length < 1 ||
      entry.length > MAX_PATH_LENGTH ||
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      entry.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(entry) ||
      entry.includes("\0") ||
      entry.split("/").some((segment) => segment === "..")
    ) {
      throw new Error("workspace-git returned an unsafe publication path");
    }
    total += entry.length;
    return entry;
  });
  if (total > MAX_TOTAL_PATH_LENGTH) {
    throw new Error("workspace-git publication paths exceed the Slack review limit");
  }
  return Object.freeze(paths);
}

function freezePlan<T extends WorkspaceGitApprovalPlan>(plan: T): T {
  return Object.freeze({
    ...plan,
    paths: Object.freeze([...plan.paths]),
  }) as unknown as T;
}

function isPublicationMode(value: string): value is WorkspaceGitPublicationMode {
  return PUBLICATION_MODES.has(value as WorkspaceGitPublicationMode);
}

function isMergeMethod(value: string | undefined): value is "merge" | "squash" | "rebase" {
  return value !== undefined && MERGE_METHODS.has(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new Error(`workspace-git ${label} is invalid`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.trim().length < 1
  ) {
    throw new Error(`workspace-git ${label} is invalid`);
  }
  return value;
}

function optionalBoundedString(value: unknown, max: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, max, "optional field");
}

function boundedTrimmedString(value: unknown, max: number, label: string): string {
  const text = boundedString(value, max, label).trim();
  if (text.length < 1) throw new Error(`workspace-git ${label} is invalid`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`workspace-git ${label} is invalid`);
  }
  return value as number;
}

function boundedHttpsUrl(value: unknown): string {
  const text = boundedString(value, 2_000, "Pull Request URL");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("workspace-git Pull Request URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("workspace-git Pull Request URL is invalid");
  }
  return text;
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
