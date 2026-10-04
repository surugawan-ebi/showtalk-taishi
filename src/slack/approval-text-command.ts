/**
 * The deliberately small text protocol accepted for Slack approvals.
 *
 * This parser only authenticates the shape and origin fields present on the
 * message event.  The caller must still bind the returned values to its
 * pending request, approver allow-list, expiry, and one-shot state.
 */

const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{1,127}$/u;
const USER_ID_PATTERN = /^[UW][A-Z0-9]{1,127}$/u;
const TIMESTAMP_PATTERN = /^[0-9]{1,32}\.[0-9]{6}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/u;

export interface ApprovalTextAttributionProfile {
  readonly appId: string;
  readonly userId: string;
}

// Exact installed Slack integration format observed via conversations.replies.
// These are public application/attribution identifiers, never approver IDs or
// proof of who authored a message. Unknown installations fail closed. Changes
// require a deliberate profile update; never learn this profile from a reply.
const CHATGPT_ATTRIBUTION_PROFILE: ApprovalTextAttributionProfile = Object.freeze({
  appId: "A097V82EGG2",
  userId: "U0BMNN5TQMA",
});

export interface ApprovalTextCommand {
  readonly decision: "approve" | "reject";
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly userId: string;
  readonly messageTs: string;
  readonly attribution?: {
    readonly kind: "chatgpt_slack_footer_v1";
    readonly appId: string;
    readonly userId: string;
  };
}

/**
 * Parse an exact approval command from a raw Slack `message` event.
 *
 * Invalid, edited, bot-authored, quoted, or misordered messages return
 * `undefined`. Formatting is limited to the exact connector context below.
 * Request binding, approver authorization, expiry, and
 * one-shot replay protection intentionally remain the caller's responsibility.
 */
export function parseApprovalTextCommand(
  event: unknown,
  attributionProfile: ApprovalTextAttributionProfile = CHATGPT_ATTRIBUTION_PROFILE,
): ApprovalTextCommand | undefined {
  const record = asRecord(event);
  if (record === undefined || record.type !== "message") return undefined;
  if (
    hasAnyOwnProperty(record, [
      "subtype",
      "bot_id",
      "bot_profile",
      "edited",
      "hidden",
      "attachments",
      "files",
      "x_files",
      "message",
      "previous_message",
    ])
  ) {
    return undefined;
  }

  const channelId = record.channel;
  const userId = record.user;
  const messageTs = record.ts;
  const rootThreadTs = record.thread_ts;
  const text = record.text;
  if (
    typeof channelId !== "string" ||
    !matchesPattern(channelId, CHANNEL_ID_PATTERN) ||
    typeof userId !== "string" ||
    !matchesPattern(userId, USER_ID_PATTERN) ||
    typeof messageTs !== "string" ||
    !isCanonicalTimestamp(messageTs) ||
    typeof rootThreadTs !== "string" ||
    !isCanonicalTimestamp(rootThreadTs) ||
    messageTs === rootThreadTs ||
    compareSlackTimestamps(messageTs, rootThreadTs) <= 0 ||
    typeof text !== "string"
  ) {
    return undefined;
  }

  const plain = parseCommandText(text);
  const attributed = plain === undefined
    ? parseAttributedCommand(record, text, attributionProfile)
    : undefined;
  const parsedText = plain ?? attributed;
  if (parsedText === undefined) return undefined;
  if (plain !== undefined &&
      (Object.hasOwn(record, "app_id") || !validateBlocks(record, text))) return undefined;
  if (attributed !== undefined && userId === attributionProfile.userId) return undefined;

  return {
    decision: parsedText.decision,
    requestId: parsedText.requestId,
    channelId,
    rootThreadTs,
    userId,
    messageTs,
    ...(attributed === undefined ? {} : {
      attribution: {
        kind: "chatgpt_slack_footer_v1" as const,
        appId: attributionProfile.appId,
        userId: attributionProfile.userId,
      },
    }),
  };
}

