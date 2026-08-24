import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";

import type {
  DelegationActivity,
  DelegationResultMessage,
  Gateway,
  GatewayAgentEvent,
  AgentEvent,
} from "../core/index.js";
import type { RuntimeSlackAttachment } from "../mcp/workspace-attachments.js";
import type {
  PermissionApprovalCoordinator,
  PermissionApprovalPresentation,
  PermissionApprovalSettlement,
} from "../permissions/approval-coordinator.js";
import {
  APPROVAL_ACTION_PREFIX,
  parseApprovalActionValue,
  parseApprovalDecision,
} from "./blocks.js";
import { SlackThreadProjector } from "./projector.js";
import { SlackEventDeduplicator } from "./deduplicator.js";
import { SlackDelegationProjector } from "./delegation-projector.js";
import { projectDelegationContinuation } from "./delegation-continuation.js";
import { SlackFileTransport } from "./file-transport.js";
import { uploadSlackAttachments } from "./file-upload.js";
import {
  PERMISSION_ACTION_PREFIX,
  buildPermissionApprovalBlocks,
  parsePermissionActionValue,
  parsePermissionDecision,
} from "./permission-blocks.js";
import {
  presentationForChannel,
  type SlackMessagePresentation,
  type SlackPresentationsByChannel,
} from "./presentation.js";
import {
  CONVERSATION_CONTROL_ACTION_PREFIX,
  buildConversationControlBlocks,
  parseConversationControlAction,
  parseConversationControlActionValue,
} from "./controls.js";
import { validateSlackActionSource } from "./interaction-source.js";
import {
  GIT_APPROVAL_RECOVERY_ACTION_PREFIX,
  GitApprovalRecoveryActionTracker,
  buildGitApprovalRecoveryBlocks,
  parseGitApprovalRecoveryActionValue,
  parseGitApprovalRecoveryDecision,
} from "./git-approval-recovery-blocks.js";
import {
  USER_INPUT_ACTION_PREFIX,
  WorkspaceGitApprovalDetailsStore,
  buildWorkspaceGitApprovalBlocks,
  parseUserInputActionValue,
  parseUserInputBodyVisibility,
  parseUserInputDecision,
  parseUserInputPathVisibility,
  type UserInputActionValue,
} from "./user-input-blocks.js";
import {
  CHOICE_ACTION_PREFIX,
  CHOICE_OTHER_VIEW_CALLBACK_ID,
  buildChoiceOtherModal,
  parseChoiceActionKind,
  parseChoiceActionValue,
  parseChoiceOtherSubmission,
} from "./choice-blocks.js";
import { PermissionApprovalCardTracker } from "./permission-card-tracker.js";

export interface SlackFrontendOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly approverUserIds: readonly string[];
  readonly agentChannelIds: readonly string[];
  readonly agentIdsByChannel: Readonly<Record<string, string>>;
  readonly presentationsByChannel?: SlackPresentationsByChannel;
  readonly durableEventLedger?: {
    has(eventId: string): boolean;
    record(eventId: string): Promise<void>;
  };
  readonly attachmentRoot: string;
  readonly permissionApprovals?: PermissionApprovalCoordinator;
  readonly requestRestart?: () => void;
}

export interface HumanSlackMessage {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly thread_ts?: string;
  readonly user?: string;
  readonly fileIds: readonly string[];
}

export interface PermissionApprovalMessageRoute {
  readonly channelId: string;
  readonly messageTs: string;
  readonly rootThreadTs?: string;
  readonly operation: string;
}

const GIT_APPROVAL_REPREPARE_PROMPT = [
  "The Slack approver explicitly requested a fresh Git approval UI.",
  "The previous workspace-git operation is unbound, expired, or otherwise not approvable in this turn.",
  "Do not approve, execute, or reuse the old operation.",
  "Inspect the current repository/worktree status, re-run the matching workspace-git prepare_* operation with the current exact state in this turn, then immediately call request_user_input with exactly `承認して実行` and `拒否・保留`.",
  "If a fresh exact plan cannot be prepared, explain the current blocker without claiming that approval controls were displayed.",
].join("\n");

export class SlackFrontend {
  readonly #app: App;
  readonly #gateway: Gateway;
  readonly #approvers: ReadonlySet<string>;
  readonly #agentChannels: ReadonlySet<string>;
  readonly #agentIdsByChannel: ReadonlyMap<string, string>;
  readonly #deduplicator = new SlackEventDeduplicator();
  readonly #fileTransport: SlackFileTransport;
  readonly #permissionApprovals: PermissionApprovalCoordinator | undefined;
  readonly #delegationProjector: SlackDelegationProjector;
  readonly #defaultNotificationUserId: string | undefined;
  readonly #requestRestart: (() => void) | undefined;
  readonly #presentationsByChannel: SlackPresentationsByChannel;
  readonly #durableEventLedger: SlackFrontendOptions["durableEventLedger"];
  readonly #idleWaiters = new Set<() => void>();
  readonly #gitApprovalRecoveryActions = new GitApprovalRecoveryActionTracker();
  readonly #gitApprovalDetails = new WorkspaceGitApprovalDetailsStore();
  readonly #permissionApprovalCards = new PermissionApprovalCardTracker();
  readonly #gitApprovalActionTails = new Map<string, Promise<void>>();
  #activeMessageHandlers = 0;
  #restartPending = false;
  #stopPromise: Promise<void> | undefined;

