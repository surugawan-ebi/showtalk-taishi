import type { PolicyDecision, TaishiConfig } from "../config/schema.js";

export type SlackPermissionAction = "read" | "write";

export type PermissionAgentDirectory = Readonly<
  Record<
    string,
    {
      readonly slack: {
        readonly channel_id: string;
      };
      readonly consultations?:
        | Readonly<Record<string, { readonly scope: string }>>
        | undefined;
    }
  >
>;

export interface AgentConsultationTarget {
  readonly targetAgentId: string;
  readonly scope: string;
}

type SlackChannelClass = "own_channel" | "agent_channels" | "other_channels";

export class PermissionEngine {
  readonly #permissions: TaishiConfig["permissions"];
  readonly #knownAgentIds: ReadonlySet<string>;
  readonly #channelByAgentId: ReadonlyMap<string, string>;
  readonly #agentChannelIds: ReadonlySet<string>;
  readonly #consultationsByAgentId: ReadonlyMap<
    string,
    ReadonlyMap<string, string>
  >;

  constructor(
    permissions: TaishiConfig["permissions"],
    agents?: PermissionAgentDirectory,
  ) {
    this.#permissions = permissions;

    // The configured directory is the source of truth. Without it no
    // consultation allowlist exists, so agent.send remains fail-closed even if
    // a source-wide default policy says allow.
    const knownAgentIds = new Set(
      agents === undefined ? Object.keys(permissions.agents) : Object.keys(agents),
    );
    const channelByAgentId = new Map<string, string>();
    const consultationsByAgentId = new Map<string, ReadonlyMap<string, string>>();
    if (agents !== undefined) {
      for (const [agentId, agent] of Object.entries(agents)) {
        channelByAgentId.set(agentId, agent.slack.channel_id);
        consultationsByAgentId.set(
          agentId,
          new Map(
            Object.entries(agent.consultations ?? {}).map(([target, rule]) => [
              target,
              rule.scope,
            ]),
          ),
        );
      }
    }

    this.#knownAgentIds = knownAgentIds;
    this.#channelByAgentId = channelByAgentId;
    this.#agentChannelIds = new Set(channelByAgentId.values());
    this.#consultationsByAgentId = consultationsByAgentId;
  }

  agentSend(sourceAgentId: string, targetAgentId: string): PolicyDecision {
    if (
      !this.#knownAgentIds.has(sourceAgentId) ||
      !this.#knownAgentIds.has(targetAgentId) ||
      this.consultationScope(sourceAgentId, targetAgentId) === undefined
    ) {
      return "deny";
    }

    return (
      this.#agentPolicy(sourceAgentId)?.agents?.send ??
      this.#permissions.defaults.agents?.send ??
      "deny"
    );
  }

  consultationScope(
    sourceAgentId: string,
    targetAgentId: string,
  ): string | undefined {
    return this.#consultationsByAgentId.get(sourceAgentId)?.get(targetAgentId);
  }

  consultationTargets(sourceAgentId: string): readonly AgentConsultationTarget[] {
    if (!this.#knownAgentIds.has(sourceAgentId)) return [];
    return [...(this.#consultationsByAgentId.get(sourceAgentId) ?? [])].map(
      ([targetAgentId, scope]) => ({ targetAgentId, scope }),
    );
  }

  slackAccess(
    sourceAgentId: string,
    action: SlackPermissionAction,
    targetChannelId: string,
  ): PolicyDecision {
    const channelClass = this.#classifySlackChannel(sourceAgentId, targetChannelId);
    if (channelClass === undefined) {
      return "deny";
    }

    return (
      this.#agentPolicy(sourceAgentId)?.slack?.[channelClass]?.[action] ??
      this.#permissions.defaults.slack?.[channelClass]?.[action] ??
      "deny"
    );
  }

  #agentPolicy(agentId: string): TaishiConfig["permissions"]["agents"][string] | undefined {
    return Object.hasOwn(this.#permissions.agents, agentId)
      ? this.#permissions.agents[agentId]
      : undefined;
  }

  #classifySlackChannel(
    sourceAgentId: string,
    targetChannelId: string,
  ): SlackChannelClass | undefined {
    if (!this.#knownAgentIds.has(sourceAgentId)) {
      return undefined;
    }

    const ownChannelId = this.#channelByAgentId.get(sourceAgentId);
    // Without a configured channel the target cannot be classified safely.
    if (ownChannelId === undefined) {
      return undefined;
    }
    if (targetChannelId === ownChannelId) {
      return "own_channel";
    }
    if (this.#agentChannelIds.has(targetChannelId)) {
      return "agent_channels";
    }
    return "other_channels";
  }
}
