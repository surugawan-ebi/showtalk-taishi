import type { WebClient } from "@slack/web-api";

import {
  CoreError,
  type DelegationResultMessage,
  type GatewayAgentEvent,
  type WorkspaceGitApprovalPlan,
} from "../core/index.js";
import {
  presentationForChannel,
  type SlackPresentationsByChannel,
} from "./presentation.js";
import { SlackThreadProjector } from "./projector.js";
import { formatAgentTextForSlack } from "./text-format.js";
import type { WorkspaceGitApprovalDetailsStore } from "./user-input-blocks.js";
import type { StructuredChoiceContinuationStore } from "./choice-continuation.js";

const MAX_FALLBACK_RESULT_TEXT = 3_000;

export class DelegationContinuationDeliveryError extends Error {
  readonly delegationResultPublished: boolean;

  constructor(cause: unknown, delegationResultPublished: boolean) {
    super(
      cause instanceof Error
        ? cause.message
        : "Delegation continuation projection was incomplete",
      { cause },
    );
    this.name = "DelegationContinuationDeliveryError";
    this.delegationResultPublished = delegationResultPublished;
  }
}

export type UserInputProjectionFailure = {
  readonly kind: "git_approval";
  readonly plan: WorkspaceGitApprovalPlan;
  readonly sessionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly requestId: string;
} | {
  readonly kind: "choice" | "approval";
  readonly sessionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly requestId: string;
};

/**
 * Projects a source-Koe continuation and preserves the target's actual result
 * as a fallback if the source turn cannot be completed.
 */
export async function projectDelegationContinuation(
  client: WebClient,
  request: DelegationResultMessage,
  events: AsyncIterable<GatewayAgentEvent>,
  presentations: SlackPresentationsByChannel = {},
  defaultNotificationUserId?: string,
  onUserInputProjectionFailure?: (
    failure: UserInputProjectionFailure,
  ) => Promise<void>,
  gitApprovalDetailsStore?: WorkspaceGitApprovalDetailsStore,
  onExternalGitResolution?: (
    event: Extract<GatewayAgentEvent["event"], {
      type: "git_approval.resolved_externally";
    }>,
  ) => Promise<void>,
  choiceContinuationStore?: StructuredChoiceContinuationStore,
): Promise<void> {
  const sourceUserId =
    request.sourceSlackUserId ?? defaultNotificationUserId;
  const projector = new SlackThreadProjector(
    client,
    request.sourceChannelId,
    request.sourceRootThreadTs,
    {
      ...(sourceUserId === undefined ? {} : { sourceUserId }),
      // A delayed continuation is intentionally concise and atomic in Slack;
      // one final post avoids partial multi-chunk delivery and raw-result duplication.
      maxFinalChunks: 1,
      presentation: presentationForChannel(
        presentations,
        request.sourceChannelId,
      ),
      ...(gitApprovalDetailsStore === undefined
        ? {}
        : { gitApprovalDetailsStore }),
      ...(choiceContinuationStore === undefined
        ? {}
        : { choiceContinuationStore }),
    },
  );
  let turnError: unknown;
  let projectionError: unknown;
  try {
    for await (const result of events) {
      projector.setSessionId(result.sessionId);
      if (result.event.type === "git_approval.resolved_externally") {
        let settlementError: unknown;
        try {
          await onExternalGitResolution?.(result.event);
        } catch (error) {
          settlementError = error;
        }
        let terminalProjectionError: unknown;
        try {
          await projector.project(result.event);
        } catch (error) {
          terminalProjectionError = error;
        }
        if (settlementError !== undefined && terminalProjectionError !== undefined) {
          projectionError ??= new AggregateError(
            [settlementError, terminalProjectionError],
            "Externally resolved Git approval could not be fully settled",
          );
        } else if (settlementError !== undefined) {
          projectionError ??= settlementError;
        }
        // Once the reject intent is durable, terminal Slack projection is
        // cosmetic and must not abort the delayed Codex continuation.
        continue;
      }
      try {
        await projector.project(result.event);
      } catch (error) {
        if (
          (result.event.type === "user_input.requested" ||
            result.event.type === "choice.requested" ||
            result.event.type === "approval.requested") &&
          onUserInputProjectionFailure !== undefined
        ) {
          const common = {
            sessionId: result.sessionId,
            channelId: result.conversation.channelId,
            rootThreadTs: result.conversation.rootThreadTs,
            requestId: result.event.requestId,
          };
          if (result.event.type === "user_input.requested") {
            await onUserInputProjectionFailure({
              kind: "git_approval",
              plan: result.event.plan,
              ...common,
            });
          } else {
            await onUserInputProjectionFailure({
              kind:
                result.event.type === "approval.requested"
                  ? "approval"
                  : "choice",
              ...common,
            });
          }
        }
        // Match ordinary Slack turns: a cosmetic stream update must not cancel
        // the underlying source Koe continuation. A structured request is
        // first rejected above so its live App Server RPC cannot be stranded.
        projectionError ??= error;
      }
    }
  } catch (error) {
    turnError = error;
  }

  if (turnError !== undefined) {
    await projector.abandon();
    if (
      turnError instanceof CoreError &&
      turnError.code === "DELEGATION_RESULT_ALREADY_HANDLED"
    ) {
      return;
    }
    await postRawResultFallback(
      client,
      request,
      presentations,
      sourceUserId,
    );
    throw new DelegationContinuationDeliveryError(turnError, true);
  }

  let completionError: unknown;
  try {
    await projector.complete();
  } catch (error) {
    completionError = error;
  }
  if (completionError !== undefined) {
    if (!projector.hasPublishedFinalResponse()) {
      await postRawResultFallback(client, request, presentations, sourceUserId);
    }
    throw new DelegationContinuationDeliveryError(completionError, true);
  }
  if (projectionError !== undefined) {
    throw new DelegationContinuationDeliveryError(
      projectionError,
      projector.hasPublishedFinalResponse(),
    );
  }
}

async function postRawResultFallback(
  client: WebClient,
  request: DelegationResultMessage,
  presentations: SlackPresentationsByChannel,
  sourceUserId: string | undefined,
): Promise<void> {
  const mention = formatSlackUserMention(sourceUserId);
  const result = formatAgentTextForSlack(
    request.result,
    MAX_FALLBACK_RESULT_TEXT,
  );
  await client.chat.postMessage({
    channel: request.sourceChannelId,
    thread_ts: request.sourceRootThreadTs,
    text:
      `${mention}${mention.length === 0 ? "" : "\n\n"}` +
      `:warning: *${escapeMrkdwn(request.sourceAgentId)}のKoeで返答を整理` +
      `できなかったため、${escapeMrkdwn(request.targetAgentId)}のKoeの返答を` +
      `そのまま表示します*\n\n${result}`,
    ...presentationForChannel(presentations, request.sourceChannelId),
  });
}

function formatSlackUserMention(userId: string | undefined): string {
  return userId !== undefined && /^[A-Za-z0-9]+$/u.test(userId)
    ? `<@${userId}>`
    : "";
}

function escapeMrkdwn(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
