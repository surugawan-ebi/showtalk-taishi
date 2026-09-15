import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAgentTextForSlack,
  splitSlackText,
  utf8ByteLength,
} from "../../src/slack/text-format.js";

test("renders simple Markdown tables as Slack-readable bullets", () => {
  const input = [
    "| Directory | Role |",
    "|---|---|",
    "| [src/](</Users/example/project/src>) | Application code |",
    "| [test/](</Users/example/project/test>) | Automated tests |",
  ].join("\n");

  const output = formatAgentTextForSlack(input, 4_000);
  assert.equal(
    output,
    ["• `src/` — Application code", "• `test/` — Automated tests"].join("\n"),
  );
  assert.doesNotMatch(output, /\/Users\/example/u);
  assert.doesNotMatch(output, /^\|/mu);
});

test("hides local link targets and keeps explicit web links readable", () => {
  const output = formatAgentTextForSlack(
    "See [runtime.ts](/Users/example/project/src/runtime.ts) and [docs](https://example.com/docs).",
    4_000,
  );

  assert.equal(output, "See `runtime.ts` and docs (https://example.com/docs)." );
  assert.doesNotMatch(output, /\/Users\/example/u);
});

test("does not rewrite tables or links inside code", () => {
  const input = [
    "```text",
    "| [raw](</Users/example/raw>) | code |",
    "|---|---|",
    "```",
    "Inline `[raw](</Users/example/raw>)` stays code.",
  ].join("\n");
  const output = formatAgentTextForSlack(input, 4_000);

  assert.match(output, /^```\n/u);
  assert.doesNotMatch(output, /^```text/u);
  assert.match(output, /\| \[raw\]\(&lt;\/Users\/example\/raw&gt;\) \| code \|/u);
  assert.match(output, /`\[raw\]\(&lt;\/Users\/example\/raw&gt;\)`/u);
});

test("neutralizes Slack mentions and bounds expanded output", () => {
  const output = formatAgentTextForSlack(
    "Notify <!channel> and <@U123>.\n" + "x".repeat(500),
    80,
  );

  assert.doesNotMatch(output, /<!channel>|<@U123>/u);
  assert.match(output, /&lt;!channel&gt;.*&lt;@U123&gt;/u);
  assert.equal(output.length, 80);
  assert.match(output, /…$/u);
});

test("shortens plain home paths outside code without touching URLs", () => {
  const output = formatAgentTextForSlack(
    "Local: /Users/example/project/src. URL: https://example.com/Users/example/page",
    4_000,
  );

  assert.equal(
    output,
    "Local: ~/project/src. URL: https://example.com/Users/example/page",
  );
});

test("hides a local Markdown target during an incomplete streaming update", () => {
  const output = formatAgentTextForSlack(
    "Reading [src/](</Users/example/project/src",
    4_000,
  );

  assert.equal(output, "Reading `src/`");
  assert.doesNotMatch(output, /Users|project/u);
});

test("closes truncated code fences without splitting Unicode", () => {
  const output = formatAgentTextForSlack(
    "```text\n" + "😀".repeat(100),
    48,
  );

  assert.ok(output.length <= 48);
  assert.match(output, /…\n```$/u);
  assert.doesNotMatch(output, /[\uD800-\uDBFF]$/u);
});

test("preserves tilde-fenced examples without formatting their contents", () => {
  const output = formatAgentTextForSlack(
    [
      "~~~text",
      "| [raw](</Users/example/raw>) | code |",
      "|---|---|",
      "~~~",
    ].join("\n"),
    4_000,
  );

  assert.match(output, /^```\n/u);
  assert.match(output, /\| \[raw\]\(&lt;\/Users\/example\/raw&gt;\) \| code \|/u);
  assert.match(output, /```$/u);
});

test("renders Markdown headings and emphasis as Slack mrkdwn", () => {
  const output = formatAgentTextForSlack(
    [
      "# Overview",
      "## Details",
      "### Notes",
      "Use **bold** and __also bold__, then ~~remove this~~.",
    ].join("\n"),
    4_000,
  );

  assert.equal(
    output,
    [
      "*Overview*",
      "*Details*",
      "*Notes*",
      "Use *bold* and *also bold*, then ~remove this~.",
    ].join("\n"),
  );
});

test("renders one-character bold and star italics with Slack markers", () => {
  const output = formatAgentTextForSlack(
    "**A** *B* __C__ ~~D~~",
    4_000,
  );

  assert.equal(output, "*A* _B_ *C* ~D~");
});

test("renders nested Markdown lists and task items for Slack", () => {
  const output = formatAgentTextForSlack(
    [
      "- first",
      "  * nested",
      "    + deeply nested",
      "- [x] completed",
      "- [X] also completed",
      "  - [ ] still pending",
    ].join("\n"),
    4_000,
  );

  assert.equal(
    output,
    [
      "• first",
      "  • nested",
      "    • deeply nested",
      "☑ completed",
      "☑ also completed",
      "  ☐ still pending",
    ].join("\n"),
  );
});

test("renders Markdown quotes and horizontal rules as visible Slack separators", () => {
  const output = formatAgentTextForSlack(
    [
      "> quoted guidance",
      "---",
      "After the divider",
      "***",
      "After another divider",
      "___",
    ].join("\n"),
    4_000,
  );

  const lines = output.split("\n");
  assert.equal(lines[0], "│ quoted guidance");
  assert.match(lines[1] ?? "", /^─{3,}$/u);
  assert.equal(lines[2], "After the divider");
  assert.match(lines[3] ?? "", /^─{3,}$/u);
  assert.equal(lines[4], "After another divider");
  assert.match(lines[5] ?? "", /^─{3,}$/u);
  assert.doesNotMatch(output, /^(?:---|\*\*\*|___)$/mu);
});

test("does not apply Slack layout conversions inside fenced or inline code", () => {
  const output = formatAgentTextForSlack(
    [
      "```markdown",
      "# raw heading",
      "**raw bold**",
      "- [x] raw task",
      "> raw quote",
      "---",
      "~~raw strike~~",
      "```",
      "Inline `# raw **bold** - [x] > quote --- ~~strike~~` stays raw.",
    ].join("\n"),
    4_000,
  );

  assert.match(output, /^```\n# raw heading\n\*\*raw bold\*\*\n- \[x\] raw task\n&gt; raw quote\n---\n~~raw strike~~\n```/u);
  assert.match(
    output,
    /`# raw \*\*bold\*\* - \[x\] &gt; quote --- ~~strike~~` stays raw\.$/u,
  );
});

