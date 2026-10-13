import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  AgentInputAttachment,
  QueuedDelegationAttachment,
} from "../core/index.js";
import { McpServiceError, type McpSlackAttachmentInput } from "./types.js";
import { withResolvedWorkspaceAttachments } from "./workspace-attachments.js";

const MAX_DELEGATION_SPOOL_BYTES = 1024 * 1024 * 1024;
const MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

let spoolMutationTail: Promise<void> = Promise.resolve();

export async function captureDelegationImages(
  workspacePath: string,
  spoolRoot: string,
  delegationId: string,
  requested: readonly McpSlackAttachmentInput[],
  signal?: AbortSignal,
): Promise<readonly QueuedDelegationAttachment[]> {
  if (requested.length === 0) return [];
  return withResolvedWorkspaceAttachments(
    workspacePath,
    requested,
    async (resolved) => {
      if (resolved.some((attachment) => attachment.kind !== "image")) {
        throw new McpServiceError(
          "INVALID_ATTACHMENT",
          "agent.send accepts image attachments only",
        );
      }
      return serializeSpoolMutation(async () => {
        if (signal?.aborted === true) throw cancelled();
        const root = resolve(spoolRoot);
        await ensurePrivateDirectory(root);
        const bytes = await directoryBytes(root);
        const incomingBytes = resolved.reduce(
          (total, attachment) => total + attachment.payload.size,
          0,
        );
        if (bytes + incomingBytes > MAX_DELEGATION_SPOOL_BYTES) {
          throw new McpServiceError(
            "INVALID_ATTACHMENT",
            "The Koe image attachment spool quota would be exceeded",
          );
        }
        const directory = join(root, sha256(delegationId));
        await mkdir(directory, { mode: 0o700 });
        await chmod(directory, 0o700);
        const captured: QueuedDelegationAttachment[] = [];
        try {
          for (const [index, attachment] of resolved.entries()) {
            if (signal?.aborted) throw cancelled();
            const extension = extname(attachment.name).toLowerCase();
            const mimeType = MIME_TYPES.get(extension);
            if (mimeType === undefined) {
              throw new McpServiceError(
                "INVALID_ATTACHMENT",
                "agent.send accepts PNG, JPEG, GIF, or WebP images only",
              );
            }
            const contents = Buffer.from(await attachment.payload.arrayBuffer());
            const name = `${String(index + 1).padStart(2, "0")}-${basename(attachment.name)}`;
            const path = join(directory, name);
            const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
            try {
              await handle.writeFile(contents);
              await handle.sync();
            } finally {
              await handle.close();
            }
            captured.push({
              kind: "image",
              path,
              name: attachment.name,
              mimeType,
              size: contents.byteLength,
              sha256: sha256(contents),
            });
          }
          return Object.freeze(captured);
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          throw error;
        }
      });
    },
    signal === undefined ? {} : { signal },
  );
}

export async function restoreDelegationImages(
  spoolRoot: string,
  captured: readonly QueuedDelegationAttachment[],
): Promise<readonly AgentInputAttachment[]> {
  const root = await realpath(resolve(spoolRoot)).catch(() => {
    throw invalidCaptured();
  });
  const restored: AgentInputAttachment[] = [];
  for (const attachment of captured) {
    if (attachment.kind !== "image" || !isAbsolute(attachment.path)) {
      throw invalidCaptured();
    }
    const candidate = await realpath(attachment.path).catch(() => {
      throw invalidCaptured();
    });
    if (!isContained(root, candidate)) throw invalidCaptured();
    const details = await lstat(candidate);
    if (!details.isFile() || details.isSymbolicLink() || details.size !== attachment.size) {
      throw invalidCaptured();
    }
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents: Buffer;
    try {
      contents = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (sha256(contents) !== attachment.sha256) throw invalidCaptured();
    restored.push({
      kind: "image",
      path: candidate,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
  }
  return Object.freeze(restored);
}

export async function removeDelegationImages(
  spoolRoot: string,
  captured: readonly QueuedDelegationAttachment[] | undefined,
): Promise<void> {
  const first = captured?.[0];
  if (first === undefined) return;
  const root = resolve(spoolRoot);
  const directory = dirname(resolve(first.path));
  if (!isContained(root, directory)) return;
  await serializeSpoolMutation(() => rm(directory, { recursive: true, force: true }));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new McpServiceError("INVALID_ATTACHMENT", "The image attachment spool is unsafe");
  }
  await chmod(path, 0o700);
}

async function directoryBytes(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const candidate = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      throw new McpServiceError("INVALID_ATTACHMENT", "The image attachment spool is unsafe");
    }
    if (entry.isDirectory()) bytes += await directoryBytes(candidate);
    else if (entry.isFile()) bytes += (await stat(candidate)).size;
  }
  return bytes;
}

function serializeSpoolMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = spoolMutationTail.then(operation, operation);
  spoolMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot.length > 0 &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function cancelled(): McpServiceError {
  return new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled");
}

function invalidCaptured(): McpServiceError {
  return new McpServiceError(
    "INVALID_ATTACHMENT",
    "A queued Koe image attachment is missing or changed",
  );
}
