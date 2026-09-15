import assert from "node:assert/strict";
import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  WorkspaceAttachmentByteBudget,
  withResolvedWorkspaceAttachments,
} from "../../src/mcp/workspace-attachments.js";

async function resolveForTest(
  workspace: string,
  attachments: Parameters<typeof withResolvedWorkspaceAttachments>[1],
) {
  return withResolvedWorkspaceAttachments(
    workspace,
    attachments,
    async (resolved) => resolved,
  );
}

test("resolves supported workspace-relative image and audio files", async (context) => {
  const workspace = await temporaryDirectory(context, "resolve");
  await writeFile(
    join(workspace, "image.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  await writeFile(
    join(workspace, "voice.m4a"),
    Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]),
  );

  const resolved = await resolveForTest(workspace, [
    { path: "image.png", alt_text: "Result preview" },
    { path: "voice.m4a", title: "Voice result" },
  ]);

  assert.deepEqual(
    resolved.map(({ name, kind, payload }) => ({ name, kind, size: payload.size })),
    [
      { name: "image.png", kind: "image", size: 8 },
      { name: "voice.m4a", kind: "audio", size: 8 },
    ],
  );
  assert.equal(resolved[0]?.altText, "Result preview");
  assert.equal(resolved[1]?.title, "Voice result");
  assert.deepEqual(
    [...new Uint8Array(await (resolved[0]?.payload ?? new Blob()).arrayBuffer())],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
});

test("captures validated bytes so a later path replacement cannot change the upload", async (context) => {
  const workspace = await temporaryDirectory(context, "stable-bytes");
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const replacement = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
  const path = join(workspace, "image.png");
  await writeFile(path, original);

  const captured = await withResolvedWorkspaceAttachments(
    workspace,
    [{ path: "image.png" }],
    async ([resolved]) => {
      await rename(path, join(workspace, "old.png"));
      await writeFile(path, replacement);
      return Buffer.from(await (resolved?.payload ?? new Blob()).arrayBuffer());
    },
  );
  assert.deepEqual(captured, original);
});

test("rejects traversal, workspace-external symlinks, and unsupported files", async (context) => {
  const workspace = await temporaryDirectory(context, "workspace");
  const outside = await temporaryDirectory(context, "outside");
  await writeFile(join(outside, "secret.png"), Buffer.from([1]));
  await writeFile(join(workspace, "notes.txt"), "not media");
  await writeFile(join(workspace, "fake.png"), "not really an image");
  await symlink(join(outside, "secret.png"), join(workspace, "linked.png"));

  await assert.rejects(
    resolveForTest(workspace, [{ path: "../outside/secret.png" }]),
    /may not leave|does not exist/u,
  );
  await assert.rejects(
    resolveForTest(workspace, [{ path: "linked.png" }]),
    /may not leave|symbolic links/u,
  );
  await assert.rejects(
    resolveForTest(workspace, [{ path: "notes.txt" }]),
    /Only supported image and audio/u,
  );
  await assert.rejects(
    resolveForTest(workspace, [{ path: "fake.png" }]),
    /does not match its file type/u,
  );
});

test("holds a process-wide byte lease until the Slack consumer finishes", async (context) => {
  const workspace = await temporaryDirectory(context, "budget");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(workspace, "one.png"), png);
  await writeFile(join(workspace, "two.png"), png);
  const budget = new WorkspaceAttachmentByteBudget(png.byteLength);
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondEntered = false;

  const first = withResolvedWorkspaceAttachments(
    workspace,
    [{ path: "one.png" }],
    async () => holdFirst,
    { budget },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const second = withResolvedWorkspaceAttachments(
    workspace,
    [{ path: "two.png" }],
    async () => {
      secondEntered = true;
    },
    { budget },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test("cancels a byte-budget waiter without leaking its queue slot", async (context) => {
  const workspace = await temporaryDirectory(context, "budget-cancel");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await writeFile(join(workspace, "one.png"), png);
  await writeFile(join(workspace, "two.png"), png);
  const budget = new WorkspaceAttachmentByteBudget(png.byteLength);
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = withResolvedWorkspaceAttachments(
    workspace,
    [{ path: "one.png" }],
    async () => holdFirst,
    { budget },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const second = withResolvedWorkspaceAttachments(
    workspace,
    [{ path: "two.png" }],
    async () => undefined,
    { budget, signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(second, /cancelled/u);
  releaseFirst();
  await first;
});

async function temporaryDirectory(
  context: { after(callback: () => void | Promise<void>): void },
  suffix: string,
): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `showtalk-taishi-${suffix}-`));
  context.after(async () => {
    await rm(path, { recursive: true, force: true });
  });
  return path;
}
