#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";

import { CodexAppServerClient } from "./adapters/codex/app-server-client.js";
import {
  parseCliArguments,
  type CliCommand,
  type ServiceAction,
} from "./cli-args.js";
import { bindCodexThread } from "./commands/bind.js";
import { loadConfig } from "./config/loader.js";
import { initializeConfig } from "./config/init.js";
import {
  adminUiUrlForLog,
  runGatewayWorker,
} from "./gateway-worker.js";
import {
  createCodexProbeEnvironment,
  validateConfiguredAdapterSession,
  validateRuntimePrerequisites,
} from "./runtime.js";
import { validateSlackWorkspace } from "./slack/doctor.js";
import {
  getMacOSLaunchAgentStatus,
  installMacOSLaunchAgent,
  uninstallMacOSLaunchAgent,
  type MacOSLaunchAgentStatus,
} from "./service/macos-launch-agent.js";
import { isGatewayWorker, superviseGatewayWorker } from "./supervisor.js";
import { inspectWorkspaceGitManualConfiguration } from
  "./approvals/workspace-git-manual-worker-transport.js";

export { adminUiUrlForLog } from "./gateway-worker.js";

try {
  const invocation = parseCliArguments(process.argv.slice(2));
  if (invocation.help) {
    printHelp(invocation.command);
  } else switch (invocation.command) {
    case "init":
      await init(invocation.configPath);
      break;
    case "doctor":
      await doctor(invocation.configPath, invocation.offline);
      break;
    case "bind":
      await bind(
        invocation.configPath,
        requireParsedValue(invocation.channelId, "--channel"),
        requireParsedValue(invocation.codexThreadId, "--codex-thread"),
        invocation.replace,
      );
      break;
    case "start":
      if (isGatewayWorker()) {
        process.exitCode = await runGatewayWorker(invocation.configPath);
      } else {
        await superviseGatewayWorker({
          onRestart: () => {
            console.log(
              "ShowTalk Taishi Gateway worker stopped cleanly; starting its replacement.",
            );
          },
        });
      }
      break;
    case "service":
      await service(
        requireParsedValue(invocation.serviceAction, "service action"),
        invocation.configPath,
        invocation.envFilePath,
      );
      break;
    case "help":
      printHelp();
      break;
  }
} catch (error) {
  console.error(`taishi: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function init(path: string): Promise<void> {
  const created = await initializeConfig(path);
  console.log(`Created ShowTalk Taishi config: ${created}`);
  console.log("Set the referenced environment variables, then run: taishi doctor");
}

async function doctor(path: string, offline: boolean): Promise<void> {
  const config = await loadConfig(path);
  const checks = [...(await validateRuntimePrerequisites(config))];
  const workspaceGit = await inspectWorkspaceGitManualConfiguration(process.env);
  if (workspaceGit.status === "invalid") {
    throw new Error(`workspace-git: ${workspaceGit.message}`);
  }
  console.log(`workspace-git: ${workspaceGit.message}`);
  if (workspaceGit.status === "configured") {
    checks.push("workspace-git:manual-configuration-metadata");
  }
  for (const [name, adapter] of Object.entries(config.adapters)) {
    let client: CodexAppServerClient | undefined;
    try {
      client = await CodexAppServerClient.spawn({
        command: adapter.command,
        env: createCodexProbeEnvironment(
          config,
          process.env,
          adapter.env_passthrough,
        ),
        requestTimeoutMs: 10_000,
      });
      checks.push(`adapter:${name}:app-server-protocol`);
      for (const [agentId, agent] of Object.entries(config.agents)) {
        if (
          agent.adapter !== name ||
          agent.adapter_session_id === undefined
        ) {
          continue;
        }
        await validateConfiguredAdapterSession(
          client,
          agentId,
          agent.adapter_session_id,
        );
        checks.push(`agent:${agentId}:configured-session`);
      }
    } catch (error) {
      if (client === undefined) {
        throw new Error(`Codex App Server is unavailable for adapter ${name}`);
      }
      throw new Error(
        `Configured session validation failed for adapter ${name}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        { cause: error },
      );
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
  const slackChecks = offline ? [] : await validateSlackWorkspace(config);
  console.log(
    `ShowTalk Taishi doctor: OK (${Object.keys(config.agents).length} agents, ${
      checks.length + slackChecks.length
    } checks${offline ? ", Slack network check skipped" : ""})`,
  );
}

async function bind(
  path: string,
  channelId: string,
  codexThreadId: string,
  replace: boolean,
): Promise<void> {
  const config = await loadConfig(path);
  const result = await bindCodexThread(config, {
    channelId,
    codexThreadId,
    ...(replace ? { replace: true } : {}),
  });
  const verb =
    result.outcome === "unchanged"
      ? "Already bound"
      : result.outcome === "replaced"
        ? "Rebound"
        : "Bound";
  console.log(
    `${verb} Slack channel ${result.channelId} (${result.agentId}) to Codex task ${result.codexThreadId}.`,
  );
}

async function service(
  action: ServiceAction,
  configPath: string,
  envFilePath: string | undefined,
): Promise<void> {
  if (action === "install") {
    const resolvedConfigPath = resolve(configPath);
    const status = await installMacOSLaunchAgent({
      configPath: resolvedConfigPath,
      envFilePath:
        envFilePath === undefined
          ? join(dirname(resolvedConfigPath), ".env")
          : resolve(envFilePath),
    });
    printServiceStatus(status);
    console.log("ShowTalk Taishi will now start automatically when this user logs in.");
    return;
  }
  if (action === "uninstall") {
    const status = await uninstallMacOSLaunchAgent();
    printServiceStatus(status);
    console.log("Gateway logs were preserved.");
    return;
  }
  printServiceStatus(await getMacOSLaunchAgentStatus());
}

function printServiceStatus(status: MacOSLaunchAgentStatus): void {
  const details = [
    `loaded=${String(status.loaded)}`,
    ...(status.state === undefined ? [] : [`state=${status.state}`]),
    ...(status.pid === undefined ? [] : [`pid=${String(status.pid)}`]),
    ...(status.lastExitCode === undefined
      ? []
      : [`last_exit=${String(status.lastExitCode)}`]),
  ];
  console.log(`ShowTalk Taishi LaunchAgent: ${details.join(", ")}`);
  console.log(`Logs: ${status.stdoutPath}`);
  console.log(`Errors: ${status.stderrPath}`);
}

function requireParsedValue<T extends string>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Missing required option: ${name}`);
  return value;
}

function printHelp(command?: CliCommand): void {
  if (command === "bind") {
    console.log(`ShowTalk Taishi

Usage:
  taishi bind --channel ID --codex-thread ID [--replace] [--config path]

The runtime must be stopped while changing a canonical channel binding.
Use --replace only to select a different or ambiguous existing task.
`);
    return;
  }
  if (command === "service") {
    console.log(`ShowTalk Taishi

Usage:
  taishi service install [--config path] [--env-file path]
  taishi service status
  taishi service uninstall

The macOS LaunchAgent keeps Slack connected independently of the Codex app.
Secrets remain in the private environment file and are never copied into the plist.
`);
    return;
  }
  console.log(`ShowTalk Taishi

Usage:
  taishi init [--config path]
  taishi doctor [--config path] [--offline]
  taishi bind --channel ID --codex-thread ID [--replace] [--config path]
  taishi start [--config path]
  taishi service install [--config path] [--env-file path]
  taishi service status
  taishi service uninstall
`);
}
