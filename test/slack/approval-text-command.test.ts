import assert from "node:assert/strict";
import test from "node:test";

import {
  type ApprovalTextAttributionProfile,
  buildApprovalTextCommandHint,
  parseApprovalTextCommand,
} from "../../src/slack/approval-text-command.js";

const baseEvent = {
  type: "message",
  channel: "C0123456789",
  user: "U0123456789",
  ts: "1786654846.000100",
  thread_ts: "1786654845.402859",
  text: "承認 req_ABC-123:xyz",
};

function eventWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...baseEvent, ...overrides };
}

const chatGptProfile: ApprovalTextAttributionProfile = {
  appId: "ACHATGPT",
  userId: "UCHATGPT",
};
const chatGptFooter = "*使用して送信されました* <@UCHATGPT>";

function commandBlock(command: string = baseEvent.text) {
  return {
    type: "rich_text",
    block_id: "synthetic",
    elements: [{
      type: "rich_text_section",
      elements: [{ type: "text", text: command }],
    }],
  };
}

function attributionBlock(footer: string = chatGptFooter) {
  return {
    type: "context",
    block_id: "synthetic-footer",
    elements: [{ type: "mrkdwn", text: footer, verbatim: false }],
  };
}

function attributedEvent(
  command: string = baseEvent.text,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return eventWith({
    text: `${command} ${chatGptFooter}`,
    app_id: chatGptProfile.appId,
    blocks: [commandBlock(command), attributionBlock()],
    ...overrides,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("parses an exact plain reply and maps the decision", () => {
  assert.deepEqual(parseApprovalTextCommand(baseEvent), {
    decision: "approve",
    requestId: "req_ABC-123:xyz",
    channelId: "C0123456789",
    rootThreadTs: "1786654845.402859",
    userId: "U0123456789",
    messageTs: "1786654846.000100",
  });
  assert.equal(
    parseApprovalTextCommand(eventWith({ text: "拒否 req_ABC-123:xyz" }))?.decision,
    "reject",
  );
});

test("accepts only rich text sections whose text leaves reconstruct the command", () => {
  const richTextEvent = eventWith({
    blocks: [{
      type: "rich_text",
      block_id: "block-1",
      elements: [{
        type: "rich_text_section",
        elements: [
          { type: "text", text: "承認 " },
          { type: "text", text: "req_ABC-123:xyz" },
        ],
      }],
    }],
  });
  assert.equal(parseApprovalTextCommand(richTextEvent)?.requestId, "req_ABC-123:xyz");

  assert.equal(
    parseApprovalTextCommand(eventWith({
      blocks: [{
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [{ type: "text", text: "different" }],
        }],
      }],
    })),
    undefined,
  );
});

test("rejects quotes, preformatted content, mentions, markdown, and footers", () => {
  const block = (type: string, elements: unknown[]) => [{ type, elements }];
  const section = (elements: unknown[]) => [{ type: "rich_text_section", elements }];
  const invalidEvents = [
    eventWith({
      blocks: block("rich_text_quote", section([{ type: "text", text: baseEvent.text }])),
    }),
    eventWith({
      blocks: block("rich_text_preformatted", section([{ type: "text", text: baseEvent.text }])),
    }),
    eventWith({
      blocks: [{
        type: "rich_text",
        elements: section([{ type: "user", user_id: "U0123456789" }]),
      }],
    }),
    eventWith({ text: "*承認 req_ABC-123:xyz*" }),
    eventWith({ text: "承認 req_ABC-123:xyz\nfooter" }),
    eventWith({ text: "承認 `req_ABC-123:xyz`" }),
  ];
  for (const event of invalidEvents) {
    assert.equal(parseApprovalTextCommand(event), undefined);
  }
});

test("rejects bot, edited, file, malformed identity, and malformed reply events", () => {
  const excludedFields = [
    "subtype",
    "bot_id",
    "app_id",
    "bot_profile",
    "edited",
    "hidden",
    "attachments",
    "files",
    "x_files",
    "message",
    "previous_message",
  ];
  for (const field of excludedFields) {
    assert.equal(
      parseApprovalTextCommand(eventWith({ [field]: field === "hidden" ? false : {} })),
      undefined,
      field,
    );
  }

  const invalidEvents = [
    eventWith({ type: "app_mention" }),
    eventWith({ channel: "C" }),
    eventWith({ channel: "X0123456789" }),
    eventWith({ channel: "C0123456789\n" }),
    eventWith({ user: "B0123456789" }),
    eventWith({ user: "U0123456789\n" }),
    eventWith({ ts: "1786654846.1" }),
    eventWith({ ts: `${"1".repeat(26)}.000001` }),
    eventWith({ ts: "1786654846.000100\n" }),
    eventWith({ thread_ts: "1786654846.000100" }),
    eventWith({ ts: "1786654845.402858" }),
    eventWith({ thread_ts: undefined }),
    eventWith({ blocks: [] }),
    eventWith({ blocks: [{ type: "rich_text", elements: [] }] }),
  ];
  for (const event of invalidEvents) {
    assert.equal(parseApprovalTextCommand(event), undefined);
  }
});

test("enforces the opaque request ID grammar and one ASCII separator", () => {
  const invalidCommands = [
    "承認",
    "承認  req_ABC-123:xyz",
    "承認\treq_ABC-123:xyz",
    "承認 req_ABC-123:xyz ",
    "承認 <@U0123456789>",
    "承認 req/ABC",
    "承認 req.ABC",
    "承認 req ABC",
    `承認 ${"a".repeat(257)}`,
  ];
  for (const text of invalidCommands) {
    assert.equal(parseApprovalTextCommand(eventWith({ text })), undefined, text);
  }

  assert.equal(
    parseApprovalTextCommand(eventWith({ text: `承認 ${"a".repeat(256)}` }))?.requestId,
    "a".repeat(256),
  );
});

test("builds a safe copyable hint and refuses unsafe IDs", () => {
  assert.equal(
    buildApprovalTextCommandHint("req_ABC-123:xyz"),
    "承認 req_ABC-123:xyz または 拒否 req_ABC-123:xyz",
  );
  assert.equal(buildApprovalTextCommandHint("<@U0123456789>"), undefined);
  assert.equal(buildApprovalTextCommandHint("req with spaces"), undefined);
  assert.equal(buildApprovalTextCommandHint("req_ABC\n"), undefined);
  assert.equal(buildApprovalTextCommandHint(""), undefined);
  assert.equal(buildApprovalTextCommandHint("a".repeat(257)), undefined);
});

test("accepts the exact observed ChatGPT footer only with the matching profile", () => {
  for (const [label, decision] of [["承認", "approve"], ["拒否", "reject"]] as const) {
    assert.deepEqual(
      parseApprovalTextCommand(attributedEvent(`${label} req_ABC-123:xyz`), chatGptProfile),
      {
        decision,
        requestId: "req_ABC-123:xyz",
        channelId: baseEvent.channel,
        rootThreadTs: baseEvent.thread_ts,
        userId: baseEvent.user,
        messageTs: baseEvent.ts,
        attribution: {
          kind: "chatgpt_slack_footer_v1",
          appId: "ACHATGPT",
          userId: "UCHATGPT",
        },
      },
    );
  }
  assert.equal(parseApprovalTextCommand(attributedEvent()), undefined);
});

test("preserves the actual author and leaves plain commands unattributed", () => {
  const plain = parseApprovalTextCommand(baseEvent, chatGptProfile);
  assert.deepEqual(plain, parseApprovalTextCommand(baseEvent));
  assert.ok(plain !== undefined);
  assert.equal(Object.hasOwn(plain, "attribution"), false);
  assert.equal(
    parseApprovalTextCommand(attributedEvent(baseEvent.text, { user: "UCHATGPT" }), chatGptProfile),
    undefined,
  );
  for (const appId of [undefined, "ACHATGPT", "AOTHER"]) {
    assert.equal(
      parseApprovalTextCommand(eventWith({ app_id: appId }), chatGptProfile),
      undefined,
    );
  }
});

test("does not mutate the Slack event or injected attribution profile", () => {
  const event = deepFreeze(attributedEvent());
  const profile = deepFreeze({ ...chatGptProfile });
  const before = JSON.stringify({ event, profile });
  const parsed = parseApprovalTextCommand(event, profile);
  assert.equal(parsed?.decision, "approve");
  assert.equal(JSON.stringify({ event, profile }), before);
  assert.notStrictEqual(parsed?.attribution, profile);
});

test("requires exact app metadata, attribution mention, and both observed blocks", () => {
  const missingApp = attributedEvent();
  delete missingApp.app_id;
  const missingBlocks = attributedEvent();
  delete missingBlocks.blocks;
  const invalid = [
    missingApp,
    missingBlocks,
    attributedEvent(baseEvent.text, { app_id: undefined }),
    attributedEvent(baseEvent.text, { app_id: "AOTHER" }),
    attributedEvent(baseEvent.text, { app_id: "ACHATGPT\n" }),
    attributedEvent(baseEvent.text, { app_id: {} }),
    attributedEvent(baseEvent.text, { blocks: undefined }),
    attributedEvent(baseEvent.text, { blocks: [] }),
    attributedEvent(baseEvent.text, { blocks: [commandBlock()] }),
    attributedEvent(baseEvent.text, { blocks: [attributionBlock()] }),
    attributedEvent(baseEvent.text, { blocks: [attributionBlock(), commandBlock()] }),
    attributedEvent(baseEvent.text, { blocks: [commandBlock(), attributionBlock(), attributionBlock()] }),
  ];
  for (const event of invalid) {
    assert.equal(parseApprovalTextCommand(event, chatGptProfile), undefined, JSON.stringify(event));
  }
  assert.equal(
    parseApprovalTextCommand(attributedEvent(), { ...chatGptProfile, appId: "AOTHER" }),
    undefined,
  );
  assert.equal(
    parseApprovalTextCommand(attributedEvent(), { ...chatGptProfile, userId: "UOTHER" }),
    undefined,
  );
});

test("rejects alternate attribution text even when raw text and context agree", () => {
  const invalidFooters = [
    "*使用して送信されました* <@UOTHER>",
    "*使用して送信されました* <@UCHATGPT|ChatGPT>",
    "*使用して送信されました* @ChatGPT",
    "使用して送信されました <@UCHATGPT>",
    "**使用して送信されました** <@UCHATGPT>",
    "*Sent using* <@UCHATGPT>",
    "*使用して送信されました*  <@UCHATGPT>",
    "*使用して送信されました*\n<@UCHATGPT>",
    "*使用して送信されました* <@UCHATGPT> extra",
    "*使用して送信されました* <@UCHATGPT> <@UOTHER>",
    "*使用して送信されました* <https://example.invalid|ChatGPT>",
  ];
  for (const footer of invalidFooters) {
    const event = attributedEvent(baseEvent.text, {
      text: `${baseEvent.text} ${footer}`,
      blocks: [commandBlock(), attributionBlock(footer)],
    });
    assert.equal(parseApprovalTextCommand(event, chatGptProfile), undefined, footer);
  }
});

test("rejects disagreement between raw text and either attributed block", () => {
  const invalid = [
    attributedEvent(baseEvent.text, { text: `拒否 req_ABC-123:xyz ${chatGptFooter}` }),
    attributedEvent(baseEvent.text, { blocks: [commandBlock("承認 other-request"), attributionBlock()] }),
    attributedEvent(baseEvent.text, { blocks: [commandBlock(), attributionBlock("different footer")] }),
    attributedEvent(baseEvent.text, { text: baseEvent.text }),
    attributedEvent(baseEvent.text, { blocks: [commandBlock(`${baseEvent.text} ${chatGptFooter}`), attributionBlock()] }),
    attributedEvent(baseEvent.text, { text: `${baseEvent.text} *使用して送信されました* <@UOTHER>` }),
  ];
  for (const event of invalid) {
    assert.equal(parseApprovalTextCommand(event, chatGptProfile), undefined, JSON.stringify(event));
  }
});

test("never trims whitespace or extra text around an attributed command", () => {
  const exact = `${baseEvent.text} ${chatGptFooter}`;
  const invalidText = [
    ` ${exact}`, `${exact} `, `${exact}\n`, `${exact}\r`, `${exact}\r\n`, `${exact}\t`,
    `${baseEvent.text}\n${chatGptFooter}`,
    `${baseEvent.text}\r\n${chatGptFooter}`,
    `${baseEvent.text}\t${chatGptFooter}`,
    `${baseEvent.text}  ${chatGptFooter}`,
    `${baseEvent.text}\u00a0${chatGptFooter}`,
    `説明 ${exact}`,
    `${exact} 説明`,
    `${exact} ${chatGptFooter}`,
  ];
  for (const text of invalidText) {
    assert.equal(
      parseApprovalTextCommand(attributedEvent(baseEvent.text, { text }), chatGptProfile),
      undefined,
      JSON.stringify(text),
    );
  }
});

test("keeps the strict command grammar inside an otherwise exact attribution envelope", () => {
  const invalidCommands = [
    "承認", "承認  req_ABC-123:xyz", "承認\treq_ABC-123:xyz", " 承認 req_ABC-123:xyz",
    "承認 req_ABC-123:xyz ", "承認 req_ABC-123:xyz\n", "承認 req_ABC-123:xyz\r\n",
    "承認 req_ABC-123:xyz\n拒否 req_ABC-123:xyz", "承認 req_ABC-123:xyz 拒否 other",
    "> 承認 req_ABC-123:xyz", "`承認 req_ABC-123:xyz`", "```承認 req_ABC-123:xyz```",
    "*承認 req_ABC-123:xyz*", "承認 req/ABC", "承認 <@U0123456789>",
    `承認 ${"a".repeat(257)}`,
  ];
  for (const command of invalidCommands) {
    assert.equal(parseApprovalTextCommand(attributedEvent(command), chatGptProfile), undefined, command);
  }
});

test("rejects quoted, linked, coded, formatted, or extra attributed block content", () => {
  const invalidBlocks = [
    [{ ...commandBlock(), extra: true }, attributionBlock()],
    [commandBlock(), { ...attributionBlock(), extra: true }],
    [{ ...commandBlock(), elements: [{ ...commandBlock().elements[0], style: {} }] }, attributionBlock()],
    [{ ...commandBlock(), elements: [{ type: "rich_text_quote", elements: commandBlock().elements[0]!.elements }] }, attributionBlock()],
    [{ ...commandBlock(), elements: [{ type: "rich_text_preformatted", elements: commandBlock().elements[0]!.elements }] }, attributionBlock()],
    [{ ...commandBlock(), elements: [{ type: "rich_text_section", elements: [{ type: "text", text: baseEvent.text, style: { bold: true } }] }] }, attributionBlock()],
    [{ ...commandBlock(), elements: [{ type: "rich_text_section", elements: [{ type: "link", text: baseEvent.text, url: "https://example.invalid" }] }] }, attributionBlock()],
    [{ ...commandBlock(), elements: [{ type: "rich_text_section", elements: [{ type: "text", text: baseEvent.text }, { type: "user", user_id: "UOTHER" }] }] }, attributionBlock()],
    [{ ...commandBlock(), elements: [...commandBlock().elements, ...commandBlock().elements] }, attributionBlock()],
    [commandBlock(), { ...attributionBlock(), elements: [{ type: "plain_text", text: chatGptFooter, verbatim: false }] }],
    [commandBlock(), { ...attributionBlock(), elements: [{ type: "mrkdwn", text: chatGptFooter, verbatim: true }] }],
    [commandBlock(), { ...attributionBlock(), elements: [{ type: "mrkdwn", text: chatGptFooter }] }],
    [commandBlock(), { ...attributionBlock(), elements: [{ type: "mrkdwn", text: chatGptFooter, verbatim: false, extra: true }] }],
    [commandBlock(), { ...attributionBlock(), elements: [...attributionBlock().elements, ...attributionBlock().elements] }],
    [commandBlock(), { ...attributionBlock(), elements: [{ type: "image", image_url: "https://example.invalid/image", alt_text: chatGptFooter }] }],
  ];
  for (const blocks of invalidBlocks) {
    assert.equal(
      parseApprovalTextCommand(attributedEvent(baseEvent.text, { blocks }), chatGptProfile),
      undefined,
      JSON.stringify(blocks),
    );
  }
});

test("allows omitted block IDs while retaining block ID validation for both blocks", () => {
  const { block_id: _commandId, ...command } = commandBlock();
  const { block_id: _footerId, ...footer } = attributionBlock();
  assert.equal(
    parseApprovalTextCommand(attributedEvent(baseEvent.text, { blocks: [command, footer] }), chatGptProfile)?.decision,
    "approve",
  );
  for (const blockId of [undefined, null, 12, "", "x".repeat(256)]) {
    for (const blocks of [
      [{ ...commandBlock(), block_id: blockId }, attributionBlock()],
      [commandBlock(), { ...attributionBlock(), block_id: blockId }],
    ]) {
      assert.equal(
        parseApprovalTextCommand(attributedEvent(baseEvent.text, { blocks }), chatGptProfile),
        undefined,
        JSON.stringify(blocks),
      );
    }
  }
});

test("does not relax bot, edit, attachment, or event identity exclusions for attribution", () => {
  for (const field of [
    "subtype", "bot_id", "bot_profile", "edited", "hidden", "attachments", "files",
    "x_files", "message", "previous_message",
  ]) {
    for (const value of [undefined, false, {}, []]) {
      assert.equal(
        parseApprovalTextCommand(attributedEvent(baseEvent.text, { [field]: value }), chatGptProfile),
        undefined,
        `${field}: ${JSON.stringify(value)}`,
      );
    }
  }
  for (const overrides of [
    { type: "message_changed" }, { type: "app_mention" }, { user: "B0123456789" },
    { user: "U0123456789\n" }, { channel: "X0123456789" }, { channel: "C0123456789\n" },
    { ts: "1786654846.1" }, { ts: `${baseEvent.ts}\n` }, { thread_ts: undefined },
    { thread_ts: baseEvent.ts }, { ts: "1786654845.402858" },
  ]) {
    assert.equal(
      parseApprovalTextCommand(attributedEvent(baseEvent.text, overrides), chatGptProfile),
      undefined,
      JSON.stringify(overrides),
    );
  }
});
