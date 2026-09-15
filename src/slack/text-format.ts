import { Buffer } from "node:buffer";

const MARKDOWN_LINK = /\[([^\]\r\n]{0,256})\]\(\s*(<[^>\r\n]{1,2048}>|[^)\s\r\n]{1,2048})\s*\)/gu;
const INCOMPLETE_LOCAL_LINK = /\[([^\]\r\n]{0,256})\]\(\s*<?(?:\/|file:)[^)\r\n]*$/u;
const HOME_PATH = /(^|[\s([{"'=])\/(?:Users|home)\/[^/\s]+(?=\/)/gu;

/** Converts the small Markdown subset commonly emitted by coding Agents into
 * safe, readable Slack mrkdwn without exposing local link targets. */
export function formatAgentTextForSlack(
  value: string,
  maxLength: number,
  maxUtf8Bytes = Number.POSITIVE_INFINITY,
): string {
  if (maxLength <= 0) return "";
  if (maxUtf8Bytes <= 0) return "";
  const escaped = escapeSlackBounded(
    normalizeMarkdown(value),
    maxLength,
    maxUtf8Bytes,
  );
  return closeMarkdownCode(
    escaped.text,
    maxLength,
    maxUtf8Bytes,
    escaped.truncated,
  );
}

/** Splits already escaped Slack mrkdwn without breaking entities, Unicode, or
 * fenced/inline code across message boundaries. */
export function splitSlackText(
  value: string,
  maxLength: number,
  maxUtf8Bytes = Number.POSITIVE_INFINITY,
): string[] {
  if (maxLength < 32) throw new RangeError("Slack chunk length must be at least 32");
  if (maxUtf8Bytes < 32) {
    throw new RangeError("Slack chunk byte length must be at least 32");
  }
  if (value.length === 0) return [];

  const chunks: string[] = [];
  let remaining = value;
  let reopen = "";
  while (remaining.length > 0) {
    const rawBudget = Math.max(1, maxLength - reopen.length - 8);
    const rawByteBudget = Math.max(
      1,
      maxUtf8Bytes - utf8ByteLength(reopen) - 8,
    );
    const safeLength = preferredSafePrefixLength(
      remaining,
      rawBudget,
      rawByteBudget,
    );
    const raw = remaining.slice(0, safeLength);
    remaining = remaining.slice(safeLength);

    const body = `${reopen}${raw}`;
    const state = requiredCodeState(body);
    const chunk = `${body}${state.closure}`;
    if (chunk.length > maxLength || utf8ByteLength(chunk) > maxUtf8Bytes) {
      throw new Error("Slack chunk formatting exceeded its configured bound");
    }
    chunks.push(chunk);
    reopen = state.reopen;
  }
  return chunks;
}

function normalizeMarkdown(value: string): string {
  const lines = value.split("\n");
  const output: string[] = [];
  let fence: { readonly character: string; readonly length: number } | undefined;

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    const fenceLine = parseFenceLine(line);
    if (fence === undefined && fenceLine !== undefined) {
      fence = { character: fenceLine.character, length: fenceLine.length };
      output.push("```");
      index += 1;
      continue;
    }
    if (
      fence !== undefined &&
      fenceLine !== undefined &&
      fenceLine.character === fence.character &&
      fenceLine.length >= fence.length &&
      fenceLine.suffix.trim().length === 0
    ) {
      fence = undefined;
      output.push("```");
      index += 1;
      continue;
    }

    if (fence === undefined) {
      const table = readSimpleTable(lines, index);
      if (table !== undefined) {
        output.push(...renderTable(table.headers, table.rows));
        index = table.nextIndex;
        continue;
      }
      output.push(normalizeSlackLine(line));
    } else {
      output.push(line);
    }
    index += 1;
  }

  return output.join("\n");
}

function normalizeSlackLine(line: string): string {
  const horizontalRule = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u;
  if (horizontalRule.test(line)) return "──────────";

  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(line);
  if (heading !== null) {
    const text = normalizeInlineMarkdown(heading[1] ?? "");
    return text.length === 0 ? "" : `*${stripOuterSlackBold(text)}*`;
  }

  const task = /^(\s*)[-+*]\s+\[([ xX])\]\s+(.*)$/u.exec(line);
  if (task !== null) {
    const marker = (task[2] ?? " ").toLowerCase() === "x" ? "☑" : "☐";
    return `${normalizeListIndent(task[1] ?? "")}${marker} ${normalizeInlineMarkdown(task[3] ?? "")}`;
  }

  const unordered = /^(\s*)[-+*]\s+(.*)$/u.exec(line);
  if (unordered !== null) {
    return `${normalizeListIndent(unordered[1] ?? "")}• ${normalizeInlineMarkdown(unordered[2] ?? "")}`;
  }

  const ordered = /^(\s*)(\d{1,6})[.)]\s+(.*)$/u.exec(line);
  if (ordered !== null) {
    return `${normalizeListIndent(ordered[1] ?? "")}${ordered[2]}. ${normalizeInlineMarkdown(ordered[3] ?? "")}`;
  }

  const quote = /^(\s*)(>+)\s?(.*)$/u.exec(line);
  if (quote !== null) {
    const depth = Math.min(3, (quote[2] ?? ">").length);
    return `${normalizeListIndent(quote[1] ?? "")}${"│ ".repeat(depth)}${normalizeInlineMarkdown(quote[3] ?? "")}`;
  }

  return normalizeInlineMarkdown(line);
}

function normalizeListIndent(indent: string): string {
  const width = [...indent].reduce(
    (total, character) => total + (character === "\t" ? 2 : 1),
    0,
  );
  return "  ".repeat(Math.min(3, Math.floor(width / 2)));
}

function stripOuterSlackBold(value: string): string {
  return value.startsWith("*") && value.endsWith("*") && value.length > 2
    ? value.slice(1, -1)
    : value;
}

interface SimpleTable {
  readonly headers: string[];
  readonly rows: string[][];
  readonly nextIndex: number;
}

function readSimpleTable(lines: string[], index: number): SimpleTable | undefined {
  const headers = parseSimpleTableRow(lines[index]);
  const separators = parseSimpleTableRow(lines[index + 1]);
  if (
    headers === undefined ||
    separators === undefined ||
    headers.length < 2 ||
    separators.length !== headers.length ||
    !separators.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()))
  ) {
    return undefined;
  }

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length) {
    const row = parseSimpleTableRow(lines[nextIndex]);
    if (row === undefined || row.length !== headers.length) break;
    rows.push(row);
    nextIndex += 1;
  }
  return rows.length === 0 ? undefined : { headers, rows, nextIndex };
}