function parseAttributedCommand(
  record: Readonly<Record<string, unknown>>,
  text: string,
  profile: ApprovalTextAttributionProfile,
): ReturnType<typeof parseCommandText> {
  if (!matchesPattern(profile.appId, /^A[A-Z0-9]{1,127}$/u) ||
      !matchesPattern(profile.userId, USER_ID_PATTERN) ||
      record.app_id !== profile.appId) return undefined;
  const footer = `*使用して送信されました* <@${profile.userId}>`;
  const suffix = ` ${footer}`;
  if (!text.endsWith(suffix)) return undefined;
  const commandText = text.slice(0, -suffix.length);
  const parsed = parseCommandText(commandText);
  if (parsed === undefined) return undefined;

  // Slack's fallback text uses a space; the visible line break comes from a
  // separate context block. Require both observed representations, unchanged.
  const blocks = record.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 2) return undefined;
  if (!validateBlocks({ blocks: [blocks[0]] }, commandText)) return undefined;
  const commandBlock = asRecord(blocks[0]);
  const sections = commandBlock?.elements as unknown[];
  const leaves = asRecord(sections[0])?.elements;
  if (!Array.isArray(leaves) || leaves.length !== 1) return undefined;
  const context = asRecord(blocks[1]);
  if (context === undefined || context.type !== "context" ||
      !hasOnlyKeys(context, ["type", "block_id", "elements"]) ||
      !validBlockId(context)) return undefined;
  if (!Array.isArray(context.elements) || context.elements.length !== 1) return undefined;
  const element = asRecord(context.elements[0]);
  if (element === undefined || element.type !== "mrkdwn" ||
      element.text !== footer || element.verbatim !== false ||
      !hasOnlyKeys(element, ["type", "text", "verbatim"])) return undefined;
  return parsed;
}

/**
 * Build the human-readable hint included with an approval message.
 *
 * The identifier grammar is intentionally shared with the parser, so the
 * returned text cannot introduce Slack markup, mentions, or command syntax
 * that would later be interpreted differently.  The hint uses a literal
 * command on each side to make copy/paste behavior unambiguous.
 */
export function buildApprovalTextCommandHint(
  requestId: string,
): string | undefined {
  const match = typeof requestId === "string"
    ? REQUEST_ID_PATTERN.exec(requestId)
    : null;
  if (
    typeof requestId !== "string" ||
    requestId.length > 256 ||
    match?.[0] !== requestId
  ) {
    return undefined;
  }
  return `承認 ${requestId} または 拒否 ${requestId}`;
}

function parseCommandText(
  text: string,
): { readonly decision: "approve" | "reject"; readonly requestId: string } | undefined {
  // `$` accepts a position immediately before a final line terminator in
  // JavaScript.  Comparing the complete match and the input keeps newlines
  // out of this one-line protocol.
  const match = /^(承認|拒否) ([A-Za-z0-9][A-Za-z0-9:_-]{0,255})$/u.exec(text);
  if (match === null || match[0] !== text) return undefined;
  return {
    decision: match[1] === "承認" ? "approve" : "reject",
    requestId: match[2]!,
  };
}

function validateBlocks(record: Readonly<Record<string, unknown>>, text: string): boolean {
  if (!Object.hasOwn(record, "blocks")) return true;
  const blocks = record.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 1) return false;
  const block = asRecord(blocks[0]);
  if (block === undefined || block.type !== "rich_text") return false;
  if (!hasOnlyKeys(block, ["type", "block_id", "elements"])) return false;
  if (!validBlockId(block)) return false;

  const sections = block.elements;
  if (!Array.isArray(sections) || sections.length !== 1) return false;
  const section = asRecord(sections[0]);
  if (
    section === undefined ||
    section.type !== "rich_text_section" ||
    !hasOnlyKeys(section, ["type", "elements"])
  ) {
    return false;
  }
  const leaves = section.elements;
  if (!Array.isArray(leaves) || leaves.length < 1) return false;

  let reconstructed = "";
  for (const leafValue of leaves) {
    const leaf = asRecord(leafValue);
    if (
      leaf === undefined ||
      leaf.type !== "text" ||
      !hasOnlyKeys(leaf, ["type", "text"]) ||
      typeof leaf.text !== "string"
    ) {
      return false;
    }
    reconstructed += leaf.text;
  }
  return reconstructed === text;
}

function validBlockId(block: Readonly<Record<string, unknown>>): boolean {
  return !Object.hasOwn(block, "block_id") ||
    (typeof block.block_id === "string" && block.block_id.length > 0 && block.block_id.length <= 255);
}

function isCanonicalTimestamp(value: string): boolean {
  return value.length <= 32 && matchesPattern(value, TIMESTAMP_PATTERN);
}

function matchesPattern(value: string, pattern: RegExp): boolean {
  return pattern.exec(value)?.[0] === value;
}

function compareSlackTimestamps(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const leftSeconds = BigInt(leftParts[0]!);
  const rightSeconds = BigInt(rightParts[0]!);
  if (leftSeconds !== rightSeconds) return leftSeconds > rightSeconds ? 1 : -1;
  const leftMicros = Number(leftParts[1]!);
  const rightMicros = Number(rightParts[1]!);
  return leftMicros === rightMicros ? 0 : leftMicros > rightMicros ? 1 : -1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasAnyOwnProperty(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => Object.hasOwn(record, key));
}

function hasOnlyKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}
