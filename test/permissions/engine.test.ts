import assert from "node:assert/strict";
import test from "node:test";

import { PermissionEngine } from "../../src/permissions/engine.js";

const agents = {
  implementer: {
    slack: { channel_id: "C_IMPLEMENTER" },
    consultations: { reviewer: { scope: "Implementation review" } },
  },
  reviewer: {
    slack: { channel_id: "C_REVIEWER" },
    consultations: { implementer: { scope: "Request implementation fixes" } },
  },
  security: { slack: { channel_id: "C_SECURITY" } },
} as const;

test("agent.send uses a per-agent value before the default", () => {
  const engine = new PermissionEngine({
    defaults: { agents: { send: "deny" } },
    agents: { implementer: { agents: { send: "allow" } } },
  }, agents);
  assert.equal(engine.agentSend("implementer", "reviewer"), "allow");
  assert.equal(engine.agentSend("reviewer", "implementer"), "deny");
});

test("agent.send uses the default for a known source when no override exists", () => {
  const engine = new PermissionEngine(
    { defaults: { agents: { send: "approval" } }, agents: {} },
    agents,
  );

  assert.equal(engine.agentSend("reviewer", "implementer"), "approval");
});

test("agent.send fails closed when the policy is omitted", () => {
  const engine = new PermissionEngine({ defaults: {}, agents: {} }, agents);
  assert.equal(engine.agentSend("implementer", "reviewer"), "deny");
});

test("agent.send denies an unknown source even when the default allows", () => {
  const engine = new PermissionEngine(
    { defaults: { agents: { send: "allow" } }, agents: {} },
    agents,
  );

  assert.equal(engine.agentSend("unknown", "reviewer"), "deny");
});

test("agent.send fails closed without a consultation directory", () => {
  const engine = new PermissionEngine({
    defaults: { agents: { send: "allow" } },
    agents: { implementer: {} },
  });

  assert.equal(engine.agentSend("implementer", "reviewer"), "deny");
  assert.equal(engine.agentSend("unknown", "reviewer"), "deny");
});

test("agent.send denies a known but unconfigured target even when defaults allow", () => {
  const engine = new PermissionEngine(
    { defaults: { agents: { send: "allow" } }, agents: {} },
    agents,
  );

  assert.equal(engine.agentSend("implementer", "reviewer"), "allow");
  assert.equal(engine.agentSend("implementer", "security"), "deny");
  assert.deepEqual(engine.consultationTargets("implementer"), [
    { targetAgentId: "reviewer", scope: "Implementation review" },
  ]);
  assert.equal(
    engine.consultationScope("implementer", "reviewer"),
    "Implementation review",
  );
});

test("an explicit agent directory is authoritative over stale policy entries", () => {
  const engine = new PermissionEngine(
    {
      defaults: { agents: { send: "deny" } },
      agents: { removed: { agents: { send: "allow" } } },
    },
    agents,
  );

  assert.equal(engine.agentSend("removed", "reviewer"), "deny");
});

test("Slack access classifies the source agent channel as own_channel", () => {
  const engine = new PermissionEngine(
    {
      defaults: {
        slack: {
          own_channel: { read: "allow", write: "approval" },
          agent_channels: { read: "deny", write: "deny" },
          other_channels: { read: "deny", write: "deny" },
        },
      },
      agents: {},
    },
    agents,
  );

  assert.equal(engine.slackAccess("implementer", "read", "C_IMPLEMENTER"), "allow");
  assert.equal(
    engine.slackAccess("implementer", "write", "C_IMPLEMENTER"),
    "approval",
  );
});

test("Slack access classifies every other configured agent channel as agent_channels", () => {
  const engine = new PermissionEngine(
    {
      defaults: {
        slack: {
          own_channel: { read: "deny", write: "deny" },
          agent_channels: { read: "allow", write: "approval" },
          other_channels: { read: "deny", write: "deny" },
        },
      },
      agents: {},
    },
    agents,
  );

  assert.equal(engine.slackAccess("implementer", "read", "C_REVIEWER"), "allow");
  assert.equal(engine.slackAccess("implementer", "write", "C_SECURITY"), "approval");
});

