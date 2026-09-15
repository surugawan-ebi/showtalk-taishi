import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AdminConfigConflictError,
  YamlAdminConfigRepository,
} from "../../src/admin/config-repository.js";
import { loadConfig } from "../../src/config/loader.js";

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
  const repository = createRepository(path);

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

test("never exposes expanded model environment references in an admin snapshot", async () => {
  const path = await createConfig(
    source
      .replace("model: model-adapter", 'model: "${ADAPTER_MODEL}"')
      .replace("reasoning_effort: medium", 'reasoning_effort: "${ADAPTER_EFFORT}"')
      .replace(
        "adapter_session_id: thread-leader",
        [
          "adapter_session_id: thread-leader",
          '    model: "${AGENT_MODEL}"',
          '    reasoning_effort: "${AGENT_EFFORT}"',
        ].join("\n"),
      ),
  );
  const repository = new YamlAdminConfigRepository(
    path,
    {
      ...environment,
      ADAPTER_MODEL: "resolved-adapter-secret",
      ADAPTER_EFFORT: "high",
      AGENT_MODEL: "resolved-agent-secret",
      AGENT_EFFORT: "low",
    },
    overridesPathFor(path),
  );

  const snapshot = await repository.read();

  assert.equal(snapshot.agents[0]?.adapter_model, "${ADAPTER_MODEL}");
  assert.equal(snapshot.agents[0]?.adapter_reasoning_effort, "${ADAPTER_EFFORT}");
  assert.equal(snapshot.agents[0]?.model, "${AGENT_MODEL}");
  assert.equal(snapshot.agents[0]?.reasoning_effort, "${AGENT_EFFORT}");
  assert.equal(JSON.stringify(snapshot).includes("resolved-adapter-secret"), false);
  assert.equal(JSON.stringify(snapshot).includes("resolved-agent-secret"), false);
});

test("saves Koe settings to a private sidecar without rewriting operator config", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const beforeMetadata = await lstat(path);
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
  const overrides = await readFile(overridesPathFor(path), "utf8");
  const overrideMetadata = await lstat(overridesPathFor(path));
  const effective = await loadConfig(path, environment, {
    adminOverridesPath: overridesPathFor(path),
  });
  const afterMetadata = await lstat(path);

  assert.notEqual(saved.revision, snapshot.revision);
  assert.equal(written, source);
  assert.equal(afterMetadata.ino, beforeMetadata.ino);
  assert.match(overrides, /Slackでは進行責任者として簡潔に答える。/u);
  assert.match(overrides, /model-selected/u);
  assert.equal(overrides.includes("xapp-secret"), false);
  assert.equal(overrides.includes("xoxb-secret"), false);
  assert.equal(overrideMetadata.mode & 0o077, 0);
  assert.equal(effective.agents.leader?.model, "model-selected");
  assert.equal(effective.agents.leader?.reasoning_effort, "high");
  assert.equal(saved.agents[0]?.model, "model-selected");
  assert.equal(saved.agents[0]?.reasoning_effort, "high");
  assert.equal(
    saved.agents[0]?.consultations.reviewer?.scope,
    "Adversarial correctness review only.",
  );
});

test("rejects stale revisions and leaves the current config untouched", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const snapshot = await repository.read();
  const firstAgents = snapshot.agents.map((agent) =>
    agent.id === "leader"
      ? { ...agent, role: "Coordinate implementation safely." }
      : agent,
  );
  await repository.save({ revision: snapshot.revision, agents: firstAgents });
  const current = await readFile(overridesPathFor(path), "utf8");

  await assert.rejects(
    repository.save({ revision: snapshot.revision, agents: snapshot.agents }),
    AdminConfigConflictError,
  );
  assert.equal(await readFile(path, "utf8"), source);
  assert.equal(await readFile(overridesPathFor(path), "utf8"), current);
});

