import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isMap, parseDocument, type Document } from "yaml";

import {
  expandEnvironmentReferences,
  ConfigError,
} from "../config/loader.js";
import { taishiConfigSchema, type TaishiConfig } from "../config/schema.js";

export interface AdminSlackConfig {
  readonly channel_id: string;
  readonly conversation_scope: "channel" | "slack_thread";
  readonly call_name?: string | undefined;
  readonly persona?: string | undefined;
  readonly display_name?: string | undefined;
  readonly icon_url?: string | undefined;
  readonly icon_emoji?: string | undefined;
}

export interface AdminAgentConfig {
  readonly id: string;
  readonly adapter: string;
  readonly adapter_session_id?: string | undefined;
  readonly adapter_model?: string | undefined;
  readonly adapter_reasoning_effort?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning_effort?: string | undefined;
  readonly workspace_path: string;
  readonly slack: AdminSlackConfig;
  readonly role: string;
  readonly consultations: Readonly<Record<string, { readonly scope: string }>>;
}

export interface AdminConfigSnapshot {
  readonly revision: string;
  readonly available_adapters: readonly string[];
  readonly agents: readonly AdminAgentConfig[];
}

export interface AdminConfigUpdate {
  readonly revision: string;
  readonly agents: readonly AdminAgentConfig[];
}

export class AdminConfigConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigConflictError";
  }
}

export class YamlAdminConfigRepository {
  readonly #path: string;
  readonly #environment: NodeJS.ProcessEnv;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string, environment: NodeJS.ProcessEnv = process.env) {
    this.#path = resolve(path);
    this.#environment = environment;
  }

  async read(): Promise<AdminConfigSnapshot> {
    const loaded = await this.#loadDocument();
    return snapshotFromConfig(loaded.config, loaded.source, loaded.document);
  }

  async save(update: AdminConfigUpdate): Promise<AdminConfigSnapshot> {
    let result: AdminConfigSnapshot | undefined;
    const write = this.#writeQueue.then(async () => {
      result = await this.#saveExclusive(update);
    });
    this.#writeQueue = write.catch(() => undefined);
    await write;
    if (result === undefined) {
      throw new Error("ShowTalk Taishi config save completed without a snapshot");
    }
    return result;
  }

  async #saveExclusive(update: AdminConfigUpdate): Promise<AdminConfigSnapshot> {
    const loaded = await this.#loadDocument();
    if (revisionOf(loaded.source) !== update.revision) {
      throw new AdminConfigConflictError(
        "The configuration changed after this page was loaded. Reload and try again.",
      );
    }

    const configuredIds = Object.keys(loaded.config.agents);
    const submittedIds = update.agents.map((agent) => agent.id);
    if (
      new Set(submittedIds).size !== submittedIds.length ||
      configuredIds.length !== submittedIds.length ||
      configuredIds.some((id) => !submittedIds.includes(id))
    ) {
      throw new ConfigError(
        "The admin UI may edit existing Koe settings but cannot add, remove, or rename Koe yet",
      );
    }

    for (const incoming of update.agents) {
      const current = loaded.config.agents[incoming.id];
      if (current === undefined) {
        throw new ConfigError(`Unknown Koe in admin update: ${incoming.id}`);
      }
      if (incoming.adapter !== current.adapter) {
        throw new ConfigError(
          `Koe ${incoming.id} cannot change adapters in the initial admin UI`,
        );
      }
      applyAgentUpdate(loaded.document, incoming, current);
    }

    const nextSource = loaded.document.toString({ lineWidth: 0 });
    validateConfigSource(nextSource, this.#environment);
    await atomicWrite(this.#path, nextSource, update.revision);
    return this.read();
  }

  async #loadDocument(): Promise<{
    source: string;
    document: Document;
    config: TaishiConfig;
  }> {
    let source: string;
    try {
      source = await readFile(this.#path, "utf8");
    } catch (error) {
      throw new ConfigError(`Unable to read configuration file: ${this.#path}`, error);
    }
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      throw new ConfigError(
        `Invalid YAML in configuration file: ${this.#path}`,
        document.errors[0],
      );
    }
    const config = validateConfigValue(document.toJS(), this.#environment);
    return { source, document, config };
  }
}

function snapshotFromConfig(
  config: TaishiConfig,
  source: string,
  document: Document,
): AdminConfigSnapshot {
  return {
    revision: revisionOf(source),
    available_adapters: Object.keys(config.adapters),
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      adapter: agent.adapter,
      ...(config.adapters[agent.adapter]?.model === undefined
        ? {}
        : { adapter_model: config.adapters[agent.adapter]!.model }),
      ...(config.adapters[agent.adapter]?.reasoning_effort === undefined
        ? {}
        : {
            adapter_reasoning_effort:
              config.adapters[agent.adapter]!.reasoning_effort,
          }),
      ...(agent.adapter_session_id === undefined
        ? {}
        : {
            adapter_session_id: rawString(
              document,
              ["agents", id, "adapter_session_id"],
              agent.adapter_session_id,
            ),
          }),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(agent.reasoning_effort === undefined
        ? {}
        : { reasoning_effort: agent.reasoning_effort }),
      workspace_path: rawString(
        document,
        ["agents", id, "workspace", "path"],
        agent.workspace.path,
      ),
      slack: {
        channel_id: rawString(
          document,
          ["agents", id, "slack", "channel_id"],
          agent.slack.channel_id,
        ),
        conversation_scope: rawConversationScope(
          document,
          ["agents", id, "slack", "conversation_scope"],
          agent.slack.conversation_scope,
        ),
        ...(agent.slack.call_name === undefined
          ? {}
          : {
              call_name: rawString(
                document,
                ["agents", id, "slack", "call_name"],
                agent.slack.call_name,
              ),
            }),
        ...(agent.slack.persona === undefined
          ? {}
          : {
              persona: rawString(
                document,
                ["agents", id, "slack", "persona"],
                agent.slack.persona,
              ),
            }),
        ...(agent.slack.display_name === undefined
          ? {}
          : {
              display_name: rawString(
                document,
                ["agents", id, "slack", "display_name"],
                agent.slack.display_name,
              ),
            }),
        ...(agent.slack.icon_url === undefined
          ? {}
          : {
              icon_url: rawString(
                document,
                ["agents", id, "slack", "icon_url"],
                agent.slack.icon_url,
              ),
            }),
        ...(agent.slack.icon_emoji === undefined
          ? {}
          : {
              icon_emoji: rawString(
                document,
                ["agents", id, "slack", "icon_emoji"],
                agent.slack.icon_emoji,
              ),
            }),
      },
      role: rawString(document, ["agents", id, "role"], agent.role),
      consultations: Object.fromEntries(
        Object.entries(agent.consultations ?? {}).map(([target, rule]) => [
          target,
          {
            scope: rawString(
              document,
              ["agents", id, "consultations", target, "scope"],
              rule.scope,
            ),
          },
        ]),
      ),
    })),
  };
}

