import assert from "node:assert/strict";
import test from "node:test";

import { validateSlackActionSource } from "../../src/slack/interaction-source.js";

const body = {
  type: "block_actions",
  api_app_id: "A0123456789",
  team: { id: "T0123456789" },
  user: { id: "U0123456789" },
  channel: { id: "C0123456789" },
  message: { ts: "1786654846.000100", thread_ts: "1786654845.402859" },
  container: {
    type: "message",
    channel_id: "C0123456789",
    message_ts: "1786654846.000100",
  },
};
const expected = {
  channelId: "C0123456789",
  rootThreadTs: "1786654845.402859",
  messageTs: "1786654846.000100",
};
const approvers = new Set(["U0123456789"]);

test("accepts a Bolt-authenticated action only from its bound source", () => {
  assert.deepEqual(validateSlackActionSource(body, expected, approvers), {
    userId: "U0123456789",
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    messageTs: "1786654846.000100",
    teamId: "T0123456789",
    apiAppId: "A0123456789",
  });
});

test("rejects an unconfigured Slack user", () => {
  assert.throws(
    () => validateSlackActionSource(body, expected, new Set(["UOTHER"])),
    /not configured/u,
  );
});

test("rejects a callback replayed into another channel or thread", () => {
  assert.throws(() =>
    validateSlackActionSource(body, { ...expected, channelId: "COTHER" }, approvers),
  );
  assert.throws(() =>
    validateSlackActionSource(body, { ...expected, rootThreadTs: "1.2" }, approvers),
  );
  assert.throws(() =>
    validateSlackActionSource(
      { ...body, container: { ...body.container, message_ts: "1.3" } },
      expected,
      approvers,
    ),
  );
  assert.throws(() =>
    validateSlackActionSource(
      body,
      { ...expected, messageTs: "1786654846.999999" },
      approvers,
    ),
  );
});

test("rejects callbacks missing the trusted Socket Mode app source", () => {
  assert.throws(() =>
    validateSlackActionSource({ ...body, api_app_id: "attacker" }, expected, approvers),
  );
  assert.throws(() =>
    validateSlackActionSource({ ...body, type: "view_submission" }, expected, approvers),
  );
});
