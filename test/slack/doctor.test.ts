import assert from "node:assert/strict";
import test from "node:test";

import { validateSlackWorkspace } from "../../src/slack/doctor.js";
import type { TaishiConfig } from "../../src/config/schema.js";

const config = {
  slack: { bot_token: "xoxb-test" },
  agents: {
    implementer: { slack: { channel_id: "C1" } },
    reviewer: { slack: { channel_id: "C2" } },
  },
} as unknown as TaishiConfig;

test("authenticates the bot and verifies every configured Agent channel", async () => {
  const seen: string[] = [];
  const checks = await validateSlackWorkspace(config, {
    auth: { test: async () => ({ ok: true, user_id: "U1" }) },
    conversations: {
      info: async ({ channel }) => {
        seen.push(channel);
        return { ok: true, channel: { id: channel, is_member: true } };
      },
    },
  });
  assert.deepEqual(seen, ["C1", "C2"]);
  assert.deepEqual(checks, [
    "slack:bot-auth",
    "slack:agent-channel:implementer",
    "slack:agent-channel:reviewer",
  ]);
});

test("rejects channels where the bot has not been invited", async () => {
  await assert.rejects(
    () =>
      validateSlackWorkspace(config, {
        auth: { test: async () => ({ ok: true, user_id: "U1" }) },
        conversations: {
          info: async ({ channel }) => ({
            ok: true,
            channel: { id: channel, is_member: false },
          }),
        },
      }),
    /Invite ShowTalk Taishi/,
  );
});