function rawString(
  document: Document,
  path: readonly string[],
  fallback: string,
): string {
  const raw = document.getIn(path);
  return typeof raw === "string" ? raw : fallback;
}

function rawConversationScope(
  document: Document,
  path: readonly string[],
  fallback: "channel" | "slack_thread",
): "channel" | "slack_thread" {
  const raw = document.getIn(path);
  return raw === "channel" || raw === "slack_thread" ? raw : fallback;
}

function applyAgentUpdate(
  document: Document,
  incoming: AdminAgentConfig,
  current: TaishiConfig["agents"][string],
): void {
  const root = ["agents", incoming.id] as const;
  setWhenChanged(document, [...root, "adapter"], incoming.adapter, current.adapter);
  setOptionalWhenChanged(
    document,
    [...root, "adapter_session_id"],
    cleanOptional(incoming.adapter_session_id),
    current.adapter_session_id,
  );
  setOptionalWhenChanged(
    document,
    [...root, "model"],
    cleanOptional(incoming.model),
    current.model,
  );
  setOptionalWhenChanged(
    document,
    [...root, "reasoning_effort"],
    cleanOptional(incoming.reasoning_effort),
    current.reasoning_effort,
  );
  setWhenChanged(
    document,
    [...root, "workspace", "path"],
    incoming.workspace_path,
    current.workspace.path,
  );
  setWhenChanged(
    document,
    [...root, "slack", "channel_id"],
    incoming.slack.channel_id,
    current.slack.channel_id,
  );
  setWhenChanged(
    document,
    [...root, "slack", "conversation_scope"],
    incoming.slack.conversation_scope,
    current.slack.conversation_scope,
  );
  for (const key of [
    "call_name",
    "persona",
    "display_name",
    "icon_url",
    "icon_emoji",
  ] as const) {
    setOptionalWhenChanged(
      document,
      [...root, "slack", key],
      cleanOptional(incoming.slack[key]),
      current.slack[key],
    );
  }
  setWhenChanged(document, [...root, "role"], incoming.role, current.role);

  const currentConsultations = current.consultations ?? {};
  const targets = new Set([
    ...Object.keys(currentConsultations),
    ...Object.keys(incoming.consultations),
  ]);
  for (const target of targets) {
    const nextScope = cleanOptional(incoming.consultations[target]?.scope);
    const previousScope = currentConsultations[target]?.scope;
    setOptionalWhenChanged(
      document,
      [...root, "consultations", target, "scope"],
      nextScope,
      previousScope,
    );
  }
  const consultations = document.getIn([...root, "consultations"], true);
  if (isMap(consultations) && consultations.items.length === 0) {
    document.deleteIn([...root, "consultations"]);
  }
}

function setWhenChanged(
  document: Document,
  path: readonly string[],
  next: string,
  previous: string,
): void {
  if (next !== previous && document.getIn(path) !== next) {
    document.setIn(path, next);
  }
}

function setOptionalWhenChanged(
  document: Document,
  path: readonly string[],
  next: string | undefined,
  previous: string | undefined,
): void {
  if (next === previous || document.getIn(path) === next) return;
  if (next === undefined) document.deleteIn(path);
  else document.setIn(path, next);
}

function cleanOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function validateConfigSource(
  source: string,
  environment: NodeJS.ProcessEnv,
): TaishiConfig {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw new ConfigError("The updated configuration is not valid YAML", document.errors[0]);
  }
  return validateConfigValue(document.toJS(), environment);
}

function validateConfigValue(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): TaishiConfig {
  const expanded = expandEnvironmentReferences(value, environment);
  const result = taishiConfigSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid ShowTalk Taishi configuration: ${issues}`);
  }
  return result.data;
}

function revisionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

async function atomicWrite(
  path: string,
  source: string,
  expectedRevision: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigError("The configuration path must be a regular file, not a symlink");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new ConfigError(
      "The configuration file must not be readable or writable by group or other users",
    );
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new ConfigError("The configuration file must be owned by the Gateway user");
  }
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, source, {
      encoding: "utf8",
      flag: "wx",
      mode: metadata.mode & 0o777,
    });
    const currentSource = await readFile(path, "utf8");
    if (revisionOf(currentSource) !== expectedRevision) {
      throw new AdminConfigConflictError(
        "The configuration changed while it was being saved. Reload and try again.",
      );
    }
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
