import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import { McpServiceError, type McpSlackAttachmentInput } from "./types.js";

export const MAX_SLACK_ATTACHMENT_FILES = 10;
export const MAX_SLACK_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SLACK_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

export interface RuntimeSlackAttachment {
  /** Immutable upload payload captured from the validated file handle. */
  readonly payload: Blob;
  readonly name: string;
  readonly kind: "image" | "audio";
  readonly title?: string;
  readonly altText?: string;
}

interface AttachmentIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

interface PreparedAttachment {
  readonly input: McpSlackAttachmentInput;
  readonly candidate: string;
  readonly kind: RuntimeSlackAttachment["kind"];
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly parents: readonly AttachmentIdentity[];
}

interface AttachmentBudgetWaiter {
  readonly bytes: number;
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/** Keeps immutable Blob captures globally bounded until Slack upload finishes. */
export class WorkspaceAttachmentByteBudget {
  readonly #capacity: number;
  readonly #waiters: AttachmentBudgetWaiter[] = [];
  #reserved = 0;

  constructor(capacity = MAX_SLACK_ATTACHMENT_TOTAL_BYTES) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Attachment byte budget must be a positive safe integer");
    }
    this.#capacity = capacity;
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.#capacity) {
      return Promise.reject(
        invalidAttachment("Attachments exceed the Gateway memory budget"),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(cancelledAttachment());
    }
    if (this.#waiters.length === 0 && this.#reserved + bytes <= this.#capacity) {
      this.#reserved += bytes;
      return Promise.resolve(this.#releaseFor(bytes));
    }
    return new Promise<() => void>((resolveWaiter, reject) => {
      const waiter: AttachmentBudgetWaiter = {
        bytes,
        resolve: resolveWaiter,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(cancelledAttachment());
        this.#drain();
      };
      if (signal !== undefined) {
        Object.assign(waiter, { onAbort });
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  #releaseFor(bytes: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved -= bytes;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0]!;
      if (waiter.signal?.aborted === true) {
        this.#waiters.shift();
        waiter.signal.removeEventListener("abort", waiter.onAbort!);
        waiter.reject(cancelledAttachment());
        continue;
      }
      if (this.#reserved + waiter.bytes > this.#capacity) return;
      this.#waiters.shift();
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.#reserved += waiter.bytes;
      waiter.resolve(this.#releaseFor(waiter.bytes));
    }
  }
}

const sharedAttachmentBudget = new WorkspaceAttachmentByteBudget();

const EXTENSION_KINDS = new Map<string, RuntimeSlackAttachment["kind"]>([
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".mp3", "audio"],
  [".m4a", "audio"],
  [".wav", "audio"],
  [".ogg", "audio"],
  [".flac", "audio"],
  [".aac", "audio"],
]);

export async function withResolvedWorkspaceAttachments<T>(
  workspacePath: string,
  requested: readonly McpSlackAttachmentInput[],
  use: (attachments: readonly RuntimeSlackAttachment[]) => Promise<T>,
  options: {
    readonly signal?: AbortSignal;
    readonly budget?: WorkspaceAttachmentByteBudget;
  } = {},
): Promise<T> {
  if (requested.length > MAX_SLACK_ATTACHMENT_FILES) {
    throw invalidAttachment(`At most ${MAX_SLACK_ATTACHMENT_FILES} files may be uploaded`);
  }
  if (requested.length === 0) return use([]);

  const workspace = await realpath(workspacePath).catch(() => {
    throw invalidAttachment("The Koe workspace could not be resolved");
  });
  const prepared: PreparedAttachment[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const attachment of requested) {
    if (isAbsolute(attachment.path)) {
      throw invalidAttachment("Attachment paths must be relative to the Koe workspace");
    }
    const lexicalCandidate = resolve(workspace, attachment.path);
    if (!isContainedPath(workspace, lexicalCandidate)) {
      throw invalidAttachment("Attachment paths may not leave the Koe workspace");
    }
    await rejectSymbolicPathComponents(workspace, lexicalCandidate, attachment.path);
    const candidate = await realpath(lexicalCandidate).catch(() => {
      throw invalidAttachment(`Attachment does not exist: ${safeLabel(attachment.path)}`);
    });
    if (!isContainedPath(workspace, candidate)) {
      throw invalidAttachment("Attachment paths may not leave the Koe workspace");
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const details = await stat(candidate);
    if (!details.isFile()) {
      throw invalidAttachment(`Attachment is not a regular file: ${safeLabel(attachment.path)}`);
    }
    if (details.size <= 0 || details.size > MAX_SLACK_ATTACHMENT_FILE_BYTES) {
      throw invalidAttachment(
        `Each attachment must be between 1 byte and ${MAX_SLACK_ATTACHMENT_FILE_BYTES} bytes`,
      );
    }
    const kind = EXTENSION_KINDS.get(extname(candidate).toLowerCase());
    if (kind === undefined) {
      throw invalidAttachment("Only supported image and audio files may be uploaded");
    }
    const parents = await captureParentIdentities(workspace, candidate, attachment.path);
    totalBytes += details.size;
    if (totalBytes > MAX_SLACK_ATTACHMENT_TOTAL_BYTES) {
      throw invalidAttachment(
        `Combined attachments may not exceed ${MAX_SLACK_ATTACHMENT_TOTAL_BYTES} bytes`,
      );
    }
    prepared.push({
      input: attachment,
      candidate,
      kind,
      size: details.size,
      dev: details.dev,
      ino: details.ino,
      parents,
    });
  }

  const release = await (options.budget ?? sharedAttachmentBudget).acquire(
    totalBytes,
    options.signal,
  );
  try {
    const resolved: RuntimeSlackAttachment[] = [];
    for (const attachment of prepared) {
      if (options.signal?.aborted === true) throw cancelledAttachment();
      const handle = await open(
        attachment.candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch(() => {
        throw invalidAttachment(
          `Attachment changed while it was validated: ${safeLabel(attachment.input.path)}`,
        );
      });
      try {
        await verifyOpenedPath(workspace, attachment);
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
          opened.dev !== attachment.dev ||
          opened.ino !== attachment.ino ||
          opened.size !== attachment.size
      ) {
        throw invalidAttachment(
            `Attachment changed while it was validated: ${safeLabel(attachment.input.path)}`,
        );
      }
        const bytes = await readExactFile(handle, opened.size, attachment.input.path);
      const afterRead = await handle.stat();
      if (
        afterRead.dev !== opened.dev ||
        afterRead.ino !== opened.ino ||
        afterRead.size !== opened.size ||
        afterRead.mtimeMs !== opened.mtimeMs ||
        afterRead.ctimeMs !== opened.ctimeMs
      ) {
        throw invalidAttachment(
            `Attachment changed while it was validated: ${safeLabel(attachment.input.path)}`,
        );
      }
        await verifyOpenedPath(workspace, attachment);
        if (!hasExpectedMediaMagic(bytes, extname(attachment.candidate).toLowerCase())) {
        throw invalidAttachment(
            `Attachment does not match its file type: ${safeLabel(attachment.input.path)}`,
        );
      }
      resolved.push({
        payload: new Blob([bytes]),
          name: basename(attachment.candidate),
          kind: attachment.kind,
          ...(attachment.input.title === undefined
            ? {}
            : { title: attachment.input.title }),
          ...(attachment.input.alt_text === undefined
            ? {}
            : { altText: attachment.input.alt_text }),
      });
      } finally {
        await handle.close();
      }
    }
    return await use(Object.freeze(resolved));
  } finally {
    release();
  }
}

async function rejectSymbolicPathComponents(
  workspace: string,
  candidate: string,
  requestedPath: string,
): Promise<void> {
  const pathFromRoot = relative(workspace, candidate);
  let current = workspace;
  for (const component of pathFromRoot.split(sep)) {
    current = resolve(current, component);
    const details = await lstat(current).catch(() => {
      throw invalidAttachment(`Attachment does not exist: ${safeLabel(requestedPath)}`);
    });
    if (details.isSymbolicLink()) {
      throw invalidAttachment("Attachment paths may not contain symbolic links");
    }
  }
}

async function captureParentIdentities(
  workspace: string,
  candidate: string,
  requestedPath: string,
): Promise<readonly AttachmentIdentity[]> {
  const paths: string[] = [];
  for (let current = dirname(candidate); ; current = dirname(current)) {
    paths.push(current);
    if (current === workspace) break;
    if (!isContainedPath(workspace, current)) {
      throw invalidAttachment("Attachment paths may not leave the Koe workspace");
    }
  }
  const identities: AttachmentIdentity[] = [];
  for (const path of paths) {
    const details = await stat(path).catch(() => {
      throw invalidAttachment(
        `Attachment changed while it was validated: ${safeLabel(requestedPath)}`,
      );
    });
    if (!details.isDirectory()) {
      throw invalidAttachment(
        `Attachment changed while it was validated: ${safeLabel(requestedPath)}`,
      );
    }
    identities.push({ path, dev: details.dev, ino: details.ino });
  }
  return identities;
}

async function verifyOpenedPath(
  workspace: string,
  attachment: PreparedAttachment,
): Promise<void> {
  const changed = () => invalidAttachment(
    `Attachment changed while it was validated: ${safeLabel(attachment.input.path)}`,
  );
  const canonical = await realpath(attachment.candidate).catch(() => {
    throw changed();
  });
  if (canonical !== attachment.candidate || !isContainedPath(workspace, canonical)) {
    throw changed();
  }
  for (const identity of attachment.parents) {
    const details = await stat(identity.path).catch(() => {
      throw changed();
    });
    if (!details.isDirectory() || details.dev !== identity.dev || details.ino !== identity.ino) {
      throw changed();
    }
  }
}

async function readExactFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  requestedPath: string,
): Promise<Buffer<ArrayBuffer>> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) {
      throw invalidAttachment(
        `Attachment changed while it was validated: ${safeLabel(requestedPath)}`,
      );
    }
    offset += result.bytesRead;
  }
  const probe = Buffer.alloc(1);
  if ((await handle.read(probe, 0, 1, size)).bytesRead !== 0) {
    throw invalidAttachment(
      `Attachment changed while it was validated: ${safeLabel(requestedPath)}`,
    );
  }
  return bytes;
}

