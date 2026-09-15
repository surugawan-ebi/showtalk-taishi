import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_SPOOL_BYTES = 1024 * 1024 * 1024;
const MAX_SPOOL_ENTRIES = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

type AttachmentKind = "image" | "audio";
type FetchFn = typeof fetch;

export interface SlackFileInfoClient {
  readonly files: {
    info(input: { readonly file: string }): Promise<unknown>;
  };
}

export interface StoredSlackAttachment {
  readonly kind: AttachmentKind;
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface IgnoredSlackAttachment {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly reason: "unsupported_mime";
}

export interface SlackFileTransportOptions {
  readonly botToken: string;
  readonly rootDirectory: string;
  readonly fetchFn?: FetchFn;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxSpoolBytes?: number;
}

export interface SlackFileDownloadRequest {
  readonly agentId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly fileIds: readonly string[];
  readonly client: SlackFileInfoClient;
}

export interface SlackFileDownloadResult {
  readonly attachments: readonly StoredSlackAttachment[];
  readonly ignored: readonly IgnoredSlackAttachment[];
}

interface ValidatedSlackFile {
  readonly id: string;
  readonly originalName: string;
  readonly safeName: string;
  readonly mimeType: string;
  readonly size: number;
  readonly url: URL;
  readonly kind: AttachmentKind | undefined;
}

/** Downloads bounded Slack image/audio attachments into a private local spool. */
export class SlackFileTransport {
  readonly #botToken: string;
  readonly #rootDirectory: string;
  readonly #fetch: FetchFn;
  readonly #maxFiles: number;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxSpoolBytes: number;
  readonly #downloadTailsByAgent = new Map<string, Promise<void>>();

