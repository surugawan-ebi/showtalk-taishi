import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";

import {
  LocalAdminServer,
  type AdminConfigPort,
} from "../../src/admin/server.js";
import type {
  AdminConfigSnapshot,
  AdminConfigUpdate,
} from "../../src/admin/config-repository.js";

const snapshot: AdminConfigSnapshot = {
  revision: "a".repeat(64),
  available_adapters: ["codex"],
  agents: [
    {
      id: "leader",
      adapter: "codex",
      adapter_model: "model-1",
      adapter_reasoning_effort: "medium",
      workspace_path: "/workspace",
      slack: { channel_id: "C1", conversation_scope: "channel" },
      role: "Lead",
      consultations: {},
    },
  ],
};
const accessToken = "b".repeat(43);

test("starts at a token-free URL and issues a stable hardened session cookie", async () => {
  const repository = memoryRepository();
  const server = new LocalAdminServer({
    port: 0,
    accessToken,
    repository,
    onRestartRequested: () => undefined,
  });
  const firstUrl = await server.start();
  try {
    assert.equal(firstUrl.includes(accessToken), false);
    assert.equal(new URL(firstUrl).hash.length, 0);

    const firstPage = await fetch(withoutHash(firstUrl));
    assert.equal(firstPage.status, 200);
    const firstPageSource = await firstPage.text();
    assert.equal(firstPageSource.includes(accessToken), false);
    assert.match(firstPageSource, /ShowTalk Taishi/u);
    assert.match(
      firstPage.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/u,
    );
    const firstCookie = requireAdminCookie(firstPage);

    await server.stop();
    const secondUrl = await server.start();
    assert.equal(secondUrl.includes(accessToken), false);
    const secondPage = await fetch(withoutHash(secondUrl));
    const secondCookie = requireAdminCookie(secondPage);
    assert.equal(firstCookie === secondCookie, true);
    const resumedRead = await fetch(`${withoutHash(secondUrl)}api/config`, {
      headers: { cookie: firstCookie },
    });
    assert.equal(resumedRead.status, 200);

    assert.equal(await requestStatus(secondUrl, "attacker.example"), 403);
  } finally {
    await server.stop();
  }
});

