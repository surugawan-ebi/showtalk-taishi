import assert from "node:assert/strict";
import test from "node:test";

import { parseCliArguments } from "../src/cli-args.js";

test("parses a complete bind invocation", () => {
  assert.deepEqual(
    parseCliArguments(
      [
        "bind",
        "--channel",
        "C1",
        "--codex-thread",
        "thread-1",
        "--replace",
        "--config",
        "custom.yaml",
      ],
      {},
    ),
    {
      command: "bind",
      configPath: "custom.yaml",
      help: false,
      offline: false,
      replace: true,
      channelId: "C1",
      codexThreadId: "thread-1",
      serviceAction: undefined,
      envFilePath: undefined,
    },
  );
});

test("bind help does not require mutation arguments", () => {
  const parsed = parseCliArguments(["bind", "--help"], {});
  assert.equal(parsed.command, "bind");
  assert.equal(parsed.help, true);
});

test("rejects missing, unknown, and duplicate options", () => {
  assert.throws(
    () =>
      parseCliArguments(
        ["bind", "--channel", "C1", "--codex-thread", "thread-1", "--config"],
        {},
      ),
    /Missing value for option: --config/,
  );
  assert.throws(
    () =>
      parseCliArguments(
        ["bind", "--channel", "C1", "--codex-thread", "thread-1", "--confg"],
        {},
      ),
    /Unknown option for bind: --confg/,
  );
  assert.throws(
    () =>
      parseCliArguments(
        [
          "bind",
          "--channel",
          "C1",
          "--channel",
          "C2",
          "--codex-thread",
          "thread-1",
        ],
        {},
      ),
    /Duplicate option: --channel/,
  );
});

test("rejects missing required bind coordinates", () => {
  assert.throws(() => parseCliArguments(["bind"], {}), /--channel/);
  assert.throws(
    () => parseCliArguments(["bind", "--channel", "C1"], {}),
    /--codex-thread/,
  );
});

test("parses macOS service lifecycle commands strictly", () => {
  assert.deepEqual(
    parseCliArguments(
      [
        "service",
        "install",
        "--config",
        "private/config.yaml",
        "--env-file",
        "private/runtime.env",
      ],
      {},
    ),
    {
      command: "service",
      configPath: "private/config.yaml",
      help: false,
      offline: false,
      replace: false,
      channelId: undefined,
      codexThreadId: undefined,
      serviceAction: "install",
      envFilePath: "private/runtime.env",
    },
  );
  assert.equal(
    parseCliArguments(["service", "status"], {}).serviceAction,
    "status",
  );
  assert.equal(parseCliArguments(["service"], {}).help, true);
  assert.throws(
    () => parseCliArguments(["service", "restart"], {}),
    /Unknown service action/,
  );
  assert.throws(
    () => parseCliArguments(["service", "status", "--config", "x.yaml"], {}),
    /available only for service install/,
  );
});
