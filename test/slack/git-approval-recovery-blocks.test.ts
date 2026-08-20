import assert from "node:assert/strict";
import test from "node:test";

import {
  GitApprovalRecoveryActionTracker,
  buildGitApprovalRecoveryBlocks,
  parseGitApprovalRecoveryActionValue,
  parseGitApprovalRecoveryDecision,
} from "../../src/slack/git-approval-recovery-blocks.js";

const routing = {
  version: 1,
  channelId: "C0123456789",
  rootThreadTs: "1786654845.402859",
  messageTs: "1786654846.000100",
} as const;

test("renders a bounded fresh-plan recovery choice without stale plan authority", () => {
  const blocks = buildGitApprovalRecoveryBlocks(
    "期限切れです。<@UATTACKER>",
    routing,
  );
  const encoded = JSON.stringify(blocks);

  assert.match(encoded, /承認画面を再作成/u);
  assert.match(encoded, /保留/u);
  assert.doesNotMatch(encoded, /承認して実行/u);
  assert.doesNotMatch(encoded, /<@UATTACKER>/u);
  assert.match(encoded, /&lt;@UATTACKER&gt;/u);
  assert.match(encoded, /taishi\.git_recovery\.reprepare/u);
});

test("bounds oversized recovery text to Slack's section limit", () => {
  const blocks = buildGitApprovalRecoveryBlocks("<&>".repeat(5_000), routing);
  const section = blocks[0];

  assert.equal(section?.type, "section");
  if (section?.type !== "section" || section.text?.type !== "mrkdwn") {
    assert.fail("expected a mrkdwn section");
  }
  assert.ok(section.text.text.length <= 3_000);
  assert.doesNotMatch(section.text.text, /<|>/u);
  assert.match(section.text.text, /…$/u);
});

test("allows a failed recovery action to be retried without replaying a success", () => {
  const tracker = new GitApprovalRecoveryActionTracker();
  const key = `${routing.channelId}\u0000${routing.messageTs}`;

  assert.equal(tracker.tryStart(key), true);
  assert.equal(tracker.tryStart(key), false);
  tracker.releaseAfterFailure(key);
  assert.equal(tracker.tryStart(key), true);
  assert.equal(tracker.tryStart(key), false);
});

test("parses only strict message-bound Git recovery actions", () => {
  const encoded = JSON.stringify(routing);
  assert.deepEqual(parseGitApprovalRecoveryActionValue(encoded), routing);
  assert.equal(
    parseGitApprovalRecoveryDecision("taishi.git_recovery.reprepare"),
    "reprepare",
  );
  assert.equal(
    parseGitApprovalRecoveryDecision("taishi.git_recovery.hold"),
    "hold",
  );
  assert.equal(parseGitApprovalRecoveryDecision("taishi.git_recovery.approve"), undefined);
  assert.throws(() =>
    parseGitApprovalRecoveryActionValue(
      JSON.stringify({ ...routing, operationId: "stale-operation" }),
    ),
  );
  assert.throws(() =>
    parseGitApprovalRecoveryActionValue(
      `{"version":1,"version":1,"channelId":"${routing.channelId}",` +
        `"rootThreadTs":"${routing.rootThreadTs}","messageTs":"${routing.messageTs}"}`,
    ),
  );
});