  constructor(gateway: Gateway, options: SlackFrontendOptions) {
    this.#gateway = gateway;
    this.#approvers = new Set(options.approverUserIds);
    this.#agentChannels = new Set(options.agentChannelIds);
    this.#agentIdsByChannel = new Map(Object.entries(options.agentIdsByChannel));
    this.#fileTransport = new SlackFileTransport({
      botToken: options.botToken,
      rootDirectory: options.attachmentRoot,
    });
    this.#permissionApprovals = options.permissionApprovals;
    this.#requestRestart = options.requestRestart;
    this.#presentationsByChannel = options.presentationsByChannel ?? {};
    this.#durableEventLedger = options.durableEventLedger;
    this.#defaultNotificationUserId = options.approverUserIds[0];
    this.#app = new App({
      token: options.botToken,
      appToken: options.appToken,
      socketMode: true,
      ignoreSelf: true,
    });
    this.#delegationProjector = new SlackDelegationProjector(
      this.#app.client,
      this.#presentationsByChannel,
    );
    this.#registerListeners();
  }

  async start(): Promise<void> {
    await this.#app.start();
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= Promise.resolve(this.#app.stop()).then(() => undefined);
    await this.#stopPromise;
  }

  beginRestart(): void {
    this.#restartPending = true;
  }

  isIdle(): boolean {
    return this.#activeMessageHandlers === 0;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  #beginSlackHandler(): () => void {
    this.#activeMessageHandlers += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#activeMessageHandlers -= 1;
      if (this.#activeMessageHandlers === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    };
  }

  #presentation(channelId: string): SlackMessagePresentation {
    return presentationForChannel(this.#presentationsByChannel, channelId);
  }

  async postMessage(
    channelId: string,
    text: string | undefined,
    attachments: readonly RuntimeSlackAttachment[] = [],
  ): Promise<string> {
    const result = await this.#app.client.chat.postMessage({
      channel: channelId,
      text: text ?? attachmentFallbackText(attachments.length),
      ...this.#presentation(channelId),
    });
    if (typeof result.ts !== "string") {
      throw new Error("Slack did not return a timestamp for the posted message");
    }
    const messageTs = result.ts;
    try {
      await this.#uploadAttachments(channelId, messageTs, attachments);
    } catch (error) {
      await this.#app.client.chat.delete({ channel: channelId, ts: messageTs }).catch(
        async (cleanupError) => {
          await this.#app.client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: ":warning: Attachment upload failed; this message was not delivered completely.",
            blocks: [],
          }).catch(() => undefined);
          throw new AggregateError(
            [error, cleanupError],
            "Slack attachment upload failed and its partial message could not be removed",
          );
        },
      );
      throw error;
    }
    return messageTs;
  }

  async reply(
    channelId: string,
    rootThreadTs: string,
    text: string | undefined,
    attachments: readonly RuntimeSlackAttachment[] = [],
  ): Promise<string> {
    const result = await this.#app.client.chat.postMessage({
      channel: channelId,
      thread_ts: rootThreadTs,
      text: text ?? attachmentFallbackText(attachments.length),
      ...this.#presentation(channelId),
    });
    if (typeof result.ts !== "string") {
      throw new Error("Slack did not return a timestamp for the posted reply");
    }
    const messageTs = result.ts;
    try {
      await this.#uploadAttachments(channelId, rootThreadTs, attachments);
    } catch (error) {
      await this.#app.client.chat.delete({ channel: channelId, ts: messageTs }).catch(
        async (cleanupError) => {
          await this.#app.client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: ":warning: Attachment upload failed; this reply was not delivered completely.",
            blocks: [],
          }).catch(() => undefined);
          throw new AggregateError(
            [error, cleanupError],
            "Slack attachment upload failed and its partial reply could not be removed",
          );
        },
      );
      throw error;
    }
    return messageTs;
  }

  async #uploadAttachments(
    channelId: string,
    rootThreadTs: string,
    attachments: readonly RuntimeSlackAttachment[],
  ): Promise<void> {
    await uploadSlackAttachments(
      this.#app.client,
      channelId,
      rootThreadTs,
      attachments,
    );
  }

  async projectDelegation(activity: DelegationActivity) {
    return this.#delegationProjector.project(activity);
  }

  async projectDelegationContinuation(
    request: DelegationResultMessage,
    events: AsyncIterable<GatewayAgentEvent>,
  ): Promise<void> {
    await projectDelegationContinuation(
      this.#app.client,
      request,
      events,
      this.#presentationsByChannel,
      this.#defaultNotificationUserId,
      async (failure) => {
        if (failure.kind === "approval") {
          await this.#gateway.resolveSessionApproval(failure.sessionId, {
            requestId: failure.requestId,
            decision: "cancel",
          });
        } else {
          await this.#gateway.resolveSessionUserInput(failure.sessionId, {
            requestId: failure.requestId,
            ...(failure.kind === "git_approval"
              ? { optionId: "reject" as const }
              : { cancelled: true as const }),
          });
        }
        await this.#app.client.chat
          .postMessage({
            channel: failure.channelId,
            thread_ts: failure.rootThreadTs,
            text:
              failure.kind === "git_approval"
                ? ":warning: Git approval controls could not be displayed, so " +
                  "this request was rejected safely. Ask this Koe to re-prepare " +
                  "the operation in a new turn."
                : failure.kind === "approval"
                  ? ":warning: Approval controls could not be displayed, so " +
                    "this request was cancelled safely."
                : ":warning: 選択肢を表示できなかったため、この質問を" +
                  "キャンセルしました。文章で質問し直してください。",
            ...this.#presentation(failure.channelId),
          })
          .catch(() => undefined);
      },
    );
  }

  async presentPermissionApproval(
    request: PermissionApprovalPresentation,
  ): Promise<void> {
    let route: PermissionApprovalMessageRoute | undefined;
    try {
      const posted = await this.#app.client.chat.postMessage(
        permissionApprovalPostArguments(
          request,
          this.#defaultNotificationUserId,
          this.#presentation(request.sourceChannelId),
        ),
      );
      if (typeof posted.ts !== "string") {
        throw new Error("Slack did not return a permission approval message timestamp");
      }
      route = {
        channelId: request.sourceChannelId,
        messageTs: posted.ts,
        ...(request.sourceRootThreadTs === undefined
          ? {}
          : { rootThreadTs: request.sourceRootThreadTs }),
        operation: request.operation,
      };
      this.#permissionApprovalCards.rememberRoute(request.requestId, route);
    } catch (error) {
      this.#permissionApprovalCards.discardUnroutedSettlement(request.requestId);
      throw error;
    }
    if (this.#permissionApprovalCards.settlementFor(request.requestId) !== undefined) {
      // The operation has already settled. A cosmetic update failure must not
      // reverse that decision; retain both records so a click can retry it.
      await this.#applyPermissionApprovalSettlement(request.requestId).catch(
        () => undefined,
      );
    }
  }

  async settlePermissionApproval(
    settlement: PermissionApprovalSettlement,
  ): Promise<void> {
    this.#permissionApprovalCards.rememberSettlement(settlement);
    await this.#applyPermissionApprovalSettlement(settlement.requestId);
  }

  async #applyPermissionApprovalSettlement(
    requestId: string,
  ): Promise<void> {
    await this.#permissionApprovalCards.apply(
      requestId,
      async (route, settlement) => {
        await this.#app.client.chat.update(
          permissionApprovalSettlementUpdateArguments(route, settlement),
        );
      },
    );
  }

  async #serializeGitApprovalAction<T>(
    routing: UserInputActionValue,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = `${routing.channelId}\u0000${routing.messageTs}\u0000${routing.requestId}`;
    const previous = this.#gitApprovalActionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#gitApprovalActionTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#gitApprovalActionTails.get(key) === tail) {
        this.#gitApprovalActionTails.delete(key);
      }
    }
  }

  #registerListeners(): void {
    this.#app.event("message", async ({ event, body, client, logger }) => {
      if (this.#durableEventLedger?.has(body.event_id) === true) return;
      if (!this.#deduplicator.accept(body.event_id)) return;
      const message = parseHumanSlackMessage(event);
      if (message === undefined) return;
      if (!this.#agentChannels.has(message.channel)) return;
      if (message.text.trim().length === 0 && message.fileIds.length === 0) return;
      const agentId = this.#agentIdsByChannel.get(message.channel);
      if (agentId === undefined) return;
      const finishHandler = this.#beginSlackHandler();
      try {
        if (this.#restartPending) {
          const rootThreadTs = message.thread_ts ?? message.ts;
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: rootThreadTs,
            text: ":arrows_counterclockwise: Gateway restart is in progress. Please resend this message after Taishi reconnects.",
            ...this.#presentation(message.channel),
          });
          return;
        }
        const rootThreadTs =
          typeof message.thread_ts === "string" ? message.thread_ts : message.ts;
        const projector = new SlackThreadProjector(
          client,
          message.channel,
          rootThreadTs,
          {
            ...(typeof message.user === "string"
              ? { sourceUserId: message.user }
              : {}),
            presentation: this.#presentation(message.channel),
            gitApprovalDetailsStore: this.#gitApprovalDetails,
          },
        );
        let projectionStarted = false;
        let turnAttempted = false;
        try {
          // Acknowledge the Slack message before attachment downloads, session
          // resume, or Gateway queueing. Those operations can legitimately take
          // time, but the user should immediately see that Taishi accepted the
          // request and is still working on it.
          await projector.project({
            type: "status.changed",
            status: "starting",
          });
          projectionStarted = true;
          const downloaded = await this.#fileTransport.download({
            agentId,
            channelId: message.channel,
            messageTs: message.ts,
            fileIds: message.fileIds,
            client,
          });
          if (downloaded.ignored.length > 0) {
            await client.chat.postMessage({
              channel: message.channel,
              thread_ts: rootThreadTs,
              text:
                `:warning: Ignored ${downloaded.ignored.length} unsupported attachment(s). ` +
                "ShowTalk Taishi accepts PNG, JPEG, GIF, WebP, MP3, M4A, WAV, OGG, FLAC, and AAC.",
              ...this.#presentation(message.channel),
            });
          }
          if (
            message.text.trim().length === 0 &&
            downloaded.attachments.length === 0
          ) {
            await projector.project({
              type: "message.completed",
              text: "対応可能な本文または添付がなかったため、処理を開始しませんでした。",
            });
            return;
          }
          if (typeof message.thread_ts !== "string") {
            await client.chat.postMessage({
                channel: message.channel,
                thread_ts: rootThreadTs,
                text: "ShowTalk Taishi conversation controls",
                ...this.#presentation(message.channel),
              })
              .then(async (posted) => {
                if (typeof posted.ts !== "string") {
                  throw new Error("Slack did not return a control message timestamp");
                }
                await client.chat.update({
                  channel: message.channel,
                  ts: posted.ts,
                  text: "ShowTalk Taishi conversation controls",
                  blocks: buildConversationControlBlocks({
                    channelId: message.channel,
                    rootThreadTs,
                    messageTs: posted.ts,
                  }),
                });
              })
              .catch((error) => logger.error(error));
          }
          turnAttempted = true;
          for await (const result of this.#gateway.handleHumanMessage({
            channelId: message.channel,
            rootThreadTs,
            messageTs: message.ts,
            text: message.text,
            ...(downloaded.attachments.length === 0
              ? {}
              : { attachments: downloaded.attachments }),
            ...(typeof message.user === "string"
              ? { slackUserId: message.user }
              : {}),
          })) {
            projector.setSessionId(result.sessionId);
            try {
              await projector.project(result.event);
            } catch (error) {
              logger.error(error);
              if (result.event.type === "choice.requested") {
                try {
                  await this.#gateway.resolveSessionUserInput(result.sessionId, {
                    requestId: result.event.requestId,
                    cancelled: true,
                  });
                } catch (resolutionError) {
                  throw new AggregateError(
                    [error, resolutionError],
                    "Structured choice UI failed and the request could not be cancelled",
                  );
                }
                await client.chat
                  .postMessage({
                    channel: message.channel,
                    thread_ts: rootThreadTs,
                    text:
                      ":warning: 選択肢を表示できなかったため、この質問を" +
                      "キャンセルしました。文章で質問し直してください。",
                    ...this.#presentation(message.channel),
                  })
                  .catch((projectionError) => logger.error(projectionError));
                continue;
              }
              if (result.event.type === "user_input.requested") {
                try {
                  await this.#gateway.resolveSessionUserInput(result.sessionId, {
                    requestId: result.event.requestId,
                    optionId: "reject",
                  });
                } catch (resolutionError) {
                  // Leaving the App Server RPC unresolved would strand the
                  // turn. Escaping the stream lets Gateway cleanup interrupt it.
                  throw new AggregateError(
                    [error, resolutionError],
                    "Git approval controls failed and the request could not be rejected",
                  );
                }
                await client.chat
                  .postMessage({
                    channel: message.channel,
                    thread_ts: rootThreadTs,
                    text:
                      ":warning: Git approval controls could not be displayed, " +
                      "so this request was rejected safely. Ask this Koe to " +
                      "re-prepare the operation in a new turn.",
                    ...this.#presentation(message.channel),
                  })
                  .catch((projectionError) => logger.error(projectionError));
                continue;
              }
              if (result.event.type === "approval.requested") {
                try {
                  await cancelUnprojectedNativeApproval(
                    this.#gateway,
                    result.sessionId,
                    result.event,
                  );
                } catch (resolutionError) {
                  throw new AggregateError(
                    [error, resolutionError],
                    "Approval UI failed and the request could not be cancelled",
                  );
                }
                await client.chat
                  .postMessage({
                    channel: message.channel,
                    thread_ts: rootThreadTs,
                    text:
                      ":warning: Approval controls could not be displayed, so " +
                      "the request was cancelled safely.",
                    ...this.#presentation(message.channel),
                  })
                  .catch((projectionError) => logger.error(projectionError));
                continue;
              }
              // Cosmetic Slack projection failures must not cancel ordinary
              // coding work. Structured approvals are handled above because
              // they would otherwise leave a live RPC waiting forever.
            }
          }
        } catch (error) {
          logger.error(error);
          const messageText = publicErrorMessage(error);
          try {
            // Keep failure state in the same projector that completes this
            // Slack turn. Posting the warning out-of-band made complete()
            // append a contradictory generic success after pre-turn failures.
            await projector.project({
              type: "error",
              code: "GATEWAY_TURN_FAILED",
              message: messageText,
            });
          } catch (projectionError) {
            logger.error(projectionError);
            await client.chat
              .postMessage({
                channel: message.channel,
                thread_ts: rootThreadTs,
                text: `:warning: ${messageText}`,
                ...this.#presentation(message.channel),
              })
              .catch((fallbackError) => logger.error(fallbackError));
          }
        } finally {
          if (projectionStarted || turnAttempted) {
            await projector.complete().catch((error) => logger.error(error));
          }
        }
      } finally {
        await this.#durableEventLedger
          ?.record(body.event_id)
          .catch((error) => logger.error(error));
        finishHandler();
      }
    });

    this.#app.action(
      new RegExp(`^${escapeRegExp(APPROVAL_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        try {
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        if (userId === undefined || channelId === undefined) return;

        try {
          const { decision, approval, source } = parseTrustedApprovalAction(
            body,
            action,
            this.#approvers,
          );
          if (approval.sessionId === undefined) {
            await this.#gateway.resolveApproval(
              approval.channelId,
              approval.rootThreadTs,
              { requestId: approval.requestId, decision },
            );
          } else {
            await this.#gateway.resolveSessionApproval(approval.sessionId, {
              requestId: approval.requestId,
              decision,
            });
          }
          await client.chat.update({
            channel: source.channelId,
            ts: source.messageTs,
            text: `Approval resolved by <@${source.userId}>: ${decisionLabel(decision)}`,
            blocks: [],
          });
        } catch (error) {
          logger.error(error);
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `Could not resolve approval: ${publicErrorMessage(error)}`,
            ...this.#presentation(channelId),
          });
        }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.action(
      new RegExp(`^${escapeRegExp(CHOICE_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        try {
          const { kind, routing, source } = parseTrustedChoiceAction(
            body,
            action,
            this.#approvers,
          );
          if (kind === "other") {
            const triggerId = asString(bodyRecord?.trigger_id);
            if (triggerId === undefined) {
              throw new Error("Slack did not provide a modal trigger");
            }
            await client.views.open({
              trigger_id: triggerId,
              view: buildChoiceOtherModal(routing, "その他の回答"),
            });
            return;
          }
          if (routing.optionId === undefined) {
            throw new Error("Structured choice option is missing");
          }
          await this.#gateway.resolveUserInput(
            routing.channelId,
            routing.rootThreadTs,
            {
              requestId: routing.requestId,
              answer: {
                questionId: routing.questionId,
                optionId: routing.optionId,
              },
            },
          );
          await client.chat.update({
            channel: source.channelId,
            ts: source.messageTs,
            text: `回答を受け付けました（<@${source.userId}>）。`,
            blocks: [],
          }).catch((error) => logger.error(error));
        } catch (error) {
          logger.error(error);
          if (userId !== undefined && channelId !== undefined) {
            await client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text: `選択肢へ回答できませんでした: ${publicErrorMessage(error)}`,
              ...this.#presentation(channelId),
            });
          }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.view(
      CHOICE_OTHER_VIEW_CALLBACK_ID,
      async ({ ack, body, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        let routing: ReturnType<typeof parseChoiceOtherSubmission>["routing"] | undefined;
        let userId: string | undefined;
        try {
          const parsed = parseChoiceOtherSubmission(body);
          routing = parsed.routing;
          userId = parsed.userId;
          validateChoiceResponder(userId, routing.responderUserId, this.#approvers);
          await this.#gateway.resolveUserInput(
            routing.channelId,
            routing.rootThreadTs,
            {
              requestId: routing.requestId,
              answer: {
                questionId: routing.questionId,
                text: parsed.answer,
              },
            },
          );
          await client.chat.update({
            channel: routing.channelId,
            ts: routing.messageTs,
            text: `自由入力の回答を受け付けました（<@${userId}>）。`,
            blocks: [],
          }).catch((error) => logger.error(error));
        } catch (error) {
          logger.error(error);
          if (routing !== undefined && userId !== undefined) {
            await client.chat.postEphemeral({
              channel: routing.channelId,
              user: userId,
              text: `自由入力を送信できませんでした: ${publicErrorMessage(error)}`,
              ...this.#presentation(routing.channelId),
            }).catch((postError) => logger.error(postError));
          }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.action(
      new RegExp(`^${escapeRegExp(USER_INPUT_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        const actionId = asString(asRecord(action)?.action_id) ?? "";
        const pathVisibility = parseUserInputPathVisibility(actionId);
        const bodyVisibility = parseUserInputBodyVisibility(actionId);
        try {
          if (pathVisibility !== undefined || bodyVisibility !== undefined) {
            const { routing, source } = pathVisibility !== undefined
              ? parseTrustedGitPlanPathAction(
                body,
                action,
                this.#approvers,
              )
              : parseTrustedGitPlanBodyAction(
                body,
                action,
                this.#approvers,
              );
            await this.#serializeGitApprovalAction(routing, async () => {
              const details = this.#gitApprovalDetails.get(routing);
              if (details === undefined) {
                throw new Error(
                  "Git approval details are no longer available; prepare a fresh plan",
                );
              }
              const display = {
                pathsExpanded:
                  pathVisibility === undefined
                    ? details.display.pathsExpanded
                    : pathVisibility === "show",
                bodyExpanded:
                  bodyVisibility === undefined
                    ? details.display.bodyExpanded
                    : bodyVisibility === "show",
              };
              const planBlocks = buildWorkspaceGitApprovalBlocks(
                details.prompt,
                details.plan,
                details.routing,
                {
                  ...display,
                  allowPathToggle: true,
                  allowBodyToggle: true,
                },
              );
              await client.chat.update({
                channel: source.channelId,
                ts: source.messageTs,
                text: details.fallbackText,
                blocks:
                  details.sourceUserMention === undefined
                    ? planBlocks
                    : [gitApprovalMentionBlock(details.sourceUserMention), ...planBlocks],
              });
              this.#gitApprovalDetails.updateDisplay(routing, display);
            });
            return;
          }
          const { decision, routing, source } = parseTrustedGitPlanAction(
            body,
            action,
            this.#approvers,
          );
          await this.#serializeGitApprovalAction(routing, async () => {
            if (this.#gitApprovalDetails.get(routing) === undefined) {
              throw new Error("This Git approval was already handled");
            }
            await this.#gateway.resolveUserInput(
              routing.channelId,
              routing.rootThreadTs,
              { requestId: routing.requestId, optionId: decision },
            );
            this.#gitApprovalDetails.forget(routing);
            try {
              await client.chat.update({
                channel: source.channelId,
                ts: source.messageTs,
                text:
                  decision === "approve"
                    ? `Git plan approved by <@${source.userId}>. Codex is revalidating it before execution.`
                    : `Git plan rejected or held by <@${source.userId}>.`,
                blocks: [],
              });
            } catch (error) {
              // The App Server response is already single-use. A cosmetic Slack
              // update failure must never cause a second approval attempt.
              logger.error(error);
            }
          });
        } catch (error) {
          logger.error(error);
          if (userId !== undefined && channelId !== undefined) {
            await client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text:
                `${pathVisibility === undefined ? "Could not resolve Git plan approval" : "Could not update the Git file list"}: ` +
                publicErrorMessage(error),
              ...this.#presentation(channelId),
            });
          }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.action(
      new RegExp(`^${escapeRegExp(GIT_APPROVAL_RECOVERY_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        let recoveryKey: string | undefined;
        let recoveryAttemptStarted = false;
        let recoveryCardCleared = false;
        let recoveryRouting:
          | ReturnType<typeof parseGitApprovalRecoveryActionValue>
          | undefined;
        try {
          const { decision, routing, source } = parseTrustedGitApprovalRecoveryAction(
            body,
            action,
            this.#approvers,
          );
          recoveryRouting = routing;
          recoveryKey = `${source.channelId}\u0000${source.messageTs}`;
          if (decision === "reprepare" && this.#restartPending) {
            throw new Error(
              "Gateway restart is in progress. Retry after Taishi reconnects.",
            );
          }
          if (!this.#gitApprovalRecoveryActions.tryStart(recoveryKey)) {
            throw new Error("This Git approval recovery action was already handled");
          }
          recoveryAttemptStarted = true;

          if (decision === "hold") {
            await client.chat.update({
              channel: source.channelId,
              ts: source.messageTs,
              text: `Git approval recovery held by <@${source.userId}>.`,
              blocks: [],
            });
            return;
          }

          await client.chat.update({
            channel: source.channelId,
            ts: source.messageTs,
            text:
              `Fresh Git approval preparation requested by <@${source.userId}>. ` +
              "The previous operation remains unapproved.",
            blocks: [],
          });
          recoveryCardCleared = true;

          const projector = new SlackThreadProjector(
            client,
            routing.channelId,
            routing.rootThreadTs,
            {
              sourceUserId: source.userId,
              presentation: this.#presentation(routing.channelId),
              gitApprovalDetailsStore: this.#gitApprovalDetails,
            },
          );
          try {
            for await (const result of this.#gateway.handleHumanMessage({
              channelId: routing.channelId,
              rootThreadTs: routing.rootThreadTs,
              messageTs: source.messageTs,
              text: GIT_APPROVAL_REPREPARE_PROMPT,
              slackUserId: source.userId,
            })) {
              projector.setSessionId(result.sessionId);
              try {
                await projector.project(result.event);
              } catch (error) {
                logger.error(error);
                if (result.event.type === "choice.requested") {
                  await this.#gateway.resolveSessionUserInput(result.sessionId, {
                    requestId: result.event.requestId,
                    cancelled: true,
                  });
                  throw new Error(
                    "Structured choice controls could not be displayed and were cancelled",
                  );
                }
                if (result.event.type === "user_input.requested") {
                  await this.#gateway.resolveSessionUserInput(result.sessionId, {
                    requestId: result.event.requestId,
                    optionId: "reject",
                  });
                  throw new Error(
                    "Fresh Git approval controls could not be displayed and were rejected safely",
                  );
                }
                if (result.event.type === "approval.requested") {
                  await cancelUnprojectedNativeApproval(
                    this.#gateway,
                    result.sessionId,
                    result.event,
                  );
                  throw new Error(
                    "Native approval controls could not be displayed and were cancelled safely",
                  );
                }
              }
            }
          } finally {
            await projector.complete().catch((error) => logger.error(error));
          }
        } catch (error) {
          logger.error(error);
          if (recoveryAttemptStarted && recoveryKey !== undefined) {
            this.#gitApprovalRecoveryActions.releaseAfterFailure(recoveryKey);
          }
          if (
            recoveryCardCleared &&
            recoveryRouting !== undefined &&
            channelId !== undefined
          ) {
            const retryMessage =
              "承認画面の再作成に失敗しました。前のoperationは未承認です。もう一度再作成できます。";
            await client.chat
              .update({
                channel: channelId,
                ts: recoveryRouting.messageTs,
                text: retryMessage,
                blocks: buildGitApprovalRecoveryBlocks(retryMessage, recoveryRouting),
              })
              .catch((restoreError) => logger.error(restoreError));
          }
          if (userId !== undefined && channelId !== undefined) {
            await client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text: `Could not recover Git approval: ${publicErrorMessage(error)}`,
              ...this.#presentation(channelId),
            });
          }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.action(
      new RegExp(`^${escapeRegExp(PERMISSION_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        try {
        const actionRecord = asRecord(action);
        const bodyRecord = asRecord(body);
        const user = asRecord(bodyRecord?.user);
        const userId = typeof user?.id === "string" ? user.id : undefined;
        const channel = asRecord(bodyRecord?.channel);
        const channelId = typeof channel?.id === "string" ? channel.id : undefined;
        if (userId === undefined || channelId === undefined) return;
        if (!this.#approvers.has(userId)) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: "You are not configured as a ShowTalk Taishi approver.",
            ...this.#presentation(channelId),
          });
          return;
        }
        if (this.#permissionApprovals === undefined) {
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: "Permission approvals are not available in this runtime.",
            ...this.#presentation(channelId),
          });
          return;
        }
        try {
          const preliminary = parsePermissionActionValue(
            asString(actionRecord?.value) ?? "",
          );
          const route = this.#permissionApprovalCards.routeFor(
            preliminary.requestId,
          );
          const { decision, approval } = parseTrustedPermissionAction(
            body,
            action,
            this.#approvers,
            route,
          );
          const settled = this.#permissionApprovalCards.settlementFor(
            approval.requestId,
          );
          if (settled !== undefined) {
            await this.#applyPermissionApprovalSettlement(approval.requestId);
            return;
          }
          this.#permissionApprovals.resolve(approval.requestId, decision, {
            resolvedBySlackUserId: userId,
          });
        } catch (error) {
          logger.error(error);
          await client.chat.postEphemeral({
            channel: channelId,
            user: userId,
            text: `Could not resolve permission: ${publicErrorMessage(error)}`,
            ...this.#presentation(channelId),
          });
        }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.action(
      new RegExp(`^${escapeRegExp(CONVERSATION_CONTROL_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        try {
        const bodyRecord = asRecord(body);
        const actionRecord = asRecord(action);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const bodyChannelId = asString(asRecord(bodyRecord?.channel)?.id);
        if (userId === undefined || bodyChannelId === undefined) return;

        try {
          const { operation, routing } = parseTrustedConversationControlAction(
            body,
            action,
            new Set([userId]),
          );
          if (operation !== "status" && !this.#approvers.has(userId)) {
            await client.chat.postEphemeral({
              channel: routing.channelId,
              user: userId,
              thread_ts: routing.rootThreadTs,
              text:
                "Only configured ShowTalk Taishi approvers can interrupt a Koe or restart the Gateway.",
              ...this.#presentation(routing.channelId),
            });
            return;
          }

          if (operation === "status") {
            const status = await this.#gateway.status(
              routing.channelId,
              routing.rootThreadTs,
              routing.rootThreadTs,
            );
            await client.chat.postEphemeral({
              channel: routing.channelId,
              user: userId,
              thread_ts: routing.rootThreadTs,
              text: `Koe ${status.agentId}: ${humanStatus(status.status)}${activeTurnRelationLabel(status.activeTurnRelation)}`,
              ...this.#presentation(routing.channelId),
            });
          } else if (operation === "interrupt") {
            await this.#gateway.interrupt(routing.channelId, routing.rootThreadTs);
            await client.chat.postMessage({
              channel: routing.channelId,
              thread_ts: routing.rootThreadTs,
              text: `:stop_sign: Interrupt requested by <@${userId}>`,
              ...this.#presentation(routing.channelId),
            });
          } else {
            if (this.#requestRestart === undefined) {
              throw new Error("Gateway restart supervisor is unavailable");
            }
            await client.chat.postMessage({
              channel: routing.channelId,
              thread_ts: routing.rootThreadTs,
              text: `:arrows_counterclockwise: Gateway restart requested by <@${userId}>. Active turns will finish first.`,
              ...this.#presentation(routing.channelId),
            });
            this.#requestRestart();
          }
        } catch (error) {
          logger.error(error);
          await client.chat.postEphemeral({
            channel: bodyChannelId,
            user: userId,
            text: `Could not apply conversation control: ${publicErrorMessage(error)}`,
            ...this.#presentation(bodyChannelId),
          });
        }
        } finally {
          finishHandler();
        }
      },
    );
  }
}

export async function cancelUnprojectedNativeApproval(
  gateway: Pick<Gateway, "resolveSessionApproval">,
  sessionId: string,
  event: AgentEvent,
): Promise<boolean> {
  if (event.type !== "approval.requested") return false;
  await gateway.resolveSessionApproval(sessionId, {
    requestId: event.requestId,
    decision: "cancel",
  });
  return true;
}

export function permissionApprovalPostArguments(
  request: PermissionApprovalPresentation,
  defaultNotificationUserId?: string,
  presentation: SlackMessagePresentation = {},
) {
  const notificationUserId =
    request.sourceSlackUserId ?? defaultNotificationUserId;
  const routedRequest = {
    ...request,
    ...(notificationUserId === undefined
      ? {}
      : { sourceSlackUserId: notificationUserId }),
  };
  return {
    channel: request.sourceChannelId,
    ...(request.sourceRootThreadTs === undefined
      ? {}
      : { thread_ts: request.sourceRootThreadTs }),
    text: `${notificationUserId === undefined ? "" : `<@${notificationUserId}> `}${request.sourceAgentId} Koe requests permission: ${request.summary}`,
    blocks: buildPermissionApprovalBlocks(routedRequest),
    ...presentation,
  };
}

export function permissionApprovalSettlementUpdateArguments(
  route: PermissionApprovalMessageRoute,
  settlement: PermissionApprovalSettlement,
) {
  return {
    channel: route.channelId,
    ts: route.messageTs,
    text: permissionApprovalSettlementText(route.operation, settlement),
    blocks: [] as KnownBlock[],
  };
}

function permissionApprovalSettlementText(
  operation: string,
  settlement: PermissionApprovalSettlement,
): string {
  const actor =
    settlement.resolvedBySlackUserId === undefined
      ? ""
      : ` by <@${settlement.resolvedBySlackUserId}>`;
  switch (settlement.reason) {
    case "allow_once":
      return `Permission approved once${actor} for ${operation}. Approval does not confirm operation completion.`;
    case "allow_session":
      return `Permission approved for this session${actor} for ${operation}. Approval does not confirm operation completion.`;
    case "deny":
      return `Permission denied${actor} for ${operation}. No action was authorized.`;
    case "cancel":
      return `Permission cancelled${actor} for ${operation}. No action was authorized.`;
    case "expired":
      return `Permission request expired for ${operation}. No action was authorized.`;
    case "caller_cancelled":
      return `Permission request closed because the requesting operation ended: ${operation}. No action was authorized.`;
    case "coordinator_closed":
      return `Permission request closed because the Gateway stopped or restarted: ${operation}. No action was authorized.`;
  }
}

export function parseHumanSlackMessage(
  value: unknown,
): HumanSlackMessage | undefined {
  const message = asRecord(value);
  if (
    message === undefined ||
    typeof message.channel !== "string" ||
    typeof message.ts !== "string" ||
    typeof message.text !== "string" ||
    typeof message.bot_id === "string" ||
    (message.subtype !== undefined && message.subtype !== "file_share")
  ) {
    return undefined;
  }

  return {
    channel: message.channel,
    ts: message.ts,
    text: message.text,
    ...(typeof message.thread_ts === "string"
      ? { thread_ts: message.thread_ts }
      : {}),
    ...(typeof message.user === "string" ? { user: message.user } : {}),
    fileIds: [
      ...(Array.isArray(message.files)
        ? message.files.flatMap((value) => {
            const file = asRecord(value);
            return typeof file?.id === "string" ? [file.id] : [];
          })
        : []),
      ...(Array.isArray(message.x_files)
        ? message.x_files.filter((value): value is string => typeof value === "string")
        : []),
    ],
  };
}

export function parseTrustedGitPlanAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const decision = parseUserInputDecision(
    asString(actionRecord?.action_id) ?? "",
  );
  if (decision === undefined) {
    throw new Error("Unsupported Git plan action ID");
  }
  const routing = parseUserInputActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const source = validateSlackActionSource(body, routing, approvers);
  return { decision, routing, source };
}