test("accepts the root session cookie or Bearer token and schedules restart once", async () => {
  const repository = memoryRepository();
  let restarts = 0;
  let appliedSnapshots = 0;
  const autonomyCalls: Array<{ agentId: string; operation: "enable" | "disable" }> = [];
  const modelCalls: Array<{ agentId: string; refresh: boolean }> = [];
  const server = new LocalAdminServer({
    port: 0,
    accessToken,
    repository,
    modelCatalog: {
      list: async (agentId, options = {}) => {
        modelCalls.push({ agentId, refresh: options.refresh ?? false });
        return {
          agent_id: agentId,
          fetched_at: "2026-08-15T00:00:00.000Z",
          models: [
            {
              id: "model-1",
              model: "model-1",
              display_name: "Model One",
              description: "Test model",
              is_default: true,
              default_reasoning_effort: "medium",
              supported_reasoning_efforts: [
                { value: "medium", description: "Balanced" },
              ],
              input_modalities: ["text", "image"],
            },
          ],
        };
      },
    },
    workspaceGitAutonomy: {
      list: () => [{
        koeId: "leader",
        available: true,
        state: "disabled",
        profileId: "11111111-1111-4111-8111-111111111111",
        profileRevision: 2,
      }],
      request: async (agentId, operation) => {
        autonomyCalls.push({ agentId, operation });
      },
    },
    onConfigSaved: () => {
      appliedSnapshots += 1;
    },
    onRestartRequested: () => {
      restarts += 1;
    },
  });
  const url = await server.start();
  const baseUrl = withoutHash(url);
  try {
    const unauthenticated = await fetch(`${baseUrl}api/config`);
    assert.equal(unauthenticated.status, 401);
    assert.match(
      (await unauthenticated.json() as { error: string }).error,
      /再読み込み.*セッション/u,
    );

    const staleRead = await fetch(`${baseUrl}api/config`, {
      headers: { authorization: `Bearer ${"c".repeat(43)}` },
    });
    assert.equal(staleRead.status, 401);

    const rawTokenCookie = await fetch(`${baseUrl}api/config`, {
      headers: { cookie: `showtalk_taishi_admin_session=${accessToken}` },
    });
    assert.equal(rawTokenCookie.status, 401);

    const bearerRead = await fetch(`${baseUrl}api/config`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(bearerRead.status, 200);
    assert.deepEqual(await bearerRead.json(), snapshot);

    const page = await fetch(baseUrl);
    const cookie = requireAdminCookie(page);
    const pageSource = await page.text();
    const csrfToken = /<meta name="showtalk-csrf" content="([^"]+)">/u.exec(
      pageSource,
    )?.[1];
    assert.ok(csrfToken);

    const currentRead = await fetch(`${baseUrl}api/config`, {
      headers: { cookie },
    });
    assert.equal(currentRead.status, 200);
    assert.deepEqual(await currentRead.json(), snapshot);

    const autonomyStatus = await fetch(`${baseUrl}api/workspace-git-autonomy`, {
      headers: { cookie },
    });
    assert.equal(autonomyStatus.status, 200);
    assert.deepEqual(await autonomyStatus.json(), {
      agents: [{
        koeId: "leader",
        available: true,
        state: "disabled",
        profileId: "11111111-1111-4111-8111-111111111111",
        profileRevision: 2,
      }],
    });

    const autonomyWithoutCsrf = await fetch(
      `${baseUrl}api/agents/leader/workspace-git-autonomy/enable`,
      { method: "POST", headers: { cookie } },
    );
    assert.equal(autonomyWithoutCsrf.status, 403);
    const autonomyRequested = await fetch(
      `${baseUrl}api/agents/leader/workspace-git-autonomy/enable`,
      {
        method: "POST",
        headers: { cookie, "x-showtalk-csrf": csrfToken },
      },
    );
    assert.equal(autonomyRequested.status, 202);
    assert.deepEqual(autonomyCalls, [{ agentId: "leader", operation: "enable" }]);

    const models = await fetch(`${baseUrl}api/agents/leader/models`, {
      headers: { cookie },
    });
    assert.equal(models.status, 200);
    assert.equal((await models.json() as { models: unknown[] }).models.length, 1);

    const denied = await fetch(`${baseUrl}api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: snapshot.revision, agents: snapshot.agents }),
    });
    assert.equal(denied.status, 401);

    const missingCsrf = await fetch(`${baseUrl}api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ revision: snapshot.revision, agents: writableAgents() }),
    });
    assert.equal(missingCsrf.status, 403);

    const foreignOrigin = await fetch(`${baseUrl}api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://attacker.example",
        "x-showtalk-csrf": csrfToken,
      },
      body: JSON.stringify({ revision: snapshot.revision, agents: writableAgents() }),
    });
    assert.equal(foreignOrigin.status, 403);

    const crossSite = await fetch(`${baseUrl}api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
        "sec-fetch-site": "cross-site",
        "x-showtalk-csrf": csrfToken,
      },
      body: JSON.stringify({ revision: snapshot.revision, agents: writableAgents() }),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(repository.saves.length, 0);

    const incompatible = await fetch(`${baseUrl}api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-showtalk-csrf": csrfToken,
      },
      body: JSON.stringify({
        revision: snapshot.revision,
        agents: writableAgents().map((agent) => ({
          ...agent,
          reasoning_effort: "ultra",
        })),
      }),
    });
    assert.equal(incompatible.status, 400);
    assert.equal(repository.saves.length, 0);

    const saved = await fetch(`${baseUrl}api/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-showtalk-csrf": csrfToken,
      },
      body: JSON.stringify({ revision: snapshot.revision, agents: writableAgents() }),
    });
    assert.equal(saved.status, 200);
    assert.equal(repository.saves.length, 1);
    assert.equal(appliedSnapshots, 1);

    const refreshedModels = await fetch(
      `${baseUrl}api/agents/leader/models/refresh`,
      {
        method: "POST",
        headers: {
          cookie,
          "x-showtalk-csrf": csrfToken,
        },
      },
    );
    assert.equal(refreshedModels.status, 200);
    assert.deepEqual(modelCalls, [
      { agentId: "leader", refresh: false },
      { agentId: "leader", refresh: false },
      { agentId: "leader", refresh: true },
    ]);

    assert.equal(
      await requestStatus(`${baseUrl}api/config`, "attacker.example", { cookie }),
      403,
    );

    const restarted = await fetch(`${baseUrl}api/restart`, {
      method: "POST",
      headers: {
        cookie,
        "x-showtalk-csrf": csrfToken,
      },
    });
    assert.equal(restarted.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restarts, 1);
  } finally {
    await server.stop();
  }
});

