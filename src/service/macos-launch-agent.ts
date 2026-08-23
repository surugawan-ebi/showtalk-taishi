import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MACOS_LAUNCH_AGENT_LABEL = "dev.showtalk-taishi.gateway";

export interface LaunchctlResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type LaunchctlRunner = (
  arguments_: readonly string[],
) => Promise<LaunchctlResult>;

export interface MacOSLaunchAgentContext {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly userId: number;
  readonly nodePath: string;
  readonly nodeArguments: readonly string[];
  readonly cliEntrypoint: string;
  readonly pathEnvironment: string;
  readonly runLaunchctl: LaunchctlRunner;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export interface InstallMacOSLaunchAgentOptions {
  readonly configPath: string;
  readonly envFilePath: string;
}

export interface MacOSLaunchAgentPaths {
  readonly plistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface MacOSLaunchAgentStatus extends MacOSLaunchAgentPaths {
  readonly label: string;
  readonly loaded: boolean;
  readonly state?: string;
  readonly pid?: number;
  readonly lastExitCode?: number;
}

export function createMacOSLaunchAgentContext(): MacOSLaunchAgentContext {
  const userId = process.getuid?.();
  const cliEntrypoint = process.argv[1];
  if (userId === undefined) {
    throw new Error("Cannot determine the current macOS user ID");
  }
  if (cliEntrypoint === undefined) {
    throw new Error("Cannot determine the ShowTalk Taishi CLI entrypoint");
  }
  return {
    platform: process.platform,
    homeDirectory: process.env.HOME ?? "",
    userId,
    nodePath: process.execPath,
    nodeArguments: process.execArgv,
    cliEntrypoint,
    pathEnvironment: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    runLaunchctl: runLaunchctlCommand,
    wait: delay,
  };
}

export async function installMacOSLaunchAgent(
  options: InstallMacOSLaunchAgentOptions,
  context: MacOSLaunchAgentContext = createMacOSLaunchAgentContext(),
): Promise<MacOSLaunchAgentStatus> {
  assertSupportedContext(context);
  const configPath = resolve(options.configPath);
  const envFilePath = resolve(options.envFilePath);
  const cliEntrypoint = resolve(context.cliEntrypoint);
  await Promise.all([
    assertPrivateReadableFile(configPath, "configuration", context.userId),
    assertPrivateReadableFile(envFilePath, "environment", context.userId),
    access(cliEntrypoint),
  ]);

  const paths = macOSLaunchAgentPaths(context.homeDirectory);
  await Promise.all([
    mkdir(dirname(paths.plistPath), { recursive: true }),
    mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    ensurePrivateLogFile(paths.stdoutPath),
    ensurePrivateLogFile(paths.stderrPath),
  ]);

  const previousPlist = await readOptionalFile(paths.plistPath);
  const previousStatus = await getMacOSLaunchAgentStatus(context);
  const plist = renderMacOSLaunchAgentPlist({
    label: MACOS_LAUNCH_AGENT_LABEL,
    nodePath: resolve(context.nodePath),
    nodeArguments: context.nodeArguments,
    cliEntrypoint,
    configPath,
    envFilePath,
    workingDirectory: dirname(configPath),
    homeDirectory: context.homeDirectory,
    pathEnvironment: context.pathEnvironment,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
  });

  if (previousStatus.loaded) {
    await requireLaunchctlSuccess(
      context.runLaunchctl(["bootout", serviceTarget(context)]),
      "stop the existing LaunchAgent",
    );
    await waitForLaunchAgentToUnload(context);
    await context.wait(250);
  }

  try {
    await writePrivateFileAtomically(paths.plistPath, plist);
    const bootstrap = await bootstrapLaunchAgent(context, paths.plistPath);
    if (bootstrap.code !== 0) {
      throw launchctlError("load the LaunchAgent", bootstrap);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      await restorePreviousPlist(paths.plistPath, previousPlist);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (previousStatus.loaded) {
      if (previousPlist === undefined) {
        rollbackErrors.push(
          new Error("The previous LaunchAgent was loaded without a restorable plist"),
        );
      } else if (rollbackErrors.length === 0) {
        const restored = await bootstrapLaunchAgent(context, paths.plistPath);
        if (restored.code !== 0) {
          rollbackErrors.push(
            launchctlError("restore the previous LaunchAgent", restored),
          );
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "LaunchAgent installation failed and rollback was incomplete",
      );
    }
    throw error;
  }
  return getMacOSLaunchAgentStatus(context);
}

async function waitForLaunchAgentToUnload(
  context: MacOSLaunchAgentContext,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await context.runLaunchctl(["print", serviceTarget(context)]);
    if (result.code !== 0) return;
    await context.wait(100);
  }
  throw new Error("The existing LaunchAgent did not finish unloading");
}

async function bootstrapLaunchAgent(
  context: MacOSLaunchAgentContext,
  plistPath: string,
): Promise<LaunchctlResult> {
  let lastResult: LaunchctlResult = { code: 1, stdout: "", stderr: "not attempted" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    lastResult = await context.runLaunchctl([
      "bootstrap",
      userDomain(context),
      plistPath,
    ]);
    if (lastResult.code === 0) return lastResult;
    const status = await context.runLaunchctl(["print", serviceTarget(context)]);
    if (status.code === 0) return { code: 0, stdout: status.stdout, stderr: "" };
    if (attempt < 2) await context.wait(500 * (attempt + 1));
  }
  return lastResult;
}

export async function getMacOSLaunchAgentStatus(
  context: MacOSLaunchAgentContext = createMacOSLaunchAgentContext(),
): Promise<MacOSLaunchAgentStatus> {
  assertSupportedContext(context);
  const paths = macOSLaunchAgentPaths(context.homeDirectory);
  const result = await context.runLaunchctl(["print", serviceTarget(context)]);
  if (result.code !== 0) {
    return {
      label: MACOS_LAUNCH_AGENT_LABEL,
      loaded: false,
      ...paths,
    };
  }
  return {
    label: MACOS_LAUNCH_AGENT_LABEL,
    loaded: true,
    ...parseLaunchctlPrint(result.stdout),
    ...paths,
  };
}

export async function uninstallMacOSLaunchAgent(
  context: MacOSLaunchAgentContext = createMacOSLaunchAgentContext(),
): Promise<MacOSLaunchAgentStatus> {
  assertSupportedContext(context);
  const status = await getMacOSLaunchAgentStatus(context);
  if (status.loaded) {
    await requireLaunchctlSuccess(
      context.runLaunchctl(["bootout", serviceTarget(context)]),
      "unload the LaunchAgent",
    );
  }
  await unlink(status.plistPath).catch((error: unknown) => {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  });
  return getMacOSLaunchAgentStatus(context);
}

export function macOSLaunchAgentPaths(
  homeDirectory: string,
): MacOSLaunchAgentPaths {
  if (homeDirectory.length === 0) {
    throw new Error("HOME is required to manage the macOS LaunchAgent");
  }
  const logDirectory = join(homeDirectory, "Library", "Logs", "ShowTalkTaishi");
  return {
    plistPath: join(
      homeDirectory,
      "Library",
      "LaunchAgents",
      `${MACOS_LAUNCH_AGENT_LABEL}.plist`,
    ),
    stdoutPath: join(logDirectory, "gateway.log"),
    stderrPath: join(logDirectory, "gateway.error.log"),
  };
}

export function renderMacOSLaunchAgentPlist(input: {
  readonly label: string;
  readonly nodePath: string;
  readonly nodeArguments: readonly string[];
  readonly cliEntrypoint: string;
  readonly configPath: string;
  readonly envFilePath: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly pathEnvironment: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}): string {
  const programArguments = [
    input.nodePath,
    `--env-file=${input.envFilePath}`,
    ...input.nodeArguments,
    input.cliEntrypoint,
    "start",
    "--config",
    input.configPath,
  ];
  const argumentXml = programArguments
    .map((argument) => `      <string>${escapeXml(argument)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(input.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${escapeXml(input.homeDirectory)}</string>
      <key>PATH</key>
      <string>${escapeXml(input.pathEnvironment)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.stderrPath)}</string>
  </dict>
</plist>
`;
}

async function assertPrivateReadableFile(
  path: string,
  label: string,
  expectedUserId: number,
): Promise<void> {
  const linkMetadata = await lstat(path).catch((error: unknown) => {
    throw new Error(`Unable to read ${label} file: ${path}`, { cause: error });
  });
  if (linkMetadata.isSymbolicLink()) {
    throw new Error(`The ${label} file must not be a symbolic link: ${path}`);
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`The ${label} path is not a file: ${path}`);
  if (metadata.uid !== expectedUserId) {
    throw new Error(`The ${label} file must be owned by the current user: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      `The ${label} file must not be accessible by group or other users: ${path}`,
    );
  }
  await access(path);
}

async function ensurePrivateLogFile(path: string): Promise<void> {
  await writeFile(path, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  await chmod(path, 0o600);
}

async function writePrivateFileAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function restorePreviousPlist(
  path: string,
  previous: string | undefined,
): Promise<void> {
  if (previous === undefined) {
    await unlink(path).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
    return;
  }
  await writePrivateFileAtomically(path, previous);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseLaunchctlPrint(output: string): Pick<
  MacOSLaunchAgentStatus,
  "state" | "pid" | "lastExitCode"
> {
  const state = /^\s*state = (.+)$/mu.exec(output)?.[1]?.trim();
  const pid = parseInteger(/^\s*pid = (\d+)$/mu.exec(output)?.[1]);
  const lastExitCode = parseInteger(
    /^\s*last exit code = (-?\d+)$/mu.exec(output)?.[1],
  );
  return {
    ...(state === undefined ? {} : { state }),
    ...(pid === undefined ? {} : { pid }),
    ...(lastExitCode === undefined ? {} : { lastExitCode }),
  };
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function assertSupportedContext(context: MacOSLaunchAgentContext): void {
  if (context.platform !== "darwin") {
    throw new Error("LaunchAgent service management is available only on macOS");
  }
  if (context.homeDirectory.length === 0) {
    throw new Error("HOME is required to manage the macOS LaunchAgent");
  }
}

function userDomain(context: MacOSLaunchAgentContext): string {
  return `gui/${context.userId}`;
}

function serviceTarget(context: MacOSLaunchAgentContext): string {
  return `${userDomain(context)}/${MACOS_LAUNCH_AGENT_LABEL}`;
}

async function requireLaunchctlSuccess(
  operation: Promise<LaunchctlResult>,
  description: string,
): Promise<void> {
  const result = await operation;
  if (result.code !== 0) throw launchctlError(description, result);
}

function launchctlError(description: string, result: LaunchctlResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.code)}`;
  return new Error(`Could not ${description}: ${detail}`);
}

function runLaunchctlCommand(arguments_: readonly string[]): Promise<LaunchctlResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/launchctl", [...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
