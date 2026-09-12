import assert from "node:assert/strict";
import { Script } from "node:vm";
import test from "node:test";

import { renderAdminPage } from "../../src/admin/ui.js";

test("renders a nonce-bound responsive admin page with parseable browser code", () => {
  const token = "csrf-safe-token";
  const page = renderAdminPage(token);

  assert.match(page, /<html lang="ja">/u);
  assert.match(page, /<script nonce="csrf-safe-token">/u);
  assert.match(page, /Gatewayを再起動/u);
  assert.match(page, /相談できるKoe/u);
  assert.match(page, /Codexの声質/u);
  assert.match(page, /"\/models" \+ suffix/u);
  assert.match(page, /次のターンから反映/u);
  assert.match(page, /自動進行とWorkspace Git自動運転は停止しました/u);
  assert.match(page, /Slack MCP投稿はPermission Engineの実効ポリシーに従う/u);
  assert.match(page, /allow設定または有効なsession grantでは承認カードを表示せず/u);
  assert.doesNotMatch(page, /外部操作はmanualで確認します/u);
  assert.match(
    page,
    /<div hidden aria-hidden="true">\s*<div class="field-grid">/u,
  );
  assert.match(page, /automatic_choice_mode: "off"/u);
  assert.match(page, /workspace_git_autonomy: undefined/u);
  assert.match(page, /通常の選択肢は一番上を自動で選ぶ/u);
  assert.match(page, /Git承認、外部操作の最終確認、command\/file承認は自動化せず/u);
  assert.match(page, /SlackでONを確認/u);
  assert.match(page, /SlackでOFFを確認/u);
  assert.match(page, /既存のGit承認2択や承認待ちplanは変更しません/u);
  assert.match(page, /workspace-git-autonomy\/" \+ operation/u);
  assert.match(page, /status\.state !== "enabled" && status\.state !== "expired"/u);
  assert.match(page, /Profile候補は削除済みのため、OFFのみ実行できます/u);
  assert.match(page, /agentForUpdate\(renameConsultationTarget/u);
  const updateProjection = /function agentForUpdate\(agent\) \{([\s\S]*?)\n      \}/u.exec(page)?.[1];
  assert.ok(updateProjection);
  assert.doesNotMatch(updateProjection, /adapter_model|adapter_reasoning_effort/u);
  assert.match(page, /credentials: "same-origin"/u);
  assert.match(page, /管理画面を再接続/u);
  assert.match(page, /response\.status === 401/u);
  assert.match(page, /window\.location\.reload/u);
  assert.doesNotMatch(page, /authorization|localStorage|sessionStorage|tokenFileInput/u);
  assert.match(page, /@media \(max-width: 650px\)/u);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(page)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
});

test("keeps the Koe list independently scrollable on two-column layouts", () => {
  const page = renderAdminPage("csrf-safe-token");
  const styles = /<style>([\s\S]*?)<\/style>/u.exec(page)?.[1];
  assert.ok(styles);

  const desktopRules = /@media \(min-width: 901px\) \{([\s\S]*?)\n    \}/u.exec(styles)?.[1];
  assert.ok(desktopRules);
  assert.match(desktopRules, /\.koe-panel \{/u);
  assert.match(desktopRules, /max-height: calc\(100dvh - 40px\);/u);
  assert.match(desktopRules, /overflow-y: auto;/u);
});

test("escapes the page-bound CSRF token before placing it in HTML attributes", () => {
  const page = renderAdminPage('token"><script>alert(1)</script>');

  assert.doesNotMatch(page, /nonce="token"><script>/u);
  assert.match(page, /token&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});
