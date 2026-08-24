import assert from "node:assert/strict";
import test from "node:test";

import {
  captureWorkspaceGitPlan,
  validateWorkspaceGitPlanQuestion,
} from "../../../src/adapters/codex/workspace-git-approval.js";

function publicationNotification() {
  return {
    threadId: "thr_1",
    turnId: "turn_1",
    item: {
      type: "mcpToolCall",
      id: "mcp_1",
      server: "workspace-git",
      tool: "prepare_git_publication",
      status: "completed",
      arguments: {
        repo_id: "showtalk-taishi",
        worktree_id: "primary",
        mode: "commit_and_push",
        commit_message: "Add approval UI",
        expected_head: "b".repeat(40),
        expected_snapshot_id: "c".repeat(64),
      },
      result: {
        structuredContent: {
          status: "awaiting_human_approval",
          operation_id: "11111111-1111-4111-8111-111111111111",
          approval_expires_at: "2026-08-14T20:00:00+09:00",
          scope: {
            repo_id: "showtalk-taishi",
            worktree_id: "primary",
            mode: "commit_and_push",
            branch: "agent/approval-ui",
            paths: ["src/slack/frontend.ts"],
          },
          plan_hash: "a".repeat(64),
          execute_tool: "execute_approved_git_publication",
          external_write: false,
        },
      },
    },
  };
}

test("captures every public exact-plan field from a publication prepare result", () => {
  assert.deepEqual(captureWorkspaceGitPlan(publicationNotification()), {
    turnId: "turn_1",
    plan: {
      operationId: "11111111-1111-4111-8111-111111111111",
      planHash: "a".repeat(64),
      operation: "git_publication",
      repoId: "showtalk-taishi",
      mode: "commit_and_push",
      branch: "agent/approval-ui",
      paths: ["src/slack/frontend.ts"],
      expectedHead: "b".repeat(40),
      expectedSnapshotId: "c".repeat(64),
      worktreeId: "primary",
      commitMessage: "Add approval UI",
      pushTarget: "origin/agent/approval-ui",
      expiresAt: "2026-08-14T20:00:00+09:00",
    },
  });
});

test("captures both narrowly scoped initial publication modes", () => {
  const existing = publicationNotification();
  existing.item.arguments.mode = "initial_push_existing";
  Reflect.deleteProperty(existing.item.arguments, "commit_message");
  existing.item.result.structuredContent.scope.mode = "initial_push_existing";
  existing.item.result.structuredContent.scope.branch = "main";
  existing.item.result.structuredContent.scope.paths = [];
  const existingCapture = captureWorkspaceGitPlan(existing);
  assert.equal(existingCapture?.plan.mode, "initial_push_existing");
  assert.equal(existingCapture?.plan.expectedHead, "b".repeat(40));
  assert.equal(existingCapture?.plan.pushTarget, "origin/main");
  assert.equal(existingCapture?.plan.commitMessage, undefined);

  const unborn = publicationNotification();
  unborn.item.arguments.mode = "initial_commit_and_push";
  Reflect.set(unborn.item.arguments, "expected_head", null);
  Reflect.set(unborn.item.arguments, "paths", ["src/slack/frontend.ts"]);
  unborn.item.result.structuredContent.scope.mode = "initial_commit_and_push";
  unborn.item.result.structuredContent.scope.branch = "main";
  const unbornCapture = captureWorkspaceGitPlan(unborn);
  assert.equal(unbornCapture?.plan.mode, "initial_commit_and_push");
  assert.equal(unbornCapture?.plan.expectedHead, null);
  assert.equal(unbornCapture?.plan.commitMessage, "Add approval UI");
  assert.equal(unbornCapture?.plan.pushTarget, "origin/main");
});

