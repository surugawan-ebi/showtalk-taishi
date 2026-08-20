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

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