function hasExpectedMediaMagic(contents: Uint8Array, extension: string): boolean {
  const bytes = contents.subarray(0, 16);
  switch (extension) {
      case ".png":
        return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      case ".jpg":
      case ".jpeg":
        return startsWith(bytes, [0xff, 0xd8, 0xff]);
      case ".gif":
        return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a");
      case ".webp":
        return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
      case ".mp3":
        return (
          asciiAt(bytes, 0, "ID3") ||
          (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
        );
      case ".m4a":
        return asciiAt(bytes, 4, "ftyp");
      case ".wav":
        return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
      case ".ogg":
        return asciiAt(bytes, 0, "OggS");
      case ".flac":
        return asciiAt(bytes, 0, "fLaC");
      case ".aac":
        return (
          asciiAt(bytes, 0, "ADIF") ||
          (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xf6) === 0xf0)
        );
    default:
      return false;
  }
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.byteLength < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith("../") &&
    !pathFromRoot.startsWith("..\\") &&
    !isAbsolute(pathFromRoot)
  );
}

function invalidAttachment(message: string): McpServiceError {
  return new McpServiceError("INVALID_ATTACHMENT", message);
}

function cancelledAttachment(): McpServiceError {
  return new McpServiceError("REQUEST_CANCELLED", "The MCP request was cancelled");
}

function safeLabel(value: string): string {
  return basename(value).slice(0, 128);
}
