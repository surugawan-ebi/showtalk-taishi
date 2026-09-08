import { isDeepStrictEqual } from "node:util";

import type {
  WorkspaceGitApprovalPlan,
  WorkspaceGitDependabotSecurityUpdateState,
  WorkspaceGitPublicationMode,
  WorkspaceGitRepositorySettingsDesired,
  WorkspaceGitRepositorySettingsState,
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
const DEPENDABOT_SECURITY_UPDATE_STATES = new Set<
  WorkspaceGitDependabotSecurityUpdateState
>(["enabled", "paused", "disabled"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SNAPSHOT = /^[0-9a-f]{64}$/u;
const TEMPORARY_WORKSPACE_ID = /^tmp_[0-9a-f]{64}$/u;
const MAX_PATHS = 100;
const MAX_PATH_LENGTH = 1_024;
const MAX_TOTAL_PATH_LENGTH = 30_000;

export interface WorkspaceGitPlanCapture {
  readonly turnId: string;
  readonly plan: WorkspaceGitApprovalPlan;
}

/**
 * Reads only the bounded, public plan result plus its original MCP inputs.
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
      item.tool !== "prepare_pull_request_operation" &&
      item.tool !== "prepare_existing_pull_request_update" &&
      item.tool !== "prepare_github_repository_settings" &&
      item.tool !== "update_repository_main")
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
  const expectedExecuteTool = item.tool === "prepare_git_publication"
    ? "execute_approved_git_publication"
    : item.tool === "prepare_pull_request_operation"
      ? "execute_approved_pull_request_operation"
      : item.tool === "prepare_existing_pull_request_update"
        ? "execute_approved_existing_pull_request_update"
        : item.tool === "prepare_github_repository_settings"
          ? "execute_approved_github_repository_settings"
          : "execute_approved_main_update";
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
  const approvalScope = requiredRecord(
    output.approval_scope,
    "approval scope",
  );
  if (Object.hasOwn(output, "approval_authority_id")) {
    throw new Error(
      "workspace-git exposed a private approval authority in its public result",
    );
  }
  const argumentsRecord = requiredRecord(
    startedItem?.arguments ?? item.arguments,
    "arguments",
  );
  const repoId = boundedString(scope.repo_id, 128, "repository ID");
  if (repoId !== boundedString(argumentsRecord.repo_id, 128, "repository input")) {
    throw new Error("workspace-git pending plan repository does not match its input");
  }

  if (item.tool === "update_repository_main") {
    if (!hasOnlyKeys(argumentsRecord, [
      "repo_id",
      "worktree_id",
      "expected_head",
      "expected_snapshot_id",
      "environment",
    ])) {
      throw new Error("workspace-git main update input is invalid");
    }
    if (!hasExactKeys(scope, [
      "repo_id",
      "worktree_id",
      "current_branch",
      "expected_head",
      "expected_snapshot_id",
    ])) {
      throw new Error("workspace-git main update scope is invalid");
    }
    const worktreeId = boundedString(scope.worktree_id, 256, "worktree ID");
    const inputWorktreeId = optionalBoundedString(argumentsRecord.worktree_id, 256);
    if (worktreeId !== "primary" || (inputWorktreeId ?? "primary") !== worktreeId) {
      throw new Error("workspace-git main update is not bound to the primary checkout");
    }
    const expectedHead = boundedString(scope.expected_head, 40, "expected HEAD");
    const expectedSnapshotId = boundedString(
      scope.expected_snapshot_id,
      64,
      "expected snapshot",
    );
    if (
      !GIT_SHA.test(expectedHead) ||
      !SNAPSHOT.test(expectedSnapshotId) ||
      expectedHead !== boundedString(argumentsRecord.expected_head, 40, "expected HEAD input") ||
      expectedSnapshotId !== boundedString(
        argumentsRecord.expected_snapshot_id,
        64,
        "expected snapshot input",
      )
    ) {
      throw new Error("workspace-git main update state does not match its input");
    }
    const currentBranch = scope.current_branch === null
      ? null
      : boundedString(scope.current_branch, 256, "current branch");
    const approvalTarget = boundedString(
      output.approval_target,
      256,
      "approval target",
    );
    if (approvalTarget !== `main_update_${repoId}`) {
      throw new Error("workspace-git approval target does not match its main update");
    }
    return {
      turnId,
      plan: bindApprovalScope({
        operationId,
        planHash,
        approvalTarget,
        operation: "main_update",
        repoId,
        environment: optionalBoundedString(argumentsRecord.environment, 64) ??
          "development",
        mode: "main_update",
        paths: [] as const,
        currentBranch,
        expectedHead,
        expectedSnapshotId,
        worktreeId: "primary",
        expiresAt,
      }, approvalScope),
    };
  }

  if (item.tool === "prepare_existing_pull_request_update") {
    if (!hasOnlyKeys(argumentsRecord, [
      "repo_id",
      "pull_request_number",
      "temporary_workspace_id",
      "expected_head_sha",
      "expected_snapshot_id",
      "paths",
      "commit_message",
      "environment",
      "ttl_minutes",
    ])) {
      throw new Error("workspace-git existing Pull Request update input is invalid");
    }
    if (
      Object.hasOwn(argumentsRecord, "ttl_minutes") &&
      (!Number.isSafeInteger(argumentsRecord.ttl_minutes) ||
        (argumentsRecord.ttl_minutes as number) < 5 ||
        (argumentsRecord.ttl_minutes as number) > 60)
    ) {
      throw new Error("workspace-git existing Pull Request update TTL is invalid");
    }
    if (!hasExactKeys(scope, [
      "repo_id",
      "temporary_workspace_id",
      "pull_request_number",
      "pull_request_url",
      "head_ref_name",
      "base_ref_name",
      "expected_pull_request_head_sha",
      "expected_remote_head_sha",
      "expected_local_head_sha",
      "expected_snapshot_id",
      "expected_tree",
      "clone_identity",
      "configured_root_identity",
      "relative_path",
      "paths",
      "commit_message",
      "push_ref",
    ])) {
      throw new Error("workspace-git existing Pull Request update scope is invalid");
    }
    const temporaryWorkspaceId = boundedString(
      scope.temporary_workspace_id,
      256,
      "temporary workspace ID",
    );
    const inputTemporaryWorkspaceId = boundedString(
      argumentsRecord.temporary_workspace_id,
      256,
      "temporary workspace input",
    );
    if (
      !TEMPORARY_WORKSPACE_ID.test(temporaryWorkspaceId) ||
      temporaryWorkspaceId !== inputTemporaryWorkspaceId
    ) {
      throw new Error("workspace-git temporary workspace does not match its input");
    }
    const pullRequestNumber = positiveInteger(
      scope.pull_request_number,
      "Pull Request number",
    );
    if (
      pullRequestNumber !== positiveInteger(
        argumentsRecord.pull_request_number,
        "Pull Request input number",
      )
    ) {
      throw new Error("workspace-git Pull Request number does not match its input");
    }
    const approvalTarget = boundedString(
      output.approval_target,
      256,
      "approval target",
    );
    if (approvalTarget !== `existing_pr_update_${pullRequestNumber}`) {
      throw new Error(
        "workspace-git approval target does not match its existing Pull Request",
      );
    }
    const expectedPullRequestHead = boundedString(
      scope.expected_pull_request_head_sha,
      40,
      "expected Pull Request HEAD",
    );
    const expectedRemoteHead = boundedString(
      scope.expected_remote_head_sha,
      40,
      "expected remote HEAD",
    );
    const expectedHead = boundedString(
      scope.expected_local_head_sha,
      40,
      "expected local HEAD",
    );
    const expectedSnapshotId = boundedString(
      scope.expected_snapshot_id,
      64,
      "expected snapshot",
    );
    const expectedTree = boundedString(
      scope.expected_tree,
      40,
      "expected tree",
    );
    if (
      !GIT_SHA.test(expectedPullRequestHead) ||
      !GIT_SHA.test(expectedRemoteHead) ||
      !GIT_SHA.test(expectedHead) ||
      !SNAPSHOT.test(expectedSnapshotId) ||
      !GIT_SHA.test(expectedTree) ||
      expectedPullRequestHead !== boundedString(
        argumentsRecord.expected_head_sha,
        40,
        "expected HEAD input",
      ) ||
      expectedSnapshotId !== boundedString(
        argumentsRecord.expected_snapshot_id,
        64,
        "expected snapshot input",
      )
    ) {
      throw new Error("workspace-git existing Pull Request heads do not match input");
    }
    const paths = validatedPaths(scope.paths);
    const inputPaths = validatedPaths(argumentsRecord.paths);
    if (paths.length < 1 || !sameStrings(paths, inputPaths)) {
      throw new Error("workspace-git existing Pull Request paths do not match input");
    }
    const commitMessage = boundedTrimmedString(
      scope.commit_message,
      500,
      "commit message",
    );
    if (
      commitMessage !== boundedTrimmedString(
        argumentsRecord.commit_message,
        500,
        "commit message input",
      )
    ) {
      throw new Error("workspace-git commit message does not match input");
    }
    const branch = boundedString(scope.head_ref_name, 256, "head branch");
    const pushRef = boundedString(scope.push_ref, 512, "push ref");
    if (pushRef !== `refs/heads/${branch}`) {
      throw new Error("workspace-git existing Pull Request push ref is invalid");
    }
    const cloneIdentity = boundedString(
      scope.clone_identity,
      64,
      "clone identity",
    );
    const configuredRootIdentity = boundedString(
      scope.configured_root_identity,
      64,
      "configured root identity",
    );
    if (!SHA256.test(cloneIdentity) || !SHA256.test(configuredRootIdentity)) {
      throw new Error("workspace-git existing Pull Request identity is invalid");
    }
    const relativePath = validatedPaths([
      boundedString(scope.relative_path, 1_024, "relative path"),
    ])[0]!;
    const environment = optionalBoundedString(
      argumentsRecord.environment,
      64,
    ) ?? "development";
    return {
      turnId,
      plan: bindApprovalScope({
        operationId,
        planHash,
        approvalTarget,
        operation: "existing_pull_request_update",
        repoId,
        environment,
        mode: "existing_pull_request_update",
        branch,
        paths,
        expectedHead,
        expectedSnapshotId,
        temporaryWorkspaceId,
        commitMessage,
        pushTarget: `origin/${branch}`,
        pullRequestNumber,
        pullRequestUrl: boundedHttpsUrl(scope.pull_request_url),
        baseBranch: boundedString(scope.base_ref_name, 256, "base branch"),
        expectedPullRequestHead,
        expectedRemoteHead,
        expectedTree,
        cloneIdentity,
        configuredRootIdentity,
        relativePath,
        pushRef,
        expiresAt,
      }, approvalScope),
    };
  }

  if (item.tool === "prepare_github_repository_settings") {
    if (!hasOnlyKeys(argumentsRecord, [
      "repo_id",
      "description",
      "topics",
      "dependabot_security_updates",
      "ttl_minutes",
    ])) {
      throw new Error("workspace-git repository settings input is invalid");
    }
    if (
      Object.hasOwn(argumentsRecord, "ttl_minutes") &&
      (!Number.isSafeInteger(argumentsRecord.ttl_minutes) ||
        (argumentsRecord.ttl_minutes as number) < 5 ||
        (argumentsRecord.ttl_minutes as number) > 60)
    ) {
      throw new Error("workspace-git repository settings TTL is invalid");
    }
    if (!hasExactKeys(scope, [
      "repo_id",
      "before",
      "desired",
      "resulting_state",
    ])) {
      throw new Error("workspace-git repository settings scope is invalid");
    }
    const approvalTarget = boundedString(
      output.approval_target,
      256,
      "approval target",
    );
    if (approvalTarget !== `repo_settings_${repoId}`) {
      throw new Error(
        "workspace-git approval target does not match its repository settings scope",
      );
    }
    const before = validatedRepositorySettingsState(scope.before, "before");
    const desired = validatedRepositorySettingsDesired(
      scope.desired,
      argumentsRecord,
    );
    const resultingState = validatedRepositorySettingsState(
      scope.resulting_state,
      "resulting state",
    );
    const expectedResult = applyRepositorySettings(before, desired);
    if (!sameRepositorySettingsState(resultingState, expectedResult)) {
      throw new Error(
        "workspace-git repository settings result does not match its exact plan",
      );
    }
    if (sameRepositorySettingsState(before, resultingState)) {
      throw new Error("workspace-git repository settings plan contains no change");
    }
    return {
      turnId,
      plan: bindApprovalScope({
        operationId,
        planHash,
        approvalTarget,
        operation: "github_repository_settings",
        repoId,
        mode: "repository_settings",
        paths: [] as const,
        repositorySettingsBefore: before,
        repositorySettingsDesired: desired,
        repositorySettingsResultingState: resultingState,
        expiresAt,
      }, approvalScope),
    };
  }

  if (item.tool === "prepare_git_publication") {
    const modeValue = boundedString(scope.mode, 64, "publication mode");
    if (!isPublicationMode(modeValue)) {
      throw new Error("workspace-git returned an invalid publication scope");
    }
    const mode = modeValue;
    const environment = optionalBoundedString(
      argumentsRecord.environment,
      64,
    ) ?? "development";
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
      environment,
      expectedSnapshotId,
      expiresAt,
    };
    if (mode === "initial_commit_and_push") {
      if (expectedHead !== null || commitMessage === undefined) {
        throw new Error("workspace-git returned invalid initial commit inputs");
      }
      return {
        turnId,
        plan: bindApprovalScope({
          ...commonPlan,
          mode,
          branch: "main",
          paths,
          expectedHead: null,
          worktreeId: "primary",
          commitMessage,
          pushTarget: "origin/main",
        }, approvalScope),
      };
    }
    if (mode === "initial_push_existing") {
      if (expectedHead === null) {
        throw new Error("workspace-git returned invalid initial push inputs");
      }
      return {
        turnId,
        plan: bindApprovalScope({
          ...commonPlan,
          mode,
          branch: "main",
          paths: [] as const,
          expectedHead,
          worktreeId: "primary",
          pushTarget: "origin/main",
        }, approvalScope),
      };
    }
    if (expectedHead === null) {
      throw new Error("workspace-git returned an invalid publication scope");
    }
    return {
      turnId,
      plan: bindApprovalScope({
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
      }, approvalScope),
    };
  }

  const action = boundedString(scope.action, 64, "Pull Request action");
  if (!hasOnlyKeys(scope, [
    "repo_id",
    "action",
    "pull_request_number",
    "pull_request_url",
    "title",
    "base_ref_name",
    "base_policy",
    "base_sha",
    "head_ref_name",
    "head_repository_owner",
    "expected_head_sha",
    "expected_is_draft",
    "auto_merge_enabled",
    "parent_pull_request_number",
    "parent_pull_request_url",
    "parent_head_ref_name",
    "parent_head_sha",
    "parent_head_repository_owner",
    "parent_state",
    "parent_is_draft",
    "parent_auto_merge_enabled",
    "merge_method",
  ])) {
    throw new Error("workspace-git Pull Request scope is invalid");
  }
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
  const targetPullRequestTitle = boundedTrimmedString(
    scope.title,
    500,
    "Pull Request title",
  );
  const branch = boundedString(scope.head_ref_name, 256, "head branch");
  const headRepositoryOwner = boundedString(
    scope.head_repository_owner,
    256,
    "head repository owner",
  );
  const baseBranch = boundedString(scope.base_ref_name, 256, "base branch");
  const basePolicy = boundedString(scope.base_policy, 64, "base policy");
  if (
    basePolicy !== "catalog_publication_branch" &&
    basePolicy !== "same_repo_stacked_pr"
  ) {
    throw new Error("workspace-git Pull Request base policy is invalid");
  }
  const baseSha = optionalBoundedString(scope.base_sha, 40);
  if (baseSha !== undefined && !GIT_SHA.test(baseSha)) {
    throw new Error("workspace-git Pull Request base SHA is invalid");
  }
  if (
    typeof scope.auto_merge_enabled !== "boolean" ||
    typeof scope.expected_is_draft !== "boolean"
  ) {
    throw new Error("workspace-git Pull Request auto-merge state is invalid");
  }
  const parentPullRequestNumber = scope.parent_pull_request_number === undefined
    ? undefined
    : positiveInteger(scope.parent_pull_request_number, "parent Pull Request number");
  const parentFields = [
    scope.parent_pull_request_url,
    scope.parent_head_ref_name,
    scope.parent_head_sha,
    scope.parent_head_repository_owner,
    scope.parent_state,
    scope.parent_is_draft,
    scope.parent_auto_merge_enabled,
  ];
  if (
    parentPullRequestNumber === undefined
      ? parentFields.some((value) => value !== undefined)
      : parentFields.some((value) => value === undefined)
  ) {
    throw new Error("workspace-git parent Pull Request scope is incomplete");
  }
  const parent = parentPullRequestNumber === undefined
    ? undefined
    : {
        parentPullRequestNumber,
        parentPullRequestUrl: boundedHttpsUrl(scope.parent_pull_request_url),
        parentHeadRefName: boundedString(
          scope.parent_head_ref_name,
          256,
          "parent head branch",
        ),
        parentHeadSha: boundedString(
          scope.parent_head_sha,
          40,
          "parent head SHA",
        ),
        parentHeadRepositoryOwner: boundedString(
          scope.parent_head_repository_owner,
          256,
          "parent repository owner",
        ),
        parentState: scope.parent_state as "OPEN",
        parentIsDraft: scope.parent_is_draft as boolean,
        parentAutoMergeEnabled: scope.parent_auto_merge_enabled as boolean,
      };
  if (
    parent !== undefined &&
    (!GIT_SHA.test(parent.parentHeadSha) ||
      parent.parentState !== "OPEN" ||
      typeof parent.parentIsDraft !== "boolean" ||
      typeof parent.parentAutoMergeEnabled !== "boolean")
  ) {
    throw new Error("workspace-git parent Pull Request scope is invalid");
  }
  const pullRequestUrl = boundedHttpsUrl(scope.pull_request_url);
  if (
    (action !== "mark_ready_for_review" && action !== "merge") ||
    action !== argumentsRecord.action ||
    pullRequestNumber !== argumentsRecord.pull_request_number ||
    !GIT_SHA.test(expectedHead) ||
    (action === "mark_ready_for_review"
      ? scope.expected_is_draft !== true
      : scope.expected_is_draft !== false)
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
    plan: bindApprovalScope({
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
      targetPullRequestTitle,
      baseBranch,
      basePolicy,
      ...(baseSha === undefined ? {} : { baseSha }),
      autoMergeEnabled: scope.auto_merge_enabled,
      headRepositoryOwner,
      expectedIsDraft: scope.expected_is_draft,
      ...(parent === undefined ? {} : parent),
      ...(action === "merge"
        ? { mergeMethod: mergeMethod as "merge" | "squash" | "rebase" }
        : {}),
      expiresAt,
    }, approvalScope),
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

type UnboundWorkspaceGitApprovalPlan = WorkspaceGitApprovalPlan extends infer Plan
  ? Plan extends WorkspaceGitApprovalPlan
    ? Omit<Plan, "approvalScope">
    : never
  : never;

function bindApprovalScope(
  plan: UnboundWorkspaceGitApprovalPlan,
  receivedScope: Record<string, unknown>,
): WorkspaceGitApprovalPlan {
  const expectedScope = approvalScopeForPlan(plan);
  if (!isDeepStrictEqual(receivedScope, expectedScope)) {
    throw new Error(
      "workspace-git approval scope does not match the human-facing plan",
    );
  }
  return freezePlan({
    ...plan,
    approvalScope: freezeApprovalScope(structuredClone(receivedScope)),
  } as WorkspaceGitApprovalPlan);
}

function approvalScopeForPlan(
  plan: UnboundWorkspaceGitApprovalPlan,
): Record<string, unknown> {
  switch (plan.operation) {
    case "git_publication":
      return {
        kind: "git_publication",
        repo_id: plan.repoId,
        mode: plan.mode,
        branch: plan.branch,
        worktree_id: plan.worktreeId,
        expected_head: plan.expectedHead,
        expected_snapshot_id: plan.expectedSnapshotId,
        paths: [...plan.paths],
        ...(plan.commitMessage === undefined
          ? {}
          : { commit_message: plan.commitMessage }),
        ...(plan.pullRequestTitle === undefined ||
            plan.pullRequestBody === undefined
          ? {}
          : {
              pr: {
                title: plan.pullRequestTitle,
                body: plan.pullRequestBody,
              },
            }),
        ...(plan.pullRequestBaseBranch === undefined
          ? {}
          : { pr_base_branch: plan.pullRequestBaseBranch }),
      };
    case "pull_request_ready":
    case "pull_request_merge":
      return {
        kind: "pull_request",
        repo_id: plan.repoId,
        action: plan.mode,
        pull_request_number: plan.pullRequestNumber,
        pull_request_url: plan.pullRequestUrl,
        title: plan.targetPullRequestTitle,
        base_ref_name: plan.baseBranch,
        base_policy: plan.basePolicy,
        ...(plan.baseSha === undefined ? {} : { base_sha: plan.baseSha }),
        head_ref_name: plan.branch,
        head_repository_owner: plan.headRepositoryOwner,
        expected_head_sha: plan.expectedHead,
        expected_is_draft: plan.expectedIsDraft,
        auto_merge_enabled: plan.autoMergeEnabled,
        ...(plan.parentPullRequestNumber === undefined
          ? {}
          : {
              parent_pull_request_number: plan.parentPullRequestNumber,
              parent_pull_request_url: plan.parentPullRequestUrl,
              parent_head_ref_name: plan.parentHeadRefName,
              parent_head_sha: plan.parentHeadSha,
              parent_head_repository_owner: plan.parentHeadRepositoryOwner,
              parent_state: plan.parentState,
              parent_is_draft: plan.parentIsDraft,
              parent_auto_merge_enabled: plan.parentAutoMergeEnabled,
            }),
        ...(plan.mergeMethod === undefined
          ? {}
          : { merge_method: plan.mergeMethod }),
      };
    case "existing_pull_request_update":
      return {
        kind: "existing_pull_request_update",
        repo_id: plan.repoId,
        temporary_workspace_id: plan.temporaryWorkspaceId,
        pull_request_number: plan.pullRequestNumber,
        pull_request_url: plan.pullRequestUrl,
        head_ref_name: plan.branch,
        base_ref_name: plan.baseBranch,
        expected_pull_request_head_sha: plan.expectedPullRequestHead,
        expected_remote_head_sha: plan.expectedRemoteHead,
        expected_local_head_sha: plan.expectedHead,
        expected_snapshot_id: plan.expectedSnapshotId,
        expected_tree: plan.expectedTree,
        clone_identity: plan.cloneIdentity,
        configured_root_identity: plan.configuredRootIdentity,
        relative_path: plan.relativePath,
        paths: [...plan.paths],
        commit_message: plan.commitMessage,
        push_ref: plan.pushRef,
      };
    case "github_repository_settings":
      return {
        kind: "repository_settings",
        repo_id: plan.repoId,
        before: approvalSettingsState(plan.repositorySettingsBefore),
        desired: approvalSettingsDesired(plan.repositorySettingsDesired),
      };
    case "main_update":
      return {
        kind: "main_update",
        repo_id: plan.repoId,
        worktree_id: plan.worktreeId,
        current_branch: plan.currentBranch,
        expected_head: plan.expectedHead,
        expected_snapshot_id: plan.expectedSnapshotId,
      };
  }
}

function approvalSettingsState(
  value: WorkspaceGitRepositorySettingsState,
): Record<string, unknown> {
  return {
    description: value.description,
    topics: [...value.topics],
    dependabot_security_updates: value.dependabotSecurityUpdates,
  };
}

function approvalSettingsDesired(
  value: WorkspaceGitRepositorySettingsDesired,
): Record<string, unknown> {
  return {
    ...(Object.hasOwn(value, "description")
      ? { description: value.description }
      : {}),
    ...(Object.hasOwn(value, "topics")
      ? { topics: [...(value.topics ?? [])] }
      : {}),
    ...(Object.hasOwn(value, "dependabotSecurityUpdates")
      ? { dependabot_security_updates: value.dependabotSecurityUpdates }
      : {}),
  };
}

function freezeApprovalScope(
  value: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          freezeApprovalScope(item as Record<string, unknown>);
        }
      }
      Object.freeze(entry);
    } else if (entry !== null && typeof entry === "object") {
      freezeApprovalScope(entry as Record<string, unknown>);
    }
  }
  return Object.freeze(value);
}

function freezePlan<T extends WorkspaceGitApprovalPlan>(plan: T): T {
  if (plan.operation === "github_repository_settings") {
    return Object.freeze({
      ...plan,
      paths: Object.freeze([]),
      repositorySettingsBefore: freezeRepositorySettingsState(
        plan.repositorySettingsBefore,
      ),
      repositorySettingsDesired: freezeRepositorySettingsDesired(
        plan.repositorySettingsDesired,
      ),
      repositorySettingsResultingState: freezeRepositorySettingsState(
        plan.repositorySettingsResultingState,
      ),
    }) as unknown as T;
  }
  return Object.freeze({
    ...plan,
    paths: Object.freeze([...plan.paths]),
  }) as unknown as T;
}

function validatedRepositorySettingsState(
  value: unknown,
  label: string,
): WorkspaceGitRepositorySettingsState {
  const state = requiredRecord(value, `repository settings ${label}`);
  if (!hasExactKeys(state, [
    "description",
    "topics",
    "dependabot_security_updates",
  ])) {
    throw new Error(`workspace-git repository settings ${label} is invalid`);
  }
  const description = repositoryDescription(state.description, label);
  const topics = canonicalRepositoryTopics(state.topics, label);
  const dependabotSecurityUpdates = boundedString(
    state.dependabot_security_updates,
    16,
    `repository settings ${label} Dependabot state`,
  );
  if (!isDependabotSecurityUpdateState(dependabotSecurityUpdates)) {
    throw new Error(
      `workspace-git repository settings ${label} Dependabot state is invalid`,
    );
  }
  return Object.freeze({
    description,
    topics,
    dependabotSecurityUpdates,
  });
}

function validatedRepositorySettingsDesired(
  value: unknown,
  input: Record<string, unknown>,
): WorkspaceGitRepositorySettingsDesired {
  const desired = requiredRecord(value, "repository settings desired state");
  const keys = Object.keys(desired);
  const allowedKeys = new Set([
    "description",
    "topics",
    "dependabot_security_updates",
  ]);
  if (
    keys.length < 1 ||
    keys.length > allowedKeys.size ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    throw new Error("workspace-git repository settings desired state is invalid");
  }
  const normalized: {
    description?: string | null;
    topics?: readonly string[];
    dependabotSecurityUpdates?: boolean;
  } = {};

  if (Object.hasOwn(input, "description") !== Object.hasOwn(desired, "description")) {
    throw new Error("workspace-git repository description does not match its input");
  }
  if (Object.hasOwn(desired, "description")) {
    const inputDescription = repositoryDescriptionInput(input.description);
    const outputDescription = repositoryDescription(desired.description, "desired");
    if (inputDescription !== outputDescription) {
      throw new Error("workspace-git repository description does not match its input");
    }
    normalized.description = outputDescription;
  }

  if (Object.hasOwn(input, "topics") !== Object.hasOwn(desired, "topics")) {
    throw new Error("workspace-git repository topics do not match their input");
  }
  if (Object.hasOwn(desired, "topics")) {
    const inputTopics = normalizedRepositoryTopicInput(input.topics);
    const outputTopics = canonicalRepositoryTopics(desired.topics, "desired");
    if (!sameStrings(inputTopics, outputTopics)) {
      throw new Error("workspace-git repository topics do not match their input");
    }
    normalized.topics = outputTopics;
  }

  if (
    Object.hasOwn(input, "dependabot_security_updates") !==
      Object.hasOwn(desired, "dependabot_security_updates")
  ) {
    throw new Error(
      "workspace-git Dependabot Security Updates choice does not match its input",
    );
  }
  if (Object.hasOwn(desired, "dependabot_security_updates")) {
    if (
      typeof input.dependabot_security_updates !== "boolean" ||
      desired.dependabot_security_updates !== input.dependabot_security_updates
    ) {
      throw new Error(
        "workspace-git Dependabot Security Updates choice does not match its input",
      );
    }
    normalized.dependabotSecurityUpdates = input.dependabot_security_updates;
  }
  return Object.freeze(normalized);
}

function repositoryDescription(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`workspace-git repository settings ${label} description is invalid`);
  }
  return value;
}

function repositoryDescriptionInput(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 1_024 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("workspace-git repository description input is invalid");
  }
  return value.trim().length === 0 ? null : value;
}

function canonicalRepositoryTopics(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`workspace-git repository settings ${label} topics are invalid`);
  }
  const topics = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,49}$/u.test(entry)
    ) {
      throw new Error(`workspace-git repository settings ${label} topics are invalid`);
    }
    return entry;
  });
  if (!sameStrings(topics, [...new Set(topics)].sort())) {
    throw new Error(`workspace-git repository settings ${label} topics are not canonical`);
  }
  return Object.freeze(topics);
}

function normalizedRepositoryTopicInput(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error("workspace-git repository topics input is invalid");
  }
  const topics = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error("workspace-git repository topics input is invalid");
    }
    const topic = entry.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,49}$/u.test(topic)) {
      throw new Error("workspace-git repository topics input is invalid");
    }
    return topic;
  });
  return Object.freeze([...new Set(topics)].sort());
}

function applyRepositorySettings(
  before: WorkspaceGitRepositorySettingsState,
  desired: WorkspaceGitRepositorySettingsDesired,
): WorkspaceGitRepositorySettingsState {
  return Object.freeze({
    description: Object.hasOwn(desired, "description")
      ? desired.description ?? null
      : before.description,
    topics: Object.hasOwn(desired, "topics")
      ? Object.freeze([...(desired.topics ?? [])])
      : before.topics,
    dependabotSecurityUpdates: Object.hasOwn(
        desired,
        "dependabotSecurityUpdates",
      )
      ? desired.dependabotSecurityUpdates === true
        ? "enabled"
        : "disabled"
      : before.dependabotSecurityUpdates,
  });
}

function sameRepositorySettingsState(
  left: WorkspaceGitRepositorySettingsState,
  right: WorkspaceGitRepositorySettingsState,
): boolean {
  return left.description === right.description &&
    sameStrings(left.topics, right.topics) &&
    left.dependabotSecurityUpdates === right.dependabotSecurityUpdates;
}

function freezeRepositorySettingsState(
  value: WorkspaceGitRepositorySettingsState,
): WorkspaceGitRepositorySettingsState {
  return Object.freeze({
    ...value,
    topics: Object.freeze([...value.topics]),
  });
}

function freezeRepositorySettingsDesired(
  value: WorkspaceGitRepositorySettingsDesired,
): WorkspaceGitRepositorySettingsDesired {
  return Object.freeze({
    ...value,
    ...(value.topics === undefined
      ? {}
      : { topics: Object.freeze([...value.topics]) }),
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return sameStrings(keys, [...expected].sort());
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isDependabotSecurityUpdateState(
  value: string,
): value is WorkspaceGitDependabotSecurityUpdateState {
  return DEPENDABOT_SECURITY_UPDATE_STATES.has(
    value as WorkspaceGitDependabotSecurityUpdateState,
  );
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
