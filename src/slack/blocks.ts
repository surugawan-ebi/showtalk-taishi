import type { KnownBlock } from "@slack/types";

import type { AgentApproval } from "../core/index.js";
import { formatAgentTextForSlack } from "./text-format.js";

export const APPROVAL_ACTION_PREFIX = "taishi.approval.";

export interface ApprovalActionValue {
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly sessionId?: string;
}

export function buildApprovalBlocks(
  summary: string,
  value: ApprovalActionValue,
): KnownBlock[] {
  const encoded = JSON.stringify(value);
  const heading = "*Koe requests permission*\n";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${heading}${formatAgentTextForSlack(summary, 3_000 - heading.length)}`,
      },
    },
    {
      type: "actions",
      elements: [
        approvalButton("Allow once", "allow_once", encoded, "primary"),
        approvalButton("Allow session", "allow_session", encoded),
        approvalButton("Deny", "deny", encoded, "danger"),
        approvalButton("Cancel", "cancel", encoded),
      ],
    },
  ];
}

function approvalButton(
  text: string,
  decision: AgentApproval["decision"],
  value: string,
  style?: "primary" | "danger",
) {
  return {
    type: "button" as const,
    text: { type: "plain_text" as const, text, emoji: true },
    action_id: `${APPROVAL_ACTION_PREFIX}${decision}`,
    value,
    ...(style === undefined ? {} : { style }),
    ...(decision === "allow_session"
      ? {
          confirm: {
            title: { type: "plain_text" as const, text: "Allow for session?" },
            text: {
              type: "mrkdwn" as const,
              text: "This allows matching requests for the active Koe session.",
            },
            confirm: { type: "plain_text" as const, text: "Allow session" },
            deny: { type: "plain_text" as const, text: "Go back" },
          },
        }
      : {}),
  };
}

export function parseApprovalDecision(
  actionId: string,
): AgentApproval["decision"] | undefined {
  if (!actionId.startsWith(APPROVAL_ACTION_PREFIX)) return undefined;
  const decision = actionId.slice(APPROVAL_ACTION_PREFIX.length);
  return decision === "allow_once" ||
    decision === "allow_session" ||
    decision === "deny" ||
    decision === "cancel"
    ? decision
    : undefined;
}

export function parseApprovalActionValue(value: string): ApprovalActionValue {
  if (value.length === 0 || value.length > 2_000) {
    throw new Error("Invalid approval action payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid approval action payload");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("requestId" in parsed) ||
    typeof parsed.requestId !== "string" ||
    !("channelId" in parsed) ||
    typeof parsed.channelId !== "string" ||
    !("rootThreadTs" in parsed) ||
    typeof parsed.rootThreadTs !== "string"
  ) {
    throw new Error("Invalid approval action payload");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const hasSession = Object.hasOwn(record, "sessionId");
  if (
    keys.length !== (hasSession ? 4 : 3) ||
    keys.some(
      (key) =>
        key !== "requestId" &&
        key !== "channelId" &&
        key !== "rootThreadTs" &&
        key !== "sessionId",
    ) ||
    countLiteralKey(value, "requestId") !== 1 ||
    countLiteralKey(value, "channelId") !== 1 ||
    countLiteralKey(value, "rootThreadTs") !== 1 ||
    (hasSession && countLiteralKey(value, "sessionId") !== 1) ||
    (hasSession &&
      (typeof record.sessionId !== "string" ||
        record.sessionId.length < 1 ||
        record.sessionId.length > 256))
  ) {
    throw new Error("Invalid approval action payload");
  }
  return {
    requestId: parsed.requestId,
    channelId: parsed.channelId,
    rootThreadTs: parsed.rootThreadTs,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  };
}

function countLiteralKey(value: string, key: string): number {
  return [...value.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
}
