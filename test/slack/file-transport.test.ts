import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  SlackFileTransport,
  type SlackFileInfoClient,
} from "../../src/slack/file-transport.js";

const BOT_TOKEN = "xoxb-test-token";

interface FileFixture {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly bytes: Buffer;
  readonly url?: string;
}

async function temporaryRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "taishi-slack-files-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

function clientFor(
  fixtures: readonly FileFixture[],
  calls: string[] = [],
): SlackFileInfoClient {
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  return {
    files: {
      info: async ({ file }) => {
        calls.push(file);
        const fixture = byId.get(file);
        if (fixture === undefined) return { ok: false };
        return {
          ok: true,
          file: {
            id: fixture.id,
            name: fixture.name,
            mimetype: fixture.mimetype,
            size: fixture.bytes.byteLength,
            url_private_download:
              fixture.url ?? `https://files.slack.com/files-pri/${fixture.id}`,
          },
        };
      },
    },
  };
}

function fetchFor(
  fixtures: readonly FileFixture[],
  inspect?: (url: URL, init: RequestInit | undefined) => void,
): typeof fetch {
  const byUrl = new Map(
    fixtures.map((fixture) => [
      fixture.url ?? `https://files.slack.com/files-pri/${fixture.id}`,
      fixture,
    ]),
  );
  return async (input, init) => {
    const url = new URL(String(input));
    inspect?.(url, init);
    const fixture = byUrl.get(url.toString());
    assert.ok(fixture, `missing fixture for ${url.toString()}`);
    return new Response(Uint8Array.from(fixture.bytes), {
      status: 200,
      headers: { "Content-Length": String(fixture.bytes.byteLength) },
    });
  };
}

function png(id: string, name = `${id}.png`): FileFixture {
  return {
    id,
    name,
    mimetype: "image/png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  };
}

function mp3(id: string, name = `${id}.mp3`): FileFixture {
  return {
    id,
    name,
    mimetype: "audio/mpeg",
    bytes: Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0]),
  };
}

test("downloads multiple image and audio files in first-occurrence order", async (t) => {
  const root = await temporaryRoot(t);
  const fixtures = [png("FIMG1"), mp3("FAUDIO1"), png("FIMG2")];
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor(fixtures),
  });

  const result = await transport.download({
    agentId: "showtalk",
    channelId: "C123",
    messageTs: "1710000000.000001",
    fileIds: ["FIMG2", "FAUDIO1", "FIMG1"],
    client: clientFor(fixtures),
  });

  assert.deepEqual(
    result.attachments.map(({ kind, name, mimeType }) => ({ kind, name, mimeType })),
    [
      { kind: "image", name: "FIMG2.png", mimeType: "image/png" },
      { kind: "audio", name: "FAUDIO1.mp3", mimeType: "audio/mpeg" },
      { kind: "image", name: "FIMG1.png", mimeType: "image/png" },
    ],
  );
  assert.deepEqual(result.ignored, []);
  for (const attachment of result.attachments) {
    const fixture = fixtures.find((candidate) => candidate.name === attachment.name);
    assert.ok(fixture);
    assert.deepEqual(await readFile(attachment.path), fixture.bytes);
  }

  const expectedDirectory = join(
    root,
    sha256("showtalk"),
    "incoming",
    sha256("C1231710000000.000001"),
  );
  assert.ok(result.attachments.every(({ path }) => dirname(path) === expectedDirectory));
});

test("deduplicates file IDs without changing their first-occurrence order", async (t) => {
  const root = await temporaryRoot(t);
  const fixtures = [png("FONE"), mp3("FTWO")];
  const infoCalls: string[] = [];
  const fetchCalls: string[] = [];
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor(fixtures, (url) => fetchCalls.push(url.pathname)),
  });

  const result = await transport.download({
    agentId: "agent",
    channelId: "C1",
    messageTs: "1.001",
    fileIds: ["FONE", "FONE", "FTWO", "FONE"],
    client: clientFor(fixtures, infoCalls),
  });

  assert.deepEqual(infoCalls, ["FONE", "FTWO"]);
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(result.attachments.map(({ name }) => name), ["FONE.png", "FTWO.mp3"]);
});

