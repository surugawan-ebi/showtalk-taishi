import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { CodexAppServerClient } from
  "../src/adapters/codex/app-server-client.js";
import {
  APPOPS_APPROVAL_HOOK_PATH_ENV,
  buildAppOpsApprovalHookConfig,
} from "../src/adapters/codex/mcp-config.js";

const apply = process.argv.slice(2).includes("--apply");
const repositoryRoot = resolve(process.cwd());
const configPath = join(
  process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  "config.toml",
);
const hookCommand = `node "$${APPOPS_APPROVAL_HOOK_PATH_ENV}"`;
const projectHook = await discoverHook(repositoryRoot, "project");
const hookKey = `${configPath}:pre_tool_use:0:0`;
const config = await readFile(configPath, "utf8");
const matcher = appOpsMatcher();
const stateHeader = `[hooks.state.${JSON.stringify(hookKey)}]`;
const exactHookConfigured = [
  "[[hooks.PreToolUse]]",
  `matcher = ${JSON.stringify(matcher)}`,
  "[[hooks.PreToolUse.hooks]]",
  'type = "command"',
  `command = ${JSON.stringify(hookCommand)}`,
  "timeout = 10",
  stateHeader,
  "enabled = true",
  `trusted_hash = ${JSON.stringify(projectHook.currentHash)}`,
].every((line) => config.includes(line));

if (exactHookConfigured) {
  const installedHook = await discoverHook(repositoryRoot, "user");
  if (
    installedHook.currentHash !== projectHook.currentHash ||
    installedHook.trustStatus !== "trusted"
  ) {
    throw new Error("Codex did not activate the exact trusted user AppOps hook");
  }
  console.log(JSON.stringify({
    status: "active",
    target: configPath,
    hook_key: hookKey,
    current_hash: installedHook.currentHash,
  }));
  process.exit(0);
}

if (/\[\[hooks\.PreToolUse\]\]/u.test(config)) {
  throw new Error("User Codex config already defines PreToolUse hooks; merge manually");
}
if (config.includes(stateHeader)) {
  throw new Error("AppOps hook trust state already exists; inspect before changing it");
}

if (!apply) {
  console.log(JSON.stringify({
    status: "ready",
    target: configPath,
    hook_key: hookKey,
    current_hash: projectHook.currentHash,
  }));
  process.exit(0);
}

const block = [
  "",
  "# ShowTalk Taishi: exact-hash-trusted AppOps approval proof handoff.",
  "[[hooks.PreToolUse]]",
  `matcher = ${JSON.stringify(matcher)}`,
  "",
  "[[hooks.PreToolUse.hooks]]",
  'type = "command"',
  `command = ${JSON.stringify(hookCommand)}`,
  "timeout = 10",
  "",
  stateHeader,
  "enabled = true",
  `trusted_hash = ${JSON.stringify(projectHook.currentHash)}`,
  "",
].join("\n");
const nextConfig = `${config.trimEnd()}\n${block}`;
const temporaryPath = `${configPath}.showtalk-${randomUUID()}.tmp`;
try {
  await writeFile(temporaryPath, nextConfig, { flag: "wx", mode: 0o600 });
  await rename(temporaryPath, configPath);
} finally {
  await rm(temporaryPath, { force: true }).catch(() => undefined);
}

const installedHook = await discoverHook(repositoryRoot, "user");
if (
  installedHook.currentHash !== projectHook.currentHash ||
  installedHook.trustStatus !== "trusted"
) {
  throw new Error("Codex did not activate the exact trusted user AppOps hook");
}
console.log(JSON.stringify({
  status: "activated",
  target: configPath,
  hook_key: hookKey,
  current_hash: installedHook.currentHash,
}));

async function discoverHook(
  cwd: string,
  source: "project" | "user",
): Promise<{
  readonly currentHash: string;
  readonly trustStatus: string;
}> {
  const client = await CodexAppServerClient.spawn({
    command: process.env.CODEX_COMMAND ?? "codex",
    env: process.env,
  });
  try {
    const listing = await client.request<unknown>("hooks/list", { cwds: [cwd] });
    const data = asRecord(listing)?.data;
    if (!Array.isArray(data)) throw new Error("Codex hooks/list returned no data");
    const matches = data.flatMap((entry) => {
      const record = asRecord(entry);
      if (record?.cwd !== cwd || !Array.isArray(record.hooks)) return [];
      return record.hooks.flatMap((hook) => {
        const metadata = asRecord(hook);
        return metadata?.handlerType === "command" &&
            metadata.command === hookCommand &&
            metadata.source === source &&
            typeof metadata.currentHash === "string" &&
            typeof metadata.trustStatus === "string"
          ? [{
              currentHash: metadata.currentHash,
              trustStatus: metadata.trustStatus,
            }]
          : [];
      });
    });
    if (matches.length !== 1) {
      throw new Error(`Codex did not discover exactly one ${source} AppOps hook`);
    }
    return matches[0]!;
  } finally {
    await client.close({ reportAsFailure: false }).catch(() => undefined);
  }
}

function appOpsMatcher(): string {
  const config = buildAppOpsApprovalHookConfig();
  const hooks = asRecord(config.hooks)?.PreToolUse;
  const matcher = Array.isArray(hooks) ? asRecord(hooks[0])?.matcher : undefined;
  if (typeof matcher !== "string") throw new Error("AppOps hook matcher is invalid");
  return matcher;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
