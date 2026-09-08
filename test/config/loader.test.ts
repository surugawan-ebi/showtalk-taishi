import assert from "node:assert/strict";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigError,
  expandEnvironmentReferences,
  loadConfig,
} from "../../src/config/loader.js";

const source = `
version: 1
gateway:
  state_file: "\${STATE_FILE}"
  agent_message_max_hops: 4
slack:
  socket_mode: true
  app_token: "\${APP_TOKEN}"
  bot_token: "\${BOT_TOKEN}"
  approver_user_ids:
    - U123
adapters:
  codex:
    type: codex-app-server
    command: codex
    transport: stdio
agents:
  implementer:
    adapter: codex
    workspace:
      path: "\${WORKSPACE}"
    slack:
      channel_id: C123
    role: Implement changes.
permissions:
  defaults:
    agents:
      send: allow
  agents: {}
`;

test("loads config and expands environment references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source);
  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });
  assert.equal(config.agents.implementer?.workspace.path, "/tmp/project");
  assert.equal(config.adapters.codex?.approval_policy, undefined);
  assert.equal(config.adapters.codex?.approvals_reviewer, undefined);
  assert.equal(config.adapters.codex?.sandbox, undefined);
  assert.equal(config.agents.implementer?.adapter_session_id, undefined);
  assert.equal(config.agents.implementer?.consultations, undefined);
  assert.equal(config.agents.implementer?.automatic_choice_mode, "off");
  assert.deepEqual(config.gateway.admin_ui, { enabled: false, port: 4_781 });
});

test("loads the opt-in Koe ordinary top-choice mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "    adapter: codex",
      "    adapter: codex\n    automatic_choice_mode: ordinary_top_choice",
    ),
  );
  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });
  assert.equal(
    config.agents.implementer?.automatic_choice_mode,
    "ordinary_top_choice",
  );
});

test("loads a bounded non-authoritative workspace-git autonomy candidate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "    adapter: codex",
      [
        "    adapter: codex",
        "    workspace_git_autonomy:",
        '      profile_id: "11111111-1111-4111-8111-111111111111"',
        "      profile_revision: 3",
        "      requested_ttl_minutes: 45",
        "      label: autonomous-dev",
      ].join("\n"),
    ),
  );
  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });
  assert.deepEqual(config.agents.implementer?.workspace_git_autonomy, {
    profile_id: "11111111-1111-4111-8111-111111111111",
    profile_revision: 3,
    requested_ttl_minutes: 45,
    label: "autonomous-dev",
  });
});

