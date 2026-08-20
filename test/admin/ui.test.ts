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

test("escapes the page-bound CSRF token before placing it in HTML attributes", () => {
  const page = renderAdminPage('token"><script>alert(1)</script>');

  assert.doesNotMatch(page, /nonce="token"><script>/u);
  assert.match(page, /token&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});
