import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeModelCatalog } from "../../../src/adapters/claude/model-catalog.js";

test("lists Claude model aliases with a single default and effort levels", async () => {
  const catalog = new ClaudeModelCatalog({ now: () => new Date("2026-01-02T03:04:05.000Z") });
  const snapshot = await catalog.list();
  assert.equal(snapshot.fetchedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ["default", "opus", "sonnet", "haiku"],
  );
  assert.deepEqual(
    snapshot.models.filter((model) => model.isDefault).map((model) => model.id),
    ["default"],
  );
  for (const model of snapshot.models) {
    assert.equal(model.model, model.id);
    assert.equal(model.hidden, false);
    assert.equal(model.defaultReasoningEffort, "high");
    assert.deepEqual(
      model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
      ["low", "medium", "high", "xhigh", "max"],
    );
    assert.deepEqual(model.inputModalities, ["text", "image"]);
  }
});
