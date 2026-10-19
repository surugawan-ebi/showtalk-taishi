import { CHATGPT_ATTRIBUTION_PROFILE } from "./approval-text-command.js";

export interface TrustedBotMessageSource {
  readonly workspaceId: string;
  readonly userId: string;
  readonly botId: string;
}

export type DotSlackMessageOrigin =
  | "dot_bot"
  | "dot_chatgpt_connector";

export type DotOriginRejectionReason =
  | "app_identity_mismatch"
  | "attribution_text_mismatch"
  | "body_elements_unsupported"
  | "block_envelope_unsupported"
  | "fallback_mismatch"
  | "footer_block_unsupported"
  | "message_envelope_unsupported"
  | "unsupported_field"
  | "unsupported_leaf_type";

export type DotOriginBodyElementType =
  | "list"
  | "non_object"
  | "preformatted"
  | "quote"
  | "section"
  | "truncated"
  | "unknown";

export interface DotOriginRejectionDiagnostic {
  readonly component: "showtalk.dot_origin";
  readonly version: 1;
  readonly event: "classification_rejected";
  readonly reason: DotOriginRejectionReason;
  /** Fixed buckets only. `8_plus` prevents attacker-controlled counts in logs. */
  readonly sectionCount: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8_plus";
  /** Fixed type classifiers only; raw Slack type strings are never copied. */
  readonly bodyElementTypes: readonly DotOriginBodyElementType[];
}

const DIAGNOSTIC_ELEMENT_LIMIT = 8;
const DIAGNOSTIC_LIFETIME_LIMIT = 32;
const DIAGNOSTIC_REPEAT_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Classifies one already-received Slack message for notification presentation.
 *
 * This is deliberately not an authorisation signal. In particular, the
 * ChatGPT attribution footer is accepted only in the exact installation shape
 * shared with the approval-text parser, and the authenticated Slack `user`
 * remains the source/responder identity everywhere else.
 */
export function classifyDotSlackMessage(
  event: unknown,
  workspaceId?: string,
  trustedBotMessageSources: readonly TrustedBotMessageSource[] = [],
): DotSlackMessageOrigin | undefined {
  const record = asRecord(event);
  if (record === undefined || record.type !== "message") return undefined;

  if (isTrustedBotSlackMessage(
    record,
    workspaceId,
    trustedBotMessageSources,
  )) return "dot_bot";

  // Keep the existing human-message boundary: a typical bot_message is not
  // newly accepted merely because its user ID resembles the dot bot.
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
  if (isVerifiedChatGptSlackAttribution(record)) {
    return "dot_chatgpt_connector";
  }
  return undefined;
}

/**
 * Accepts only an explicitly configured bot identity in its verified workspace.
 * The workspace value must come from the Slack event envelope, not message
 * text, display names, or other self-reported content.
 */
export function isTrustedBotSlackMessage(
  event: unknown,
  workspaceId: string | undefined,
  trustedBotMessageSources: readonly TrustedBotMessageSource[],
): boolean {
  const record = asRecord(event);
  return record?.type === "message" &&
    (record.subtype === undefined || record.subtype === "bot_message") &&
    typeof workspaceId === "string" &&
    trustedBotMessageSources.some((source) =>
      source.workspaceId === workspaceId &&
      source.userId === record.user &&
      source.botId === record.bot_id
    ) &&
    !hasAnyOwnProperty(record, [
      "edited",
      "hidden",
      "message",
      "previous_message",
    ]);
}

