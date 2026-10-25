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

test("duplicate supervisor stop signals forward once and wait for the worker", async () => {
  const processRef = fakeProcess();
  const child = fakeChild();
  const signals: NodeJS.Signals[] = [];
  child.kill = ((signal: NodeJS.Signals = "SIGTERM") => {
    signals.push(signal);
    return true;
  }) as ChildProcess["kill"];
  let finished = false;
  const supervising = superviseGatewayWorker({ processRef, spawnWorker: () => child })
    .then(() => { finished = true; });
  processRef.emit("SIGTERM");
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  await Promise.resolve();
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(finished, false);
  assert.equal(processRef.listenerCount("SIGTERM"), 1);
  child.emit("exit", 0, null);
  await supervising;
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
});

test("stop suppresses a racing clean restart exit and requires explicit new supervision", async () => {
  const processRef = fakeProcess();
  let starts = 0;
  let restarts = 0;
  const first = fakeChild();
  first.kill = (() => true) as ChildProcess["kill"];
  const supervising = superviseGatewayWorker({
    processRef,
    onRestart: () => { restarts += 1; },
    spawnWorker: () => { starts += 1; return first; },
  });
  processRef.emit("SIGTERM");
  first.emit("exit", GATEWAY_RESTART_EXIT_CODE, null);
  await supervising;
  assert.equal(starts, 1);
  assert.equal(restarts, 0);
  await superviseGatewayWorker({ processRef, spawnWorker: () => {
    starts += 1;
    const resumed = fakeChild();
    queueMicrotask(() => resumed.emit("exit", 0, null));
    return resumed;
  } });
  assert.equal(starts, 2);
});

for (const failedExit of [{ code: 1, signal: null }, { code: null, signal: "SIGKILL" as const }]) {
  test(`unclean stop (${String(failedExit.code)}/${String(failedExit.signal)}) stays held without replacement or success`, async () => {
    const processRef = fakeProcess();
    const child = fakeChild();
    child.kill = (() => true) as ChildProcess["kill"];
    let starts = 0;
    let finished = false;
    let failure: Error | undefined;
    void superviseGatewayWorker({
      processRef,
      spawnWorker: () => { starts += 1; return child; },
      holdAfterStopFailure: (error) => {
        failure = error;
        return new Promise<never>(() => undefined);
      },
    }).then(() => { finished = true; });
    processRef.emit("SIGTERM");
    child.emit("exit", failedExit.code, failedExit.signal);
    await Promise.resolve();
    await Promise.resolve();
    assert.match(failure?.message ?? "", /Gateway stop failed/u);
    processRef.emit("SIGTERM");
    assert.equal(starts, 1);
    assert.equal(finished, false);
    assert.equal(processRef.listenerCount("SIGTERM"), 1);
  });
}