test("rejects initial publication plans outside the primary main checkout", () => {
  const wrongBranch = publicationNotification();
  wrongBranch.item.arguments.mode = "initial_push_existing";
  Reflect.deleteProperty(wrongBranch.item.arguments, "commit_message");
  wrongBranch.item.result.structuredContent.scope.mode = "initial_push_existing";
  wrongBranch.item.result.structuredContent.scope.paths = [];
  assert.throws(
    () => captureWorkspaceGitPlan(wrongBranch),
    /invalid initial publication scope/u,
  );

  const wrongHead = publicationNotification();
  wrongHead.item.arguments.mode = "initial_commit_and_push";
  wrongHead.item.result.structuredContent.scope.mode = "initial_commit_and_push";
  wrongHead.item.result.structuredContent.scope.branch = "main";
  assert.throws(
    () => captureWorkspaceGitPlan(wrongHead),
    /invalid publication scope/u,
  );

  const temporary = publicationNotification();
  temporary.item.arguments.mode = "initial_push_existing";
  Reflect.deleteProperty(temporary.item.arguments, "commit_message");
  Reflect.set(temporary.item.arguments, "temporary_workspace_id", "tmp_workspace");
  temporary.item.result.structuredContent.scope.mode = "initial_push_existing";
  temporary.item.result.structuredContent.scope.branch = "main";
  temporary.item.result.structuredContent.scope.paths = [];
  assert.throws(
    () => captureWorkspaceGitPlan(temporary),
    /invalid initial publication scope/u,
  );

  const linkedWorktree = publicationNotification();
  linkedWorktree.item.arguments.mode = "initial_push_existing";
  Reflect.deleteProperty(linkedWorktree.item.arguments, "commit_message");
  linkedWorktree.item.arguments.worktree_id = "wt_opaque";
  linkedWorktree.item.result.structuredContent.scope.mode = "initial_push_existing";
  linkedWorktree.item.result.structuredContent.scope.branch = "main";
  linkedWorktree.item.result.structuredContent.scope.worktree_id = "wt_opaque";
  linkedWorktree.item.result.structuredContent.scope.paths = [];
  assert.throws(
    () => captureWorkspaceGitPlan(linkedWorktree),
    /invalid initial publication scope/u,
  );
});

test("rejects null HEADs outside an unborn initial commit", () => {
  const publication = publicationNotification();
  Reflect.set(publication.item.arguments, "expected_head", null);
  assert.throws(
    () => captureWorkspaceGitPlan(publication),
    /invalid publication scope/u,
  );
});

test("rejects fields that cannot belong to an initial push", () => {
  for (const mutate of [
    (value: ReturnType<typeof publicationNotification>) => {
      value.item.result.structuredContent.scope.paths = ["README.md"];
      Reflect.set(value.item.arguments, "paths", ["README.md"]);
    },
    (value: ReturnType<typeof publicationNotification>) => {
      Reflect.set(value.item.arguments, "commit_message", "Unexpected commit");
    },
    (value: ReturnType<typeof publicationNotification>) => {
      Reflect.set(value.item.arguments, "pr", { title: "Unexpected", body: "Unexpected" });
    },
    (value: ReturnType<typeof publicationNotification>) => {
      Reflect.set(value.item.arguments, "pr_base_branch", "main");
    },
  ]) {
    const notification = publicationNotification();
    notification.item.arguments.mode = "initial_push_existing";
    Reflect.deleteProperty(notification.item.arguments, "commit_message");
    notification.item.result.structuredContent.scope.mode = "initial_push_existing";
    notification.item.result.structuredContent.scope.branch = "main";
    notification.item.result.structuredContent.scope.paths = [];
    mutate(notification);
    assert.throws(
      () => captureWorkspaceGitPlan(notification),
      /invalid initial push inputs/u,
    );
  }
});

