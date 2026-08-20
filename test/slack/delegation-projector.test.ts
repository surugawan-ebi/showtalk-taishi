import assert from "node:assert/strict";
import test from "node:test";

import type { WebClient } from "@slack/web-api";

import type { DelegationActivity } from "../../src/core/index.js";
import { SlackDelegationProjector } from "../../src/slack/delegation-projector.js";

test("projects direct delegation into the target channel as an activity thread", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: posts.length === 1 ? "100.1" : `${100 + posts.length}.1` };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const projector = new SlackDelegationProjector(client, {
    C1: { username: "Taishi Implementer", icon_emoji: ":hammer:" },
    C2: { username: "Taishi Reviewer", icon_emoji: ":mag:" },
  });
  const base = {
    delegationId: "d1",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    sourceRootThreadTs: "99.1",
    targetAgentId: "reviewer",
    targetChannelId: "C2",
    targetSessionId: "s2",
    depth: 1,
    timestamp: "2026-08-12T00:00:00.000Z",
  } as const;
  const activity: DelegationActivity[] = [
    { ...base, type: "delegation.started", message: "Review this" },
    {
      ...base,
      type: "delegation.agent_event",
      event: { type: "message.completed", text: "Looks good" },
    },
    { ...base, type: "delegation.completed" },
  ];
  const destination = await projector.project(activity[0]!);
  for (const event of activity.slice(1)) await projector.project(event);

  assert.deepEqual(destination, { channelId: "C2", rootThreadTs: "100.1" });

  assert.equal(posts[0]?.channel, "C2");
  assert.match(String(posts[0]?.text), /implementerのKoe.*<#C1>.*訪問/u);
  assert.equal(posts[0]?.username, "Taishi Implementer");
  assert.equal(posts[0]?.icon_emoji, ":hammer:");
  assert.equal(posts[1]?.thread_ts, "100.1");
  assert.equal(posts[1]?.text, "Looks good");
  assert.equal(posts[1]?.username, "Taishi Reviewer");
  assert.equal(posts[2]?.thread_ts, "100.1");
  assert.match(String(posts[2]?.text), /reviewerのKoe.*implementerのKoe/u);
  assert.equal(posts[2]?.username, "Taishi Reviewer");
  assert.equal(posts[3]?.channel, "C1");
  assert.equal(posts[3]?.thread_ts, "99.1");
  assert.match(String(posts[3]?.text), /reviewerのKoeから返答/u);
  assert.match(String(posts[3]?.text), /<#C2>/u);
  assert.equal(posts[3]?.username, "Taishi Implementer");
  assert.equal(posts[3]?.icon_emoji, ":hammer:");
  assert.equal(updates.length, 0);
});

test("neutralizes Slack mentions in Koe-controlled routing text", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: "100.1" };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackDelegationProjector(client);
  await projector.project({
    delegationId: "mention",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    targetAgentId: "reviewer",
    targetChannelId: "C2",
    targetSessionId: "s2",
    depth: 1,
    timestamp: "2026-08-12T00:00:00.000Z",
    type: "delegation.started",
    message: "Please alert <!channel> and <@U123>",
  });

  assert.doesNotMatch(String(posts[0]?.text), /<!channel>|<@U123>/u);
  assert.match(String(posts[0]?.text), /&lt;!channel&gt;.*&lt;@U123&gt;/u);
});

test("bounds delegation text after Slack escaping and quote formatting", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: "100.1" };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackDelegationProjector(client);

  await projector.project({
    delegationId: "bounded",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    targetAgentId: "reviewer",
    targetChannelId: "C2",
    targetSessionId: "s2",
    depth: 1,
    timestamp: "2026-08-13T00:00:00.000Z",
    type: "delegation.started",
    message: `${"<@U123>&".repeat(2_000)}\n`.repeat(20),
  });

  const text = String(posts[0]?.text);
  assert.ok(text.length <= 3_800);
  assert.doesNotMatch(text, /<@U123>/u);
});

test("does not guess a source Slack thread for a Koe visit without one", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: `${100 + posts.length}.1` };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackDelegationProjector(client);
  const base = {
    delegationId: "app-origin",
    sourceAgentId: "implementer",
    sourceChannelId: "C1",
    targetAgentId: "reviewer",
    targetChannelId: "C2",
    targetSessionId: "s2",
    depth: 1,
    timestamp: "2026-08-13T00:00:00.000Z",
  } as const;

  await projector.project({ ...base, type: "delegation.started", message: "相談" });
  await projector.project({
    ...base,
    type: "delegation.agent_event",
    event: { type: "message.completed", text: "返答" },
  });
  await projector.project({ ...base, type: "delegation.completed" });

  assert.ok(posts.every((post) => post.channel === "C2"));
});

test("reports a failed channel visit back to the exact source Slack thread", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: `${100 + posts.length}.1` };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackDelegationProjector(client, {
    C1: { username: "Agent A" },
    C2: { username: "Agent B" },
  });
  const base = {
    delegationId: "failed-visit",
    sourceAgentId: "agent-a",
    sourceChannelId: "C1",
    sourceRootThreadTs: "99.1",
    targetAgentId: "agent-b",
    targetChannelId: "C2",
    targetSessionId: "s2",
    depth: 1,
    timestamp: "2026-08-13T00:00:00.000Z",
  } as const;

  await projector.project({ ...base, type: "delegation.started", message: "相談" });
  await projector.project({
    ...base,
    type: "delegation.failed",
    error: { name: "Error", message: "unavailable" },
  });

  assert.equal(posts.at(-1)?.channel, "C1");
  assert.equal(posts.at(-1)?.thread_ts, "99.1");
  assert.equal(posts.at(-1)?.username, "Agent A");
  assert.match(String(posts.at(-1)?.text), /agent-bのKoeとの会話に失敗/u);
});

test("attempts the source receipt and cleans up when the target completion notice fails", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        if (String(input.text).includes("返答を渡しました")) {
          throw new Error("target completion unavailable");
        }
        return { ok: true, ts: `${100 + posts.length}.1` };
      },
      update: async () => ({ ok: true }),
    },
  } as unknown as WebClient;
  const projector = new SlackDelegationProjector(client);
  const base = {
    delegationId: "partial-completion",
    sourceAgentId: "agent-a",
    sourceChannelId: "C1",
    sourceRootThreadTs: "99.1",
    targetAgentId: "agent-b",
    targetChannelId: "C2",
    targetSessionId: "s2",
    depth: 1,
    timestamp: "2026-08-13T00:00:00.000Z",
  } as const;

  await projector.project({ ...base, type: "delegation.started", message: "相談" });
  await projector.project({
    ...base,
    type: "delegation.agent_event",
    event: { type: "message.completed", text: "返答" },
  });
  await assert.rejects(
    () => projector.project({ ...base, type: "delegation.completed" }),
    /target completion unavailable/u,
  );

  const sourceReceipt = posts.find(
    (post) => post.channel === "C1" && post.thread_ts === "99.1",
  );
  assert.match(String(sourceReceipt?.text), /agent-bのKoeから返答/u);
  await assert.rejects(
    () => projector.project({ ...base, type: "delegation.completed" }),
    /was not started/u,
  );
});
