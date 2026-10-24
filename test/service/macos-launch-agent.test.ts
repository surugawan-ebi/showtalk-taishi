import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getMacOSLaunchAgentStatus,
  installMacOSLaunchAgent,
  macOSLaunchAgentPaths,
  renderMacOSLaunchAgentPlist,
  startMacOSLaunchAgent,
  stopMacOSLaunchAgent,
  uninstallMacOSLaunchAgent,
  type LaunchctlResult,
  type MacOSLaunchAgentContext,
} from "../../src/service/macos-launch-agent.js";

test("renders a secret-free LaunchAgent with deterministic Node arguments", () => {
  const plist = renderMacOSLaunchAgentPlist({
    label: "dev.showtalk-taishi.gateway",
    nodePath: "/opt/node/bin/node",
    nodeArguments: ["--enable-source-maps"],
    cliEntrypoint: "/repo/dist/cli.js",
    configPath: "/repo/config & private.yaml",
    envFilePath: "/repo/.env",
    workingDirectory: "/repo",
    homeDirectory: "/Users/example",
    pathEnvironment: "/opt/bin:/usr/bin",
    stdoutPath: "/Users/example/Library/Logs/ShowTalkTaishi/gateway.log",
    stderrPath: "/Users/example/Library/Logs/ShowTalkTaishi/gateway.error.log",
  });

  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/u);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/u);
  assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>60<\/integer>/u);
  assert.match(plist, /--env-file=\/repo\/\.env/u);
  assert.match(plist, /config &amp; private\.yaml/u);
  assert.ok(plist.indexOf("--env-file=") < plist.indexOf("/repo/dist/cli.js"));
  assert.doesNotMatch(plist, /xoxb-|xapp-/u);
});

test("installs, reports, and uninstalls a private per-user LaunchAgent", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "taishi-launch-agent-"));
  const repository = join(homeDirectory, "repo");
  await mkdir(repository);
  const configPath = join(repository, "config.yaml");
  const envFilePath = join(repository, ".env");
  const cliEntrypoint = join(repository, "dist", "cli.js");
  await mkdir(join(repository, "dist"));
  await Promise.all([
    writePrivate(configPath, "version: 1\n"),
    writePrivate(envFilePath, "SLACK_BOT_TOKEN=not-a-real-token\n"),
    writeFile(cliEntrypoint, "// test entrypoint\n", "utf8"),
  ]);

  let loaded = false;
  const userId = process.getuid?.() ?? 501;
  const calls: string[][] = [];
  const runLaunchctl = async (arguments_: readonly string[]): Promise<LaunchctlResult> => {
    calls.push([...arguments_]);
    if (arguments_[0] === "print") {
      return loaded
        ? {
            code: 0,
            stdout: "\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n",
            stderr: "",
          }
        : { code: 113, stdout: "", stderr: "Could not find service" };
    }
    if (arguments_[0] === "bootstrap") loaded = true;
    if (arguments_[0] === "bootout") loaded = false;
    return { code: 0, stdout: "", stderr: "" };
  };
  const context: MacOSLaunchAgentContext = {
    platform: "darwin",
    homeDirectory,
    userId,
    nodePath: "/opt/node/bin/node",
    nodeArguments: [],
    cliEntrypoint,
    pathEnvironment: "/opt/bin:/usr/bin",
    runLaunchctl,
    wait: async () => undefined,
  };

  const installed = await installMacOSLaunchAgent(
    { configPath, envFilePath },
    context,
  );
  assert.equal(installed.loaded, true);
  assert.equal(installed.state, "running");
  assert.equal(installed.pid, 4242);
  const paths = macOSLaunchAgentPaths(homeDirectory);
  assert.equal((await stat(paths.plistPath)).mode & 0o777, 0o600);
  assert.match(await readFile(paths.plistPath, "utf8"), /--env-file=/u);
  assert.deepEqual(calls[1]?.slice(0, 2), ["bootstrap", `gui/${userId}`]);
  assert.equal((await stat(paths.stdoutPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.stderrPath)).mode & 0o777, 0o600);

  const reinstalled = await installMacOSLaunchAgent(
    { configPath, envFilePath },
    context,
  );
  assert.equal(reinstalled.loaded, true);
  assert.ok(calls.some((arguments_) => arguments_[0] === "bootout"));

  const status = await getMacOSLaunchAgentStatus(context);
  assert.equal(status.loaded, true);
  const removed = await uninstallMacOSLaunchAgent(context);
  assert.equal(removed.loaded, false);
  await assert.rejects(() => stat(paths.plistPath), { code: "ENOENT" });
});

