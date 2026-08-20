import type {
  CodexModel,
  ModelListParams,
  ModelListResponse,
} from "./protocol.js";

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

export interface CodexModelListClient {
  listModels(params?: ModelListParams): Promise<ModelListResponse>;
}

export interface CodexModelCatalogSnapshot {
  readonly fetchedAt: string;
  readonly models: readonly CodexModel[];
}

export interface CodexModelCatalogOptions {
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

export class CodexModelCatalog {
  readonly #client: CodexModelListClient;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  #cached:
    | { readonly expiresAtMs: number; readonly snapshot: CodexModelCatalogSnapshot }
    | undefined;
  #inFlight: Promise<CodexModelCatalogSnapshot> | undefined;

  constructor(
    client: CodexModelListClient,
    options: CodexModelCatalogOptions = {},
  ) {
    this.#client = client;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? (() => new Date());
    if (this.#ttlMs < 1) throw new Error("Codex model catalog TTL must be positive");
  }

  async list(options: { readonly refresh?: boolean } = {}): Promise<CodexModelCatalogSnapshot> {
    const nowMs = this.#now().getTime();
    if (!options.refresh && this.#cached !== undefined && this.#cached.expiresAtMs > nowMs) {
      return this.#cached.snapshot;
    }
    if (this.#inFlight !== undefined) return this.#inFlight;

    const loading = this.#load();
    this.#inFlight = loading;
    try {
      const snapshot = await loading;
      this.#cached = {
        expiresAtMs: this.#now().getTime() + this.#ttlMs,
        snapshot,
      };
      return snapshot;
    } finally {
      if (this.#inFlight === loading) this.#inFlight = undefined;
    }
  }

  async #load(): Promise<CodexModelCatalogSnapshot> {
    const models: CodexModel[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null | undefined;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.#client.listModels({
        ...(cursor === undefined ? {} : { cursor }),
        includeHidden: false,
        limit: PAGE_SIZE,
      });
      if (!Array.isArray(page.data)) {
        throw new Error("Codex App Server returned an invalid model catalog page");
      }
      const pageModels = page.data.map((model, index) =>
        normalizeModel(model, index),
      );
      models.push(...pageModels.filter((model) => !model.hidden));
      cursor = page.nextCursor;
      if (cursor === undefined || cursor === null) {
        return {
          fetchedAt: this.#now().toISOString(),
          models,
        };
      }
      if (typeof cursor !== "string" || cursor.length === 0 || seenCursors.has(cursor)) {
        throw new Error("Codex App Server returned an invalid model catalog cursor");
      }
      seenCursors.add(cursor);
    }
    throw new Error("Codex App Server model catalog exceeded the pagination limit");
  }
}

function normalizeModel(value: unknown, index: number): CodexModel {
  const model = asRecord(value, `model ${index}`);
  const effortsValue = model.supportedReasoningEfforts;
  if (!Array.isArray(effortsValue)) {
    throw invalidCatalog(`model ${index} has no reasoning effort list`);
  }
  const supportedReasoningEfforts = effortsValue.map((value, effortIndex) => {
    const effort = asRecord(value, `model ${index} reasoning effort ${effortIndex}`);
    return {
      reasoningEffort: requiredString(
        effort.reasoningEffort,
        `model ${index} reasoning effort ${effortIndex}`,
      ),
      description: requiredString(
        effort.description,
        `model ${index} reasoning effort ${effortIndex} description`,
        true,
      ),
    };
  });
  const modalities = model.inputModalities;
  let inputModalities: readonly ("text" | "image")[] | undefined;
  if (modalities !== undefined) {
    if (
      !Array.isArray(modalities) ||
      modalities.some((modality) => modality !== "text" && modality !== "image")
    ) {
      throw invalidCatalog(`model ${index} has invalid input modalities`);
    }
    inputModalities = modalities as readonly ("text" | "image")[];
  }
  return {
    id: requiredString(model.id, `model ${index} id`),
    model: requiredString(model.model, `model ${index} name`),
    displayName: requiredString(model.displayName, `model ${index} display name`),
    description: requiredString(
      model.description,
      `model ${index} description`,
      true,
    ),
    hidden: requiredBoolean(model.hidden, `model ${index} hidden`),
    isDefault: requiredBoolean(model.isDefault, `model ${index} default flag`),
    defaultReasoningEffort: requiredString(
      model.defaultReasoningEffort,
      `model ${index} default reasoning effort`,
    ),
    supportedReasoningEfforts,
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(typeof model.supportsPersonality === "boolean"
      ? { supportsPersonality: model.supportsPersonality }
      : {}),
  };
}

function asRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidCatalog(`${label} is not an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidCatalog(`${label} is invalid`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalidCatalog(`${label} is invalid`);
  return value;
}

function invalidCatalog(detail: string): Error {
  return new Error(`Codex App Server returned an invalid model catalog: ${detail}`);
}
