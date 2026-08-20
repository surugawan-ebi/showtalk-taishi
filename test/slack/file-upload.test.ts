import assert from "node:assert/strict";
import test from "node:test";

import { uploadSlackAttachments } from "../../src/slack/file-upload.js";

test("completes multiple Slack files with only supported upload arguments", async () => {
  const tickets: Array<Record<string, unknown>> = [];
  const completions: Array<Record<string, unknown>> = [];
  const uploadedUrls: string[] = [];
  let nextFile = 1;
  const client = {
    files: {
      getUploadURLExternal: async (input: Record<string, unknown>) => {
        tickets.push(input);
        const file = nextFile++;
        return {
          ok: true,
          upload_url: `https://files.slack.com/upload/v1/${file}`,
          file_id: `F${file}`,
        };
      },
    },
    apiCall: async (method: string, input: Record<string, unknown>) => {
      assert.equal(method, "files.completeUploadExternal");
      completions.push(input);
      return { ok: true };
    },
  };

  await uploadSlackAttachments(
    client,
    "C1",
    "100.1",
    [
      {
        path: "/workspace/one.png",
        name: "one.png",
        size: 3,
        kind: "image",
        altText: "First image",
        title: "One",
      },
      {
        path: "/workspace/two.wav",
        name: "two.wav",
        size: 3,
        kind: "audio",
      },
    ],
    {
      readFile: async () => Buffer.from("abc"),
      fetch: async (url) => {
        uploadedUrls.push(url.toString());
        return new Response("ok", { status: 200 });
      },
    },
  );

  assert.deepEqual(tickets, [
    { filename: "one.png", length: 3, alt_text: "First image" },
    { filename: "two.wav", length: 3 },
  ]);
  assert.deepEqual(uploadedUrls, [
    "https://files.slack.com/upload/v1/1",
    "https://files.slack.com/upload/v1/2",
  ]);
  assert.deepEqual(completions, [
    {
      channel_id: "C1",
      thread_ts: "100.1",
      files: [{ id: "F1", title: "One" }, { id: "F2" }],
    },
  ]);
});

test("rejects unsafe upload tickets and files changed after validation", async () => {
  const completionClient = {
    files: {
      getUploadURLExternal: async () => ({
        ok: true,
        upload_url: "https://attacker.example/upload",
        file_id: "F1",
      }),
    },
    apiCall: async () => ({ ok: true }),
  };
  const attachment = {
    path: "/workspace/one.png",
    name: "one.png",
    size: 3,
    kind: "image" as const,
  };
  await assert.rejects(
    uploadSlackAttachments(completionClient, "C1", "100.1", [attachment], {
      readFile: async () => Buffer.from("abc"),
      fetch: async () => new Response("ok"),
    }),
    /unsafe external file upload URL/u,
  );

  completionClient.files.getUploadURLExternal = async () => ({
    ok: true,
    upload_url: "https://files.slack.com/upload/v1/1",
    file_id: "F1",
  });
  await assert.rejects(
    uploadSlackAttachments(completionClient, "C1", "100.1", [attachment], {
      readFile: async () => Buffer.from("changed"),
      fetch: async () => new Response("ok"),
    }),
    /changed after it was validated/u,
  );
});