test("rejects environment files that expose Slack secrets to other users", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "taishi-launch-agent-mode-"));
  const configPath = join(homeDirectory, "config.yaml");
  const envFilePath = join(homeDirectory, ".env");
  const cliEntrypoint = join(homeDirectory, "cli.js");
  await Promise.all([
    writePrivate(configPath, "version: 1\n"),
    writeFile(envFilePath, "SLACK_BOT_TOKEN=not-a-real-token\n", {
      mode: 0o644,
    }),
    writeFile(cliEntrypoint, "// test entrypoint\n", "utf8"),
  ]);
  // writeFile's creation mode is filtered by the process umask. Force the
  // insecure fixture mode so this test is deterministic under a 0077 umask.
  await chmod(envFilePath, 0o644);
  const context: MacOSLaunchAgentContext = {
    platform: "darwin",
    homeDirectory,
    userId: process.getuid?.() ?? 501,
    nodePath: "/usr/bin/node",
    nodeArguments: [],
    cliEntrypoint,
    pathEnvironment: "/usr/bin:/bin",
    runLaunchctl: async () => ({ code: 113, stdout: "", stderr: "" }),
    wait: async () => undefined,
  };
  await assert.rejects(
    () => installMacOSLaunchAgent({ configPath, envFilePath }, context),
    /must not be accessible by group or other users/,
  );
});

test("restores the previous plist and reports a failed rollback bootstrap", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "taishi-launch-rollback-"));
  const repository = join(homeDirectory, "repo");
  await mkdir(repository);
  const configPath = join(repository, "config.yaml");
  const envFilePath = join(repository, ".env");
  const cliEntrypoint = join(repository, "cli.js");
  await Promise.all([
    writePrivate(configPath, "version: 1\n"),
    writePrivate(envFilePath, "SLACK_BOT_TOKEN=fixture\n"),
    writeFile(cliEntrypoint, "// fixture\n", "utf8"),
  ]);
  let loaded = false;
  let failBootstrap = false;
  const context: MacOSLaunchAgentContext = {
    platform: "darwin",
    homeDirectory,
    userId: process.getuid?.() ?? 501,
    nodePath: "/usr/bin/node",
    nodeArguments: [],
    cliEntrypoint,
    pathEnvironment: "/usr/bin:/bin",
    runLaunchctl: async (arguments_) => {
      if (arguments_[0] === "print") {
        return loaded
          ? { code: 0, stdout: "\tstate = running\n", stderr: "" }
          : { code: 113, stdout: "", stderr: "not loaded" };
      }
      if (arguments_[0] === "bootout") {
        loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (arguments_[0] === "bootstrap") {
        if (failBootstrap) {
          return { code: 5, stdout: "", stderr: "bootstrap failed" };
        }
        loaded = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    wait: async () => undefined,
  };

  await installMacOSLaunchAgent({ configPath, envFilePath }, context);
  const plistPath = macOSLaunchAgentPaths(homeDirectory).plistPath;
  const previous = await readFile(plistPath, "utf8");
  failBootstrap = true;

  await assert.rejects(
    installMacOSLaunchAgent({ configPath, envFilePath }, context),
    (error) =>
      error instanceof AggregateError &&
      /rollback was incomplete/u.test(error.message) &&
      error.errors.length === 2,
  );
  assert.equal(await readFile(plistPath, "utf8"), previous);
});

test("stop is idempotent for a loaded clean job and sends no signal", async () => {
  const calls: string[][] = [];
  const context = launchAgentContext(async (arguments_) => {
    calls.push([...arguments_]);
    return {
      code: 0,
      stdout: "state = waiting\nlast exit code = 0\n",
      stderr: "",
    };
  });

  const status = await stopMacOSLaunchAgent(context);
  assert.equal(status.loaded, true);
  assert.equal(status.pid, undefined);
  assert.equal(status.lastExitCode, 0);
  assert.deepEqual(calls, [["print", `gui/${context.userId}/${status.label}`]]);
});

test("stop sends one SIGTERM and waits for a clean exit without unloading", async () => {
  const calls: string[][] = [];
  let running = true;
  const context = launchAgentContext(async (arguments_) => {
    calls.push([...arguments_]);
    if (arguments_[0] === "kill") {
      running = false;
      return { code: 0, stdout: "", stderr: "" };
    }
    return running
      ? { code: 0, stdout: "state = running\npid = 4242\nlast exit code = 0\n", stderr: "" }
      : { code: 0, stdout: "state = waiting\nlast exit code = 0\n", stderr: "" };
  });

  const status = await stopMacOSLaunchAgent(context);
  assert.equal(status.pid, undefined);
  assert.equal(status.lastExitCode, 0);
  assert.deepEqual(calls[1], ["kill", "SIGTERM", `gui/${context.userId}/${status.label}`]);
  assert.equal(calls.filter((call) => call[0] === "kill").length, 1);
  assert.equal(calls.some((call) => call[0] === "bootout" || call[0] === "disable"), false);
  assert.equal(calls.flat().some((argument) => argument.includes("--env-file") || argument === "--config"), false);
});

test("stop reports pending after the bound poll and never escalates or unloads", async () => {
  const calls: string[][] = [];
  const context = launchAgentContext(async (arguments_) => {
    calls.push([...arguments_]);
    return arguments_[0] === "kill"
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: "state = running\npid = 4242\nlast exit code = 0\n", stderr: "" };
  });

  await assert.rejects(() => stopMacOSLaunchAgent(context), /still pending/u);
  assert.equal(calls.filter((call) => call[0] === "kill").length, 1);
  assert.equal(calls.some((call) => call[0] === "bootout" || call[0] === "disable"), false);
});

