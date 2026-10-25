import assert from "node:assert/strict";
import test from "node:test";

import {
  LocalMcpCorrelationScopeError,
  LocalMcpCorrelationRuntimeReader,
  LocalMcpCorrelationSnapshotDiagnostic,
  type LocalMcpCorrelationInternalState,
} from "../../src/diagnostics/local-mcp-correlation-snapshot.js";

const localChannel = "C0LOCALMCP";

function request(client: object, overrides: Partial<{
  agentId: string;
  channelId: string;
}> = {}) {
  return {
    agentId: overrides.agentId ?? "local-mcp",
    channelId: overrides.channelId ?? localChannel,
    client,
  };
}

test("returns the one existing snapshot for the matching channel, agent, and client", () => {
  const client = {};
  let reads = 0;
  const diagnostic = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => {
      reads += 1;
      return {
        classification: "success",
        registrations: [
          { name: "workspace-git", status: "connected" },
          { name: "showtalk_taishi", status: "connected" },
        ],
      };
    },
  });

  const first = diagnostic.read(request(client));
  const second = diagnostic.read(request(client));
  assert.equal(reads, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.entries, [
    {
      registered_name: "workspace-git",
      runtime_status: "connected",
      classification: "success",
      target_match: "yes",
    },
    {
      registered_name: "showtalk_taishi",
      runtime_status: "connected",
      classification: "success",
      target_match: "no",
    },
    {
      registered_name: "workspace-git",
      runtime_status: "connected",
      classification: "caller_callable",
      target_match: "insufficient_evidence",
    },
  ]);
});

test("rejects a different Slack channel without reading another snapshot", () => {
  const client = {};
  let reads = 0;
  const diagnostic = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => {
      reads += 1;
      return { classification: "empty_result", registrations: [] };
    },
  });

  assert.throws(
    () => diagnostic.read(request(client, { channelId: "C0OTHER" })),
    LocalMcpCorrelationScopeError,
  );
  assert.equal(reads, 1);
});

test("rejects a different App Server client", () => {
  const client = {};
  const diagnostic = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => ({
      classification: "empty_result",
      registrations: [],
    }),
  });

  assert.throws(
    () => diagnostic.read(request({})),
    LocalMcpCorrelationScopeError,
  );
});

test("records observation time and a non-secret correlation reference internally", () => {
  const client = {};
  let state: LocalMcpCorrelationInternalState | undefined;
  const diagnostic = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => ({
      classification: "empty_result",
      registrations: [],
    }),
    now: () => new Date("2026-10-16T01:02:03.000Z"),
    correlationRefFactory: () => "corr-public-1",
    recordInternalState: (next) => {
      state = next;
    },
  });

  const report = diagnostic.read(request(client));
  assert.deepEqual(state, {
    observedAt: "2026-10-16T01:02:03.000Z",
    correlationRef: "corr-public-1",
  });
  assert.equal(JSON.stringify(report).includes("2026-10-16"), false);
  assert.equal(JSON.stringify(report).includes("corr-public-1"), false);
});

test("drops secret and forbidden fields from the external report", () => {
  const client = {};
  const diagnostic = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => ({
      classification: "success",
      registrations: [{
        name: "workspace-git",
        status: "connected",
        threadId: "thread-secret",
        url: "https://secret.invalid",
        token: "token-secret",
        env: { SECRET: "value" },
        command: "private-command",
        approval: "approved",
        git: { branch: "secret-branch" },
      }],
    }),
  });

  const serialized = JSON.stringify(diagnostic.read(request(client)));
  for (const secret of [
    "thread-secret",
    "secret.invalid",
    "token-secret",
    "SECRET",
    "private-command",
    "approved",
    "secret-branch",
    localChannel,
  ]) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
  for (const key of Object.keys(diagnostic.read(request(client)).entries[0] ?? {})) {
    assert.ok([
      "registered_name",
      "runtime_status",
      "classification",
      "target_match",
    ].includes(key));
  }
});

test("keeps status success separate from same-caller callable verification", () => {
  const client = {};
  const withoutCallerEvidence = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => ({
      classification: "success",
      registrations: [{ name: "workspace-git", status: "connected" }],
    }),
  });
  assert.equal(
    withoutCallerEvidence.read(request(client)).entries.at(-1)?.target_match,
    "insufficient_evidence",
  );

  const callable = new LocalMcpCorrelationSnapshotDiagnostic({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    readExistingStatusSnapshot: () => ({
      classification: "success",
      registrations: [{ name: "workspace-git", status: "connected" }],
    }),
    callerToolEvidence: {
      client,
      modelVisibleNamespaces: ["mcp__workspace_git"],
      directToolCalls: [{
        namespace: "mcp__workspace_git",
        tool: "list_repositories",
        outcome: "success",
      }],
    },
  });
  assert.equal(callable.read(request(client)).entries.at(-1)?.target_match, "yes");
});

test("does not accept callable evidence from another client", () => {
  const client = {};
  assert.throws(
    () => new LocalMcpCorrelationSnapshotDiagnostic({
      agentId: "local-mcp",
      channelId: localChannel,
      client,
      readExistingStatusSnapshot: () => ({
        classification: "success",
        registrations: [{ name: "workspace-git", status: "connected" }],
      }),
      callerToolEvidence: {
        client: {},
        modelVisibleNamespaces: ["mcp__workspace_git"],
        directToolCalls: [{
          namespace: "mcp__workspace_git",
          tool: "list_repositories",
          outcome: "success",
        }],
      },
    }),
    LocalMcpCorrelationScopeError,
  );
});

test("runtime reader rejects a replaced agent client before caching a snapshot", () => {
  const client = {};
  let currentClient: object | undefined = client;
  let reads = 0;
  const reader = new LocalMcpCorrelationRuntimeReader({
    agentId: "local-mcp",
    channelId: localChannel,
    client,
    resolveClient: () => currentClient,
    readExistingStatusSnapshot: () => {
      reads += 1;
      return { classification: "empty_result", registrations: [] };
    },
  });
  currentClient = {};
  assert.throws(
    () => reader.read({ agentId: "local-mcp", channelId: localChannel }),
    LocalMcpCorrelationScopeError,
  );
  assert.equal(reads, 0);
});