test("keeps mention neutralization and output bounds after Slack layout conversion", () => {
  const output = formatAgentTextForSlack(
    "# Result\n**Notify** <!channel> and <@U123>.\n" + "😀".repeat(100),
    96,
  );

  assert.match(output, /^\*Result\*\n\*Notify\*/u);
  assert.doesNotMatch(output, /<!channel>|<@U123>/u);
  assert.match(output, /&lt;!channel&gt;.*&lt;@U123&gt;/u);
  assert.ok(output.length <= 96);
  assert.doesNotMatch(output, /[\uD800-\uDBFF]$/u);
  assert.match(output, /…$/u);
});

test("does not create unmatched Slack decoration from incomplete streaming Markdown", () => {
  const output = formatAgentTextForSlack(
    [
      "Completed **bold**, streaming **unfinished",
      "Completed __bold__, streaming __unfinished",
      "Completed ~~strike~~, streaming ~~unfinished",
    ].join("\n"),
    4_000,
  );

  assert.equal(
    output,
    [
      "Completed *bold*, streaming **unfinished",
      "Completed *bold*, streaming __unfinished",
      "Completed ~strike~, streaming ~~unfinished",
    ].join("\n"),
  );
});

test("splits long Slack text while balancing fenced code in every chunk", () => {
  const formatted = formatAgentTextForSlack(
    ["```text", ...Array.from({ length: 30 }, (_, index) => `line-${index}`), "```"].join("\n"),
    10_000,
  );
  const chunks = splitSlackText(formatted, 96);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 96));
  assert.ok(chunks.every((chunk) => (chunk.match(/```/gu)?.length ?? 0) % 2 === 0));
  assert.match(chunks[0] ?? "", /```$/u);
  assert.match(chunks[1] ?? "", /^```/u);
});

test("splits without cutting escaped entities or non-BMP Unicode", () => {
  const formatted = formatAgentTextForSlack("<&>" + "😀".repeat(100), 10_000);
  const chunks = splitSlackText(formatted, 64);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 64));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk)));
  assert.ok(chunks.every((chunk) => !/&(?:a|am|l|g)?$/u.test(chunk)));
});

test("bounds multibyte Slack text by UTF-8 size", () => {
  const formatted = formatAgentTextForSlack(
    "日本語😀".repeat(2_000),
    3_800,
    3_800,
  );

  assert.ok(formatted.length <= 3_800);
  assert.ok(utf8ByteLength(formatted) <= 3_800);
  assert.ok(!/[\uD800-\uDBFF]$/u.test(formatted));
  assert.match(formatted, /…$/u);
});

test("splits multibyte Slack text within both wire bounds", () => {
  const formatted = formatAgentTextForSlack(
    "確認結果です。😀\n".repeat(2_000),
    12_000,
    12_000,
  );
  const chunks = splitSlackText(formatted, 3_000, 3_000);

  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every(
      (chunk) => chunk.length <= 3_000 && utf8ByteLength(chunk) <= 3_000,
    ),
  );
});