test("rejects malformed and allowlist-bypassing admin overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  const overridesPath = join(directory, "admin-config-overrides.v1.json");
  await writeFile(path, source);
  const environment = {
    STATE_FILE: join(directory, "state.json"),
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };

  await writeFile(overridesPath, "not-json\n", { mode: 0o600 });
  await assert.rejects(
    loadConfig(path, environment, { adminOverridesPath: overridesPath }),
    /not valid JSON/u,
  );

  await writeFile(
    overridesPath,
    `${JSON.stringify({
      version: 1,
      overrides: [
        {
          json_pointer: "/slack/bot_token",
          expected_base_hash: "0".repeat(64),
          value: "xoxb-replacement",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    loadConfig(path, environment, { adminOverridesPath: overridesPath }),
    /not editable/u,
  );
});

test("refuses a symlinked admin override file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  const targetPath = join(directory, "target.json");
  const overridesPath = join(directory, "admin-config-overrides.v1.json");
  await writeFile(path, source);
  await writeFile(targetPath, '{"version":1,"overrides":[]}\n', { mode: 0o600 });
  await symlink(targetPath, overridesPath);

  await assert.rejects(
    loadConfig(
      path,
      {
        STATE_FILE: join(directory, "state.json"),
        APP_TOKEN: "xapp-test",
        BOT_TOKEN: "xoxb-test",
        WORKSPACE: "/tmp/project",
      },
      { adminOverridesPath: overridesPath },
    ),
    /Unable to read the admin override file/u,
  );
});

test("rejects unknown permission override Koe IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "  agents: {}",
      "  agents:\n    implemener:\n      agents:\n        send: deny",
    ),
  );
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Permission override references unknown Koe/u,
  );
});

test("rejects malformed or duplicate Slack approver IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source.replace("    - U123", "    - ' '\n    - ' '"));
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Invalid Slack user ID|must be unique/u,
  );
});

test("rejects Koe addresses that shadow literal Slack channel IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace("  implementer:", "  C123:"),
  );
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Koe address conflicts with Slack channel/u,
  );
});

test("loads an explicit localhost admin UI configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "  agent_message_max_hops: 4",
      [
        "  agent_message_max_hops: 4",
        "  admin_ui:",
        "    enabled: true",
        "    port: 4781",
      ].join("\n"),
    ),
  );

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });

  assert.deepEqual(config.gateway.admin_ui, { enabled: true, port: 4_781 });
});

test("defaults a Koe conversation scope to channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source);

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });

  assert.equal(config.agents.implementer?.slack.conversation_scope, "channel");
});

test("loads an explicit Slack-thread conversation scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "      channel_id: C123",
      "      channel_id: C123\n      conversation_scope: slack_thread",
    ),
  );

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });

  assert.equal(
    config.agents.implementer?.slack.conversation_scope,
    "slack_thread",
  );
});

test("rejects an invalid conversation scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "      channel_id: C123",
      "      channel_id: C123\n      conversation_scope: workspace",
    ),
  );

  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /conversation_scope|channel|slack_thread/u,
  );
});

test("rejects adapter_session_id with Slack-thread conversation scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source
      .replace(
        "    adapter: codex",
        "    adapter: codex\n    adapter_session_id: fixed-session",
      )
      .replace(
        "      channel_id: C123",
        "      channel_id: C123\n      conversation_scope: slack_thread",
      ),
  );

  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /adapter_session_id cannot be configured with slack_thread conversation scope/u,
  );
});

test("loads a bounded Slack-only persona for a Koe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "      channel_id: C123",
      [
        "      channel_id: C123",
        "      persona: Lead with concise, evidence-based findings.",
      ].join("\n"),
    ),
  );

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });

  assert.equal(
    config.agents.implementer?.slack.persona,
    "Lead with concise, evidence-based findings.",
  );
});

test("keeps Slack-only persona optional for backward compatibility", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source);

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });

  assert.equal(config.agents.implementer?.slack.persona, undefined);
  assert.equal(config.agents.implementer?.slack.call_name, undefined);
});

test("loads an operator-facing Koe call name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "      channel_id: C123",
      "      channel_id: C123\n      call_name: 実装係",
    ),
  );

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });

  assert.equal(config.agents.implementer?.slack.call_name, "実装係");
});

test("rejects normalized call-name duplicates and Koe ID collisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  const secondKoe = [
    "  reviewer:",
    "    adapter: codex",
    "    workspace:",
    '      path: "${WORKSPACE}"',
    "    slack:",
    "      channel_id: C456",
    "      call_name: modeler",
    "    role: Review changes.",
  ].join("\n");

  const duplicatePath = join(directory, "duplicate-call-name.yaml");
  await writeFile(
    duplicatePath,
    source
      .replace(
        "      channel_id: C123",
        "      channel_id: C123\n      call_name: ＭＯＤＥＬＥＲ",
      )
      .replace("permissions:", `${secondKoe}\npermissions:`),
  );
  await assert.rejects(
    loadConfig(duplicatePath, environment),
    /call name conflicts with Koe/u,
  );

  const idCollisionPath = join(directory, "id-call-name.yaml");
  await writeFile(
    idCollisionPath,
    source.replace(
      "      channel_id: C123",
      "      channel_id: C123\n      call_name: IMPLEMENTER",
    ),
  );
  await assert.rejects(
    loadConfig(idCollisionPath, environment),
    /call name conflicts with Koe/u,
  );
});

test("rejects normalized duplicate and MCP-incompatible Koe IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  const duplicateIdPath = join(directory, "duplicate-normalized-id.yaml");
  await writeFile(
    duplicateIdPath,
    source.replace(
      "permissions:",
      [
        "  IMPLEMENTER:",
        "    adapter: codex",
        "    workspace:",
        '      path: "${WORKSPACE}"',
        "    slack:",
        "      channel_id: C456",
        "    role: Duplicate normalized ID.",
        "permissions:",
      ].join("\n"),
    ),
  );
  await assert.rejects(
    loadConfig(duplicateIdPath, environment),
    /Koe ID conflicts after normalization/u,
  );

  for (const [index, invalidId] of [
    " implementer ",
    `agent-${"x".repeat(128)}`,
    `bad${String.fromCharCode(7)}id`,
  ].entries()) {
    const path = join(directory, `invalid-id-${index}.yaml`);
    await writeFile(
      path,
      source.replace("  implementer:", `  ${JSON.stringify(invalidId)}:`),
    );
    await assert.rejects(
      loadConfig(path, environment),
      /Koe ID|Invalid key in record/u,
    );
  }
});

test("rejects Koe IDs and call names that can shadow literal Slack channels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  const idPath = join(directory, "channel-shaped-id.yaml");
  await writeFile(
    idPath,
    source.replace("  implementer:", "  C999:"),
  );
  await assert.rejects(
    loadConfig(idPath, environment),
    /must not look like literal Slack channel IDs/u,
  );

  const callNamePath = join(directory, "channel-shaped-call-name.yaml");
  await writeFile(
    callNamePath,
    source.replace(
      "      channel_id: C123",
      "      channel_id: C123\n      call_name: G999",
    ),
  );
  await assert.rejects(
    loadConfig(callNamePath, environment),
    /must not look like literal Slack channel IDs/u,
  );
});

test("rejects prototype-inherited adapter names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "prototype-adapter.yaml");
  await writeFile(path, source.replace("adapter: codex", "adapter: toString"));
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Unknown adapter: toString/u,
  );
});

test("rejects blank Slack-only personas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };

  for (const [index, persona] of ["", " \t "].entries()) {
    const path = join(directory, `blank-persona-${index}.yaml`);
    await writeFile(
      path,
      source.replace(
        "      channel_id: C123",
        `      channel_id: C123\n      persona: ${JSON.stringify(persona)}`,
      ),
    );
    await assert.rejects(
      loadConfig(path, environment),
      /Slack persona must contain non-whitespace text/u,
    );
  }
});

test("loads scoped Koe consultation targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source
      .replace(
        "    role: Implement changes.",
        [
          "    role: Implement changes.",
          "    consultations:",
          "      reviewer:",
          "        scope: Adversarial review of implementation changes only.",
        ].join("\n"),
      )
      .replace(
        "permissions:",
        [
          "  reviewer:",
          "    adapter: codex",
          "    workspace:",
          '      path: "${WORKSPACE}"',
          "    slack:",
          "      channel_id: C456",
          "    role: Review changes.",
          "permissions:",
        ].join("\n"),
      ),
  );

  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });
  assert.equal(
    config.agents.implementer?.consultations?.reviewer?.scope,
    "Adversarial review of implementation changes only.",
  );
});

test("rejects unknown and self consultation targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  for (const target of ["unknown", "toString", "implementer"] as const) {
    const path = join(directory, `${target}.yaml`);
    await writeFile(
      path,
      source.replace(
        "    role: Implement changes.",
        [
          "    role: Implement changes.",
          "    consultations:",
          `      ${target}:`,
          "        scope: Must fail closed.",
        ].join("\n"),
      ),
    );
    await assert.rejects(loadConfig(path, environment), /consultation target/u);
  }
});

test("loads a bounded adapter-neutral session ID for a Koe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  const validSessionIds = ["a", "Codex.session_1:turn-2", "a".repeat(256)];

  for (const [index, sessionId] of validSessionIds.entries()) {
    const path = join(directory, `valid-${index}.yaml`);
    await writeFile(
      path,
      source.replace(
        "    adapter: codex",
        `    adapter: codex\n    adapter_session_id: ${JSON.stringify(sessionId)}`,
      ),
    );
    const config = await loadConfig(path, environment);
    assert.equal(config.agents.implementer?.adapter_session_id, sessionId);
  }
});

test("rejects invalid adapter-neutral session IDs for a Koe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  const invalidSessionIds = [
    "",
    "a".repeat(257),
    "_leading",
    "contains space",
    "contains/slash",
    "non-ascii-会話",
  ];

  for (const [index, sessionId] of invalidSessionIds.entries()) {
    const path = join(directory, `invalid-${index}.yaml`);
    await writeFile(
      path,
      source.replace(
        "    adapter: codex",
        `    adapter: codex\n    adapter_session_id: ${JSON.stringify(sessionId)}`,
      ),
    );
    await assert.rejects(loadConfig(path, environment));
  }
});

test("keeps Koe configuration strict around adapter session IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "    adapter: codex",
      "    adapter: codex\n    adapter_session_id_extra: unexpected",
    ),
  );

  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /adapter_session_id_extra/,
  );
});

test("rejects one declared adapter session assigned to multiple Koe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "permissions:",
      `  reviewer:
    adapter: codex
    adapter_session_id: shared-session
    workspace:
      path: "\${WORKSPACE}"
    slack:
      channel_id: C456
    role: Review changes.
permissions:`,
    ).replace(
      "    adapter: codex\n    workspace:",
      "    adapter: codex\n    adapter_session_id: shared-session\n    workspace:",
    ),
  );

  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Adapter session is already assigned to Koe: implementer/,
  );
});

test("expands a leading HOME reference inside environment-provided paths", () => {
  assert.equal(
    expandEnvironmentReferences("${STATE_FILE}", {
      HOME: "/Users/example",
      STATE_FILE: "$HOME/.showtalk-taishi/state.json",
    }),
    "/Users/example/.showtalk-taishi/state.json",
  );
  assert.equal(
    expandEnvironmentReferences("${WORKSPACE}", {
      HOME: "/Users/example",
      WORKSPACE: "~/Developer/project",
    }),
    "/Users/example/Developer/project",
  );
});

test("loads explicit Codex permission overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "    transport: stdio",
      [
        "    transport: stdio",
        "    approval_policy: never",
        "    approvals_reviewer: auto_review",
        "    sandbox: read-only",
      ].join("\n"),
    ),
  );
  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });
  assert.equal(config.adapters.codex?.approval_policy, "never");
  assert.equal(config.adapters.codex?.approvals_reviewer, "auto_review");
  assert.equal(config.adapters.codex?.sandbox, "read-only");
});

test("loads a bounded per-Agent Slack display name and icon", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "      channel_id: C123",
      [
        "      channel_id: C123",
        "      display_name: Taishi Implementer",
        "      icon_url: https://example.com/implementer.png",
      ].join("\n"),
    ),
  );
  const config = await loadConfig(path, {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  });
  assert.equal(config.agents.implementer?.slack.display_name, "Taishi Implementer");
  assert.equal(
    config.agents.implementer?.slack.icon_url,
    "https://example.com/implementer.png",
  );
});

test("rejects ambiguous or non-public Slack icon configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const environment = {
    STATE_FILE: "/tmp/state.json",
    APP_TOKEN: "xapp-test",
    BOT_TOKEN: "xoxb-test",
    WORKSPACE: "/tmp/project",
  };
  for (const addition of [
    "      icon_url: http://example.com/icon.png",
    "      icon_emoji: hammer",
    "      icon_url: https://example.com/icon.png\n      icon_emoji: :hammer:",
  ]) {
    const path = join(directory, `config-${Math.random()}.yaml`);
    await writeFile(
      path,
      source.replace("      channel_id: C123", `      channel_id: C123\n${addition}`),
    );
    await assert.rejects(loadConfig(path, environment));
  }
});

test("does not expose secret values when validation fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(path, source);
  const secret = "this-must-not-appear";
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: secret,
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("rejects duplicate channel assignments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "permissions:\n",
      `  reviewer:\n    adapter: codex\n    workspace:\n      path: "\${WORKSPACE}"\n    slack:\n      channel_id: C123\n    role: Review changes.\npermissions:\n`,
    ),
  );
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /already assigned/,
  );
});

test("rejects Gateway credential names in Agent environment passthrough", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "    transport: stdio",
      "    transport: stdio\n    env_passthrough: [showtalk_taishi_mcp_token]",
    ),
  );
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Gateway or Slack token variables cannot be passed through/,
  );
});

test("rejects AppOps approval key names in Agent environment passthrough", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-config-"));
  const path = join(directory, "config.yaml");
  await writeFile(
    path,
    source.replace(
      "    transport: stdio",
      "    transport: stdio\n    env_passthrough: [APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY]",
    ),
  );
  await assert.rejects(
    loadConfig(path, {
      STATE_FILE: "/tmp/state.json",
      APP_TOKEN: "xapp-test",
      BOT_TOKEN: "xoxb-test",
      WORKSPACE: "/tmp/project",
    }),
    /Gateway or Slack token variables cannot be passed through/,
  );
});
