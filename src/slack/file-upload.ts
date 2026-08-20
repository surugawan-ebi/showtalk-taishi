import { readFile } from "node:fs/promises";

import type { RuntimeSlackAttachment } from "../mcp/workspace-attachments.js";

interface SlackFileUploadClient {
  readonly files: {
    getUploadURLExternal(input: {
      filename: string;
      length: number;
      alt_text?: string;
    }): Promise<unknown>;
  };
  apiCall(method: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface SlackFileUploadDependencies {
  readonly fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  readonly readFile?: (path: string) => Promise<Buffer>;
}

/**
 * Uses Slack's external-upload sequence directly because the current SDK's
 * filesUploadV2 wrapper does not forward per-message identity fields to the
 * completion call.
 */
export async function uploadSlackAttachments(
  client: SlackFileUploadClient,
  channelId: string,
  rootThreadTs: string,
  attachments: readonly RuntimeSlackAttachment[],
  dependencies: SlackFileUploadDependencies = {},
): Promise<void> {
  if (attachments.length === 0) return;
  const fetchFile = dependencies.fetch ?? fetch;
  const loadFile = dependencies.readFile ?? readFile;
  const files: Array<{ id: string; title?: string }> = [];

  for (const attachment of attachments) {
    const ticket = asRecord(
      await client.files.getUploadURLExternal({
        filename: attachment.name,
        length: attachment.size,
        ...(attachment.altText === undefined
          ? {}
          : { alt_text: attachment.altText }),
      }),
    );
    if (
      ticket?.ok !== true ||
      typeof ticket.upload_url !== "string" ||
      typeof ticket.file_id !== "string"
    ) {
      throw new Error("Slack did not provide a usable external file upload ticket");
    }
    const uploadUrl = requireSlackUploadUrl(ticket.upload_url);
    const bytes = await loadFile(attachment.path);
    if (bytes.byteLength !== attachment.size) {
      throw new Error("Slack attachment changed after it was validated");
    }
    const uploaded = await fetchFile(uploadUrl, {
      method: "POST",
      body: new Uint8Array(bytes),
      redirect: "error",
    });
    if (!uploaded.ok) {
      throw new Error("Slack external file upload failed");
    }
    files.push({
      id: ticket.file_id,
      ...(attachment.title === undefined ? {} : { title: attachment.title }),
    });
  }

  const completed = asRecord(
    await client.apiCall("files.completeUploadExternal", {
      channel_id: channelId,
      thread_ts: rootThreadTs,
      files,
    }),
  );
  if (completed?.ok !== true) {
    throw new Error("Slack did not complete the external file upload");
  }
}

function requireSlackUploadUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "slack.com" && !url.hostname.endsWith(".slack.com")) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Slack returned an unsafe external file upload URL");
  }
  return url;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
