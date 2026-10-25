import { createHash, randomUUID } from "node:crypto";

export const APPROVAL_DELIVERY_BUILD_IDENTITY =
  "showtalk-taishi@0.0.1/approval-delivery-v3";

export type InteractionAuditEvent =
  | "approval_text.binding_validated"
  | "approval_text.binding_rejected"
  | "approval_text.broker_result"
  | "approval_text.classification_rejected"
  | "approval_text.failed"
  | "approval.request_received"
  | "approval.controls_attached"
  | "turn_start.collaboration_mode_attached"
  | "turn_start.dispatched"
  | "turn_start.bound"
  | "turn.terminalized"
  | "workspace_git.plan_notification_received"
  | "workspace_git.plan_registered"
  | "workspace_git.plan_binding_failed"
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
  | "choice.display_failed"
  | "choice.expired"
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
  | "git_approval.delivery_failed"
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
  "approver_mismatch",
  "attribution_format_mismatch",
  "attribution_identity_mismatch",
  "automatic_choice",
  "before_start_bound",
  "broker_applied",
  "broker_persist_failed",
  "broker_result_unknown",
  "broker_status_conflict",
  "broker_transport_failed",
  "callback_binding_missing",
  "client_error",
  "configured",
  "command_format_mismatch",
  "deferred_queue_full",
  "delivery_failed",
  "decision_context_missing",
  "direct_server_request",
  "display_failed",
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
  "invalid_route",
  "message_envelope_unsupported",
  "message_order_invalid",
  "other",
  "outside_exact_active_turn",
  "plan_capture_invalid",
  "plan_expired_before_binding",
  "plan_not_received",
  "plan_notification_received_different_turn",
  "plan_notification_received_same_turn",
  "plan_notification_server_unrecognized",
  "plan_received_different_turn",
  "plan_registered_same_turn",
  "reject",
  "request_unavailable",
  "resolved_after_dispatch",
  "resolved_before_callback_binding",
  "resolved_before_dispatch",
  "resolved_without_local_binding",
  "response_deserialize_failed",
  "response_receiver_dropped",
  "response_written",
  "responder_mismatch",
  "route_fields_invalid",
  "route_mismatch",
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
  readonly commandMessageTs?: string;
  readonly actorUserId?: string;
  readonly attributionUserId?: string;
  readonly attributionAppId?: string;
  /** Observed syntax only, never proof of the publisher or approver. */
  readonly approvalTextFormat?:
    | "plain"
    | "chatgpt_slack_footer_v1"
    | "chatgpt_slack_footer_v2";
  /** Fixed classifier only; never include exception text, prompts, or answers. */
  readonly outcome?: InteractionAuditOutcome;
}

export interface InteractionAuditIdentity {
  readonly workerId?: string;
  readonly buildIdentity?: string;
}

export interface StructuredInputAuditSummary {
  readonly presentation: "displayed" | "not_displayed" | "unknown";
  readonly decision: "approved" | "rejected" | "none" | "unknown";
  readonly terminal:
    | "answered"
    | "expired"
    | "action_failed"
    | "delivery_failed"
    | "unknown";
  /** Diagnostic signal only. It never establishes presentation or terminal cause. */
  readonly emptyAnswerObserved: boolean;
}

export type InteractionAudit = (input: InteractionAuditInput) => void;

/**
 * Reduces sanitized lifecycle fixtures without inferring causality from an
 * empty App Server answer. Conflicting evidence remains unknown.
 */
export function summarizeStructuredInputAudit(
  events: readonly InteractionAuditInput[],
): StructuredInputAuditSummary {
  const displayed = events.some((event) => event.event === "choice.controls_attached");
  const displayFailed = events.some((event) => event.event === "choice.display_failed");
  const decisions = new Set(events.flatMap((event) =>
    event.event === "choice.answer_recorded" &&
        (event.outcome === "approve" || event.outcome === "reject")
      ? [event.outcome]
      : []
  ));
  const terminals = new Set(events.flatMap((event) => {
    if (event.event === "choice.expired") return ["expired" as const];
    if (event.event === "choice.delivery_failed") return ["delivery_failed" as const];
    if (event.event === "choice.action_failed") return ["action_failed" as const];
    if (
      event.event === "choice.card_terminalized" &&
      event.outcome === "answer_dispatched"
    ) {
      return ["answered" as const];
    }
    return [];
  }));
  return {
    presentation: displayed === displayFailed
      ? "unknown"
      : displayed
        ? "displayed"
        : "not_displayed",
    decision: decisions.size !== 1
      ? decisions.size === 0 ? "none" : "unknown"
      : decisions.has("approve") ? "approved" : "rejected",
    terminal: terminals.size === 1 ? [...terminals][0]! : "unknown",
    emptyAnswerObserved: events.some(
      (event) => event.event === "structured_input.answer_dispatch_failed" &&
        event.outcome === "empty_answers_rejected",
    ),
  };
}

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
      ...(input.commandMessageTs === undefined
        ? {}
        : { commandMessageRef: correlationRef("message", input.commandMessageTs) }),
      ...(input.actorUserId === undefined
        ? {}
        : { actorRef: correlationRef("user", input.actorUserId) }),
      ...(input.attributionUserId === undefined
        ? {}
        : { attributionUserRef: correlationRef("user", input.attributionUserId) }),
      ...(input.attributionAppId === undefined
        ? {}
        : { attributionAppRef: correlationRef("app", input.attributionAppId) }),
      ...(input.approvalTextFormat === undefined
        ? {}
        : { approvalTextFormat: input.approvalTextFormat === "plain" ||
            input.approvalTextFormat === "chatgpt_slack_footer_v1" ||
            input.approvalTextFormat === "chatgpt_slack_footer_v2"
            ? input.approvalTextFormat : "invalid_format_classifier" }),
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
