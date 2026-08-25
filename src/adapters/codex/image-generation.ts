import type { AgentEvent } from "../../core/index.js";

export const MAX_CODEX_GENERATED_IMAGE_FILES = 10;
export const MAX_CODEX_GENERATED_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_CODEX_GENERATED_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

type GeneratedImageEvent = Extract<
  AgentEvent,
  { readonly type: "attachment.generated" }
>;
type GeneratedImageErrorEvent = Extract<AgentEvent, { readonly type: "error" }>;

interface DetectedImage {
  readonly mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly extension: "png" | "jpg" | "gif" | "webp";
}

/**
 * Converts only the authoritative App Server imageGeneration completion item.
 * Local paths are intentionally ignored: accepting a path from an Agent event
 * would turn Slack projection into an arbitrary local-file read primitive.
 */
export function normalizeCodexImageGenerationCompletion(
  item: Record<string, unknown>,
): GeneratedImageEvent | GeneratedImageErrorEvent | undefined {
  if (item.type !== "imageGeneration") return undefined;
  if (typeof item.id !== "string" || item.id.trim().length === 0) {
    return rejectedImage();
  }
  if (
    item.status === "failed" ||
    (item.failure !== null && item.failure !== undefined)
  ) {
    return {
      type: "error",
      code: "CODEX_IMAGE_GENERATION_FAILED",
      message: "Codexでの画像生成が完了しませんでした。",
    };
  }
  if (typeof item.result !== "string" || item.result.length === 0) {
    return rejectedImage();
  }

  try {
    const { bytes, declaredMimeType } = decodeImageResult(item.result);
    const detected = detectImage(bytes);
    if (detected === undefined) {
      throw new Error("unsupported generated image format");
    }
    if (
      declaredMimeType !== undefined &&
      normalizeMimeType(declaredMimeType) !== detected.mimeType
    ) {
      throw new Error("generated image MIME type does not match its bytes");
    }

    const safeId = item.id.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 64);
    return {
      type: "attachment.generated",
      attachmentId: item.id,
      attachment: {
        kind: "image",
        payload: new Blob([bytes], { type: detected.mimeType }),
        name: `codex-generated-${safeId}.${detected.extension}`,
        mimeType: detected.mimeType,
        title: "Codex生成画像",
        altText: "Codexで生成された画像",
      },
    };
  } catch {
    return rejectedImage();
  }
}

function decodeImageResult(result: string): {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly declaredMimeType?: string;
} {
  const dataUrl = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(
    result,
  );
  const encoded = dataUrl?.[2] ?? result;
  const firstPadding = encoded.indexOf("=");
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) ||
    encoded.length === 0 ||
    encoded.length % 4 === 1 ||
    (firstPadding >= 0 && firstPadding < encoded.length - 2) ||
    encoded.length > Math.ceil(MAX_CODEX_GENERATED_IMAGE_FILE_BYTES / 3) * 4 + 4
  ) {
    throw new Error("generated image base64 is invalid");
  }
  const padded = encoded.padEnd(
    encoded.length + (4 - encoded.length % 4) % 4,
    "=",
  );
  const buffer = Buffer.from(padded, "base64");
  if (
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_CODEX_GENERATED_IMAGE_FILE_BYTES
  ) {
    throw new Error("generated image payload size is invalid");
  }
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return {
    bytes,
    ...(dataUrl?.[1] === undefined ? {} : { declaredMimeType: dataUrl[1] }),
  };
}

function detectImage(bytes: Uint8Array): DetectedImage | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return undefined;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function normalizeMimeType(value: string): string {
  return value.toLowerCase() === "image/jpg" ? "image/jpeg" : value.toLowerCase();
}

function rejectedImage(): GeneratedImageErrorEvent {
  return {
    type: "error",
    code: "CODEX_GENERATED_IMAGE_REJECTED",
    message: "生成画像をSlackへ転送できませんでした（形式またはサイズが不正です）。",
  };
}