test("Slack access classifies unassigned channels as other_channels", () => {
  const engine = new PermissionEngine(
    {
      defaults: {
        slack: {
          other_channels: { read: "approval", write: "deny" },
        },
      },
      agents: {},
    },
    agents,
  );

  assert.equal(engine.slackAccess("reviewer", "read", "C_GENERAL"), "approval");
  assert.equal(engine.slackAccess("reviewer", "write", "C_GENERAL"), "deny");
});

test("Slack per-agent policy overrides only the specified leaf", () => {
  const engine = new PermissionEngine(
    {
      defaults: {
        slack: {
          own_channel: { read: "allow", write: "approval" },
          agent_channels: { read: "allow", write: "deny" },
          other_channels: { read: "deny", write: "approval" },
        },
      },
      agents: {
        implementer: {
          slack: {
            own_channel: { read: "deny" },
            agent_channels: { write: "allow" },
            other_channels: { read: "approval" },
          },
        },
      },
    },
    agents,
  );

  assert.equal(engine.slackAccess("implementer", "read", "C_IMPLEMENTER"), "deny");
  assert.equal(
    engine.slackAccess("implementer", "write", "C_IMPLEMENTER"),
    "approval",
  );
  assert.equal(engine.slackAccess("implementer", "read", "C_REVIEWER"), "allow");
  assert.equal(engine.slackAccess("implementer", "write", "C_REVIEWER"), "allow");
  assert.equal(engine.slackAccess("implementer", "read", "C_GENERAL"), "approval");
  assert.equal(engine.slackAccess("implementer", "write", "C_GENERAL"), "approval");
});

test("Slack access fails closed for an omitted policy leaf", () => {
  const engine = new PermissionEngine(
    { defaults: { slack: { own_channel: { read: "allow" } } }, agents: {} },
    agents,
  );

  assert.equal(engine.slackAccess("security", "write", "C_SECURITY"), "deny");
  assert.equal(engine.slackAccess("security", "read", "C_REVIEWER"), "deny");
});

test("Slack access denies an unknown source before consulting permissive defaults", () => {
  const engine = new PermissionEngine(
    {
      defaults: {
        slack: {
          own_channel: { read: "allow", write: "allow" },
          agent_channels: { read: "allow", write: "allow" },
          other_channels: { read: "allow", write: "allow" },
        },
      },
      agents: {},
    },
    agents,
  );

  assert.equal(engine.slackAccess("unknown", "read", "C_GENERAL"), "deny");
  assert.equal(engine.slackAccess("unknown", "write", "C_IMPLEMENTER"), "deny");
});

test("Slack access fails closed when no agent directory was supplied", () => {
  const engine = new PermissionEngine({
    defaults: { slack: { other_channels: { read: "allow", write: "allow" } } },
    agents: { implementer: {} },
  });

  assert.equal(engine.slackAccess("implementer", "read", "C_GENERAL"), "deny");
  assert.equal(engine.slackAccess("implementer", "write", "C_GENERAL"), "deny");
});

test("the agent directory is snapshotted at construction", () => {
  const mutableAgents: Record<string, { slack: { channel_id: string } }> = {
    implementer: { slack: { channel_id: "C_IMPLEMENTER" } },
    reviewer: { slack: { channel_id: "C_REVIEWER" } },
  };
  const engine = new PermissionEngine(
    {
      defaults: {
        slack: {
          own_channel: { read: "allow" },
          agent_channels: { read: "approval" },
          other_channels: { read: "deny" },
        },
      },
      agents: {},
    },
    mutableAgents,
  );

  mutableAgents.implementer!.slack.channel_id = "C_CHANGED";
  mutableAgents.newAgent = { slack: { channel_id: "C_NEW" } };

  assert.equal(engine.slackAccess("implementer", "read", "C_IMPLEMENTER"), "allow");
  assert.equal(engine.slackAccess("implementer", "read", "C_CHANGED"), "deny");
  assert.equal(engine.slackAccess("implementer", "read", "C_NEW"), "deny");
  assert.equal(engine.slackAccess("newAgent", "read", "C_NEW"), "deny");
});
