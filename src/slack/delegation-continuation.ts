import type { WebClient } from "@slack/web-api";

import {
  CoreError,
  type DelegationResultMessage,
  type GatewayAgentEvent,
} from "../core/index.js";
import {
  presentationForChannel,
  type SlackPresentationsByChannel,
} from "./presentation.js";
import { SlackThreadProjector } from "./projector.js";
import { formatAgentTextForSlack } from "./text-format.js";

const MAX_FALLBACK_RESULT_TEXT = 3_000;

export interface UserInputProjectionFailure {
  readonly kind: "git_approval" | "choice" | "approval";
  readonly sessionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly requestId: string;
}

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
    },
  );
  let turnError: unknown;
  let projectionError: unknown;
  try {
    for await (const result of events) {
      projector.setSessionId(result.sessionId);
      try {
        await projector.project(result.event);
      } catch (error) {
        if (
          (result.event.type === "user_input.requested" ||
            result.event.type === "choice.requested" ||
            result.event.type === "approval.requested") &&
          onUserInputProjectionFailure !== undefined
        ) {
          await onUserInputProjectionFailure({
            kind:
              result.event.type === "user_input.requested"
                ? "git_approval"
                : result.event.type === "approval.requested"
                  ? "approval"
                  : "choice",
            sessionId: result.sessionId,
            channelId: result.conversation.channelId,
            rootThreadTs: result.conversation.rootThreadTs,
            requestId: result.event.requestId,
          });
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
    throw turnError;
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
    throw completionError;
  }
  if (projectionError !== undefined) {
    throw projectionError;
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