  constructor(options: SlackFileTransportOptions) {
    if (!/^xoxb-[A-Za-z0-9-]+$/u.test(options.botToken)) {
      throw new TypeError("Slack bot token is invalid");
    }
    if (options.rootDirectory.trim().length === 0) {
      throw new TypeError("Slack file spool root directory is required");
    }

    this.#botToken = options.botToken;
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#fetch = options.fetchFn ?? fetch;
    this.#maxFiles = positiveInteger(
      options.maxFiles ?? DEFAULT_MAX_FILES,
      "maxFiles",
    );
    this.#maxFileBytes = positiveInteger(
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "maxFileBytes",
    );
    this.#maxTotalBytes = positiveInteger(
      options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      "maxTotalBytes",
    );
    this.#maxSpoolBytes = positiveInteger(
      options.maxSpoolBytes ?? DEFAULT_MAX_SPOOL_BYTES,
      "maxSpoolBytes",
    );
  }

  download(
    request: SlackFileDownloadRequest,
  ): Promise<SlackFileDownloadResult> {
    const previous = this.#downloadTailsByAgent.get(request.agentId) ?? Promise.resolve();
    const operation = previous.then(() => this.#download(request));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#downloadTailsByAgent.set(request.agentId, tail);
    void tail.then(() => {
      if (this.#downloadTailsByAgent.get(request.agentId) === tail) {
        this.#downloadTailsByAgent.delete(request.agentId);
      }
    });
    return operation;
  }

  async #download(
    request: SlackFileDownloadRequest,
  ): Promise<SlackFileDownloadResult> {
    validateRoutingValue(request.agentId, "Agent ID");
    validateRoutingValue(request.channelId, "Slack channel ID");
    validateRoutingValue(request.messageTs, "Slack message timestamp");

    const fileIds = uniqueFileIds(request.fileIds);
    if (fileIds.length > this.#maxFiles) {
      throw new Error(`Slack message contains more than ${this.#maxFiles} files`);
    }

    const files: ValidatedSlackFile[] = [];
    const ignored: IgnoredSlackAttachment[] = [];
    let declaredTotal = 0;

    for (const fileId of fileIds) {
      const file = await this.#loadFileInfo(request.client, fileId);
      if (file.kind === undefined) {
        ignored.push({
          fileId: file.id,
          name: file.safeName,
          mimeType: file.mimeType,
          reason: "unsupported_mime",
        });
        continue;
      }
      if (file.size > this.#maxFileBytes) {
        throw new Error(`Slack file ${file.id} exceeds the per-file size limit`);
      }
      declaredTotal += file.size;
      if (declaredTotal > this.#maxTotalBytes) {
        throw new Error("Slack attachments exceed the total size limit");
      }
      files.push(file);
    }

    if (files.length === 0) return { attachments: [], ignored };

    const destination = await this.#destinationDirectory(request, declaredTotal);
    const attachments: StoredSlackAttachment[] = [];
    const createdPaths: string[] = [];
    let actualTotal = 0;

    try {
      for (const file of files) {
        const kind = file.kind;
        if (kind === undefined) {
          throw new Error(`Slack file ${file.id} has no supported attachment kind`);
        }
        const bytes = await this.#downloadFile(file);
        actualTotal += bytes.byteLength;
        if (actualTotal > this.#maxTotalBytes) {
          throw new Error("Slack attachments exceed the total size limit");
        }
        if (!hasExpectedMagic(file.mimeType, bytes)) {
          throw new Error(`Slack file ${file.id} does not match its declared MIME type`);
        }

        const path = await atomicPrivateWrite(destination, file.id, file.safeName, bytes);
        createdPaths.push(path);
        attachments.push({
          kind,
          path,
          name: file.safeName,
          mimeType: file.mimeType,
          size: bytes.byteLength,
        });
      }
      return { attachments, ignored };
    } catch (error) {
      await Promise.allSettled(createdPaths.map((path) => unlink(path)));
      throw error;
    }
  }

  async #loadFileInfo(
    client: SlackFileInfoClient,
    fileId: string,
  ): Promise<ValidatedSlackFile> {
    let response: unknown;
    try {
      response = await client.files.info({ file: fileId });
    } catch {
      throw new Error(`Slack files.info failed for file ${fileId}`);
    }

    const envelope = asRecord(response);
    const file = asRecord(envelope?.file);
    if (envelope?.ok !== true || file === undefined) {
      throw new Error(`Slack files.info returned malformed data for file ${fileId}`);
    }
    if (file.id !== fileId) {
      throw new Error(`Slack files.info returned the wrong file for ${fileId}`);
    }

    const originalName = boundedString(file.name, 1_024);
    const mimeType = normalizedMimeType(file.mimetype);
    const size = nonNegativeInteger(file.size);
    if (originalName === undefined || mimeType === undefined || size === undefined) {
      throw new Error(`Slack files.info returned malformed data for file ${fileId}`);
    }

    const rawUrl = file.url_private_download ?? file.url_private;
    if (typeof rawUrl !== "string") {
      throw new Error(`Slack files.info did not provide a download URL for file ${fileId}`);
    }

    return {
      id: fileId,
      originalName,
      safeName: ensureMediaExtension(safeFileName(originalName), mimeType),
      mimeType,
      size,
      url: validatedSlackUrl(rawUrl, fileId),
      kind: attachmentKind(mimeType),
    };
  }

  async #destinationDirectory(
    request: Pick<SlackFileDownloadRequest, "agentId" | "channelId" | "messageTs">,
    incomingBytes: number,
  ): Promise<string> {
    await ensurePrivateDirectory(this.#rootDirectory);
    const agentDirectory = join(this.#rootDirectory, sha256(request.agentId));
    await ensurePrivateDirectory(agentDirectory);
    const usage = await privateDirectoryUsage(agentDirectory);
    if (usage.bytes + incomingBytes > this.#maxSpoolBytes) {
      throw new Error("Slack attachment spool quota would be exceeded");
    }
    const incomingDirectory = join(agentDirectory, "incoming");
    await ensurePrivateDirectory(incomingDirectory);
    const messageDirectory = join(
      incomingDirectory,
      sha256(`${request.channelId}${request.messageTs}`),
    );
    await ensurePrivateDirectory(messageDirectory);
    return messageDirectory;
  }

  async #downloadFile(file: ValidatedSlackFile): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    timeout.unref();

    let response: Response;
    try {
      response = await this.#fetch(file.url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.#botToken}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new Error(`Slack file download timed out for file ${file.id}`);
      }
      throw new Error(`Slack file download failed for file ${file.id}`);
    }

    try {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Slack file authorization failed for file ${file.id}`);
      }
      if (!response.ok) {
        throw new Error(`Slack file download failed for file ${file.id}`);
      }

      const contentLength = parseContentLength(response.headers.get("content-length"), file.id);
      if (contentLength !== undefined) {
        if (contentLength > this.#maxFileBytes) {
          throw new Error(`Slack file ${file.id} exceeds the per-file size limit`);
        }
        if (contentLength !== file.size) {
          throw new Error(`Slack file ${file.id} has inconsistent size metadata`);
        }
      }

      let bytes: Buffer;
      try {
        bytes = await readBoundedBody(response, file.size, this.#maxFileBytes, file.id);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Slack file download timed out for file ${file.id}`);
        }
        if (isPublicTransportError(error)) throw error;
        throw new Error(`Slack file download failed for file ${file.id}`);
      }
      if (bytes.byteLength !== file.size) {
        throw new Error(`Slack file ${file.id} has inconsistent size metadata`);
      }
      return bytes;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function privateDirectoryUsage(root: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_SPOOL_ENTRIES) {
        throw new Error("Slack attachment spool contains too many entries");
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
      }
    }
  }
  return { bytes, entries };
}