export function parseTrustedPermissionAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
  route: PermissionApprovalMessageRoute | undefined,
) {
  const actionRecord = asRecord(action);
  const decision = parsePermissionDecision(
    asString(actionRecord?.action_id) ?? "",
  );
  if (decision === undefined) {
    throw new Error("Unsupported permission approval action ID");
  }
  const approval = parsePermissionActionValue(
    asString(actionRecord?.value) ?? "",
  );
  if (route === undefined || route.channelId !== approval.channelId) {
    throw new Error("Permission approval route is no longer available");
  }
  const source = validateSlackActionSource(
    body,
    {
      channelId: route.channelId,
      rootThreadTs: route.rootThreadTs ?? route.messageTs,
      messageTs: route.messageTs,
    },
    approvers,
  );
  return { decision, approval, route, source };
}

export function parseTrustedConversationControlAction(
  body: unknown,
  action: unknown,
  allowedUsers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const operation = parseConversationControlAction(
    asString(actionRecord?.action_id) ?? "",
  );
  if (operation === undefined) {
    throw new Error("Unsupported conversation control action ID");
  }
  const routing = parseConversationControlActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const source = validateSlackActionSource(body, routing, allowedUsers);
  return { operation, routing, source };
}

export function parseTrustedApprovalAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const decision = parseApprovalDecision(
    asString(actionRecord?.action_id) ?? "",
  );
  if (decision === undefined) {
    throw new Error("Unsupported approval action ID");
  }
  const approval = parseApprovalActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const source = validateSlackActionSource(body, approval, approvers);
  return { decision, approval, source };
}

export function parseTrustedGitPlanPathAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const visibility = parseUserInputPathVisibility(
    asString(actionRecord?.action_id) ?? "",
  );
  if (visibility === undefined) {
    throw new Error("Unsupported Git file-list action ID");
  }
  const routing = parseUserInputActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const source = validateSlackActionSource(body, routing, approvers);
  return { visibility, routing, source };
}

export function parseTrustedGitPlanBodyAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const visibility = parseUserInputBodyVisibility(
    asString(actionRecord?.action_id) ?? "",
  );
  if (visibility === undefined) {
    throw new Error("Unsupported Git PR-body action ID");
  }
  const routing = parseUserInputActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const source = validateSlackActionSource(body, routing, approvers);
  return { visibility, routing, source };
}

export function parseTrustedGitApprovalRecoveryAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const decision = parseGitApprovalRecoveryDecision(
    asString(actionRecord?.action_id) ?? "",
  );
  if (decision === undefined) {
    throw new Error("Unsupported Git approval recovery action ID");
  }
  const routing = parseGitApprovalRecoveryActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const source = validateSlackActionSource(body, routing, approvers);
  return { decision, routing, source };
}

export function parseTrustedChoiceAction(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const kind = parseChoiceActionKind(
    asString(actionRecord?.action_id) ?? "",
  );
  if (kind === undefined) {
    throw new Error("Unsupported structured choice action ID");
  }
  const routing = parseChoiceActionValue(
    asString(actionRecord?.value) ?? "",
  );
  if (
    (kind === "select" && routing.optionId === undefined) ||
    (kind === "other" && routing.optionId !== undefined)
  ) {
    throw new Error("Structured choice action does not match its payload");
  }
  const allowedUsers = routing.responderUserId === undefined
    ? approvers
    : new Set([routing.responderUserId]);
  const source = validateSlackActionSource(body, routing, allowedUsers);
  return { kind, routing, source };
}

