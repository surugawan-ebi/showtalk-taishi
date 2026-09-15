export type CliCommand =
  | "init"
  | "doctor"
  | "bind"
  | "start"
  | "service"
  | "help";
export type ServiceAction = "install" | "status" | "uninstall";

export interface ParsedCliArguments {
  readonly command: CliCommand;
  readonly configPath: string;
  readonly help: boolean;
  readonly offline: boolean;
  readonly replace: boolean;
  readonly channelId: string | undefined;
  readonly codexThreadId: string | undefined;
  readonly serviceAction: ServiceAction | undefined;
  readonly envFilePath: string | undefined;
}

const COMMANDS = new Set<CliCommand>([
  "init",
  "doctor",
  "bind",
  "start",
  "service",
  "help",
]);

const OPTIONS_BY_COMMAND: Readonly<Record<CliCommand, ReadonlySet<string>>> = {
  init: new Set(["--config", "--help", "-h"]),
  doctor: new Set(["--config", "--offline", "--help", "-h"]),
  bind: new Set([
    "--config",
    "--channel",
    "--codex-thread",
    "--replace",
    "--help",
    "-h",
  ]),
  start: new Set(["--config", "--help", "-h"]),
  service: new Set(["--config", "--env-file", "--help", "-h"]),
  help: new Set(["--help", "-h"]),
};

const VALUE_OPTIONS = new Set([
  "--config",
  "--channel",
  "--codex-thread",
  "--env-file",
]);

/** Strict parsing matters because bind can select a different persistent task. */
export function parseCliArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): ParsedCliArguments {
  const commandToken = argv[0] ?? "help";
  if (commandToken === "--help" || commandToken === "-h") {
    return result("help", defaultConfigPath(environment), { help: true });
  }
  if (!COMMANDS.has(commandToken as CliCommand)) {
    throw new Error(`Unknown command: ${commandToken}`);
  }
  const command = commandToken as CliCommand;
  let serviceAction: ServiceAction | undefined;
  let optionStart = 1;
  if (command === "service") {
    const actionToken = argv[1];
    if (actionToken === undefined || actionToken === "--help" || actionToken === "-h") {
      return result(command, defaultConfigPath(environment), { help: true });
    }
    if (!isServiceAction(actionToken)) {
      throw new Error(`Unknown service action: ${actionToken}`);
    }
    serviceAction = actionToken;
    optionStart = 2;
  }
  const allowed = OPTIONS_BY_COMMAND[command];
  const seen = new Set<string>();
  const values = new Map<string, string>();
  let help = command === "help";
  let offline = false;
  let replace = false;

  for (let index = optionStart; index < argv.length; index += 1) {
    const option = argv[index]!;
    if (!allowed.has(option)) {
      const label = option.startsWith("-") ? "option" : "argument";
      throw new Error(`Unknown ${label} for ${command}: ${option}`);
    }
    const canonical = option === "-h" ? "--help" : option;
    if (seen.has(canonical)) throw new Error(`Duplicate option: ${canonical}`);
    seen.add(canonical);

    if (VALUE_OPTIONS.has(option)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`Missing value for option: ${option}`);
      }
      values.set(option, value);
      index += 1;
      continue;
    }
    if (canonical === "--help") help = true;
    if (option === "--offline") offline = true;
    if (option === "--replace") replace = true;
  }

  const configPath = values.get("--config") ?? defaultConfigPath(environment);
  const channelId = values.get("--channel");
  const codexThreadId = values.get("--codex-thread");
  const envFilePath = values.get("--env-file");
  if (command === "bind" && !help) {
    if (channelId === undefined) {
      throw new Error("Missing required option: --channel");
    }
    if (codexThreadId === undefined) {
      throw new Error("Missing required option: --codex-thread");
    }
  }
  if (
    command === "service" &&
    serviceAction !== "install" &&
    (values.has("--config") || envFilePath !== undefined)
  ) {
    throw new Error(
      `Options --config and --env-file are available only for service install`,
    );
  }
  return {
    command,
    configPath,
    help,
    offline,
    replace,
    channelId,
    codexThreadId,
    serviceAction,
    envFilePath,
  };
}

function defaultConfigPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment.TAISHI_CONFIG;
  return configured === undefined || configured.length === 0
    ? "config.yaml"
    : configured;
}

function result(
  command: CliCommand,
  configPath: string,
  overrides: Partial<ParsedCliArguments> = {},
): ParsedCliArguments {
  return {
    command,
    configPath,
    help: false,
    offline: false,
    replace: false,
    channelId: undefined,
    codexThreadId: undefined,
    serviceAction: undefined,
    envFilePath: undefined,
    ...overrides,
  };
}

function isServiceAction(value: string): value is ServiceAction {
  return value === "install" || value === "status" || value === "uninstall";
}
