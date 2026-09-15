import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

test("Slack manifest grants bounded media and per-message identity scopes", async () => {
  const manifest = parse(await readFile("slack/manifest.yaml", "utf8")) as {
    oauth_config?: { scopes?: { bot?: unknown } };
    settings?: {
      interactivity?: { is_enabled?: unknown };
      socket_mode_enabled?: unknown;
    };
  };
  const scopes = manifest.oauth_config?.scopes?.bot;
  assert.ok(Array.isArray(scopes));
  assert.ok(scopes.includes("files:read"));
  assert.ok(scopes.includes("files:write"));
  assert.ok(scopes.includes("chat:write"));
  assert.ok(scopes.includes("chat:write.customize"));
  assert.equal(manifest.settings?.interactivity?.is_enabled, true);
  assert.equal(manifest.settings?.socket_mode_enabled, true);
});
