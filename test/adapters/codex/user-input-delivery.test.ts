import assert from "node:assert/strict";
import test from "node:test";

import {
  UserInputDeliveryTracker,
  classifyUserInputDeliveryFailure,
} from "../../../src/adapters/codex/user-input-delivery.js";

test("classifies only fixed request_user_input failure signatures", () => {
  assert.equal(
    classifyUserInputDeliveryFailure(
      "failed to deserialize ToolRequestUserInputResponse: invalid type",
    ),
    "response_deserialize_failed",
  );
  assert.equal(
    classifyUserInputDeliveryFailure(
      "could not notify callback for 17: receiver dropped",
    ),
    "response_receiver_dropped",
  );
  assert.equal(
    classifyUserInputDeliveryFailure(
      "17 client responded with error for item/tool/requestUserInput",
    ),
    "client_error",
  );
  assert.equal(
    classifyUserInputDeliveryFailure("client responded with error for thread/read"),
    undefined,
  );
});

test("keeps a receipt through resolved and leaves id-less deserialize stderr unattributed", () => {
  const tracker = new UserInputDeliveryTracker<{ requestId: string }>();
  const receipt = { requestId: "opaque-request" };
  tracker.record(17, receipt);
  assert.equal(tracker.markServerResolved(17), receipt);
  assert.deepEqual(
    tracker.observeStderr("failed to deserialize ToolRequestUserInput"),
    [],
  );
  assert.deepEqual(
    tracker.observeStderr("Response: invalid type\n"),
    [{ reason: "response_deserialize_failed" }],
  );
  assert.equal(tracker.markServerResolved(17), receipt);
});

test("uses an explicit RPC id for receiver-drop correlation", () => {
  const tracker = new UserInputDeliveryTracker<string>();
  tracker.record(21, "first");
  tracker.record(22, "second");
  assert.deepEqual(
    tracker.observeStderr("could not notify callback for 22: receiver dropped\n"),
    [{ receipt: "second", reason: "response_receiver_dropped" }],
  );
  assert.equal(tracker.markServerResolved(21), "first");
  assert.equal(tracker.markServerResolved(22), undefined);
});

test("does not attribute unrelated stderr to the only outstanding receipt", () => {
  const tracker = new UserInputDeliveryTracker<string>();
  tracker.record("rpc-a", "receipt");
  assert.deepEqual(
    tracker.observeStderr("client responded with error for thread/read\n"),
    [],
  );
  assert.equal(tracker.markServerResolved("rpc-a"), "receipt");
});

test("does not attribute an explicitly different RPC id to a singleton receipt", () => {
  const tracker = new UserInputDeliveryTracker<string>();
  tracker.record(21, "receipt-21");
  assert.deepEqual(
    tracker.observeStderr(
      "requestId=22 failed to deserialize ToolRequestUserInputResponse\n",
    ),
    [{ reason: "response_deserialize_failed" }],
  );
  assert.equal(tracker.markServerResolved(21), "receipt-21");
});
