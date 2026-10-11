import type { CodexModelCatalogSnapshot } from "../codex/model-catalog.js";

const EFFORTS = [
  { reasoningEffort: "low", description: "Fastest responses" },
  { reasoningEffort: "medium", description: "Balanced" },
  { reasoningEffort: "high", description: "Deeper reasoning" },
  { reasoningEffort: "xhigh", description: "Extended reasoning" },
  { reasoningEffort: "max", description: "Maximum reasoning" },
] as const;

/**
 * Claude Code accepts model aliases that always resolve to the newest model of
 * each family, so the Management UI can offer a stable list without spawning
 * Claude. Operators can still configure any exact model ID in config.yaml.
 */
export class ClaudeModelCatalog {
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async list(): Promise<CodexModelCatalogSnapshot> {
    const model = (
      id: string,
      displayName: string,
      description: string,
      isDefault = false,
    ) => ({
      id,
      model: id,
      displayName,
      description,
      hidden: false,
      isDefault,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: EFFORTS,
      inputModalities: ["text", "image"] as const,
    });
    return {
      fetchedAt: this.#now().toISOString(),
      models: [
        model("default", "Claude Code default", "The account's default Claude Code model", true),
        model("opus", "Claude Opus (latest)", "Most capable model for complex work"),
        model("sonnet", "Claude Sonnet (latest)", "Balanced model for everyday coding"),
        model("haiku", "Claude Haiku (latest)", "Fastest, lowest-cost model"),
      ],
    };
  }
}
