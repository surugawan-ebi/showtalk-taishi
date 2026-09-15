import assert from "node:assert/strict";
import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreateAdminAccessToken } from "../../src/admin/access-token.js";

test("creates and reuses an owner-only admin access token beside runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-admin-token-"));
  const statePath = join(directory, "runtime", "state.json");

  const first = await loadOrCreateAdminAccessToken(statePath);
  const second = await loadOrCreateAdminAccessToken(statePath);

  assert.equal(first.token, second.token);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
});

test("rejects an admin access token readable by another OS user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-admin-token-"));
  const statePath = join(directory, "state.json");
  const created = await loadOrCreateAdminAccessToken(statePath);
  await chmod(created.path, 0o644);

  await assert.rejects(
    loadOrCreateAdminAccessToken(statePath),
    /owner-only/u,
  );
});
