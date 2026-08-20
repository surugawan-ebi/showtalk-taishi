import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  resolveWorkspaceAttachments,
} from "../../src/mcp/workspace-attachments.js";

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

  const resolved = await resolveWorkspaceAttachments(workspace, [
    { path: "image.png", alt_text: "Result preview" },
    { path: "voice.m4a", title: "Voice result" },
  ]);

  assert.deepEqual(
    resolved.map(({ name, kind, size }) => ({ name, kind, size })),
    [
      { name: "image.png", kind: "image", size: 8 },
      { name: "voice.m4a", kind: "audio", size: 8 },
    ],
  );
  assert.equal(resolved[0]?.altText, "Result preview");
  assert.equal(resolved[1]?.title, "Voice result");
});

test("rejects traversal, workspace-external symlinks, and unsupported files", async (context) => {
  const workspace = await temporaryDirectory(context, "workspace");
  const outside = await temporaryDirectory(context, "outside");
  await writeFile(join(outside, "secret.png"), Buffer.from([1]));
  await writeFile(join(workspace, "notes.txt"), "not media");
  await writeFile(join(workspace, "fake.png"), "not really an image");
  await symlink(join(outside, "secret.png"), join(workspace, "linked.png"));

  await assert.rejects(
    resolveWorkspaceAttachments(workspace, [{ path: "../outside/secret.png" }]),
    /may not leave|does not exist/u,
  );
  await assert.rejects(
    resolveWorkspaceAttachments(workspace, [{ path: "linked.png" }]),
    /may not leave/u,
  );
  await assert.rejects(
    resolveWorkspaceAttachments(workspace, [{ path: "notes.txt" }]),
    /Only supported image and audio/u,
  );
  await assert.rejects(
    resolveWorkspaceAttachments(workspace, [{ path: "fake.png" }]),
    /does not match its file type/u,
  );
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
