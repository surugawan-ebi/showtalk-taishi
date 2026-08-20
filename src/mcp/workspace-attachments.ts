import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";

import { McpServiceError, type McpSlackAttachmentInput } from "./types.js";

export const MAX_SLACK_ATTACHMENT_FILES = 10;
export const MAX_SLACK_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SLACK_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

export interface RuntimeSlackAttachment {
  readonly path: string;
  readonly name: string;
  readonly size: number;
  readonly kind: "image" | "audio";
  readonly title?: string;
  readonly altText?: string;
}

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

export async function resolveWorkspaceAttachments(
  workspacePath: string,
  requested: readonly McpSlackAttachmentInput[],
): Promise<readonly RuntimeSlackAttachment[]> {
  if (requested.length > MAX_SLACK_ATTACHMENT_FILES) {
    throw invalidAttachment(`At most ${MAX_SLACK_ATTACHMENT_FILES} files may be uploaded`);
  }
  if (requested.length === 0) return [];

  const workspace = await realpath(workspacePath).catch(() => {
    throw invalidAttachment("The Koe workspace could not be resolved");
  });
  const resolved: RuntimeSlackAttachment[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const attachment of requested) {
    if (isAbsolute(attachment.path)) {
      throw invalidAttachment("Attachment paths must be relative to the Koe workspace");
    }
    const candidate = await realpath(resolve(workspace, attachment.path)).catch(() => {
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
    totalBytes += details.size;
    if (totalBytes > MAX_SLACK_ATTACHMENT_TOTAL_BYTES) {
      throw invalidAttachment(
        `Combined attachments may not exceed ${MAX_SLACK_ATTACHMENT_TOTAL_BYTES} bytes`,
      );
    }

    const kind = EXTENSION_KINDS.get(extname(candidate).toLowerCase());
    if (kind === undefined) {
      throw invalidAttachment("Only supported image and audio files may be uploaded");
    }
    if (!(await hasExpectedMediaMagic(candidate, extname(candidate).toLowerCase()))) {
      throw invalidAttachment(
        `Attachment does not match its file type: ${safeLabel(attachment.path)}`,
      );
    }
    resolved.push({
      path: candidate,
      name: basename(candidate),
      size: details.size,
      kind,
      ...(attachment.title === undefined ? {} : { title: attachment.title }),
      ...(attachment.alt_text === undefined ? {} : { altText: attachment.alt_text }),
    });
  }

  return resolved;
}

async function hasExpectedMediaMagic(path: string, extension: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    const bytes = header.subarray(0, bytesRead);
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
  } finally {
    await handle.close();
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

function safeLabel(value: string): string {
  return basename(value).slice(0, 128);
}