test("does not let one Koe's slow download block another Koe", async (t) => {
  const root = await temporaryRoot(t);
  const fixtures = [png("FONE"), png("FTWO")];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async (input) => {
      const value = String(input);
      const fixture = fixtures.find((candidate) => value.endsWith(candidate.id));
      assert.ok(fixture);
      if (fixture.id === "FONE") await firstGate;
      if (fixture.id === "FTWO") markSecondStarted();
      return new Response(Uint8Array.from(fixture.bytes), {
        status: 200,
        headers: { "Content-Length": String(fixture.bytes.byteLength) },
      });
    },
  });

  const first = transport.download({
    agentId: "one",
    channelId: "C1",
    messageTs: "1.001",
    fileIds: ["FONE"],
    client: clientFor(fixtures),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = transport.download({
    agentId: "two",
    channelId: "C2",
    messageTs: "2.001",
    fileIds: ["FTWO"],
    client: clientFor(fixtures),
  });
  try {
    await Promise.race([
      secondStarted,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the second Koe stayed blocked")),
          1_000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
});

test("ignores unsupported MIME types without downloading them", async (t) => {
  const root = await temporaryRoot(t);
  const fixture: FileFixture = {
    id: "FTEXT",
    name: "notes.txt",
    mimetype: "text/plain",
    bytes: Buffer.from("notes"),
  };
  let fetches = 0;
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () => {
      fetches += 1;
      throw new Error("must not fetch");
    },
  });

  const result = await transport.download({
    agentId: "agent",
    channelId: "C1",
    messageTs: "1.001",
    fileIds: [fixture.id],
    client: clientFor([fixture]),
  });

  assert.deepEqual(result.attachments, []);
  assert.deepEqual(result.ignored, [
    {
      fileId: "FTEXT",
      name: "notes.txt",
      mimeType: "text/plain",
      reason: "unsupported_mime",
    },
  ]);
  assert.equal(fetches, 0);
});

test("rejects non-Slack download hosts before fetch", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = {
    ...png("FEVIL"),
    url: "https://attacker.example/private?token=secret",
  };
  let fetches = 0;
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () => {
      fetches += 1;
      throw new Error("must not fetch");
    },
  });

  await assert.rejects(
    transport.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.001",
      fileIds: [fixture.id],
      client: clientFor([fixture]),
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /URL is not allowed/u);
      assert.doesNotMatch(error.message, /attacker|secret|xoxb/u);
      return true;
    },
  );
  assert.equal(fetches, 0);
});

test("uses bearer authentication and rejects redirects without exposing secrets", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = png("FAUTH");
  let observed = false;
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async (input, init) => {
      observed = true;
      assert.equal(String(input), "https://files.slack.com/files-pri/FAUTH");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${BOT_TOKEN}`);
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/leak" },
      });
    },
  });

  await assert.rejects(
    transport.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.001",
      fileIds: [fixture.id],
      client: clientFor([fixture]),
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /download failed/u);
      assert.doesNotMatch(error.message, /attacker|xoxb/u);
      return true;
    },
  );
  assert.equal(observed, true);
});

test("sanitizes thrown download errors and reports authorization failures", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = png("FERROR");
  const thrown = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () => {
      throw new Error(`network failed ${BOT_TOKEN} https://files.slack.com/private`);
    },
  });
  await assert.rejects(
    thrown.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.001",
      fileIds: [fixture.id],
      client: clientFor([fixture]),
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Slack file download failed for file FERROR");
      return true;
    },
  );

  const unauthorized = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () => new Response(null, { status: 401 }),
  });
  await assert.rejects(
    unauthorized.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.002",
      fileIds: [fixture.id],
      client: clientFor([fixture]),
    }),
    /authorization failed for file FERROR/u,
  );

  const bodyFailure = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(
              new Error(`stream failed ${BOT_TOKEN} https://files.slack.com/private`),
            );
          },
        }),
        { status: 200 },
      ),
  });
  await assert.rejects(
    bodyFailure.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.003",
      fileIds: [fixture.id],
      client: clientFor([fixture]),
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Slack file download failed for file FERROR");
      return true;
    },
  );
});

test("enforces declared, Content-Length, actual, count, and total size limits", async (t) => {
  const root = await temporaryRoot(t);
  const large = png("FLARGE");
  const tinyLimit = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor([large]),
    maxFileBytes: large.bytes.byteLength - 1,
  });
  await assert.rejects(
    tinyLimit.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.001",
      fileIds: [large.id],
      client: clientFor([large]),
    }),
    /per-file size limit/u,
  );

  const first = png("FTOTAL1");
  const second = png("FTOTAL2");
  const totalLimit = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor([first, second]),
    maxTotalBytes: first.bytes.byteLength + second.bytes.byteLength - 1,
  });
  await assert.rejects(
    totalLimit.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.002",
      fileIds: [first.id, second.id],
      client: clientFor([first, second]),
    }),
    /total size limit/u,
  );

  const countLimit = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor([first, second]),
    maxFiles: 1,
  });
  await assert.rejects(
    countLimit.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.003",
      fileIds: [first.id, second.id],
      client: clientFor([first, second]),
    }),
    /more than 1 files/u,
  );

  const inconsistentLength = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () =>
      new Response(Uint8Array.from(first.bytes), {
        status: 200,
        headers: { "Content-Length": String(first.bytes.byteLength - 1) },
      }),
  });
  await assert.rejects(
    inconsistentLength.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.004",
      fileIds: [first.id],
      client: clientFor([first]),
    }),
    /inconsistent size metadata/u,
  );

  const actualMismatch = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: async () =>
      new Response(Uint8Array.from(first.bytes.subarray(0, first.bytes.byteLength - 1))),
  });
  await assert.rejects(
    actualMismatch.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.005",
      fileIds: [first.id],
      client: clientFor([first]),
    }),
    /inconsistent size metadata/u,
  );
});