test("strict stop and start status reads reject denied, missing, and unknown results", async () => {
  for (const code of [1, 113, null]) {
    const context = launchAgentContext(async () => ({
      code,
      stdout: "",
      stderr: code === 113 ? "Could not find service" : "permission denied",
    }));
    await assert.rejects(() => stopMacOSLaunchAgent(context));
    await assert.rejects(() => startMacOSLaunchAgent(context));
  }
});

test("start rejects running or unclean jobs and kickstarts only a clean loaded job", async () => {
  let calls: string[][] = [];
  const runningContext = launchAgentContext(async (arguments_) => {
    calls.push([...arguments_]);
    return { code: 0, stdout: "state = running\npid = 4242\nlast exit code = 0\n", stderr: "" };
  });
  await assert.rejects(() => startMacOSLaunchAgent(runningContext), /already running/u);
  assert.equal(calls.some((call) => call[0] === "kickstart"), false);

  calls = [];
  let started = false;
  const stoppedContext = launchAgentContext(async (arguments_) => {
    calls.push([...arguments_]);
    if (arguments_[0] === "kickstart") {
      started = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    return started
      ? { code: 0, stdout: "state = running\npid = 4343\nlast exit code = 0\n", stderr: "" }
      : { code: 0, stdout: "state = waiting\nlast exit code = 0\n", stderr: "" };
  });
  const result = await startMacOSLaunchAgent(stoppedContext);
  assert.equal(result.pid, 4343);
  assert.deepEqual(calls[1], ["kickstart", `gui/${stoppedContext.userId}/${result.label}`]);
  assert.equal(calls.some((call) => call[0] === "kickstart" && call.includes("-k")), false);
  assert.equal(calls.flat().some((argument) => argument.includes("--env-file") || argument === "--config"), false);

  const pendingContext = launchAgentContext(async () => ({
    code: 0,
    stdout: "state = waiting\n",
    stderr: "",
  }));
  await assert.rejects(() => startMacOSLaunchAgent(pendingContext), /not cleanly stopped/u);
});

test("start reports an unconfirmed kickstart when no process appears", async () => {
  const calls: string[][] = [];
  const context = launchAgentContext(async (arguments_) => {
    calls.push([...arguments_]);
    return { code: 0, stdout: "state = waiting\nlast exit code = 0\n", stderr: "" };
  });
  await assert.rejects(() => startMacOSLaunchAgent(context), /start was not confirmed/u);
  assert.equal(calls.filter((call) => call[0] === "kickstart").length, 1);
});

test("unknown or starting no-PID states are not a stopped service even with an old clean exit", async () => {
  for (const state of ["", "state = starting\n", "state = unknown\n"]) {
    const calls: string[][] = [];
    const context = launchAgentContext(async (args) => {
      calls.push([...args]);
      return { code: 0, stdout: `${state}last exit code = 0\n`, stderr: "" };
    });
    await assert.rejects(() => stopMacOSLaunchAgent(context), /pending or unclean/u);
    await assert.rejects(() => startMacOSLaunchAgent(context), /not cleanly stopped/u);
    assert.equal(calls.every((args) => args[0] === "print"), true);
  }
});

function launchAgentContext(
  runLaunchctl: MacOSLaunchAgentContext["runLaunchctl"],
): MacOSLaunchAgentContext {
  return {
    platform: "darwin",
    homeDirectory: "/Users/fixture",
    userId: 501,
    nodePath: "/usr/bin/node",
    nodeArguments: [],
    cliEntrypoint: "/fixture/cli.js",
    pathEnvironment: "/usr/bin:/bin",
    runLaunchctl,
    wait: async () => undefined,
  };
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
