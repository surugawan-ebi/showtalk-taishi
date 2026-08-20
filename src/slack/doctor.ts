import { WebClient } from "@slack/web-api";

import type { TaishiConfig } from "../config/schema.js";

interface SlackDoctorClient {
  readonly auth: {
    test(): Promise<unknown>;
  };
  readonly conversations: {
    info(input: { channel: string }): Promise<unknown>;
  };
}

export async function validateSlackWorkspace(
  config: TaishiConfig,
  client: SlackDoctorClient = new WebClient(config.slack.bot_token),
): Promise<readonly string[]> {
  const auth = asRecord(await client.auth.test());
  if (auth?.ok !== true || typeof auth.user_id !== "string") {
    throw new Error("Slack bot token could not be authenticated");
  }

  const checks = ["slack:bot-auth"];
  for (const [agentId, agent] of Object.entries(config.agents)) {
    const result = asRecord(
      await client.conversations.info({ channel: agent.slack.channel_id }),
    );
    const channel = asRecord(result?.channel);
    if (result?.ok !== true || channel?.id !== agent.slack.channel_id) {
      throw new Error(`Slack channel for Koe ${agentId} could not be resolved`);
    }
    if (channel.is_archived === true) {
      throw new Error(`Slack channel for Koe ${agentId} is archived`);
    }
    if (channel.is_member !== true) {
      throw new Error(
        `Invite ShowTalk Taishi to the Slack channel for Koe ${agentId}`,
      );
    }
    checks.push(`slack:agent-channel:${agentId}`);
  }
  return checks;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