test("enforces a persistent per-Agent spool quota across Slack messages", async (t) => {
  const root = await temporaryRoot(t);
  const first = png("FQUOTA1");
  const second = png("FQUOTA2");
  const fixtures = [first, second];
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor(fixtures),
    maxSpoolBytes: first.bytes.byteLength + second.bytes.byteLength - 1,
  });

  await transport.download({
    agentId: "agent",
    channelId: "C1",
    messageTs: "1.001",
    fileIds: [first.id],
    client: clientFor(fixtures),
  });
  await assert.rejects(
    transport.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.002",
      fileIds: [second.id],
      client: clientFor(fixtures),
    }),
    /spool quota/u,
  );
});

test("rejects MIME spoofing before writing a file", async (t) => {
  const root = await temporaryRoot(t);
  const fixture: FileFixture = {
    id: "FSPOOF",
    name: "fake.png",
    mimetype: "image/png",
    bytes: Buffer.from("not a png"),
  };
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor([fixture]),
  });

  await assert.rejects(
    transport.download({
      agentId: "agent",
      channelId: "C1",
      messageTs: "1.001",
      fileIds: [fixture.id],
      client: clientFor([fixture]),
    }),
    /does not match its declared MIME type/u,
  );
});

test("stores files and spool directories with private permissions and safe names", async (t) => {
  const root = await temporaryRoot(t);
  const fixture = png("FPERMS", "../../.secret?.png");
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor([fixture]),
  });

  const result = await transport.download({
    agentId: "agent",
    channelId: "C1",
    messageTs: "1.001",
    fileIds: [fixture.id],
    client: clientFor([fixture]),
  });
  const attachment = result.attachments[0];
  assert.ok(attachment);
  assert.equal(attachment.name, "_secret_.png");
  assert.equal((await stat(attachment.path)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(attachment.path))).mode & 0o777, 0o700);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await readdir(dirname(attachment.path))).some((name) => name.endsWith(".tmp")), false);
});

test("accepts the requested image and audio magic signatures", async (t) => {
  const root = await temporaryRoot(t);
  const cases: FileFixture[] = [
    { id: "FPNG", name: "a.png", mimetype: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { id: "FJPEG", name: "a.jpg", mimetype: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xdb]) },
    { id: "FGIF", name: "a.gif", mimetype: "image/gif", bytes: Buffer.from("GIF89a") },
    { id: "FWEBP", name: "a.webp", mimetype: "image/webp", bytes: Buffer.from("RIFF0000WEBP") },
    { id: "FMP3", name: "a.mp3", mimetype: "audio/mpeg", bytes: Buffer.from("ID3data") },
    { id: "FM4A", name: "a.m4a", mimetype: "audio/x-m4a", bytes: Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypM4A ")]) },
    { id: "FMP4", name: "a.mp4", mimetype: "audio/mp4", bytes: Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypmp42")]) },
    { id: "FWAV", name: "a.wav", mimetype: "audio/wav", bytes: Buffer.from("RIFF0000WAVE") },
    { id: "FOGG", name: "a.ogg", mimetype: "audio/ogg", bytes: Buffer.from("OggSdata") },
    { id: "FFLAC", name: "a.flac", mimetype: "audio/flac", bytes: Buffer.from("fLaCdata") },
    { id: "FAAC", name: "a.aac", mimetype: "audio/aac", bytes: Buffer.from([0xff, 0xf1, 0x50, 0x80]) },
  ];
  const transport = new SlackFileTransport({
    botToken: BOT_TOKEN,
    rootDirectory: root,
    fetchFn: fetchFor(cases),
    maxFiles: cases.length,
  });

  const result = await transport.download({
    agentId: "agent",
    channelId: "C1",
    messageTs: "1.001",
    fileIds: cases.map(({ id }) => id),
    client: clientFor(cases),
  });
  assert.equal(result.attachments.length, cases.length);
  assert.deepEqual(
    result.attachments.map(({ kind }) => kind),
    ["image", "image", "image", "image", "audio", "audio", "audio", "audio", "audio", "audio", "audio"],
  );
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
