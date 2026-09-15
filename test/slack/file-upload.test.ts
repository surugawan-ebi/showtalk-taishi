import assert from "node:assert/strict";
import test from "node:test";

import { uploadSlackAttachments } from "../../src/slack/file-upload.js";

test("completes multiple Slack files with only supported upload arguments", async () => {
  const tickets: Array<Record<string, unknown>> = [];
  const completions: Array<Record<string, unknown>> = [];
  const uploadedUrls: string[] = [];
  const uploadedBodies: Buffer[] = [];
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
        payload: new Blob(["abc"]),
        name: "one.png",
        kind: "image",
        altText: "First image",
        title: "One",
      },
      {
        payload: new Blob(["abc"]),
        name: "two.wav",
        kind: "audio",
      },
    ],
    {
      fetch: async (url, init) => {
        uploadedUrls.push(url.toString());
        uploadedBodies.push(Buffer.from(await new Response(init.body).arrayBuffer()));
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
  assert.deepEqual(uploadedBodies, [Buffer.from("abc"), Buffer.from("abc")]);
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
    payload: new Blob(["abc"]),
    name: "one.png",
    kind: "image" as const,
  };
  await assert.rejects(
    uploadSlackAttachments(completionClient, "C1", "100.1", [attachment], {
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
    uploadSlackAttachments(completionClient, "C1", "100.1", [{
      ...attachment,
      payload: new Blob([]),
    }], {
      fetch: async () => new Response("ok"),
    }),
    /invalid size/u,
  );
});

test("deletes every acquired file ticket when a later upload fails", async () => {
  let nextFile = 1;
  const deleted: string[] = [];
  const client = {
    files: {
      getUploadURLExternal: async () => {
        const file = nextFile++;
        return {
          ok: true,
          upload_url: `https://files.slack.com/upload/v1/${file}`,
          file_id: `F${file}`,
        };
      },
    },
    apiCall: async (method: string, input: Record<string, unknown>) => {
      if (method === "files.delete") {
        deleted.push(String(input.file));
        return { ok: true };
      }
      throw new Error(`unexpected ${method}`);
    },
  };

  await assert.rejects(
    uploadSlackAttachments(
      client,
      "C1",
      "100.1",
      [
        { payload: new Blob(["one"]), name: "one.png", kind: "image" },
        { payload: new Blob(["two"]), name: "two.png", kind: "image" },
      ],
      {
        fetch: async (url) =>
          url.pathname.endsWith("/1")
            ? new Response("ok", { status: 200 })
            : new Response("failed", { status: 500 }),
      },
    ),
    /external file upload failed/u,
  );
  assert.deepEqual(deleted.sort(), ["F1", "F2"]);
});