const MIME_KINDS = new Map<string, AttachmentKind>([
  ["image/png", "image"],
  ["image/jpeg", "image"],
  ["image/gif", "image"],
  ["image/webp", "image"],
  ["audio/mpeg", "audio"],
  ["audio/mp3", "audio"],
  ["audio/m4a", "audio"],
  ["audio/x-m4a", "audio"],
  ["audio/mp4", "audio"],
  ["audio/wav", "audio"],
  ["audio/wave", "audio"],
  ["audio/x-wav", "audio"],
  ["audio/ogg", "audio"],
  ["application/ogg", "audio"],
  ["audio/flac", "audio"],
  ["audio/x-flac", "audio"],
  ["audio/aac", "audio"],
  ["audio/x-aac", "audio"],
]);

function attachmentKind(mimeType: string): AttachmentKind | undefined {
  return MIME_KINDS.get(mimeType);
}

function uniqueFileIds(values: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!/^F[A-Z0-9]{1,63}$/u.test(value)) {
      throw new Error("Slack file ID is invalid");
    }
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function validatedSlackUrl(value: string, fileId: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Slack file download URL is invalid for file ${fileId}`);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "files.slack.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(`Slack file download URL is not allowed for file ${fileId}`);
  }
  return url;
}

async function readBoundedBody(
  response: Response,
  declaredSize: number,
  maxBytes: number,
  fileId: string,
): Promise<Buffer> {
  if (response.body === null) {
    throw new Error(`Slack file download returned no body for file ${fileId}`);
  }

  const output = Buffer.allocUnsafe(declaredSize);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (offset + chunk.value.byteLength > maxBytes) {
        throw new Error(`Slack file ${fileId} exceeds the per-file size limit`);
      }
      if (offset + chunk.value.byteLength > declaredSize) {
        throw new Error(`Slack file ${fileId} has inconsistent size metadata`);
      }
      output.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return output.subarray(0, offset);
}

function parseContentLength(value: string | null, fileId: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`Slack file ${fileId} has an invalid Content-Length`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Slack file ${fileId} has an invalid Content-Length`);
  }
  return parsed;
}

function hasExpectedMagic(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a");
    case "image/webp":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP");
    case "audio/mpeg":
    case "audio/mp3":
      return (
        asciiAt(bytes, 0, "ID3") ||
        (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
      );
    case "audio/m4a":
    case "audio/x-m4a":
    case "audio/mp4":
      return asciiAt(bytes, 4, "ftyp");
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE");
    case "audio/ogg":
    case "application/ogg":
      return asciiAt(bytes, 0, "OggS");
    case "audio/flac":
    case "audio/x-flac":
      return asciiAt(bytes, 0, "fLaC");
    case "audio/aac":
    case "audio/x-aac":
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

async function atomicPrivateWrite(
  directory: string,
  fileId: string,
  safeName: string,
  bytes: Uint8Array,
): Promise<string> {
  const stem = `${sha256(fileId).slice(0, 16)}-${randomUUID()}`;
  const finalPath = join(directory, `${stem}-${safeName}`);
  const temporaryPath = join(directory, `.${stem}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, finalPath);
    await chmod(finalPath, 0o600);
    return finalPath;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Slack file spool path is not a private directory");
  }
  await chmod(path, 0o700);
}

function safeFileName(value: string): string {
  let name = basename(value.replaceAll("\\", "/"))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[:*?"<>|]/gu, "_")
    .trim();
  if (name === "" || name === "." || name === "..") name = "attachment";
  if (name.startsWith(".")) name = `_${name.slice(1) || "attachment"}`;
  return Array.from(name).slice(0, 180).join("");
}

function ensureMediaExtension(name: string, mimeType: string): string {
  const canonical = CANONICAL_EXTENSIONS.get(mimeType);
  if (canonical === undefined) return name;
  const current = extname(name).toLowerCase();
  if (current === canonical || (canonical === ".jpg" && current === ".jpeg")) {
    return name;
  }
  const stem = current.length === 0 ? name : name.slice(0, -current.length);
  return `${Array.from(stem).slice(0, 170).join("") || "attachment"}${canonical}`;
}

const CANONICAL_EXTENSIONS = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp3", ".mp3"],
  ["audio/m4a", ".m4a"],
  ["audio/x-m4a", ".m4a"],
  ["audio/mp4", ".m4a"],
  ["audio/wav", ".wav"],
  ["audio/wave", ".wav"],
  ["audio/x-wav", ".wav"],
  ["audio/ogg", ".ogg"],
  ["application/ogg", ".ogg"],
  ["audio/flac", ".flac"],
  ["audio/x-flac", ".flac"],
  ["audio/aac", ".aac"],
  ["audio/x-aac", ".aac"],
]);

function normalizedMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function validateRoutingValue(value: string, label: string): void {
  if (value.length === 0 || value.length > 256 || value.includes("\u0000")) {
    throw new Error(`${label} is invalid`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPublicTransportError(error: unknown): error is Error {
  return error instanceof Error && /^Slack file /u.test(error.message);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
