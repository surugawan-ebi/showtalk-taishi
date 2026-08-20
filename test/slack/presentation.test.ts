import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlackMessagePresentation,
  presentationForChannel,
} from "../../src/slack/presentation.js";

test("builds Slack identity fields only when a presentation is configured", () => {
  assert.deepEqual(createSlackMessagePresentation({}), {});
  assert.deepEqual(
    createSlackMessagePresentation({
      display_name: "Taishi Implementer",
      icon_url: "https://example.com/implementer.png",
    }),
    {
      username: "Taishi Implementer",
      icon_url: "https://example.com/implementer.png",
    },
  );
  assert.deepEqual(
    createSlackMessagePresentation({ icon_emoji: ":hammer:" }),
    { icon_emoji: ":hammer:" },
  );
});

test("selects presentation from the destination channel", () => {
  const presentations = {
    C_IMPLEMENTER: { username: "Taishi Implementer" },
    C_REVIEWER: { username: "Taishi Reviewer", icon_emoji: ":mag:" },
  } as const;

  assert.deepEqual(presentationForChannel(presentations, "C_REVIEWER"), {
    username: "Taishi Reviewer",
    icon_emoji: ":mag:",
  });
  assert.deepEqual(presentationForChannel(presentations, "C_UNKNOWN"), {});
});
