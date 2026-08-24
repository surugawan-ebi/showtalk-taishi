import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isMap, type Document } from "yaml";
import { z } from "zod";

const MAX_ADMIN_OVERRIDES_BYTES = 1_048_576;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ENV_REFERENCE = /\$\{[A-Z_][A-Z0-9_]*\}/u;

const overrideEntrySchema = z
  .object({
    json_pointer: z.string().min(1).max(1_024),
    expected_base_hash: z.string().regex(HASH_PATTERN),
    value: z.string().max(100_000).nullable(),
  })
  .strict();

const overrideFileSchema = z
  .object({
    version: z.literal(1),
    overrides: z.array(overrideEntrySchema).max(4_096),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.overrides.map((entry) => entry.json_pointer)).size ===
      value.overrides.length,
    "Admin override paths must be unique",
  );

export type AdminOverrideFile = z.infer<typeof overrideFileSchema>;
export type AdminOverrideEntry = AdminOverrideFile["overrides"][number];

export class AdminOverrideError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "AdminOverrideError";
  }
}

export class AdminOverrideConflictError extends AdminOverrideError {
  constructor(message: string) {
    super(message);
    this.name = "AdminOverrideConflictError";
  }
}

export interface LoadedAdminOverrides {
  readonly path: string;
  readonly source: string;
  readonly file: AdminOverrideFile;
}

export function adminOverridesPath(stateFilePath: string): string {
  return join(dirname(resolve(stateFilePath)), "admin-config-overrides.v1.json");
}

