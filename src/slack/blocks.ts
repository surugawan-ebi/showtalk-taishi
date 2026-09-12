import type { KnownBlock } from "@slack/types";

import type { AgentApproval } from "../core/index.js";
import { formatAgentTextForSlack } from "./text-format.js";

export const APPROVAL_ACTION_PREFIX = "taishi.approval.";

export interface ApprovalActionValue {
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly sessionId?: string;
}

export function buildApprovalBlocks(
  summary: string,
  value: ApprovalActionValue,
  availableDecisions: readonly AgentApproval["decision"][] = [
    "allow_once",
    "allow_session",
    "deny",
    "cancel",
  ],
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
      elements: availableDecisions.map((decision) =>
        approvalButton(
          decision === "allow_once"
            ? "Allow once"
            : decision === "allow_session"
              ? "Allow session"
              : decision === "allow_command_rule"
                ? "正確なコマンド規則を今後許可"
              : decision === "deny"
                ? "Deny"
                : "Cancel",
          decision,
          encoded,
          decision === "allow_once"
            ? "primary"
            : decision === "deny"
              ? "danger"
              : undefined,
        )
      ),
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
    ...(decision === "allow_session" || decision === "allow_command_rule"
      ? {
          confirm: {
            title: {
              type: "plain_text" as const,
              text: decision === "allow_session"
                ? "Allow for session?"
                : "今後も許可しますか？",
            },
            text: {
              type: "mrkdwn" as const,
              text: decision === "allow_session"
                ? "This allows matching requests for the active Koe session."
                : "Codexが提示した正確なコマンド規則に一致する、今後の実行を許可します。",
            },
            confirm: {
              type: "plain_text" as const,
              text: decision === "allow_session"
                ? "Allow session"
                : "規則を許可",
            },
            deny: {
              type: "plain_text" as const,
              text: decision === "allow_session" ? "Go back" : "戻る",
            },
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
    decision === "allow_command_rule" ||
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
    !Object.hasOwn(record, "messageTs") ||
    typeof record.messageTs !== "string" ||
    keys.length !== (hasSession ? 5 : 4) ||
    keys.some(
      (key) =>
        key !== "requestId" &&
        key !== "channelId" &&
        key !== "rootThreadTs" &&
        key !== "messageTs" &&
        key !== "sessionId",
    ) ||
    countLiteralKey(value, "requestId") !== 1 ||
    countLiteralKey(value, "channelId") !== 1 ||
    countLiteralKey(value, "rootThreadTs") !== 1 ||
    countLiteralKey(value, "messageTs") !== 1 ||
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
    messageTs: record.messageTs,
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
  };
}

function countLiteralKey(value: string, key: string): number {
  return [...value.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
}