function parseSimpleTableRow(line: string | undefined): string[] | undefined {
  if (line === undefined) return undefined;
  const trimmed = line.trim();
  if (
    !trimmed.startsWith("|") ||
    !trimmed.endsWith("|") ||
    trimmed.includes("\\|") ||
    /`[^`]*\|[^`]*`/u.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(headers: string[], rows: string[][]): string[] {
  return rows.map((row) => {
    const first = normalizeInlineMarkdown(row[0] ?? "");
    if (row.length === 2) {
      return `• ${first} — ${normalizeInlineMarkdown(row[1] ?? "")}`;
    }
    const details = row
      .slice(1)
      .map((cell, index) => {
        const header = normalizeInlineMarkdown(headers[index + 1] ?? `Column ${index + 2}`);
        return `${header}: ${normalizeInlineMarkdown(cell)}`;
      })
      .join(" · ");
    return `• ${first}${details.length === 0 ? "" : ` — ${details}`}`;
  });
}

function normalizeInlineMarkdown(line: string): string {
  let output = "";
  let cursor = 0;
  let inlineFenceLength = 0;
  const fencePattern = /`+/gu;

  for (const match of line.matchAll(fencePattern)) {
    const position = match.index;
    const fence = match[0];
    const segment = line.slice(cursor, position);
    output += inlineFenceLength === 0 ? normalizePlainSegment(segment) : segment;
    output += fence;
    if (inlineFenceLength === 0) {
      inlineFenceLength = fence.length;
    } else if (inlineFenceLength === fence.length) {
      inlineFenceLength = 0;
    }
    cursor = position + fence.length;
  }
  const tail = line.slice(cursor);
  output += inlineFenceLength === 0 ? normalizePlainSegment(tail) : tail;
  return output;
}

function normalizePlainSegment(segment: string): string {
  const normalized = segment
    .replace(MARKDOWN_LINK, (_match, rawLabel: string, rawTarget: string) =>
      renderMarkdownLink(rawLabel, rawTarget),
    )
    .replace(HOME_PATH, "$1~");
  const incomplete = INCOMPLETE_LOCAL_LINK.exec(normalized);
  const safe = incomplete === null || incomplete.index === undefined
    ? normalized
    : `${normalized.slice(0, incomplete.index)}\`${safeLinkLabel(incomplete[1] ?? "", "local file")}\``;
  return normalizeEmphasisOutsideCode(safe);
}

function normalizeEmphasisOutsideCode(value: string): string {
  let output = "";
  let cursor = 0;
  let inlineFenceLength = 0;
  for (const match of value.matchAll(/`+/gu)) {
    const position = match.index;
    const marker = match[0];
    const segment = value.slice(cursor, position);
    output += inlineFenceLength === 0 ? normalizeInlineEmphasis(segment) : segment;
    output += marker;
    if (inlineFenceLength === 0) {
      inlineFenceLength = marker.length;
    } else if (inlineFenceLength === marker.length) {
      inlineFenceLength = 0;
    }
    cursor = position + marker.length;
  }
  const tail = value.slice(cursor);
  output += inlineFenceLength === 0 ? normalizeInlineEmphasis(tail) : tail;
  return output;
}

function normalizeInlineEmphasis(value: string): string {
  return value
    // Slack uses underscores for italics and single asterisks for bold. Run
    // single-star italics first so newly emitted Slack bold is not rewritten.
    .replace(/(?<!\*)\*(?!\*)(?=\S)(.*?\S)\*(?!\*)/gu, "_$1_")
    .replace(/(?<!\*)\*\*(?=\S)(.*?\S)\*\*(?!\*)/gu, "*$1*")
    .replace(/(?<!_)__(?=\S)(.*?\S)__(?!_)/gu, "*$1*")
    .replace(/(?<!~)~~(?=\S)(.*?\S)~~(?!~)/gu, "~$1~");
}

function renderMarkdownLink(rawLabel: string, rawTarget: string): string {
  const label = safeLinkLabel(rawLabel, rawTarget);
  const target = rawTarget.startsWith("<") && rawTarget.endsWith(">")
    ? rawTarget.slice(1, -1)
    : rawTarget;
  if (/^https?:\/\//iu.test(target)) {
    try {
      const url = new URL(target);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username.length === 0 &&
        url.password.length === 0
      ) {
        return `${label} (${url.toString()})`;
      }
    } catch {
      // Fall through and hide malformed or credential-bearing link targets.
    }
  }
  return `\`${label}\``;
}

function safeLinkLabel(rawLabel: string, rawTarget: string): string {
  let label = rawLabel.trim().replaceAll("`", "'");
  if (label.startsWith("/") || label.startsWith("file://")) {
    const target = rawTarget.replace(/^<|>$/gu, "").replace(/\/+$/u, "");
    label = target.split("/").at(-1) ?? "local file";
  }
  if (label.length === 0) label = "local file";
  return label.length <= 200 ? label : `${label.slice(0, 199)}…`;
}

interface FenceLine {
  readonly character: string;
  readonly length: number;
  readonly suffix: string;
}

function parseFenceLine(line: string): FenceLine | undefined {
  const match = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
  const marker = match?.[1];
  if (marker === undefined) return undefined;
  return {
    character: marker[0] ?? "`",
    length: marker.length,
    suffix: match?.[2] ?? "",
  };
}

interface EscapedText {
  readonly text: string;
  readonly truncated: boolean;
}

function escapeSlackBounded(
  value: string,
  maxLength: number,
  maxUtf8Bytes: number,
): EscapedText {
  const chunks: string[] = [];
  let length = 0;
  let utf8Bytes = 0;
  for (const character of value) {
    const replacement =
      character === "&"
        ? "&amp;"
        : character === "<"
          ? "&lt;"
          : character === ">"
            ? "&gt;"
            : character;
    const replacementBytes = utf8ByteLength(replacement);
    if (
      length + replacement.length > maxLength ||
      utf8Bytes + replacementBytes > maxUtf8Bytes
    ) {
      return { text: chunks.join(""), truncated: true };
    }
    chunks.push(replacement);
    length += replacement.length;
    utf8Bytes += replacementBytes;
  }
  return { text: chunks.join(""), truncated: false };
}

function closeMarkdownCode(
  value: string,
  maxLength: number,
  maxUtf8Bytes: number,
  wasTruncated: boolean,
): string {
  let text = value;
  let truncated = wasTruncated;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const closure = requiredCodeClosure(text);
    const suffix = `${truncated ? "…" : ""}${closure}`;
    const candidate = `${text}${suffix}`;
    if (
      candidate.length <= maxLength &&
      utf8ByteLength(candidate) <= maxUtf8Bytes
    ) {
      return candidate;
    }
    text = truncateEscapedText(
      text,
      Math.max(0, maxLength - suffix.length),
      Math.max(0, maxUtf8Bytes - utf8ByteLength(suffix)),
    );
    truncated = true;
  }
  return truncateEscapedText(
    `${text}…${requiredCodeClosure(text)}`,
    maxLength,
    maxUtf8Bytes,
  );
}

function requiredCodeClosure(value: string): string {
  return requiredCodeState(value).closure;
}

interface CodeContinuation {
  readonly closure: string;
  readonly reopen: string;
}

function requiredCodeState(value: string): CodeContinuation {
  const lines = value.split("\n");
  let fence: string | undefined;
  let inlineFenceLength = 0;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      if (fence === undefined) {
        fence = marker;
        inlineFenceLength = 0;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) continue;
    for (const match of line.matchAll(/`+/gu)) {
      const markerLength = match[0].length;
      if (inlineFenceLength === 0) {
        inlineFenceLength = markerLength;
      } else if (inlineFenceLength === markerLength) {
        inlineFenceLength = 0;
      }
    }
  }

  if (fence !== undefined) {
    return { closure: `\n${fence}`, reopen: `${fence}\n` };
  }
  if (inlineFenceLength > 0) {
    const marker = "`".repeat(inlineFenceLength);
    return { closure: marker, reopen: marker };
  }
  return { closure: "", reopen: "" };
}

function truncateEscapedText(
  value: string,
  maxLength: number,
  maxUtf8Bytes = Number.POSITIVE_INFINITY,
): string {
  if (maxLength <= 0 || maxUtf8Bytes <= 0) return "";
  const chunks = escapedTextChunks(value);
  let output = "";
  let utf8Bytes = 0;
  for (const chunk of chunks) {
    const chunkBytes = utf8ByteLength(chunk);
    if (
      output.length + chunk.length > maxLength ||
      utf8Bytes + chunkBytes > maxUtf8Bytes
    ) {
      break;
    }
    output += chunk;
    utf8Bytes += chunkBytes;
  }
  return output;
}

function escapedTextChunks(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length;) {
    const entity = /^(?:&amp;|&lt;|&gt;)/u.exec(value.slice(index));
    if (entity !== null) {
      chunks.push(entity[0]);
      index += entity[0].length;
      continue;
    }
    if (value[index] === "`") {
      let end = index + 1;
      while (value[end] === "`") end += 1;
      chunks.push(value.slice(index, end));
      index = end;
      continue;
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    chunks.push(character);
    index += character.length;
  }
  return chunks;
}

function preferredSafePrefixLength(
  value: string,
  maxLength: number,
  maxUtf8Bytes = Number.POSITIVE_INFINITY,
): number {
  const chunks = escapedTextChunks(value);
  let length = 0;
  let utf8Bytes = 0;
  for (const chunk of chunks) {
    const chunkBytes = utf8ByteLength(chunk);
    if (
      length + chunk.length > maxLength ||
      utf8Bytes + chunkBytes > maxUtf8Bytes
    ) {
      break;
    }
    length += chunk.length;
    utf8Bytes += chunkBytes;
  }
  if (length === 0) {
    throw new Error("A Slack text token exceeds the configured chunk size");
  }
  if (length >= value.length) return value.length;

  const prefix = value.slice(0, length);
  const newline = prefix.lastIndexOf("\n");
  return newline >= Math.floor(maxLength / 2) ? newline + 1 : length;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