export async function loadAdminOverrides(
  path: string,
): Promise<LoadedAdminOverrides> {
  const resolvedPath = await canonicalizeParent(resolve(path));
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    validatePrivateFile(metadata);
    if (metadata.size > MAX_ADMIN_OVERRIDES_BYTES) {
      throw new AdminOverrideError("The admin override file is too large");
    }
    const source = await handle.readFile("utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_ADMIN_OVERRIDES_BYTES) {
      throw new AdminOverrideError("The admin override file is too large");
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch (error) {
      throw new AdminOverrideError("The admin override file is not valid JSON", error);
    }
    const parsed = overrideFileSchema.safeParse(value);
    if (!parsed.success) {
      throw new AdminOverrideError(
        `Invalid admin override file: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "overrides"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    for (const entry of parsed.data.overrides) {
      parseEditablePointer(entry.json_pointer);
    }
    return { path: resolvedPath, source, file: parsed.data };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        path: resolvedPath,
        source: "",
        file: { version: 1, overrides: [] },
      };
    }
    if (error instanceof AdminOverrideError) throw error;
    throw new AdminOverrideError("Unable to read the admin override file", error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function applyAdminOverrides(
  baseDocument: Document,
  overrides: AdminOverrideFile,
): Document {
  const effectiveDocument = baseDocument.clone();
  for (const entry of overrides.overrides) {
    const path = parseEditablePointer(entry.json_pointer);
    if (baseDocument.getIn(["agents", path[1]!], true) === undefined) {
      throw new AdminOverrideError(
        `Admin override references an unknown Koe: ${path[1]!}`,
      );
    }
    const baseValue = baseDocument.getIn(path);
    if (hashAdminValue(baseValue) !== entry.expected_base_hash) {
      throw new AdminOverrideConflictError(
        `The operator configuration changed at ${entry.json_pointer}. ` +
          "Remove or recreate the conflicting admin override before continuing.",
      );
    }
    if (typeof entry.value === "string" && ENV_REFERENCE.test(entry.value)) {
      throw new AdminOverrideError(
        `Environment references are not allowed in admin overrides: ${entry.json_pointer}`,
      );
    }
    if (entry.value === null) {
      if (!isOptionalEditablePath(path)) {
        throw new AdminOverrideError(
          `Required admin setting cannot be removed: ${entry.json_pointer}`,
        );
      }
      effectiveDocument.deleteIn(path);
      cleanEmptyConsultationMaps(effectiveDocument, path);
    } else {
      effectiveDocument.setIn(path, entry.value);
    }
  }
  return effectiveDocument;
}

export function buildAdminOverrides(
  baseDocument: Document,
  targetDocument: Document,
  agentIds: readonly string[],
): AdminOverrideFile {
  const entries: AdminOverrideEntry[] = [];
  for (const path of editablePaths(baseDocument, targetDocument, agentIds)) {
    const baseValue = baseDocument.getIn(path);
    const targetValue = targetDocument.getIn(path);
    if (sameAdminValue(baseValue, targetValue)) continue;
    if (targetValue !== undefined && typeof targetValue !== "string") {
      throw new AdminOverrideError(
        `Admin setting must be text: ${toJsonPointer(path)}`,
      );
    }
    if (typeof targetValue === "string" && ENV_REFERENCE.test(targetValue)) {
      throw new AdminOverrideError(
        `Environment references must be edited in config.yaml: ${toJsonPointer(path)}`,
      );
    }
    entries.push({
      json_pointer: toJsonPointer(path),
      expected_base_hash: hashAdminValue(baseValue),
      value: targetValue === undefined ? null : targetValue,
    });
  }
  return { version: 1, overrides: entries };
}

export function serializeAdminOverrides(file: AdminOverrideFile): string {
  const parsed = overrideFileSchema.parse(file);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export async function writeAdminOverrides(
  path: string,
  source: string,
  expectedSource: string,
): Promise<void> {
  if (Buffer.byteLength(source, "utf8") > MAX_ADMIN_OVERRIDES_BYTES) {
    throw new AdminOverrideError("The admin override file is too large");
  }
  const requestedPath = resolve(path);
  const requestedDirectory = dirname(requestedPath);
  await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const directory = await realpath(requestedDirectory);
  const resolvedPath = join(directory, basename(requestedPath));
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new AdminOverrideError("The private state path must be a real directory");
  }
  if ((directoryMetadata.mode & 0o077) !== 0) {
    throw new AdminOverrideError("The private state directory must be owner-only (mode 0700)");
  }
  assertOwnedByGateway(directoryMetadata, "private state directory");

  const releaseLock = await acquireAdminOverrideLock(resolvedPath);
  try {
    const current = await loadAdminOverrides(resolvedPath);
    if (current.source !== expectedSource) {
      throw new AdminOverrideConflictError(
        "The admin settings changed while they were being saved. Reload and try again.",
      );
    }

    const temporaryPath = join(
      directory,
      `.admin-config-overrides.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryHandle: FileHandle | undefined;
    try {
      temporaryHandle = await open(temporaryPath, "wx", 0o600);
      await temporaryHandle.writeFile(source, "utf8");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await rename(temporaryPath, resolvedPath);
      await syncDirectory(directory);
    } catch (error) {
      await temporaryHandle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export function adminConfigRevision(
  canonicalSource: string,
  overrideSource: string,
): string {
  return createHash("sha256")
    .update(canonicalSource)
    .update("\0")
    .update(overrideSource)
    .digest("hex");
}

function editablePaths(
  baseDocument: Document,
  targetDocument: Document,
  agentIds: readonly string[],
): readonly string[][] {
  const paths: string[][] = [];
  for (const id of agentIds) {
    const root = ["agents", id];
    for (const suffix of [
      ["adapter_session_id"],
      ["model"],
      ["reasoning_effort"],
      ["workspace", "path"],
      ["slack", "channel_id"],
      ["slack", "conversation_scope"],
      ["slack", "call_name"],
      ["slack", "persona"],
      ["slack", "display_name"],
      ["slack", "icon_url"],
      ["slack", "icon_emoji"],
      ["role"],
    ] as const) {
      paths.push([...root, ...suffix]);
    }
    const consultationTargets = new Set([
      ...consultationKeys(baseDocument, id),
      ...consultationKeys(targetDocument, id),
    ]);
    for (const target of [...consultationTargets].sort()) {
      paths.push([...root, "consultations", target, "scope"]);
    }
  }
  return paths;
}

function consultationKeys(document: Document, agentId: string): readonly string[] {
  const value = document.getIn(["agents", agentId, "consultations"], true);
  if (!isMap(value)) return [];
  return value.items
    .map((item) => (item.key === undefined ? undefined : String(item.key)))
    .filter((key): key is string => typeof key === "string");
}

function parseEditablePointer(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer.endsWith("/")) {
    throw new AdminOverrideError(`Invalid admin override path: ${pointer}`);
  }
  const path = pointer
    .slice(1)
    .split("/")
    .map((token) => decodePointerToken(token, pointer));
  const fixed = new Set([
    "adapter_session_id",
    "model",
    "reasoning_effort",
    "workspace/path",
    "slack/channel_id",
    "slack/conversation_scope",
    "slack/call_name",
    "slack/persona",
    "slack/display_name",
    "slack/icon_url",
    "slack/icon_emoji",
    "role",
  ]);
  const isConsultation =
    path.length === 5 &&
    path[2] === "consultations" &&
    path[3] !== undefined &&
    path[3].length > 0 &&
    path[4] === "scope";
  if (
    path[0] !== "agents" ||
    path[1] === undefined ||
    path[1].length === 0 ||
    path[2] === undefined ||
    (!fixed.has([path[2], ...path.slice(3)].join("/")) && !isConsultation)
  ) {
    throw new AdminOverrideError(`Admin override path is not editable: ${pointer}`);
  }
  return path;
}

function isOptionalEditablePath(path: readonly string[]): boolean {
  const suffix = path.slice(2).join("/");
  return (
    suffix === "adapter_session_id" ||
    suffix === "model" ||
    suffix === "reasoning_effort" ||
    suffix === "slack/call_name" ||
    suffix === "slack/persona" ||
    suffix === "slack/display_name" ||
    suffix === "slack/icon_url" ||
    suffix === "slack/icon_emoji" ||
    (path.length === 5 && path[2] === "consultations" && path[4] === "scope")
  );
}

function cleanEmptyConsultationMaps(
  document: Document,
  path: readonly string[],
): void {
  if (path.length !== 5 || path[2] !== "consultations") return;
  document.deleteIn(path.slice(0, 4));
  const consultations = document.getIn(path.slice(0, 3), true);
  if (isMap(consultations) && consultations.items.length === 0) {
    document.deleteIn(path.slice(0, 3));
  }
}

function hashAdminValue(value: unknown): string {
  const encoded = value === undefined ? "undefined" : JSON.stringify(value);
  return createHash("sha256").update(encoded).digest("hex");
}

function sameAdminValue(left: unknown, right: unknown): boolean {
  return hashAdminValue(left) === hashAdminValue(right);
}

function toJsonPointer(path: readonly string[]): string {
  return `/${path.map(encodePointerToken).join("/")}`;
}

function encodePointerToken(token: string): string {
  return token.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function decodePointerToken(token: string, pointer: string): string {
  if (/~(?:[^01]|$)/u.test(token)) {
    throw new AdminOverrideError(`Invalid JSON pointer escape: ${pointer}`);
  }
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function validatePrivateFile(metadata: Stats): void {
  if (!metadata.isFile()) {
    throw new AdminOverrideError("The admin override path must be a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new AdminOverrideError("The admin override file must be owner-only (mode 0600)");
  }
  assertOwnedByGateway(metadata, "admin override file");
}

function assertOwnedByGateway(
  metadata: { readonly uid: number },
  label: string,
): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new AdminOverrideError(`The ${label} must be owned by the Gateway user`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface AdminOverrideLock {
  readonly version: 1;
  readonly pid: number;
  readonly nonce: string;
}

async function acquireAdminOverrideLock(
  overridesPath: string,
): Promise<() => Promise<void>> {
  const lockPath = `${overridesPath}.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const nonce = randomUUID();
    const temporaryPath = `${lockPath}.${process.pid}.${nonce}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ version: 1, pid: process.pid, nonce })}\n`,
        "utf8",
      );
      await handle.sync();
      await link(temporaryPath, lockPath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (await removeStaleAdminOverrideLock(lockPath)) continue;
      throw new AdminOverrideConflictError(
        "Another Gateway process is saving admin settings. Reload and try again.",
      );
    }
    await handle.close();
    await unlink(temporaryPath).catch(() => undefined);
    return async () => {
      const current = await readAdminOverrideLock(lockPath);
      if (current?.nonce === nonce) await unlink(lockPath);
    };
  }
  throw new AdminOverrideConflictError(
    "Could not acquire the admin settings save lock. Reload and try again.",
  );
}

async function removeStaleAdminOverrideLock(lockPath: string): Promise<boolean> {
  let lock: AdminOverrideLock;
  try {
    const current = await readAdminOverrideLock(lockPath);
    if (current === undefined) return true;
    lock = current;
  } catch (error) {
    throw new AdminOverrideError(
      "The admin settings save lock is invalid and must be inspected",
      error,
    );
  }
  if (processIsAlive(lock.pid)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

async function readAdminOverrideLock(
  lockPath: string,
): Promise<AdminOverrideLock | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    validatePrivateFile(metadata);
    if (metadata.size > 1_024) {
      throw new AdminOverrideError("The admin settings save lock is too large");
    }
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("pid" in value) ||
      typeof value.pid !== "number" ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !("nonce" in value) ||
      typeof value.nonce !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(value.nonce)
    ) {
      throw new AdminOverrideError("Invalid admin settings save lock");
    }
    return value as AdminOverrideLock;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function canonicalizeParent(path: string): Promise<string> {
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return path;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
