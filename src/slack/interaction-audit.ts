import { createHash } from "node:crypto";

export type InteractionAuditEvent =
  | "structured_input.rejected_before_display"
  | "choice.request_received"
  | "choice.card_posted"
  | "choice.controls_attached"
  | "choice.action_received"
  | "choice.answer_applied"
  | "choice.card_terminalized"
  | "choice.resolved_externally"
  | "choice.action_failed"
  | "git_approval.request_received"
  | "git_approval.card_posted"
  | "git_approval.action_received"
  | "git_approval.answer_applied"
  | "git_approval.card_terminalized"
  | "git_approval.resolved_externally"
  | "git_approval.expired"
  | "git_approval.action_failed";

export interface InteractionAuditInput {
  readonly event: InteractionAuditEvent;
  readonly requestId?: string;
  readonly channelId?: string;
  readonly rootThreadTs?: string;
  readonly messageTs?: string;
  readonly sessionId?: string;
  readonly outcome?: string;
}

export type InteractionAudit = (input: InteractionAuditInput) => void;

/** Emits lifecycle records without message text, choices, plans, users, or raw IDs. */
export function createInteractionAudit(
  write: (line: string) => void = console.info,
  now: () => number = Date.now,
): InteractionAudit {
  return (input) => {
    write(JSON.stringify({
      component: "showtalk.interaction_audit",
      timestamp: new Date(now()).toISOString(),
      event: input.event,
      ...(input.requestId === undefined
        ? {}
        : { requestRef: correlationRef("request", input.requestId) }),
      ...(input.channelId === undefined
        ? {}
        : { channelRef: correlationRef("channel", input.channelId) }),
      ...(input.rootThreadTs === undefined
        ? {}
        : { threadRef: correlationRef("thread", input.rootThreadTs) }),
      ...(input.messageTs === undefined
        ? {}
        : { messageRef: correlationRef("message", input.messageTs) }),
      ...(input.sessionId === undefined
        ? {}
        : { sessionRef: correlationRef("session", input.sessionId) }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    }));
  };
}

function correlationRef(kind: string, value: string): string {
  return createHash("sha256")
    .update("showtalk-interaction-audit-v1\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}
