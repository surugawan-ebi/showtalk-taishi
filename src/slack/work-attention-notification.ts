import type { WorkAttentionNotification } from "../diagnostics/work-stoppage-monitor.js";

export const WORK_ATTENTION_SLACK_MARKER = "SHOWTALK_WORK_ATTENTION_V1";

export interface WorkAttentionSlackPostArguments {
  readonly channel: string;
  readonly text: string;
  readonly mrkdwn: false;
}

/**
 * Visible approval waits are expected operator interactions, not incidents that
 * need a separate operations-channel notification. They remain in the local
 * work-attention audit so diagnosis and lifecycle reconciliation are intact.
 */
export function shouldPostWorkAttentionToSlack(
  notification: WorkAttentionNotification,
): boolean {
  return notification.reason !== "visible_approval_wait";
}

/**
 * Builds the stable, payload-free Slack contract consumed by external
 * notification bridges. The result is always a new root message: callers must
 * not add thread_ts or replace it with an update/delete operation.
 */
export function workAttentionSlackPostArguments(
  channel: string,
  notification: WorkAttentionNotification,
): WorkAttentionSlackPostArguments {
  assertSlackChannelId(channel);
  assertIncidentRef(notification.incidentRef);
  const targetKoe = safeContractValue(notification.agentId, "target Koe", 256);
  const sourceThread = sourceThreadValue(notification);
  const lifecycle = notification.event === "attention_required"
    ? "detected"
    : "recovered";
  return {
    channel,
    mrkdwn: false,
    text: [
      WORK_ATTENTION_SLACK_MARKER,
      `incident_id: ${notification.incidentRef}`,
      `status: ${lifecycle}`,
      `target_koe: ${targetKoe}`,
      `source_thread: ${sourceThread}`,
      `reason: ${notification.reason}`,
      `last_progress_at: ${notification.lastProgressAt}`,
      `next_safe_action: ${notification.nextAction}`,
    ].join("\n"),
  };
}

function sourceThreadValue(notification: WorkAttentionNotification): string {
  if (
    notification.sourceChannelId === undefined ||
    notification.sourceRootThreadTs === undefined
  ) {
    return "unavailable";
  }
  assertSlackChannelId(notification.sourceChannelId);
  if (!/^\d{1,20}\.\d{1,20}$/u.test(notification.sourceRootThreadTs)) {
    throw new Error("Invalid work-attention source thread timestamp");
  }
  return `${notification.sourceChannelId}/${notification.sourceRootThreadTs}`;
}

function assertSlackChannelId(value: string): void {
  if (!/^[CDG][A-Z0-9]{1,127}$/u.test(value)) {
    throw new Error("Invalid work-attention Slack channel ID");
  }
}

function assertIncidentRef(value: string): void {
  if (!/^[a-f0-9]{16}$/u.test(value)) {
    throw new Error("Invalid work-attention incident ID");
  }
}

function safeContractValue(value: string, name: string, maxLength: number): string {
  if (
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
  ) {
    throw new Error(`Invalid work-attention ${name}`);
  }
  return value;
}
