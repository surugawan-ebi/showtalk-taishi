import {
  MAX_SLACK_ATTACHMENT_FILE_BYTES,
  MAX_SLACK_ATTACHMENT_TOTAL_BYTES,
  type RuntimeSlackAttachment,
} from "../mcp/workspace-attachments.js";

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
  const files: Array<{ id: string; title?: string }> = [];
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (
      attachment.payload.size <= 0 ||
      attachment.payload.size > MAX_SLACK_ATTACHMENT_FILE_BYTES
    ) {
      throw new Error("Slack attachment payload has an invalid size");
    }
    totalBytes += attachment.payload.size;
    if (totalBytes > MAX_SLACK_ATTACHMENT_TOTAL_BYTES) {
      throw new Error("Slack attachment payloads exceed the total size limit");
    }
  }

  try {
    for (const attachment of attachments) {
      const ticket = asRecord(
        await client.files.getUploadURLExternal({
          filename: attachment.name,
          length: attachment.payload.size,
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
      files.push({
        id: ticket.file_id,
        ...(attachment.title === undefined ? {} : { title: attachment.title }),
      });
      const uploaded = await fetchFile(uploadUrl, {
        method: "POST",
        body: attachment.payload,
        redirect: "error",
      });
      await uploaded.body?.cancel().catch(() => undefined);
      if (!uploaded.ok) {
        throw new Error("Slack external file upload failed");
      }
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
  } catch (error) {
    // Uploaded-but-uncompleted tickets are not visible as the requested
    // message, but deleting every acquired file ID avoids abandoned uploads
    // and also compensates uncertain partial completion.
    await Promise.allSettled(
      files.map(({ id }) => client.apiCall("files.delete", { file: id })),
    );
    throw error;
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
