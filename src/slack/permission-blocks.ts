import type { KnownBlock } from "@slack/types";

import type {
  PermissionApprovalDecision,
  PermissionApprovalPresentation,
} from "../permissions/approval-coordinator.js";
import { formatAgentTextForSlack } from "./text-format.js";

export const PERMISSION_ACTION_PREFIX = "taishi.permission.";

export interface PermissionActionValue {
  readonly requestId: string;
  readonly channelId: string;
}

export function buildPermissionApprovalBlocks(
  request: PermissionApprovalPresentation,
): KnownBlock[] {
  const value = JSON.stringify({
    requestId: request.requestId,
    channelId: request.sourceChannelId,
  } satisfies PermissionActionValue);
  const heading = `${userMention(request.sourceSlackUserId)}*${escapeMrkdwn(request.sourceAgentId)} Koe requests permission*\n`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${heading}${formatAgentTextForSlack(request.summary, 3_000 - heading.length)}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Operation: \`${escapeMrkdwn(request.operation)}\` · expires ${escapeMrkdwn(request.expiresAt)}`,
        },
      ],
    },
    {
      type: "actions",
      elements: [
        button("Allow once", "allow_once", value, "primary"),
        ...(request.allowSessionGrant !== false
          ? [button("Allow session", "allow_session", value)]
          : []),
        button("Deny", "deny", value, "danger"),
        button("Cancel", "cancel", value),
      ],
    },
  ];
}

function userMention(userId: string | undefined): string {
  return userId === undefined ? "" : `<@${userId}> `;
}

export function parsePermissionDecision(
  actionId: string,
): PermissionApprovalDecision | undefined {
  if (!actionId.startsWith(PERMISSION_ACTION_PREFIX)) return undefined;
  const value = actionId.slice(PERMISSION_ACTION_PREFIX.length);
  return value === "allow_once" ||
    value === "allow_session" ||
    value === "deny" ||
    value === "cancel"
    ? value
    : undefined;
}

export function parsePermissionActionValue(value: string): PermissionActionValue {
  if (value.length > 2_000) throw new Error("Permission action payload is too large");
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid permission action payload");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    countLiteralKey(value, "requestId") !== 1 ||
    countLiteralKey(value, "channelId") !== 1 ||
    typeof record.requestId !== "string" ||
    !record.requestId.startsWith("permission:") ||
    record.requestId.length > 256 ||
    typeof record.channelId !== "string" ||
    !/^[CGD][A-Z0-9]{1,127}$/.test(record.channelId)
  ) {
    throw new Error("Invalid permission action payload");
  }
  return { requestId: record.requestId, channelId: record.channelId };
}

function button(
  text: string,
  decision: PermissionApprovalDecision,
  value: string,
  style?: "primary" | "danger",
) {
  return {
    type: "button" as const,
    text: { type: "plain_text" as const, text, emoji: true },
    action_id: `${PERMISSION_ACTION_PREFIX}${decision}`,
    value,
    ...(style === undefined ? {} : { style }),
  };
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function countLiteralKey(value: string, key: string): number {
  return [...value.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
}
