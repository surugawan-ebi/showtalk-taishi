import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdminConfigConflictError,
  YamlAdminConfigRepository,
} from "../../src/admin/config-repository.js";

const source = `
# Keep this operator comment.
version: 1
gateway:
  state_file: "\${STATE_FILE}"
slack:
  socket_mode: true
  app_token: "\${APP_TOKEN}"
  bot_token: "\${BOT_TOKEN}"
  approver_user_ids: [U123]
adapters:
  codex:
    type: codex-app-server
    command: codex
    transport: stdio
    model: model-adapter
    reasoning_effort: medium
agents:
  leader:
    adapter: codex
    adapter_session_id: thread-leader
    workspace:
      path: "\${LEADER_WORKSPACE}"
    slack:
      channel_id: "\${LEADER_CHANNEL}"
      conversation_scope: channel
      call_name: 実装係
    consultations:
      reviewer:
        scope: Strict review only.
    role: |
      Lead implementation.
  reviewer:
    adapter: codex
    workspace:
      path: "\${REVIEWER_WORKSPACE}"
    slack:
      channel_id: "\${REVIEWER_CHANNEL}"
      conversation_scope: slack_thread
      call_name: レビュー係
    role: Review independently.
permissions:
  defaults:
    agents:
      send: allow
  agents: {}
`;

const environment = {
  STATE_FILE: "/tmp/state.json",
  APP_TOKEN: "xapp-secret",
  BOT_TOKEN: "xoxb-secret",
  LEADER_WORKSPACE: "/workspace/leader",
  REVIEWER_WORKSPACE: "/workspace/reviewer",
  LEADER_CHANNEL: "C111",
  REVIEWER_CHANNEL: "C222",
};

test("reads only editable Koe settings without resolving environment references", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);

  const snapshot = await repository.read();

  assert.deepEqual(snapshot.available_adapters, ["codex"]);
  assert.equal(snapshot.agents[0]?.workspace_path, "${LEADER_WORKSPACE}");
  assert.equal(snapshot.agents[0]?.slack.channel_id, "${LEADER_CHANNEL}");
  assert.equal(snapshot.agents[0]?.adapter_session_id, "thread-leader");
  assert.equal(snapshot.agents[0]?.adapter_model, "model-adapter");
  assert.equal(snapshot.agents[0]?.adapter_reasoning_effort, "medium");
  assert.equal(JSON.stringify(snapshot).includes("xapp-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("xoxb-secret"), false);
});

test("saves Koe settings atomically while preserving untouched environment references", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);
  const snapshot = await repository.read();
  const agents = snapshot.agents.map((agent) =>
    agent.id === "leader"
      ? {
          ...agent,
          model: "model-selected",
          reasoning_effort: "high",
          slack: {
            ...agent.slack,
            persona: "Slackでは進行責任者として簡潔に答える。",
          },
          consultations: {
            ...agent.consultations,
            reviewer: { scope: "Adversarial correctness review only." },
          },
        }
      : agent,
  );

  const saved = await repository.save({ revision: snapshot.revision, agents });
  const written = await readFile(path, "utf8");

  assert.notEqual(saved.revision, snapshot.revision);
  assert.match(written, /# Keep this operator comment\./u);
  assert.match(written, /app_token: "\$\{APP_TOKEN\}"/u);
  assert.match(written, /path: "\$\{LEADER_WORKSPACE\}"/u);
  assert.match(written, /channel_id: "\$\{LEADER_CHANNEL\}"/u);
  assert.match(written, /role: \|\n\s+Lead implementation\./u);
  assert.match(written, /persona: Slackでは進行責任者として簡潔に答える。/u);
  assert.match(written, /model: model-selected/u);
  assert.match(written, /reasoning_effort: high/u);
  assert.equal(saved.agents[0]?.model, "model-selected");
  assert.equal(saved.agents[0]?.reasoning_effort, "high");
  assert.equal(
    saved.agents[0]?.consultations.reviewer?.scope,
    "Adversarial correctness review only.",
  );
});

test("rejects stale revisions and leaves the current config untouched", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);
  const snapshot = await repository.read();
  const firstAgents = snapshot.agents.map((agent) =>
    agent.id === "leader"
      ? { ...agent, role: "Coordinate implementation safely." }
      : agent,
  );
  await repository.save({ revision: snapshot.revision, agents: firstAgents });
  const current = await readFile(path, "utf8");

  await assert.rejects(
    repository.save({ revision: snapshot.revision, agents: snapshot.agents }),
    AdminConfigConflictError,
  );
  assert.equal(await readFile(path, "utf8"), current);
});

test("rejects invalid cross-Koe settings before replacing the file", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);
  const snapshot = await repository.read();
  const agents = snapshot.agents.map((agent) =>
    agent.id === "reviewer"
      ? {
          ...agent,
          slack: { ...agent.slack, channel_id: "C111" },
        }
      : agent,
  );

  await assert.rejects(
    repository.save({ revision: snapshot.revision, agents }),
    /Slack channel is already assigned/u,
  );
  assert.equal(await readFile(path, "utf8"), source);
});

test("serializes concurrent saves so one stale revision cannot overwrite another", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);
  const snapshot = await repository.read();
  const updates = ["First role", "Second role"].map((role) => ({
    revision: snapshot.revision,
    agents: snapshot.agents.map((agent) =>
      agent.id === "leader" ? { ...agent, role } : agent,
    ),
  }));

  const results = await Promise.allSettled(updates.map((update) => repository.save(update)));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok(
    results.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof AdminConfigConflictError,
    ),
  );
});

test("refuses to save through a non-private config file", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);
  const snapshot = await repository.read();
  await chmod(path, 0o644);

  await assert.rejects(
    repository.save({ revision: snapshot.revision, agents: snapshot.agents }),
    /must not be readable or writable by group or other users/u,
  );
  assert.equal(await readFile(path, "utf8"), source);
});

test("keeps the configured adapter immutable in the initial admin UI", async () => {
  const path = await createConfig();
  const repository = new YamlAdminConfigRepository(path, environment);
  const snapshot = await repository.read();
  const agents = snapshot.agents.map((agent) =>
    agent.id === "leader" ? { ...agent, adapter: "other" } : agent,
  );

  await assert.rejects(
    repository.save({ revision: snapshot.revision, agents }),
    /cannot change adapters/u,
  );
  assert.equal(await readFile(path, "utf8"), source);
});

async function createConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taishi-admin-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source, { mode: 0o600 });
  return path;
}