function validateChoiceResponder(
  userId: string,
  responderUserId: string | undefined,
  approvers: ReadonlySet<string>,
): void {
  if (!/^[UW][A-Z0-9]{1,127}$/u.test(userId)) {
    throw new Error("Slack user is invalid");
  }
  if (responderUserId !== undefined) {
    if (userId !== responderUserId) {
      throw new Error("This structured question belongs to another Slack user");
    }
    return;
  }
  if (!approvers.has(userId)) {
    throw new Error("Slack user is not allowed to answer this structured question");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function publicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected gateway error";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function humanStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function activeTurnRelationLabel(
  relation:
    | "exact_request"
    | "same_slack_thread"
    | "other_slack_thread"
    | "agent_delegation"
    | "external_or_unknown"
    | undefined,
): string {
  switch (relation) {
    case "exact_request":
      return " (this exact Slack request is the active turn)";
    case "same_slack_thread":
      return " (another message in this Slack thread started the active turn)";
    case "other_slack_thread":
      return " (the active turn was started from another Slack thread)";
    case "agent_delegation":
      return " (the active turn was started by another Koe)";
    case "external_or_unknown":
      return " (Codex is active outside this Gateway, or its origin is unknown)";
    default:
      return "";
  }
}

function decisionLabel(decision: string): string {
  switch (decision) {
    case "allow_once":
      return "allowed once";
    case "allow_session":
      return "allowed for session";
    case "deny":
      return "denied";
    default:
      return "cancelled";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gitApprovalMentionBlock(sourceUserMention: string): KnownBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: sourceUserMention },
  };
}

function attachmentFallbackText(count: number): string {
  return count === 1 ? "Shared 1 attachment." : `Shared ${count} attachments.`;
}
