import { App } from "@slack/bolt";

import type {
  DelegationActivity,
  DelegationResultMessage,
  Gateway,
  GatewayAgentEvent,
} from "../core/index.js";
import type { RuntimeSlackAttachment } from "../mcp/workspace-attachments.js";
import type {
  PermissionApprovalCoordinator,
  PermissionApprovalPresentation,
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
  parseUserInputActionValue,
  parseUserInputDecision,
} from "./user-input-blocks.js";

export interface SlackFrontendOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly approverUserIds: readonly string[];
  readonly agentChannelIds: readonly string[];
  readonly agentIdsByChannel: Readonly<Record<string, string>>;
  readonly presentationsByChannel?: SlackPresentationsByChannel;
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
  readonly #idleWaiters = new Set<() => void>();
  readonly #gitApprovalRecoveryActions = new GitApprovalRecoveryActionTracker();
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
    await this.#uploadAttachments(channelId, result.ts, attachments);
    return result.ts;
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
    await this.#uploadAttachments(channelId, rootThreadTs, attachments);
    return result.ts;
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
        await this.#gateway.resolveSessionUserInput(failure.sessionId, {
          requestId: failure.requestId,
          optionId: "reject",
        });
        await this.#app.client.chat
          .postMessage({
            channel: failure.channelId,
            thread_ts: failure.rootThreadTs,
            text:
              ":warning: Git approval controls could not be displayed, so " +
              "this request was rejected safely. Ask this Koe to re-prepare " +
              "the operation in a new turn.",
            ...this.#presentation(failure.channelId),
          })
          .catch(() => undefined);
      },
    );
  }

  async presentPermissionApproval(
    request: PermissionApprovalPresentation,
  ): Promise<void> {
    await this.#app.client.chat.postMessage(
      permissionApprovalPostArguments(
        request,
        this.#defaultNotificationUserId,
        this.#presentation(request.sourceChannelId),
      ),
    );
  }

  #registerListeners(): void {
    this.#app.event("message", async ({ event, body, client, logger }) => {
      if (!this.#deduplicator.accept(body.event_id)) return;
      const message = parseHumanSlackMessage(event);
      if (message === undefined) return;
      if (!this.#agentChannels.has(message.channel)) return;
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
        this.#permissionApprovals?.rememberSlackContext(message.channel, {
          rootThreadTs,
          ...(typeof message.user === "string"
            ? { slackUserId: message.user }
            : {}),
        });
        const projector = new SlackThreadProjector(
          client,
          message.channel,
          rootThreadTs,
          {
            ...(typeof message.user === "string"
              ? { sourceUserId: message.user }
              : {}),
            presentation: this.#presentation(message.channel),
          },
        );
        let turnAttempted = false;
        try {
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
            return;
          }
          if (typeof message.thread_ts !== "string") {
            await client.chat
              .postMessage({
                channel: message.channel,
                thread_ts: rootThreadTs,
                text: "ShowTalk Taishi conversation controls",
                blocks: buildConversationControlBlocks({
                  channelId: message.channel,
                  rootThreadTs,
                }),
                ...this.#presentation(message.channel),
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
              // Cosmetic Slack projection failures must not cancel ordinary
              // coding work. Structured approvals are handled above because
              // they would otherwise leave a live RPC waiting forever.
            }
          }
        } catch (error) {
          logger.error(error);
          await client.chat
            .postMessage({
              channel: message.channel,
              thread_ts: rootThreadTs,
              text: `:warning: ${publicErrorMessage(error)}`,
              ...this.#presentation(message.channel),
            })
            .catch((projectionError) => logger.error(projectionError));
        } finally {
          if (turnAttempted) {
            await projector.complete().catch((error) => logger.error(error));
          }
        }
      } finally {
        finishHandler();
      }
    });

    this.#app.action(
      new RegExp(`^${escapeRegExp(APPROVAL_ACTION_PREFIX)}`),
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

        const actionId =
          typeof actionRecord?.action_id === "string" ? actionRecord.action_id : "";
        const value = typeof actionRecord?.value === "string" ? actionRecord.value : "";
        const decision = parseApprovalDecision(actionId);
        if (decision === undefined) return;

        try {
          const approval = parseApprovalActionValue(value);
          if (approval.channelId !== channelId) {
            throw new Error("Approval channel mismatch");
          }
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
          const message = asRecord(bodyRecord?.message);
          if (typeof message?.ts === "string") {
            await client.chat.update({
              channel: channelId,
              ts: message.ts,
              text: `Approval resolved by <@${userId}>: ${decisionLabel(decision)}`,
              blocks: [],
            });
          }
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
      new RegExp(`^${escapeRegExp(USER_INPUT_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        try {
          const { decision, routing, source } = parseTrustedGitPlanAction(
            body,
            action,
            this.#approvers,
          );
          await this.#gateway.resolveUserInput(
            routing.channelId,
            routing.rootThreadTs,
            { requestId: routing.requestId, optionId: decision },
          );
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
        } catch (error) {
          logger.error(error);
          if (userId !== undefined && channelId !== undefined) {
            await client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text: `Could not resolve Git plan approval: ${publicErrorMessage(error)}`,
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
                if (result.event.type !== "user_input.requested") continue;
                await this.#gateway.resolveSessionUserInput(result.sessionId, {
                  requestId: result.event.requestId,
                  optionId: "reject",
                });
                throw new Error(
                  "Fresh Git approval controls could not be displayed and were rejected safely",
                );
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
          const actionId =
            typeof actionRecord?.action_id === "string" ? actionRecord.action_id : "";
          const value = typeof actionRecord?.value === "string" ? actionRecord.value : "";
          const decision = parsePermissionDecision(actionId);
          if (decision === undefined) return;
          const approval = parsePermissionActionValue(value);
          if (approval.channelId !== channelId) {
            throw new Error("Permission approval channel mismatch");
          }
          this.#permissionApprovals.resolve(approval.requestId, decision);
          const message = asRecord(bodyRecord?.message);
          if (typeof message?.ts === "string") {
            await client.chat.update({
              channel: channelId,
              ts: message.ts,
              text: `Permission resolved by <@${userId}>: ${decisionLabel(decision)}`,
              blocks: [],
            });
          }
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
          const operation = parseConversationControlAction(
            asString(actionRecord?.action_id) ?? "",
          );
          if (operation === undefined) return;
          const routing = parseConversationControlActionValue(
            asString(actionRecord?.value) ?? "",
          );
          if (routing.channelId !== bodyChannelId) {
            throw new Error("Conversation control channel mismatch");
          }
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

function attachmentFallbackText(count: number): string {
  return count === 1 ? "Shared 1 attachment." : `Shared ${count} attachments.`;
}
