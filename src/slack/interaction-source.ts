export interface TrustedSlackActionSource {
  readonly userId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly teamId: string;
  readonly apiAppId: string;
}

/**
 * Bolt authenticates the Socket Mode envelope before invoking an action
 * listener. This second boundary rejects a valid-but-misrouted callback from a
 * different user, channel, thread, or Block message.
 */
export function validateSlackActionSource(
  body: unknown,
  expected: {
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly messageTs?: string;
  },
  approvers: ReadonlySet<string>,
): TrustedSlackActionSource {
  const record = requiredRecord(body);
  const userId = requiredString(requiredRecord(record.user).id);
  const channelId = requiredString(requiredRecord(record.channel).id);
  const teamId = requiredString(requiredRecord(record.team).id);
  const apiAppId = requiredString(record.api_app_id);
  const message = requiredRecord(record.message);
  const messageTs = requiredString(message.ts);
  const rootThreadTs =
    message.thread_ts === undefined
      ? messageTs
      : requiredString(message.thread_ts);
  const container = requiredRecord(record.container);

  if (record.type !== "block_actions") {
    throw new Error("Slack interaction type is not trusted");
  }
  if (!/^[UW][A-Z0-9]{1,127}$/u.test(userId) || !approvers.has(userId)) {
    throw new Error("Slack user is not configured as a ShowTalk Taishi approver");
  }
  if (
    channelId !== expected.channelId ||
    requiredString(container.channel_id) !== expected.channelId
  ) {
    throw new Error("Git approval channel mismatch");
  }
  if (rootThreadTs !== expected.rootThreadTs) {
    throw new Error("Git approval thread mismatch");
  }
  if (
    expected.messageTs !== undefined &&
    messageTs !== expected.messageTs
  ) {
    throw new Error("Git approval Block message mismatch");
  }
  if (
    container.type !== "message" ||
    requiredString(container.message_ts) !== messageTs
  ) {
    throw new Error("Git approval message source mismatch");
  }
  if (!/^T[A-Z0-9]{1,127}$/u.test(teamId) || !/^A[A-Z0-9]{1,127}$/u.test(apiAppId)) {
    throw new Error("Slack application source is invalid");
  }
  return { userId, channelId, rootThreadTs, messageTs, teamId, apiAppId };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Slack interaction source is incomplete");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error("Slack interaction source is incomplete");
  }
  return value;
}
