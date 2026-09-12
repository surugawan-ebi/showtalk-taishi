import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CODEX_GENERATED_IMAGE_FILES,
  MAX_CODEX_GENERATED_IMAGE_TOTAL_BYTES,
  normalizeCodexDynamicToolImageCompletions,
  normalizeCodexImageGenerationCompletion,
} from "../../../src/adapters/codex/image-generation.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

test("allows up to 30 generated images and 150 MiB per turn", () => {
  assert.equal(MAX_CODEX_GENERATED_IMAGE_FILES, 30);
  assert.equal(MAX_CODEX_GENERATED_IMAGE_TOTAL_BYTES, 150 * 1024 * 1024);
});

test("normalizes an App Server imageGeneration result without reading savedPath", async () => {
  const event = normalizeCodexImageGenerationCompletion({
    type: "imageGeneration",
    id: "image/item-1",
    status: "completed",
    revisedPrompt: "private prompt text",
    result: ONE_PIXEL_PNG_BASE64,
    savedPath: "/private/secret/generated.png",
    failure: null,
  });

  assert.equal(event?.type, "attachment.generated");
  if (event?.type !== "attachment.generated") return;
  assert.equal(event.attachmentId, "image/item-1");
  assert.equal(event.attachment.name, "codex-generated-image-item-1.png");
  assert.equal(event.attachment.mimeType, "image/png");
  assert.equal(event.attachment.payload.type, "image/png");
  assert.ok(event.attachment.payload.size > 8);
  assert.doesNotMatch(JSON.stringify({
    name: event.attachment.name,
    title: event.attachment.title,
    altText: event.attachment.altText,
  }), /private|secret|prompt/u);
});

test("accepts a matching image data URL", () => {
  const event = normalizeCodexImageGenerationCompletion({
    type: "imageGeneration",
    id: "image-2",
    status: "completed",
    result: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
    failure: null,
  });

  assert.equal(event?.type, "attachment.generated");
});

test("rejects paths, malformed payloads, and mismatched MIME types", () => {
  for (const result of [
    "/private/tmp/generated.png",
    "not base64!",
    `data:image/jpeg;base64,${ONE_PIXEL_PNG_BASE64}`,
  ]) {
    const event = normalizeCodexImageGenerationCompletion({
      type: "imageGeneration",
      id: "image-invalid",
      status: "completed",
      result,
      failure: null,
    });
    assert.deepEqual(event, {
      type: "error",
      code: "CODEX_GENERATED_IMAGE_REJECTED",
      message: "生成画像をSlackへ転送できませんでした（形式またはサイズが不正です）。",
    });
  }
});

test("reports an image generation failure without exposing protocol details", () => {
  const event = normalizeCodexImageGenerationCompletion({
    type: "imageGeneration",
    id: "image-failed",
    status: "failed",
    result: "upstream secret",
    failure: { message: "sensitive provider details" },
  });

  assert.deepEqual(event, {
    type: "error",
    code: "CODEX_IMAGE_GENERATION_FAILED",
    message: "Codexでの画像生成が完了しませんでした。",
  });
});

test("normalizes inline dynamic-tool images without accepting paths or remote URLs", () => {
  const events = normalizeCodexDynamicToolImageCompletions({
    type: "dynamicToolCall",
    id: "browser/screenshot-1",
    status: "completed",
    contentItems: [
      { type: "inputText", text: "private tool output" },
      { type: "inputImage", imageUrl: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}` },
      { type: "inputImage", imageUrl: "https://private.example/screenshot.png" },
      { type: "inputImage", imageUrl: "/private/tmp/screenshot.png" },
    ],
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "attachment.generated");
  if (events[0]?.type !== "attachment.generated") return;
  assert.equal(events[0].attachmentId, "browser/screenshot-1:image:1");
  assert.equal(events[0].attachment.name, "codex-tool-image-browser-screenshot-1-2.png");
  assert.equal(events[0].attachment.mimeType, "image/png");
  assert.doesNotMatch(JSON.stringify({
    name: events[0].attachment.name,
    title: events[0].attachment.title,
    altText: events[0].attachment.altText,
  }), /private\.example|private\/tmp|tool output/u);
});

test("rejects a malformed inline dynamic-tool image", () => {
  assert.deepEqual(normalizeCodexDynamicToolImageCompletions({
    type: "dynamicToolCall",
    id: "browser-image",
    contentItems: [
      { type: "inputImage", imageUrl: `data:image/jpeg;base64,${ONE_PIXEL_PNG_BASE64}` },
    ],
  }), [{
    type: "error",
    code: "CODEX_GENERATED_IMAGE_REJECTED",
    message: "生成画像をSlackへ転送できませんでした（形式またはサイズが不正です）。",
  }]);
});