function isVerifiedChatGptSlackAttribution(
  record: Readonly<Record<string, unknown>>,
): boolean {
  if (
    record.app_id !== CHATGPT_ATTRIBUTION_PROFILE.appId ||
    typeof record.text !== "string"
  ) {
    return false;
  }
  const footer = `*使用して送信されました* <@${CHATGPT_ATTRIBUTION_PROFILE.userId}>`;
  const suffix = ` ${footer}`;
  if (!record.text.endsWith(suffix)) return false;
  const commandText = record.text.slice(0, -suffix.length);
  if (commandText.length === 0) return false;

  // Match the existing verified connector representation: a single rich-text
  // body block followed by one exact footer context block. This is a source
  // hint only and never changes approval identity or authorization.
  const blocks = record.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 2) return false;
  const body = asRecord(blocks[0]);
  if (
    body === undefined || body.type !== "rich_text" ||
    !hasOnlyKeys(body, ["type", "block_id", "elements"]) ||
    !validBlockId(body)
  ) return false;
  const sections = body.elements;
  if (!Array.isArray(sections) || sections.length !== 1) return false;
  const section = asRecord(sections[0]);
  if (
    section === undefined || section.type !== "rich_text_section" ||
    !hasOnlyKeys(section, ["type", "elements"])
  ) return false;
  const leaves = section.elements;
  if (!Array.isArray(leaves) || leaves.length < 1 ||
      !matchesCanonicalRichTextFallback(leaves, commandText)) return false;

  const context = asRecord(blocks[1]);
  if (
    context === undefined || context.type !== "context" ||
    !hasOnlyKeys(context, ["type", "block_id", "elements"]) ||
    !validBlockId(context)
  ) return false;
  if (!Array.isArray(context.elements) || context.elements.length !== 1) return false;
  const element = asRecord(context.elements[0]);
  return element !== undefined && element.type === "mrkdwn" &&
    element.text === footer && element.verbatim === false &&
    hasOnlyKeys(element, ["type", "text", "verbatim"]);
}

/**
 * Match Slack's canonical fallback text for the small rich-text subset used by
 * the ChatGPT connector. URLs and user mentions are separate rich-text leaves,
 * so requiring one plain-text leaf rejects otherwise verified long messages.
 *
 * Keep this deliberately narrower than a general rich-text renderer. Unknown
 * leaf types and fields fail closed, while every accepted leaf must still
 * reproduce the exact top-level message text.
 */
function matchesCanonicalRichTextFallback(
  leaves: readonly unknown[],
  expected: string,
): boolean {
  let offsets = new Set([0]);
  for (const value of leaves) {
    const candidates = canonicalLeafFallbacks(value);
    if (candidates === undefined) return false;
    const nextOffsets = new Set<number>();
    for (const offset of offsets) {
      for (const candidate of candidates) {
        if (expected.startsWith(candidate, offset)) {
          nextOffsets.add(offset + candidate.length);
        }
      }
    }
    if (nextOffsets.size === 0) return false;
    offsets = nextOffsets;
  }
  return offsets.has(expected.length);
}

function canonicalLeafFallbacks(value: unknown): readonly string[] | undefined {
  const leaf = asRecord(value);
  if (leaf === undefined) return undefined;

  if (leaf.type === "text") {
    return hasOnlyKeys(leaf, ["type", "text"]) && typeof leaf.text === "string"
      ? [leaf.text]
      : undefined;
  }

  if (leaf.type === "user") {
    if (!hasOnlyKeys(leaf, ["type", "user_id", "from_llm"]) ||
        !validOptionalTrue(leaf, "from_llm") ||
        typeof leaf.user_id !== "string" ||
        !/^[UW][A-Z0-9]{1,127}$/u.test(leaf.user_id)) return undefined;
    return [`<@${leaf.user_id}>`];
  }

  if (leaf.type === "link") {
    if (!hasOnlyKeys(leaf, ["type", "url", "text", "from_llm"]) ||
        !validOptionalTrue(leaf, "from_llm") ||
        typeof leaf.url !== "string" ||
        !isCanonicalWebUrl(leaf.url) ||
        (Object.hasOwn(leaf, "text") && typeof leaf.text !== "string")) {
      return undefined;
    }
    if (typeof leaf.text === "string") {
      return [`<${leaf.url}|${leaf.text}>`];
    }
    return [leaf.url, `<${leaf.url}>`];
  }

  return undefined;
}

function validOptionalTrue(
  record: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  return !Object.hasOwn(record, key) || record[key] === true;
}

function isCanonicalWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

export function shouldSuppressDotUserMention(
  event: unknown,
  workspaceId?: string,
  trustedBotMessageSources: readonly TrustedBotMessageSource[] = [],
): boolean {
  return classifyDotSlackMessage(
    event,
    workspaceId,
    trustedBotMessageSources,
  ) !== undefined;
}

/**
 * Returns a bounded, payload-free explanation for a rejected connector-shaped
 * message. This is diagnostic-only and never participates in acceptance,
 * identity, authorization, or notification decisions.
 */
export function diagnoseRejectedDotSlackMessage(
  event: unknown,
): DotOriginRejectionDiagnostic | undefined {
  if (classifyDotSlackMessage(event) !== undefined) return undefined;
  const record = asRecord(event);
  if (record === undefined || record.type !== "message") return undefined;

  const footer = `*使用して送信されました* <@${CHATGPT_ATTRIBUTION_PROFILE.userId}>`;
  const suffix = ` ${footer}`;
  const exactFooter = typeof record.text === "string" && record.text.endsWith(suffix);
  const exactApp = record.app_id === CHATGPT_ATTRIBUTION_PROFILE.appId;
  // Avoid diagnosing ordinary human traffic. Either exact connector identity
  // or its exact attribution suffix must be present before emitting anything.
  if (!exactApp && !exactFooter) return undefined;

  const bodyElements = diagnosticBodyElements(record);
  const diagnostic = (
    reason: DotOriginRejectionReason,
  ): DotOriginRejectionDiagnostic => ({
    component: "showtalk.dot_origin",
    version: 1,
    event: "classification_rejected",
    reason,
    sectionCount: sectionCountBucket(bodyElements),
    bodyElementTypes: diagnosticBodyElementTypes(bodyElements),
  });

  if (hasAnyOwnProperty(record, [
    "subtype", "bot_id", "bot_profile", "edited", "hidden", "attachments",
    "files", "x_files", "message", "previous_message",
  ])) return diagnostic("message_envelope_unsupported");
  if (!exactApp) return diagnostic("app_identity_mismatch");
  if (!exactFooter || typeof record.text !== "string" ||
      record.text.length === suffix.length) {
    return diagnostic("attribution_text_mismatch");
  }

  const blocks = record.blocks;
  if (!Array.isArray(blocks) || blocks.length !== 2) {
    return diagnostic("block_envelope_unsupported");
  }
  const body = asRecord(blocks[0]);
  if (body === undefined || body.type !== "rich_text" || !validBlockId(body)) {
    return diagnostic("block_envelope_unsupported");
  }
  if (!hasOnlyKeys(body, ["type", "block_id", "elements"])) {
    return diagnostic("unsupported_field");
  }
  if (!Array.isArray(body.elements) || body.elements.length !== 1) {
    return diagnostic("body_elements_unsupported");
  }
  const section = asRecord(body.elements[0]);
  if (section === undefined || section.type !== "rich_text_section") {
    return diagnostic("body_elements_unsupported");
  }
  if (!hasOnlyKeys(section, ["type", "elements"])) {
    return diagnostic("unsupported_field");
  }
  const leaves = section.elements;
  if (!Array.isArray(leaves) || leaves.length < 1) {
    return diagnostic("fallback_mismatch");
  }
  const leafReason = diagnosticLeafRejection(leaves);
  if (leafReason !== undefined) return diagnostic(leafReason);
  const commandText = record.text.slice(0, -suffix.length);
  if (!matchesCanonicalRichTextFallback(leaves, commandText)) {
    return diagnostic("fallback_mismatch");
  }

  const context = asRecord(blocks[1]);
  if (context === undefined || context.type !== "context" || !validBlockId(context)) {
    return diagnostic("footer_block_unsupported");
  }
  if (!hasOnlyKeys(context, ["type", "block_id", "elements"])) {
    return diagnostic("unsupported_field");
  }
  if (!Array.isArray(context.elements) || context.elements.length !== 1) {
    return diagnostic("footer_block_unsupported");
  }
  const element = asRecord(context.elements[0]);
  if (element !== undefined && !hasOnlyKeys(element, ["type", "text", "verbatim"])) {
    return diagnostic("unsupported_field");
  }
  return diagnostic("footer_block_unsupported");
}

