import { readFile } from "node:fs/promises";

import { parseDocument, type Document } from "yaml";

import {
  AdminOverrideError,
  adminOverridesPath,
  applyAdminOverrides,
  loadAdminOverrides,
} from "./admin-overrides.js";
import { taishiConfigSchema, type TaishiConfig } from "./schema.js";

const ENV_REFERENCE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export class ConfigError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ConfigError";
  }
}

export async function loadConfig(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly adminOverridesPath?: string } = {},
): Promise<TaishiConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Unable to read configuration file: ${path}`, error);
  }

  const baseDocument = parseDocument(source);
  if (baseDocument.errors.length > 0) {
    throw new ConfigError(
      `Invalid YAML in configuration file: ${path}`,
      baseDocument.errors[0],
    );
  }

  const baseConfig = validateConfig(baseDocument.toJS(), environment);
  const overridePath =
    options.adminOverridesPath ?? adminOverridesPath(baseConfig.gateway.state_file);
  let effectiveDocument: Document = baseDocument;
  try {
    const overrides = await loadAdminOverrides(overridePath);
    if (overrides.file.overrides.length > 0) {
      effectiveDocument = applyAdminOverrides(baseDocument, overrides.file);
    }
  } catch (error) {
    if (error instanceof AdminOverrideError) {
      throw new ConfigError(`Unable to apply admin settings: ${error.message}`, error);
    }
    throw error;
  }
  return validateConfig(effectiveDocument.toJS(), environment);
}

function validateConfig(
  document: unknown,
  environment: NodeJS.ProcessEnv,
): TaishiConfig {
  const expanded = expandEnvironmentReferences(document, environment);
  const result = taishiConfigSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid ShowTalk Taishi configuration: ${issues}`);
  }
  return result.data;
}

export function expandEnvironmentReferences(
  value: unknown,
  environment: NodeJS.ProcessEnv,
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REFERENCE, (_match, name: string) => {
      const resolved = environment[name];
      if (resolved === undefined || resolved.length === 0) {
        throw new ConfigError(`Required environment variable is missing: ${name}`);
      }
      return expandLeadingHomeReference(resolved, environment);
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvironmentReferences(entry, environment));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        expandEnvironmentReferences(entry, environment),
      ]),
    );
  }
  return value;
}

function expandLeadingHomeReference(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  const home = environment.HOME;
  if (home === undefined || home.length === 0) return value;
  if (value === "$HOME" || value === "${HOME}" || value === "~") return home;
  for (const prefix of ["$HOME/", "${HOME}/", "~/"] as const) {
    if (value.startsWith(prefix)) return `${home}/${value.slice(prefix.length)}`;
  }
  return value;
}
