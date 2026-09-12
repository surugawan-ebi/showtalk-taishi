import type { KnownBlock } from "@slack/types";

export const GIT_APPROVAL_RECOVERY_ACTION_PREFIX = "taishi.git_recovery.";

const MAX_SECTION_TEXT_LENGTH = 3_000;
const RECOVERY_HEADING = "*このGit承認は古いカードから再開できません*\n";
const RECOVERY_TRAILER =
  "\n\n元の依頼がまだ処理中の場合、その最終結果はこの案内とは別に届きます。この案内が新しいターンを開始することはありません。";
const MAX_TRACKED_RECOVERY_MESSAGES = 4_096;

export type GitApprovalRecoveryDecision = "reprepare" | "hold";

export interface GitApprovalRecoveryActionValue {
  readonly version: 1;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
}

/**
 * Keeps a recovery action single-use. Entries are intentionally not evicted:
 * replaying an old action is
 * safer to reject than silently making it usable again. A hard upper bound
 * fails closed without growing process memory indefinitely.
 */
export class GitApprovalRecoveryActionTracker {
  readonly #used = new Set<string>();

  tryStart(key: string): boolean {
    if (this.#used.has(key)) return false;
    if (this.#used.size >= MAX_TRACKED_RECOVERY_MESSAGES) {
      throw new Error("Git approval recovery tracker capacity reached");
    }
    this.#used.add(key);
    return true;
  }

}

export function buildGitApprovalRecoveryBlocks(
  message: string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          RECOVERY_HEADING +
          boundedEscapedSlackText(
            message,
            MAX_SECTION_TEXT_LENGTH -
              RECOVERY_HEADING.length -
              RECOVERY_TRAILER.length,
          ) + RECOVERY_TRAILER,
      },
    },
  ];
}

export function parseGitApprovalRecoveryDecision(
  actionId: string,
): GitApprovalRecoveryDecision | undefined {
  if (!actionId.startsWith(GIT_APPROVAL_RECOVERY_ACTION_PREFIX)) return undefined;
  const decision = actionId.slice(GIT_APPROVAL_RECOVERY_ACTION_PREFIX.length);
  return decision === "reprepare" || decision === "hold" ? decision : undefined;
}

export function parseGitApprovalRecoveryActionValue(
  value: string,
): GitApprovalRecoveryActionValue {
  if (value.length < 1 || value.length > 1_000) throw invalidPayload();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidPayload();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidPayload();
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.channelId !== "string" ||
    !/^C[A-Z0-9]{1,127}$/u.test(record.channelId) ||
    typeof record.rootThreadTs !== "string" ||
    !/^\d{1,20}\.\d{1,20}$/u.test(record.rootThreadTs) ||
    typeof record.messageTs !== "string" ||
    !/^\d{1,20}\.\d{1,20}$/u.test(record.messageTs) ||
    Object.keys(record).length !== 4 ||
    countLiteralKey(value, "version") !== 1 ||
    countLiteralKey(value, "channelId") !== 1 ||
    countLiteralKey(value, "rootThreadTs") !== 1 ||
    countLiteralKey(value, "messageTs") !== 1
  ) {
    throw invalidPayload();
  }
  return {
    version: 1,
    channelId: record.channelId,
    rootThreadTs: record.rootThreadTs,
    messageTs: record.messageTs,
  };
}

function countLiteralKey(value: string, key: string): number {
  return [...value.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
}

function escapeSlack(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function boundedEscapedSlackText(value: string, maxLength: number): string {
  let result = "";
  let truncated = false;
  for (const character of value) {
    const escaped = escapeSlack(character);
    if (result.length + escaped.length > maxLength) {
      truncated = true;
      break;
    }
    result += escaped;
  }
  if (!truncated) return result;
  return result.length < maxLength ? `${result}…` : `${result.slice(0, -1)}…`;
}

function invalidPayload(): Error {
  return new Error("Invalid Git approval recovery payload");
}
