import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { ChildProcess } from "node:child_process";

import {
  GATEWAY_RESTART_EXIT_CODE,
  isGatewayWorker,
  superviseGatewayWorker,
} from "../src/supervisor.js";

function fakeChild(onKill?: (signal: NodeJS.Signals) => void): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  Object.defineProperties(emitter, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true },
  });
  emitter.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
    onKill?.(signal);
    queueMicrotask(() => emitter.emit("exit", 0, null));
    return true;
  }) as ChildProcess["kill"];
  return emitter;
}

function fakeProcess(): NodeJS.Process {
  const emitter = new EventEmitter() as NodeJS.Process;
  emitter.execPath = "/usr/bin/node";
  emitter.execArgv = [];
  emitter.argv = ["/usr/bin/node", "/workspace/dist/cli.js", "start"];
  emitter.env = {};
  return emitter;
}

test("replaces only workers that request the reserved restart exit code", async () => {
  const processRef = fakeProcess();
  let starts = 0;
  let restarts = 0;

  await superviseGatewayWorker({
    processRef,
    onRestart: () => {
      restarts += 1;
    },
    spawnWorker: () => {
      const child = fakeChild();
      starts += 1;
      queueMicrotask(() =>
        child.emit(
          "exit",
          starts === 1 ? GATEWAY_RESTART_EXIT_CODE : 0,
          null,
        ),
      );
      return child;
    },
  });

  assert.equal(starts, 2);
  assert.equal(restarts, 1);
});

test("forwards supervisor shutdown to the current worker without restarting", async () => {
  const processRef = fakeProcess();
  const signals: NodeJS.Signals[] = [];
  let starts = 0;
  const supervising = superviseGatewayWorker({
    processRef,
    spawnWorker: () => {
      starts += 1;
      return fakeChild((signal) => signals.push(signal));
    },
  });

  queueMicrotask(() => processRef.emit("SIGTERM"));
  await supervising;

  assert.equal(starts, 1);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("recognizes only the explicit internal worker marker", () => {
  assert.equal(isGatewayWorker({ SHOWTALK_TAISHI_GATEWAY_WORKER: "1" }), true);
  assert.equal(isGatewayWorker({ SHOWTALK_TAISHI_GATEWAY_WORKER: "0" }), false);
  assert.equal(isGatewayWorker({}), false);
});