test("rotating the owner token invalidates the previous browser session", async () => {
  const repository = memoryRepository();
  const firstServer = new LocalAdminServer({
    port: 0,
    accessToken,
    repository,
    onRestartRequested: () => undefined,
  });
  const firstUrl = await firstServer.start();
  const oldCookie = requireAdminCookie(await fetch(firstUrl));
  await firstServer.stop();

  const rotatedServer = new LocalAdminServer({
    port: 0,
    accessToken: "d".repeat(43),
    repository,
    onRestartRequested: () => undefined,
  });
  const rotatedUrl = await rotatedServer.start();
  try {
    const rejected = await fetch(`${rotatedUrl}api/config`, {
      headers: { cookie: oldCookie },
    });
    assert.equal(rejected.status, 401);

    const newCookie = requireAdminCookie(await fetch(rotatedUrl), "d".repeat(43));
    assert.notEqual(newCookie, oldCookie);
    const accepted = await fetch(`${rotatedUrl}api/config`, {
      headers: { cookie: newCookie },
    });
    assert.equal(accepted.status, 200);
  } finally {
    await rotatedServer.stop();
  }
});

function memoryRepository(): AdminConfigPort & { saves: AdminConfigUpdate[] } {
  const saves: AdminConfigUpdate[] = [];
  return {
    saves,
    read: async () => snapshot,
    save: async (update) => {
      saves.push(update);
      return snapshot;
    },
  };
}

function writableAgents(): AdminConfigUpdate["agents"] {
  return snapshot.agents.map((agent) => ({
    id: agent.id,
    adapter: agent.adapter,
    ...(agent.adapter_session_id === undefined
      ? {}
      : { adapter_session_id: agent.adapter_session_id }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.reasoning_effort === undefined
      ? {}
      : { reasoning_effort: agent.reasoning_effort }),
    workspace_path: agent.workspace_path,
    slack: agent.slack,
    role: agent.role,
    consultations: agent.consultations,
  }));
}

function withoutHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.href;
}

function requireAdminCookie(
  response: Response,
  expectedAccessToken = accessToken,
): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "admin root should issue a session cookie");
  assert.equal(setCookie.includes(expectedAccessToken), false);

  const [cookiePair = "", ...rawAttributes] = setCookie.split(";");
  const separator = cookiePair.indexOf("=");
  assert.equal(separator >= 0, true);
  const cookieName = cookiePair.slice(0, separator);
  const cookieValue = cookiePair.slice(separator + 1);
  assert.equal(cookieName, "showtalk_taishi_admin_session");
  assert.equal(cookieValue.length, 43);
  assert.equal(/^[A-Za-z0-9_-]+$/u.test(cookieValue), true);
  const expectedValue = createHmac("sha256", expectedAccessToken)
    .update("showtalk-taishi-local-admin-session-v1")
    .digest("base64url");
  assert.equal(cookieValue === expectedValue, true);

  const attributes = new Set(
    rawAttributes.map((attribute) => attribute.trim().toLowerCase()),
  );
  assert.equal(attributes.has("httponly"), true);
  assert.equal(attributes.has("samesite=strict"), true);
  assert.equal(attributes.has("path=/"), true);
  assert.equal(attributes.has("max-age=31536000"), true);
  assert.equal(attributes.has("secure"), false);
  assert.equal(
    [...attributes].some((attribute) => attribute.startsWith("domain=")),
    false,
  );
  return cookiePair;
}

async function requestStatus(
  url: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(url, { headers: { ...headers, host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}
