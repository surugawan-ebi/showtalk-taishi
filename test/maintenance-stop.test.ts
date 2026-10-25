import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { createGatewayStopController, runGatewayWorkerLifecycle } from "../src/gateway-worker.js";
import { superviseGatewayWorker } from "../src/supervisor.js";
import { startMacOSLaunchAgent, stopMacOSLaunchAgent } from "../src/service/macos-launch-agent.js";

test("service stop drains the fixture worker, holds the stopped job, and resumes only explicitly", async () => {
  const processRef = new EventEmitter() as NodeJS.Process;
  const child = new EventEmitter() as ChildProcess;
  let accepting = true;
  let active = true;
  let shutdowns = 0;
  let pid: number | undefined = 4242;
  let supervisorFinished = false;
  let releaseWork!: () => void;
  const idle = new Promise<void>((resolve) => { releaseWork = () => { active = false; resolve(); }; });
  const controller = createGatewayStopController(() => { accepting = false; });
  child.kill = (() => { controller.requestStop(); return true; }) as ChildProcess["kill"];
  Object.defineProperties(child, { exitCode: { value: null, writable: true }, signalCode: { value: null } });
  let starts = 0;
  const supervising = superviseGatewayWorker({ processRef, spawnWorker: () => { starts += 1; return child; } })
    .then(() => { supervisorFinished = true; pid = undefined; });
  const worker = runGatewayWorkerLifecycle(
    { beginRestart: () => { accepting = false; }, waitForIdle: () => idle,
      idleComponents: () => ({ gateway: !active, slack: true, mcpService: true, mcpServer: true }) },
    async () => undefined, async () => undefined,
    async () => { if (shutdowns === 0) shutdowns += 1; }, async () => undefined,
    controller.stopRequested, new Promise<void>(() => undefined),
  ).then((code) => { child.emit("exit", code, null); return code; });
  const calls: string[][] = [];
  const context = {
    platform: "darwin" as const, homeDirectory: "/fixture/home", userId: 501,
    nodePath: "/fixture/node", nodeArguments: [], cliEntrypoint: "/fixture/dist/cli.js",
    pathEnvironment: "/fixture/bin",
    runLaunchctl: async (args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "kill") { processRef.emit("SIGTERM"); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "kickstart") { pid = 4343; return { code: 0, stdout: "", stderr: "" }; }
      return { code: 0, stdout: pid === undefined ? "state = waiting\nlast exit code = 0\n" : `state = running\npid = ${pid}\nlast exit code = 0\n`, stderr: "" };
    },
    wait: async () => {
      assert.equal(accepting, false);
      assert.equal(shutdowns, 0);
      assert.equal(supervisorFinished, false);
      assert.equal(active, true);
      processRef.emit("SIGTERM"); // duplicate stop cannot force accepted work
      releaseWork();
      await worker;
      await supervising;
    },
  };
  const stopped = await stopMacOSLaunchAgent(context);
  assert.equal(stopped.pid, undefined);
  assert.equal(shutdowns, 1);
  assert.equal(starts, 1);
  assert.equal(await worker, 0);
  await Promise.resolve();
  assert.equal(pid, undefined);
  assert.equal(calls.some((args) => args[0] === "kickstart"), false);
  const resumed = await startMacOSLaunchAgent(context);
  assert.equal(resumed.pid, 4343);
  assert.deepEqual(calls.filter((args) => args[0] === "kickstart"), [["kickstart", "gui/501/dev.showtalk-taishi.gateway"]]);
  assert.equal(calls.some((args) => args.includes("-k") || args[0] === "bootout" || args[0] === "bootstrap"), false);
});
