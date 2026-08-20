import type { KnownBlock } from "@slack/types";

export const CONVERSATION_CONTROL_ACTION_PREFIX = "taishi.conversation.";

export type ConversationControlAction = "status" | "interrupt" | "restart";

export interface ConversationControlActionValue {
  readonly channelId: string;
  readonly rootThreadTs: string;
}

const MAX_ACTION_VALUE_LENGTH = 512;
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{1,127}$/;
const ROOT_THREAD_TS_PATTERN = /^[0-9]{1,20}\.[0-9]{1,20}$/;

/**
 * Builds controls for the channel-wide Koe session. The root timestamp only
 * determines where Slack displays the control response.
 */
export function buildConversationControlBlocks(
  value: ConversationControlActionValue,
): KnownBlock[] {
  const validated = validateActionValue(value);
  const encoded = JSON.stringify(validated);

  return [
    {
      type: "actions",
      elements: [
        controlButton("Status", "status", encoded),
        controlButton("Interrupt", "interrupt", encoded, {
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Interrupt current turn?" },
            text: {
              type: "mrkdwn",
              text: "This asks the Koe to stop its current channel-wide active turn.",
            },
            confirm: { type: "plain_text", text: "Interrupt" },
            deny: { type: "plain_text", text: "Keep running" },
          },
        }),
        controlButton("Restart gateway", "restart", encoded, {
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Restart ShowTalk Taishi?" },
            text: {
              type: "mrkdwn",
              text: "New Koe work will pause, active turns will finish, and the Gateway worker will restart with the latest local code.",
            },
            confirm: { type: "plain_text", text: "Restart" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        }),
      ],
    },
  ];
}

export function parseConversationControlAction(
  actionId: string,
): ConversationControlAction | undefined {
  if (!actionId.startsWith(CONVERSATION_CONTROL_ACTION_PREFIX)) return undefined;
  const action = actionId.slice(CONVERSATION_CONTROL_ACTION_PREFIX.length);
  return action === "status" || action === "interrupt" || action === "restart"
    ? action
    : undefined;
}

export function parseConversationControlActionValue(
  value: string,
): ConversationControlActionValue {
  if (value.length === 0 || value.length > MAX_ACTION_VALUE_LENGTH) {
    throw invalidActionValue();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidActionValue();
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidActionValue();
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("channelId") ||
    !keys.includes("rootThreadTs") ||
    countLiteralKey(value, "channelId") !== 1 ||
    countLiteralKey(value, "rootThreadTs") !== 1
  ) {
    throw invalidActionValue();
  }

  return validateActionValue(record);
}

function validateActionValue(
  value: Record<string, unknown> | ConversationControlActionValue,
): ConversationControlActionValue {
  if (
    typeof value.channelId !== "string" ||
    !CHANNEL_ID_PATTERN.test(value.channelId) ||
    typeof value.rootThreadTs !== "string" ||
    !ROOT_THREAD_TS_PATTERN.test(value.rootThreadTs)
  ) {
    throw invalidActionValue();
  }

  return {
    channelId: value.channelId,
    rootThreadTs: value.rootThreadTs,
  };
}

function controlButton(
  text: string,
  action: ConversationControlAction,
  value: string,
  options: {
    readonly style?: "primary" | "danger";
    readonly confirm?: {
      readonly title: { readonly type: "plain_text"; readonly text: string };
      readonly text: { readonly type: "mrkdwn"; readonly text: string };
      readonly confirm: { readonly type: "plain_text"; readonly text: string };
      readonly deny: { readonly type: "plain_text"; readonly text: string };
    };
  } = {},
) {
  return {
    type: "button" as const,
    text: { type: "plain_text" as const, text, emoji: true },
    action_id: `${CONVERSATION_CONTROL_ACTION_PREFIX}${action}`,
    value,
    ...(options.style === undefined ? {} : { style: options.style }),
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
  };
}

function countLiteralKey(value: string, key: string): number {
  const matcher = new RegExp(`"${key}"\\s*:`, "g");
  return [...value.matchAll(matcher)].length;
}

function invalidActionValue(): Error {
  return new Error("Invalid conversation control action payload");
}