test("rejects invalid cross-Koe settings before replacing the file", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
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
  const repository = createRepository(path);
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

test("serializes stale saves across separate repository instances", async () => {
  const path = await createConfig();
  const firstRepository = createRepository(path);
  const secondRepository = createRepository(path);
  const snapshot = await firstRepository.read();
  const updates = ["First process role", "Second process role"].map((role) => ({
    revision: snapshot.revision,
    agents: snapshot.agents.map((agent) =>
      agent.id === "leader" ? { ...agent, role } : agent
    ),
  }));

  const results = await Promise.allSettled([
    firstRepository.save(updates[0]!),
    secondRepository.save(updates[1]!),
  ]);

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

test("keeps the canonical config byte-identical and readable during admin saves", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const snapshot = await repository.read();
  let finished = false;
  let missingReads = 0;
  const reader = (async () => {
    while (!finished) {
      try {
        await readFile(path, "utf8");
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          missingReads += 1;
        } else {
          throw error;
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();

  try {
    await repository.save({
      revision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === "leader" ? { ...agent, role: "Updated atomically" } : agent
      ),
    });
  } finally {
    finished = true;
    await reader;
  }

  assert.equal(missingReads, 0);
  assert.equal(await readFile(path, "utf8"), source);
  assert.equal((await repository.read()).agents[0]?.role, "Updated atomically");
});

test("refuses to read a non-private admin override file", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const snapshot = await repository.read();
  await repository.save({
    revision: snapshot.revision,
    agents: snapshot.agents.map((agent) =>
      agent.id === "leader" ? { ...agent, role: "Private override" } : agent
    ),
  });
  await chmod(overridesPathFor(path), 0o644);

  await assert.rejects(
    repository.read(),
    /must be owner-only/u,
  );
  assert.equal(await readFile(path, "utf8"), source);
});

test("keeps the configured adapter immutable in the initial admin UI", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
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

test("adopts unrelated operator edits without losing admin overrides", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const snapshot = await repository.read();
  await repository.save({
    revision: snapshot.revision,
    agents: snapshot.agents.map((agent) =>
      agent.id === "leader" ? { ...agent, model: "admin-model" } : agent
    ),
  });

  const operatorSource = source.replace(
    "# Keep this operator comment.",
    "# Operator changed an unrelated comment.",
  );
  await writeFile(path, operatorSource, { mode: 0o600 });

  const reloaded = await repository.read();
  assert.equal(reloaded.agents[0]?.model, "admin-model");
  assert.equal(await readFile(path, "utf8"), operatorSource);
});

test("fails closed when operator and admin edit the same setting", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const snapshot = await repository.read();
  await repository.save({
    revision: snapshot.revision,
    agents: snapshot.agents.map((agent) =>
      agent.id === "leader" ? { ...agent, role: "Admin role" } : agent
    ),
  });

  const operatorSource = source.replace(
    "Lead implementation.",
    "Operator role.",
  );
  await writeFile(path, operatorSource, { mode: 0o600 });

  await assert.rejects(repository.read(), AdminConfigConflictError);
  assert.equal(await readFile(path, "utf8"), operatorSource);
});

test("keeps environment references in operator config instead of the sidecar", async () => {
  const path = await createConfig();
  const repository = createRepository(path);
  const snapshot = await repository.read();

  await assert.rejects(
    repository.save({
      revision: snapshot.revision,
      agents: snapshot.agents.map((agent) =>
        agent.id === "leader"
          ? { ...agent, workspace_path: "${APP_TOKEN}" }
          : agent
      ),
    }),
    /Environment references must be edited in config.yaml/u,
  );
  assert.equal(await readFile(path, "utf8"), source);
});

test("canonicalizes an ancestor symlink before writing the sidecar", async () => {
  const path = await createConfig();
  const root = dirname(path);
  const privateDirectory = join(root, "private-state");
  const linkedDirectory = join(root, "linked-state");
  await mkdir(privateDirectory, { mode: 0o700 });
  await symlink(privateDirectory, linkedDirectory);
  const overridesPath = join(linkedDirectory, "admin-config-overrides.v1.json");
  const repository = new YamlAdminConfigRepository(path, environment, overridesPath);
  const snapshot = await repository.read();

  await repository.save({
    revision: snapshot.revision,
    agents: snapshot.agents.map((agent) =>
      agent.id === "leader" ? { ...agent, role: "Canonical parent" } : agent
    ),
  });

  assert.match(
    await readFile(join(privateDirectory, "admin-config-overrides.v1.json"), "utf8"),
    /Canonical parent/u,
  );
});

async function createConfig(contents = source): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taishi-admin-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

function overridesPathFor(path: string): string {
  return join(dirname(path), "admin-config-overrides.v1.json");
}

function createRepository(path: string): YamlAdminConfigRepository {
  return new YamlAdminConfigRepository(path, environment, overridesPathFor(path));
}
