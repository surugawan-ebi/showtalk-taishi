import { z } from "zod";

import {
  MAX_KOE_CALL_NAME_LENGTH,
  MAX_KOE_ID_LENGTH,
} from "../core/koe-address.js";

export const MAX_AGENT_ID_LENGTH = MAX_KOE_ID_LENGTH;
export const MAX_CHANNEL_LENGTH = 128;
export const MAX_MESSAGE_LENGTH = 32_000;
export const MAX_RESULT_MESSAGE_LENGTH = 64_000;
export const MAX_LISTED_AGENTS = 256;
export const MAX_CONSULTATION_SCOPE_LENGTH = 2_000;
export const MAX_SLACK_ATTACHMENTS = 10;
export const MAX_SLACK_ATTACHMENT_PATH_LENGTH = 1_024;
export const MAX_SLACK_ATTACHMENT_TITLE_LENGTH = 256;
export const MAX_SLACK_ATTACHMENT_ALT_TEXT_LENGTH = 2_000;

const noControlCharacters = (value: string) => !/[\u0000-\u001f\u007f]/u.test(value);

function boundedIdentifier(label: string, maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim() === value, `${label} must not have surrounding whitespace`)
    .refine(noControlCharacters, `${label} must not contain control characters`);
}

export const agentIdSchema = boundedIdentifier("Koe ID", MAX_AGENT_ID_LENGTH);
export const koeTargetSchema = boundedIdentifier(
  "Koe ID or call name",
  Math.max(MAX_AGENT_ID_LENGTH, MAX_KOE_CALL_NAME_LENGTH),
);
export const channelSchema = boundedIdentifier("Slack channel", MAX_CHANNEL_LENGTH);
export const statusSchema = boundedIdentifier("Status", 64);
export const adapterSchema = boundedIdentifier("Adapter", 128);
export const sessionIdSchema = boundedIdentifier("Session ID", 256);
export const delegationIdSchema = boundedIdentifier("Delegation ID", 256);

export const messageSchema = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_LENGTH)
  .refine((value) => value.trim().length > 0, "Message must contain non-whitespace text")
  .refine((value) => !value.includes("\u0000"), "Message must not contain NUL characters");

const boundedPlainString = (label: string, maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value.trim().length > 0, `${label} must contain non-whitespace text`)
    .refine(noControlCharacters, `${label} must not contain control characters`);

const consultationScopeOutputSchema = z
  .string()
  .min(1)
  .max(MAX_CONSULTATION_SCOPE_LENGTH)
  .refine(
    (value) => value.trim().length > 0,
    "Consultation scope must contain non-whitespace text",
  )
  .refine(
    (value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
    "Consultation scope must not contain unsupported control characters",
  );

export const slackAttachmentPathSchema = z
  .string()
  .min(1)
  .max(MAX_SLACK_ATTACHMENT_PATH_LENGTH)
  .refine(noControlCharacters, "Attachment path must not contain control characters")
  .refine(
    (value) => !/^[\\/]/u.test(value) && !/^[A-Za-z]:/u.test(value),
    "Attachment path must be relative to the Koe workspace",
  )
  .refine(
    (value) => !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value),
    "Attachment path must not be a URL or encoded data URI",
  )
  .refine(
    (value) =>
      value
        .split(/[\\/]/u)
        .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Attachment path must not contain empty, current-directory, or parent-directory segments",
  );

export const slackAttachmentInputSchema = z
  .object({
    path: slackAttachmentPathSchema.describe(
      "Workspace-relative path to an image or audio file",
    ),
    title: boundedPlainString(
      "Attachment title",
      MAX_SLACK_ATTACHMENT_TITLE_LENGTH,
    ).optional(),
    alt_text: boundedPlainString(
      "Attachment alt text",
      MAX_SLACK_ATTACHMENT_ALT_TEXT_LENGTH,
    ).optional(),
  })
  .strict();

const slackAttachmentsSchema = z
  .array(slackAttachmentInputSchema)
  .max(MAX_SLACK_ATTACHMENTS);

function requireSlackMessageOrAttachments<T extends {
  message?: string | undefined;
  attachments?: unknown[] | undefined;
}>(value: T): boolean {
  return value.message !== undefined || (value.attachments?.length ?? 0) > 0;
}

export const threadTsSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^\d{1,20}\.\d{1,20}$/u, "Slack thread timestamp is invalid");

export const agentListInputSchema = z.object({}).strict().default({});
export const gatewayRestartInputSchema = z.object({}).strict().default({});
export const agentStatusInputSchema = z
  .object({
    target: koeTargetSchema.describe(
      "Koe ID or configured call name whose current status should be returned",
    ),
  })
  .strict();
export const agentSendInputSchema = z
  .object({
    target: koeTargetSchema.describe(
      "Configured Koe ID or call name that should receive the direct Gateway request",
    ),
    message: messageSchema.describe("Work or question to send to the target Koe"),
  })
  .strict();
export const slackPostInputSchema = z
  .object({
    channel: channelSchema.describe("Slack channel ID or service-supported channel alias"),
    message: messageSchema.describe("Optional message to post").optional(),
    attachments: slackAttachmentsSchema
      .describe("Workspace-relative image or audio files to upload")
      .optional(),
  })
  .strict()
  .refine(requireSlackMessageOrAttachments, {
    message: "A Slack write requires a message, at least one attachment, or both",
  });
export const slackReplyInputSchema = z
  .object({
    channel: channelSchema.describe("Slack channel ID or service-supported channel alias"),
    thread_ts: threadTsSchema.describe("Root Slack thread timestamp"),
    message: messageSchema.describe("Optional reply to post in the thread").optional(),
    attachments: slackAttachmentsSchema
      .describe("Workspace-relative image or audio files to upload")
      .optional(),
  })
  .strict()
  .refine(requireSlackMessageOrAttachments, {
    message: "A Slack write requires a message, at least one attachment, or both",
  });

const agentSummarySchema = z
  .object({
    id: agentIdSchema,
    call_name: boundedIdentifier(
      "Koe call name",
      MAX_KOE_CALL_NAME_LENGTH,
    ).optional(),
    adapter: adapterSchema.optional(),
    channel: channelSchema.optional(),
    status: statusSchema.optional(),
    consultation_scope: consultationScopeOutputSchema.optional(),
  })
  .strict();

export const agentListOutputSchema = z
  .object({
    agents: z.array(agentSummarySchema).max(MAX_LISTED_AGENTS),
  })
  .strict();

export const agentStatusOutputSchema = z
  .object({
    agent_id: agentIdSchema,
    status: statusSchema,
    session_id: sessionIdSchema.optional(),
  })
  .strict();

export const agentSendOutputSchema = z
  .object({
    target: agentIdSchema,
    status: statusSchema,
    message: z.string().max(MAX_RESULT_MESSAGE_LENGTH).optional(),
    delegation_id: delegationIdSchema.optional(),
  })
  .strict();

export const gatewayRestartOutputSchema = z
  .object({
    status: z.literal("scheduled"),
  })
  .strict();

export const slackWriteOutputSchema = z
  .object({
    channel: channelSchema,
    ts: threadTsSchema,
    thread_ts: threadTsSchema.optional(),
    file_ids: z
      .array(boundedIdentifier("Slack file ID", 128))
      .max(MAX_SLACK_ATTACHMENTS)
      .optional(),
  })
  .strict();

export const publicErrorCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

export const publicErrorMessageSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(noControlCharacters);