/**
 * Creates a best-effort reporter with fixed per-shape deduplication and a hard
 * process-lifetime cap. Diagnostic failures never affect Slack turn handling.
 */
export function createDotOriginDiagnosticReporter(
  write: (line: string) => void = console.info,
  now: () => number = Date.now,
): (event: unknown) => void {
  const lastEmission = new Map<string, number>();
  let emitted = 0;
  return (event: unknown): void => {
    if (emitted >= DIAGNOSTIC_LIFETIME_LIMIT) return;
    const diagnostic = diagnoseRejectedDotSlackMessage(event);
    if (diagnostic === undefined) return;
    const key = JSON.stringify([
      diagnostic.reason,
      diagnostic.sectionCount,
      diagnostic.bodyElementTypes,
    ]);
    const observedAt = now();
    const previous = lastEmission.get(key);
    if (previous !== undefined &&
        observedAt - previous < DIAGNOSTIC_REPEAT_WINDOW_MS) return;
    lastEmission.set(key, observedAt);
    emitted += 1;
    try {
      write(JSON.stringify(diagnostic));
    } catch {
      // Diagnostics must never change delivery, authorization, or projection.
    }
  };
}

function diagnosticBodyElements(
  record: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  const blocks = record.blocks;
  if (!Array.isArray(blocks)) return [];
  const body = asRecord(blocks[0]);
  return Array.isArray(body?.elements) ? body.elements : [];
}

function diagnosticBodyElementTypes(
  elements: readonly unknown[],
): readonly DotOriginBodyElementType[] {
  const classified: DotOriginBodyElementType[] = elements
    .slice(0, DIAGNOSTIC_ELEMENT_LIMIT).map((value): DotOriginBodyElementType => {
    const element = asRecord(value);
    if (element === undefined) return "non_object";
    switch (element.type) {
      case "rich_text_section": return "section";
      case "rich_text_list": return "list";
      case "rich_text_preformatted": return "preformatted";
      case "rich_text_quote": return "quote";
      default: return "unknown";
    }
    });
  if (elements.length > DIAGNOSTIC_ELEMENT_LIMIT) classified.push("truncated");
  return classified;
}

function sectionCountBucket(
  elements: readonly unknown[],
): DotOriginRejectionDiagnostic["sectionCount"] {
  const count = elements.reduce<number>((total, value) =>
    total + (asRecord(value)?.type === "rich_text_section" ? 1 : 0), 0);
  return count >= 8 ? "8_plus" : String(count) as DotOriginRejectionDiagnostic["sectionCount"];
}

function diagnosticLeafRejection(
  leaves: readonly unknown[],
): "unsupported_field" | "unsupported_leaf_type" | undefined {
  for (const value of leaves) {
    const leaf = asRecord(value);
    if (leaf === undefined) return "unsupported_leaf_type";
    if (leaf.type === "text") {
      if (!hasOnlyKeys(leaf, ["type", "text"])) return "unsupported_field";
      continue;
    }
    if (leaf.type === "user") {
      if (!hasOnlyKeys(leaf, ["type", "user_id", "from_llm"])) {
        return "unsupported_field";
      }
      continue;
    }
    if (leaf.type === "link") {
      if (!hasOnlyKeys(leaf, ["type", "url", "text", "from_llm"])) {
        return "unsupported_field";
      }
      continue;
    }
    return "unsupported_leaf_type";
  }
  return undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
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

function validBlockId(record: Readonly<Record<string, unknown>>): boolean {
  return !Object.hasOwn(record, "block_id") ||
    (typeof record.block_id === "string" &&
      record.block_id.length > 0 && record.block_id.length <= 255);
}