test("requires exact non-empty paths and no PR input for an initial commit", () => {
  for (const mutate of [
    (value: ReturnType<typeof publicationNotification>) => {
      value.item.result.structuredContent.scope.paths = [];
      Reflect.set(value.item.arguments, "paths", []);
    },
    (value: ReturnType<typeof publicationNotification>) => {
      Reflect.set(value.item.arguments, "paths", ["README.md"]);
    },
    (value: ReturnType<typeof publicationNotification>) => {
      Reflect.set(value.item.arguments, "pr", { title: "Unexpected", body: "Unexpected" });
    },
    (value: ReturnType<typeof publicationNotification>) => {
      Reflect.set(value.item.arguments, "pr_base_branch", "main");
    },
  ]) {
    const notification = publicationNotification();
    notification.item.arguments.mode = "initial_commit_and_push";
    Reflect.set(notification.item.arguments, "expected_head", null);
    Reflect.set(notification.item.arguments, "paths", ["src/slack/frontend.ts"]);
    notification.item.result.structuredContent.scope.mode = "initial_commit_and_push";
    notification.item.result.structuredContent.scope.branch = "main";
    mutate(notification);
    assert.throws(
      () => captureWorkspaceGitPlan(notification),
      /invalid initial commit inputs/u,
    );
  }
});

test("captures Ready and merge plans with the exact PR HEAD", () => {
  for (const [action, operation] of [
    ["mark_ready_for_review", "pull_request_ready"],
    ["merge", "pull_request_merge"],
  ] as const) {
    const mergeMethod = action === "merge" ? "squash" : undefined;
    const capture = captureWorkspaceGitPlan({
      threadId: "thr_1",
      turnId: "turn_pr",
      item: {
        type: "mcpToolCall",
        id: `mcp_${action}`,
        server: "workspace_git",
        tool: "prepare_pull_request_operation",
        status: "completed",
        arguments: {
          repo_id: "showtalk-taishi",
          pull_request_number: 42,
          action,
          ...(mergeMethod === undefined ? {} : { merge_method: mergeMethod }),
        },
        result: {
          structuredContent: {
            status: "awaiting_human_approval",
            operation_id: "22222222-2222-4222-8222-222222222222",
            approval_expires_at: "2026-08-14T20:00:00+09:00",
            scope: {
              repo_id: "showtalk-taishi",
              action,
              pull_request_number: 42,
              pull_request_url: "https://github.com/example-org/example-repo/pull/42",
              base_ref_name: "main",
              head_ref_name: "agent/approval-ui",
              expected_head_sha: "d".repeat(40),
              ...(mergeMethod === undefined ? {} : { merge_method: mergeMethod }),
            },
            plan_hash: "e".repeat(64),
            execute_tool: "execute_approved_pull_request_operation",
            external_write: false,
          },
        },
      },
    });
    assert.equal(capture?.plan.operation, operation);
    assert.equal(capture?.plan.expectedHead, "d".repeat(40));
    assert.equal(capture?.plan.pullRequestNumber, 42);
    assert.equal(capture?.plan.mergeMethod, mergeMethod);
    assert.equal(capture?.plan.worktreeId, undefined);
  }
});

test("captures every Draft PR field and requires an explicit base branch", () => {
  const draft = publicationNotification();
  draft.item.arguments.mode = "commit_push_and_open_draft_pr";
  Object.assign(draft.item.arguments, {
    pr: { title: "Approval UI", body: "Exact review body" },
    pr_base_branch: "main",
  });
  draft.item.result.structuredContent.scope.mode =
    "commit_push_and_open_draft_pr";
  const capture = captureWorkspaceGitPlan(draft);
  assert.equal(capture?.plan.pullRequestTitle, "Approval UI");
  assert.equal(capture?.plan.pullRequestBody, "Exact review body");
  assert.equal(capture?.plan.pullRequestBaseBranch, "main");

  Reflect.deleteProperty(draft.item.arguments, "pr_base_branch");
  assert.throws(
    () => captureWorkspaceGitPlan(draft),
    /Pull Request base branch is invalid/u,
  );
});

