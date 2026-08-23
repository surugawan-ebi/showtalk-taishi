import assert from "node:assert/strict";
import test from "node:test";

import { validateOrdinaryChoiceRequest } from "../../../src/adapters/codex/structured-input.js";

function request(autoResolutionMs: number | null) {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "item_1",
    questions: [
      {
        id: "terrain",
        header: "地形",
        question: "どれを作りますか？",
        isOther: false,
        isSecret: false,
        options: [
          { label: "砂漠", description: "乾いた地形" },
          { label: "岩場", description: "険しい地形" },
        ],
      },
    ],
    autoResolutionMs,
  };
}

test("accepts only the documented structured-input auto-resolution window", () => {
  assert.equal(validateOrdinaryChoiceRequest(request(null)).autoResolutionMs, undefined);
  assert.equal(
    validateOrdinaryChoiceRequest(request(60_000)).autoResolutionMs,
    60_000,
  );
  assert.equal(
    validateOrdinaryChoiceRequest(request(240_000)).autoResolutionMs,
    240_000,
  );
  for (const value of [1, 59_999, 240_001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => validateOrdinaryChoiceRequest(request(value)),
      /auto-resolution/u,
    );
  }
});
