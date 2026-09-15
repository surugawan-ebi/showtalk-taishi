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

test("renders bounded recovery guidance without stale plan authority or auto-resume wording", () => {
  const blocks = buildGitApprovalRecoveryBlocks("期限切れです。<@UATTACKER>");
  const encoded = JSON.stringify(blocks);

  assert.match(encoded, /元の依頼がまだ処理中の場合/u);
  assert.doesNotMatch(encoded, /承認して実行/u);
  assert.doesNotMatch(encoded, /再作成する/u);
  assert.doesNotMatch(encoded, /"type":"button"|"type":"actions"/u);
  assert.doesNotMatch(encoded, /<@UATTACKER>/u);
  assert.match(encoded, /&lt;@UATTACKER&gt;/u);
});

test("bounds oversized recovery text to Slack's section limit", () => {
  const blocks = buildGitApprovalRecoveryBlocks("<&>".repeat(5_000));
  const section = blocks[0];

  assert.equal(section?.type, "section");
  if (section?.type !== "section" || section.text?.type !== "mrkdwn") {
    assert.fail("expected a mrkdwn section");
  }
  assert.ok(section.text.text.length <= 3_000);
  assert.doesNotMatch(section.text.text, /<|>/u);
  assert.match(section.text.text, /…\n\n元の依頼がまだ処理中/u);
});

test("never reopens a consumed recovery action", () => {
  const tracker = new GitApprovalRecoveryActionTracker();
  const key = `${routing.channelId}\u0000${routing.messageTs}`;

  assert.equal(tracker.tryStart(key), true);
  assert.equal(tracker.tryStart(key), false);
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
