import { createHash, randomUUID } from "node:crypto";

export const APPROVAL_DELIVERY_BUILD_IDENTITY =
  "showtalk-taishi@0.0.1/approval-delivery-v2";

export type InteractionAuditEvent =
  | "turn_start.collaboration_mode_attached"
  | "turn_start.dispatched"
  | "turn_start.bound"
  | "turn.terminalized"
  | "structured_input.request_received"
  | "structured_input.request_deferred"
  | "structured_input.request_rejected"
  | "structured_input.callback_bound"
  | "structured_input.answer_dispatch_started"
  | "structured_input.answer_dispatch_succeeded"
  | "structured_input.answer_dispatch_failed"
  | "structured_input.request_terminalized"
  | "structured_input.rejected_before_display"
  | "choice.request_received"
  | "choice.card_posted"
  | "choice.controls_attached"
  | "choice.action_received"
  | "choice.answer_recorded"
  | "choice.answer_dispatched"
  | "choice.server_request_resolved"
  | "choice.delivery_failed"
  | "choice.delivery_signal_unattributed"
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

const INTERACTION_AUDIT_OUTCOMES = [
  "UNSUPPORTED_STRUCTURED_INPUT",
  "active",
  "after_start_bound",
  "answer_dispatched",
  "answered_or_cleared",
  "answers_nonempty_check",
  "approve",
  "automatic_choice",
  "before_start_bound",
  "callback_binding_missing",
  "client_error",
  "configured",
  "deferred_queue_full",
  "delivery_failed",
  "direct_server_request",
  "empty_answers_rejected",
  "error",
  "expired",
  "external_action_blocking_required",
  "external_action_description_invalid",
  "external_action_details_invalid",
  "external_action_option_shape_invalid",
  "external_action_question_shape_invalid",
  "external_action_request_invalid",
  "external_unapproved",
  "git_answer_dispatched",
  "invalid_outcome_classifier",
  "interactive",
  "other",
  "outside_exact_active_turn",
  "reject",
  "resolved_after_dispatch",
  "resolved_before_callback_binding",
  "resolved_before_dispatch",
  "resolved_without_local_binding",
  "response_deserialize_failed",
  "response_receiver_dropped",
  "response_written",
  "select",
  "sent",
  "slack_choice_callback_bound",
  "slack_git_callback_bound",
  "terminal_already_observed",
  "transport_write_failed",
  "turn_binding_pending",
  "type_error",
  "unavailable",
  "unknown_error",
] as const;

export type InteractionAuditOutcome =
  (typeof INTERACTION_AUDIT_OUTCOMES)[number];

const INTERACTION_AUDIT_OUTCOME_SET: ReadonlySet<string> = new Set(
  INTERACTION_AUDIT_OUTCOMES,
);

export interface InteractionAuditInput {
  readonly event: InteractionAuditEvent;
  readonly requestId?: string;
  readonly rpcId?: string | number;
  readonly turnId?: string;
  readonly channelId?: string;
  readonly rootThreadTs?: string;
  readonly messageTs?: string;
  readonly sessionId?: string;
  /** Fixed classifier only; never include exception text, prompts, or answers. */
  readonly outcome?: InteractionAuditOutcome;
}

export interface InteractionAuditIdentity {
  readonly workerId?: string;
  readonly buildIdentity?: string;
}

export type InteractionAudit = (input: InteractionAuditInput) => void;

/** Emits allowlisted lifecycle records without payloads, text, answers, or raw IDs. */
export function createInteractionAudit(
  write: (line: string) => void = console.info,
  now: () => number = Date.now,
  identity: InteractionAuditIdentity = {},
): InteractionAudit {
  const workerId = identity.workerId ?? randomUUID();
  const buildIdentity = identity.buildIdentity ?? APPROVAL_DELIVERY_BUILD_IDENTITY;
  assertBoundedIdentity(workerId, "worker");
  assertBoundedIdentity(buildIdentity, "build");
  return (input) => {
    write(JSON.stringify({
      component: "showtalk.interaction_audit",
      timestamp: new Date(now()).toISOString(),
      workerRef: correlationRef("worker", workerId),
      buildIdentity,
      event: input.event,
      ...(input.requestId === undefined
        ? {}
        : {
            requestRef: correlationRef(
              "request",
              normalizeStructuredRequestId(input.requestId),
            ),
          }),
      ...(input.rpcId === undefined
        ? {}
        : { rpcRef: correlationRef("rpc", String(input.rpcId)) }),
      ...(input.turnId === undefined
        ? {}
        : { turnRef: correlationRef("turn", input.turnId) }),
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
      ...(input.outcome === undefined
        ? {}
        : { outcome: fixedClassifier(input.outcome) }),
    }));
  };
}

function normalizeStructuredRequestId(value: string): string {
  return value.replace(/^codex-(?:choice|input):/u, "");
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

function assertBoundedIdentity(value: string, kind: string): void {
  if (
    !/^[A-Za-z0-9@._+/-]{1,128}$/u.test(value)
  ) {
    throw new TypeError(`Interaction audit ${kind} identity is invalid`);
  }
}

function fixedClassifier(value: unknown): InteractionAuditOutcome {
  return typeof value === "string" && INTERACTION_AUDIT_OUTCOME_SET.has(value)
    ? value as InteractionAuditOutcome
    : "invalid_outcome_classifier";
}