test("rejects substituted identity, scope, and unsafe path fields", () => {
  const wrongRepo = publicationNotification();
  wrongRepo.item.result.structuredContent.scope.repo_id = "other-repo";
  assert.throws(() => captureWorkspaceGitPlan(wrongRepo), /repository does not match/u);

  const wrongHash = publicationNotification();
  wrongHash.item.result.structuredContent.plan_hash = "short";
  assert.throws(() => captureWorkspaceGitPlan(wrongHash), /invalid pending plan identity/u);

  const absolutePath = publicationNotification();
  absolutePath.item.result.structuredContent.scope.paths = ["/Users/person/private.txt"];
  assert.throws(() => captureWorkspaceGitPlan(absolutePath), /unsafe publication path/u);

  const windowsPath = publicationNotification();
  windowsPath.item.result.structuredContent.scope.paths = ["C:\\Users\\person\\private.txt"];
  assert.throws(() => captureWorkspaceGitPlan(windowsPath), /unsafe publication path/u);

  const wrongWorktree = publicationNotification();
  wrongWorktree.item.result.structuredContent.scope.worktree_id = "wt_other";
  assert.throws(() => captureWorkspaceGitPlan(wrongWorktree), /worktree does not match/u);

  const wrongExecuteTool = publicationNotification();
  wrongExecuteTool.item.result.structuredContent.execute_tool = "execute_something_else";
  assert.throws(
    () => captureWorkspaceGitPlan(wrongExecuteTool),
    /invalid approval execution boundary/u,
  );

  const externalWrite = publicationNotification();
  externalWrite.item.result.structuredContent.external_write = true;
  assert.throws(
    () => captureWorkspaceGitPlan(externalWrite),
    /invalid approval execution boundary/u,
  );

  assert.throws(
    () =>
      captureWorkspaceGitPlan(publicationNotification(), {
        id: "mcp_1",
        server: "other-server",
        tool: "prepare_git_publication",
        arguments: publicationNotification().item.arguments,
      }),
    /tool identities do not match/u,
  );
});

test("rejects an unsupported merge method", () => {
  const notification = {
    threadId: "thr_1",
    turnId: "turn_pr",
    item: {
      type: "mcpToolCall",
      id: "mcp_merge",
      server: "workspace-git",
      tool: "prepare_pull_request_operation",
      status: "completed",
      arguments: {
        repo_id: "showtalk-taishi",
        pull_request_number: 42,
        action: "merge",
        merge_method: "octopus",
      },
      result: {
        structuredContent: {
          status: "awaiting_human_approval",
          operation_id: "22222222-2222-4222-8222-222222222222",
          approval_expires_at: "2026-08-14T20:00:00+09:00",
          scope: {
            repo_id: "showtalk-taishi",
            action: "merge",
            pull_request_number: 42,
            pull_request_url:
              "https://github.com/example-org/example-repo/pull/42",
            base_ref_name: "main",
            head_ref_name: "agent/approval-ui",
            expected_head_sha: "d".repeat(40),
            merge_method: "octopus",
          },
          plan_hash: "e".repeat(64),
          execute_tool: "execute_approved_pull_request_operation",
          external_write: false,
        },
      },
    },
  };
  assert.throws(() => captureWorkspaceGitPlan(notification), /merge method/u);
});

test("accepts only the fixed, non-secret approval choices", () => {
  const request = {
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "input_1",
    questions: [
      {
        id: "approval",
        header: "Approval",
        question: "Approve this exact plan?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "承認して実行", description: "execute" },
          { label: "拒否・保留", description: "hold" },
        ],
      },
    ],
    isBlocking: true,
    autoResolutionMs: null,
  };
  assert.equal(validateWorkspaceGitPlanQuestion(request).questionId, "approval");
  assert.equal(
    validateWorkspaceGitPlanQuestion({ ...request, autoResolutionMs: 60_000 })
      .autoResolutionMs,
    60_000,
  );
  for (const autoResolutionMs of [59_999, 240_001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() =>
      validateWorkspaceGitPlanQuestion({ ...request, autoResolutionMs }),
    );
  }
  assert.throws(() =>
    validateWorkspaceGitPlanQuestion({
      ...request,
      questions: [{ ...request.questions[0], isSecret: true }],
    }),
  );
  assert.throws(() =>
    validateWorkspaceGitPlanQuestion({
      ...request,
      questions: [
        {
          ...request.questions[0],
          options: [
            { label: "承認", description: "ambiguous free text" },
            { label: "拒否・保留", description: "hold" },
          ],
        },
      ],
    }),
  );
});
