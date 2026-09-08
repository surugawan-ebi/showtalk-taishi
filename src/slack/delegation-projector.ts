import type { WebClient } from "@slack/web-api";

import type { DelegationActivity } from "../core/index.js";
import {
  presentationForChannel,
  type SlackPresentationsByChannel,
} from "./presentation.js";
import { SlackThreadProjector } from "./projector.js";
import { formatAgentTextForSlack } from "./text-format.js";
import type { WorkspaceGitApprovalDetailsStore } from "./user-input-blocks.js";
import type { StructuredChoiceContinuationStore } from "./choice-continuation.js";

const MAX_DELEGATION_MESSAGE_TEXT = 3_300;
const MAX_DELEGATION_ERROR_TEXT = 2_000;

interface ActiveProjection {
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly sourceAgentId: string;
  readonly sourceChannelId: string;
  readonly sourceRootThreadTs?: string;
  readonly targetAgentId: string;
  readonly projector: SlackThreadProjector;
}

export interface SlackDelegationDestination {
  readonly channelId: string;
  readonly rootThreadTs: string;
}

/** Projects direct Gateway routing into Slack without using Slack as transport. */
export class SlackDelegationProjector {
  readonly #client: WebClient;
  readonly #presentations: SlackPresentationsByChannel;
  readonly #gitApprovalDetailsStore?: WorkspaceGitApprovalDetailsStore;
  readonly #choiceContinuationStore?: StructuredChoiceContinuationStore;
  readonly #active = new Map<string, ActiveProjection>();

  constructor(
    client: WebClient,
    presentations: SlackPresentationsByChannel = {},
    gitApprovalDetailsStore?: WorkspaceGitApprovalDetailsStore,
    choiceContinuationStore?: StructuredChoiceContinuationStore,
  ) {
    this.#client = client;
    this.#presentations = presentations;
    if (gitApprovalDetailsStore !== undefined) {
      this.#gitApprovalDetailsStore = gitApprovalDetailsStore;
    }
    if (choiceContinuationStore !== undefined) {
      this.#choiceContinuationStore = choiceContinuationStore;
    }
  }

  async project(
    activity: DelegationActivity,
  ): Promise<SlackDelegationDestination | undefined> {
    switch (activity.type) {
      case "delegation.started": {
        const result = await this.#client.chat.postMessage({
          channel: activity.targetChannelId,
          text:
            `:wave: *${formatKoe(activity.sourceAgentId)}が` +
            `${formatChannelMention(activity.sourceChannelId)}から訪問しました*\n` +
            formatQuotedAgentText(
              activity.message,
              MAX_DELEGATION_MESSAGE_TEXT,
            ),
          ...presentationForChannel(
            this.#presentations,
            activity.sourceChannelId,
          ),
        });
        if (typeof result.ts !== "string") {
          throw new Error("Slack did not return a timestamp for delegation activity");
        }
        const projector = new SlackThreadProjector(
          this.#client,
          activity.targetChannelId,
          result.ts,
          {
            presentation: presentationForChannel(
              this.#presentations,
              activity.targetChannelId,
            ),
            ...(this.#gitApprovalDetailsStore === undefined
              ? {}
              : { gitApprovalDetailsStore: this.#gitApprovalDetailsStore }),
            ...(this.#choiceContinuationStore === undefined
              ? {}
              : { choiceContinuationStore: this.#choiceContinuationStore }),
          },
        );
        projector.setSessionId(activity.targetSessionId);
        this.#active.set(activity.delegationId, {
          channelId: activity.targetChannelId,
          rootThreadTs: result.ts,
          sourceAgentId: activity.sourceAgentId,
          sourceChannelId: activity.sourceChannelId,
          ...(activity.sourceRootThreadTs === undefined
            ? {}
            : { sourceRootThreadTs: activity.sourceRootThreadTs }),
          targetAgentId: activity.targetAgentId,
          projector,
        });
        return {
          channelId: activity.targetChannelId,
          rootThreadTs: result.ts,
        };
      }
      case "delegation.agent_event": {
        const active = this.#requireActive(activity.delegationId);
        await active.projector.project(activity.event);
        return undefined;
      }
      case "delegation.completed": {
        const active = this.#requireActive(activity.delegationId);
        const errors: unknown[] = [];
        try {
          await captureError(errors, () => active.projector.complete());
          await captureError(errors, () =>
            this.#client.chat.postMessage({
              channel: active.channelId,
              thread_ts: active.rootThreadTs,
              text:
                `:incoming_envelope: *${formatKoe(active.targetAgentId)}が` +
                `${formatKoe(active.sourceAgentId)}へ返答を渡しました*`,
              ...presentationForChannel(this.#presentations, active.channelId),
            }),
          );
          const sourceRootThreadTs = active.sourceRootThreadTs;
          if (sourceRootThreadTs !== undefined) {
            await captureError(errors, () =>
              this.#client.chat.postMessage({
                channel: active.sourceChannelId,
                thread_ts: sourceRootThreadTs,
                text:
                  `:leftwards_arrow_with_hook: *${formatKoe(active.targetAgentId)}から` +
                  `返答を受け取りました*\n${formatChannelMention(active.channelId)}` +
                  "での作業が完了しました。",
                ...presentationForChannel(
                  this.#presentations,
                  active.sourceChannelId,
                ),
              }),
            );
          }
        } finally {
          this.#active.delete(activity.delegationId);
        }
        if (errors.length > 0) throw errors[0];
        return undefined;
      }
      case "delegation.failed": {
        const active = this.#active.get(activity.delegationId);
        if (active !== undefined) {
          const errors: unknown[] = [];
          try {
            await captureError(errors, () => active.projector.complete());
            await captureError(errors, () =>
              this.#client.chat.postMessage({
                channel: active.channelId,
                thread_ts: active.rootThreadTs,
                text:
                  `:warning: *${formatKoe(active.targetAgentId)}との会話に失敗しました*\n` +
                  formatAgentTextForSlack(
                    activity.error.message,
                    MAX_DELEGATION_ERROR_TEXT,
                  ),
                ...presentationForChannel(this.#presentations, active.channelId),
              }),
            );
            const sourceRootThreadTs = active.sourceRootThreadTs;
            if (sourceRootThreadTs !== undefined) {
              await captureError(errors, () =>
                this.#client.chat.postMessage({
                  channel: active.sourceChannelId,
                  thread_ts: sourceRootThreadTs,
                  text:
                    `:warning: *${formatKoe(active.targetAgentId)}との会話に` +
                    "失敗しました*",
                  ...presentationForChannel(
                    this.#presentations,
                    active.sourceChannelId,
                  ),
                }),
              );
            }
          } finally {
            this.#active.delete(activity.delegationId);
          }
          if (errors.length > 0) throw errors[0];
        }
        return undefined;
      }
    }
  }

  #requireActive(delegationId: string): ActiveProjection {
    const active = this.#active.get(delegationId);
    if (active === undefined) {
      throw new Error(`Delegation projection was not started: ${delegationId}`);
    }
    return active;
  }
}

async function captureError(
  errors: unknown[],
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatQuotedAgentText(value: string, maxLength: number): string {
  const quoted = value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return formatAgentTextForSlack(quoted, maxLength);
}

function formatKoe(agentId: string): string {
  return `${escapeMrkdwn(agentId)}のKoe`;
}

function formatChannelMention(channelId: string): string {
  return /^[CDG][A-Z0-9]+$/u.test(channelId)
    ? `<#${channelId}>`
    : `\`${escapeMrkdwn(channelId)}\``;
}
