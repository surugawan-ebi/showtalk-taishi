import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceGitAutonomyBlocks,
  parseWorkspaceGitAutonomyAction,
  parseWorkspaceGitAutonomyToken,
  WorkspaceGitAutonomyCardStore,
  type WorkspaceGitAutonomyCardRoute,
} from "../../src/slack/workspace-git-autonomy-blocks.js";

const route: WorkspaceGitAutonomyCardRoute = {
  token: "11111111-1111-4111-8111-111111111111",
  operation: "enable",
  koeId: "implementer",
  channelId: "C0123456789",
  rootThreadTs: "1700000000.000001",
  messageTs: "1700000000.000001",
  candidate: {
    profileId: "22222222-2222-4222-8222-222222222222",
    profileRevision: 3,
    requestedTtlMinutes: 60,
    label: "autonomous-dev",
  },
  koeBindingRevision: 7,
  principalPolicyRevision: 11,
  requestedExpiresAt: "2099-01-01T01:00:00.000Z",
};

test("builds an independent future-plan autonomy card with opaque action values", () => {
  const blocks = buildWorkspaceGitAutonomyBlocks(route);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /次のfresh planから/u);
  assert.match(serialized, /main、Ready、merge、release、deploy、productionは引き続き手動承認/u);
  assert.doesNotMatch(serialized, /git_approval|operation_id|plan_hash|approval_authority|signature|socket/u);
  assert.equal(serialized.includes(route.token), true);
  assert.equal(parseWorkspaceGitAutonomyAction("workspace_git_autonomy.enable"), "enable");
  assert.equal(parseWorkspaceGitAutonomyAction("workspace_git_autonomy.hold"), "hold");
  assert.equal(parseWorkspaceGitAutonomyAction("workspace_git_autonomy.approve"), undefined);
  assert.equal(parseWorkspaceGitAutonomyToken(route.token), route.token);
  assert.throws(() => parseWorkspaceGitAutonomyToken(route.candidate.profileId.slice(0, -1)));
});

test("keeps card routes process-local and forgets consumed tokens", () => {
  const store = new WorkspaceGitAutonomyCardStore();
  store.remember(route);
  assert.deepEqual(store.get(route.token), route);
  store.forget(route.token);
  assert.equal(store.get(route.token), undefined);
});
