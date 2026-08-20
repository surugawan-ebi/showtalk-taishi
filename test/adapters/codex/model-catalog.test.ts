import assert from "node:assert/strict";
import test from "node:test";

import { CodexModelCatalog } from "../../../src/adapters/codex/model-catalog.js";
import type {
  CodexModel,
  ModelListParams,
  ModelListResponse,
} from "../../../src/adapters/codex/protocol.js";

const visibleModel: CodexModel = {
  id: "model-visible",
  model: "model-visible",
  displayName: "Visible",
  description: "Visible model",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
  ],
  inputModalities: ["text", "image"],
};

test("paginates visible models and caches the catalog", async () => {
  const calls: ModelListParams[] = [];
  const pages: ModelListResponse[] = [
    {
      data: [visibleModel, { ...visibleModel, id: "hidden", model: "hidden", hidden: true }],
      nextCursor: "next",
    },
    {
      data: [{ ...visibleModel, id: "second", model: "second", isDefault: false }],
      nextCursor: null,
    },
  ];
  const catalog = new CodexModelCatalog(
    {
      listModels: async (params = {}) => {
        calls.push(params);
        return pages[calls.length - 1] ?? { data: [], nextCursor: null };
      },
    },
    { now: () => new Date("2026-08-15T00:00:00.000Z") },
  );

  const first = await catalog.list();
  const second = await catalog.list();

  assert.deepEqual(first.models.map((model) => model.model), ["model-visible", "second"]);
  assert.equal(first.fetchedAt, "2026-08-15T00:00:00.000Z");
  assert.strictEqual(second, first);
  assert.deepEqual(calls, [
    { includeHidden: false, limit: 100 },
    { cursor: "next", includeHidden: false, limit: 100 },
  ]);
});

test("refresh bypasses a warm model catalog cache", async () => {
  let calls = 0;
  const catalog = new CodexModelCatalog({
    listModels: async () => {
      calls += 1;
      return { data: [visibleModel], nextCursor: null };
    },
  });

  await catalog.list();
  await catalog.list({ refresh: true });

  assert.equal(calls, 2);
});

test("rejects a repeated pagination cursor", async () => {
  const catalog = new CodexModelCatalog({
    listModels: async () => ({ data: [], nextCursor: "same" }),
  });

  await assert.rejects(catalog.list(), /invalid model catalog cursor/u);
});

test("does not cache malformed model entries", async () => {
  let calls = 0;
  const catalog = new CodexModelCatalog({
    listModels: async () => {
      calls += 1;
      return calls === 1
        ? {
            data: [{ ...visibleModel, supportedReasoningEfforts: undefined } as never],
            nextCursor: null,
          }
        : { data: [visibleModel], nextCursor: null };
    },
  });

  await assert.rejects(catalog.list(), /invalid model catalog/u);
  const recovered = await catalog.list();

  assert.equal(calls, 2);
  assert.equal(recovered.models[0]?.model, "model-visible");
});
