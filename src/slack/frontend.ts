import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type {
  DelegationActivity,
  DelegationResultMessage,
  Gateway,
  GatewayAgentEvent,
  AgentEvent,
  WorkspaceGitApprovalPlan,
} from "../core/index.js";
import type { RuntimeSlackAttachment } from "../mcp/workspace-attachments.js";
import type {
  PermissionApprovalCoordinator,
  PermissionApprovalPresentation,
  PermissionApprovalSettlement,
} from "../permissions/approval-coordinator.js";
import {
  createWorkspaceGitHumanDecisionDeliveryId,
  isWorkspaceGitHumanDecisionBrokerError,
  type WorkspaceGitHumanDecisionBroker,
} from "../approvals/workspace-git-human-decision-broker.js";
import {
  validateWorkspaceGitAutonomyDisableResult,
  validateWorkspaceGitAutonomyEnableResult,
  workspaceGitAutonomyDecisionId,
  type PersistedWorkspaceGitAutonomyActivation,
  type WorkspaceGitAutonomyControlBrokerV4,
  type WorkspaceGitAutonomyRuntimeSettings,
  type WorkspaceGitAutonomyStatus,
} from "../approvals/workspace-git-autonomy-control.js";
import type {
  WorkspaceGitSystemRejectionActor,
  WorkspaceGitSystemRejectionRecorder,
} from "../approvals/workspace-git-system-rejection-coordinator.js";
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
  buildExpiredWorkspaceGitApprovalBlocks,
  buildUnavailableWorkspaceGitApprovalBlocks,
  buildWorkspaceGitApprovalBlocks,
  parseUserInputActionToken,
  parseUserInputActionValue,
  parseUserInputBodyVisibility,
  parseUserInputDecision,
  parseUserInputPathVisibility,
  type UserInputActionValue,
  type WorkspaceGitApprovalDetails,
} from "./user-input-blocks.js";
import {
  CHOICE_ACTION_PREFIX,
  CHOICE_OTHER_VIEW_CALLBACK_ID,
  buildChoiceOtherModal,
  parseChoiceActionId,
  parseChoiceActionValue,
  parseChoiceOtherSubmission,
} from "./choice-blocks.js";
import {
  CHOICE_CONTINUATION_ACTION_PREFIX,
  CHOICE_CONTINUATION_VIEW_CALLBACK_ID,
  StructuredChoiceContinuationStore,
  buildChoiceContinuationOtherModal,
  parseChoiceContinuationActionId,
  parseChoiceContinuationId,
  parseChoiceContinuationOtherSubmission,
  type StructuredChoiceContinuation,
} from "./choice-continuation.js";
import {
  PermissionApprovalCardTracker,
  type PersistedPermissionApprovalCard,
} from "./permission-card-tracker.js";
import {
  createInteractionAudit,
  type InteractionAudit,
} from "./interaction-audit.js";
import {
  WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX,
  WorkspaceGitAutonomyCardStore,
  buildWorkspaceGitAutonomyBlocks,
  parseWorkspaceGitAutonomyAction,
  parseWorkspaceGitAutonomyToken,
  type WorkspaceGitAutonomyCardOperation,
} from "./workspace-git-autonomy-blocks.js";

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
  readonly permissionApprovalCardOutbox?: {
    readonly initialCards: readonly PersistedPermissionApprovalCard[];
    persist(cards: readonly PersistedPermissionApprovalCard[]): Promise<void>;
  };
  readonly attachmentRoot: string;
  readonly permissionApprovals?: PermissionApprovalCoordinator;
  readonly workspaceGitDecisionBroker?: WorkspaceGitHumanDecisionBroker;
  readonly workspaceGitAutonomyControl?: {
    readonly broker: WorkspaceGitAutonomyControlBrokerV4;
    readonly settings: readonly WorkspaceGitAutonomyRuntimeSettings[];
    readonly initialActivations?: readonly PersistedWorkspaceGitAutonomyActivation[];
    persist(
      activations: readonly PersistedWorkspaceGitAutonomyActivation[],
    ): Promise<void>;
  };
  readonly workspaceGitSystemRejectionRecorder?: WorkspaceGitSystemRejectionRecorder;
  /** Shared with the adapter so terminal RPC notifications invalidate cards synchronously. */
  readonly workspaceGitApprovalDetailsStore?: WorkspaceGitApprovalDetailsStore;
  readonly requestRestart?: () => void;
  readonly now?: () => number;
  readonly interactionAudit?: InteractionAudit;
}

export interface HumanSlackMessage {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly thread_ts?: string;
  readonly user?: string;
  readonly fileIds: readonly string[];
}

export function workspaceGitAutonomyStatus(
  setting: WorkspaceGitAutonomyRuntimeSettings,
  activation: PersistedWorkspaceGitAutonomyActivation | undefined,
  brokerAvailable: boolean,
  now: number,
): WorkspaceGitAutonomyStatus {
  if (!brokerAvailable) {
    return { koeId: setting.koeId, available: false, state: "unconfigured" };
  }
  if (activation !== undefined && activation.state === "enabled") {
    return {
      koeId: setting.koeId,
      available: true,
      state: Date.parse(activation.expiresAt) <= now ? "expired" : "enabled",
      profileId: activation.profileId,
      profileRevision: activation.profileRevision,
      expiresAt: activation.expiresAt,
    };
  }
  if (setting.candidate === undefined) {
    return { koeId: setting.koeId, available: false, state: "unconfigured" };
  }
  return {
    koeId: setting.koeId,
    available: true,
    state: "disabled",
    profileId: setting.candidate.profileId,
    profileRevision: setting.candidate.profileRevision,
  };
}

export interface PermissionApprovalMessageRoute {
  readonly channelId: string;
  readonly messageTs: string;
  readonly rootThreadTs?: string;
  readonly operation: string;
}

export class SlackFrontend {
  readonly #app: App;
  readonly #gateway: Gateway;
  readonly #approvers: ReadonlySet<string>;
  readonly #agentChannels: ReadonlySet<string>;
  readonly #agentIdsByChannel: ReadonlyMap<string, string>;
  readonly #deduplicator = new SlackEventDeduplicator();
  readonly #fileTransport: SlackFileTransport;
  readonly #permissionApprovals: PermissionApprovalCoordinator | undefined;
  readonly #workspaceGitDecisionBroker:
    | WorkspaceGitHumanDecisionBroker
    | undefined;
  readonly #workspaceGitAutonomyBroker:
    | WorkspaceGitAutonomyControlBrokerV4
    | undefined;
  readonly #workspaceGitAutonomyCards = new WorkspaceGitAutonomyCardStore();
  readonly #workspaceGitAutonomySettings = new Map<
    string,
    WorkspaceGitAutonomyRuntimeSettings
  >();
  readonly #workspaceGitAutonomyActivations = new Map<
    string,
    PersistedWorkspaceGitAutonomyActivation
  >();
  readonly #persistWorkspaceGitAutonomy:
    | ((activations: readonly PersistedWorkspaceGitAutonomyActivation[]) => Promise<void>)
    | undefined;
  readonly #workspaceGitSystemRejectionRecorder:
    | WorkspaceGitSystemRejectionRecorder
    | undefined;
  readonly #delegationProjector: SlackDelegationProjector;
  readonly #defaultNotificationUserId: string | undefined;
  readonly #requestRestart: (() => void) | undefined;
  readonly #presentationsByChannel: SlackPresentationsByChannel;
  readonly #durableEventLedger: SlackFrontendOptions["durableEventLedger"];
  readonly #idleWaiters = new Set<() => void>();
  readonly #gitApprovalRecoveryActions = new GitApprovalRecoveryActionTracker();
  readonly #gitApprovalDetails: WorkspaceGitApprovalDetailsStore;
  readonly #choiceContinuations: StructuredChoiceContinuationStore;
  readonly #permissionApprovalCards: PermissionApprovalCardTracker;
  readonly #now: () => number;
  readonly #interactionAudit: InteractionAudit;
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
    this.#workspaceGitDecisionBroker = options.workspaceGitDecisionBroker;
    this.#workspaceGitAutonomyBroker = options.workspaceGitAutonomyControl?.broker;
    this.#persistWorkspaceGitAutonomy = options.workspaceGitAutonomyControl?.persist;
    for (const setting of options.workspaceGitAutonomyControl?.settings ?? []) {
      this.#workspaceGitAutonomySettings.set(setting.koeId, setting);
    }
    for (const activation of options.workspaceGitAutonomyControl?.initialActivations ?? []) {
      this.#workspaceGitAutonomyActivations.set(activation.koeId, activation);
    }
    this.#workspaceGitSystemRejectionRecorder =
      options.workspaceGitSystemRejectionRecorder;
    this.#gitApprovalDetails = options.workspaceGitApprovalDetailsStore ??
      new WorkspaceGitApprovalDetailsStore();
    this.#requestRestart = options.requestRestart;
    this.#now = options.now ?? Date.now;
    this.#interactionAudit = options.interactionAudit ??
      createInteractionAudit(console.info, this.#now);
    this.#choiceContinuations = new StructuredChoiceContinuationStore(this.#now);
    this.#presentationsByChannel = options.presentationsByChannel ?? {};
    this.#durableEventLedger = options.durableEventLedger;
    this.#permissionApprovalCards = new PermissionApprovalCardTracker({
      ...(options.permissionApprovalCardOutbox === undefined
        ? {}
        : {
            initialCards: options.permissionApprovalCardOutbox.initialCards,
            persist: options.permissionApprovalCardOutbox.persist,
          }),
    });
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
      this.#gitApprovalDetails,
      this.#choiceContinuations,
    );
    this.#registerListeners();
  }

  async start(): Promise<void> {
    await this.#app.start();
    await this.#recoverPermissionApprovalCards();
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= Promise.resolve(this.#app.stop()).then(() => undefined);
    await this.#stopPromise;
  }

  beginRestart(): void {
    this.#restartPending = true;
  }

  /** Adapter-side terminal notification fence; never performs a Slack write. */
  invalidateWorkspaceGitApproval(requestId: string): void {
    this.#gitApprovalDetails.invalidateRequest(requestId);
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
        } else if (failure.kind === "git_approval") {
          await this.#rejectUnprojectedGitApproval(
            this.#app.client,
            failure.sessionId,
            failure.channelId,
            failure.rootThreadTs,
            failure.requestId,
            failure.plan,
          );
        } else {
          await this.#gateway.resolveSessionUserInput(failure.sessionId, {
            requestId: failure.requestId,
            cancelled: true,
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
      this.#gitApprovalDetails,
      async (event) => {
        await recordSystemGitRejection(
          this.#workspaceGitSystemRejectionRecorder,
          event.plan,
          "showtalk:external-app-server-resolution",
        );
      },
      this.#choiceContinuations,
    );
  }

  updateWorkspaceGitAutonomySettings(
    settings: readonly WorkspaceGitAutonomyRuntimeSettings[],
  ): void {
    this.#workspaceGitAutonomySettings.clear();
    for (const setting of settings) {
      this.#workspaceGitAutonomySettings.set(setting.koeId, setting);
    }
  }

  workspaceGitAutonomyStatuses(): readonly WorkspaceGitAutonomyStatus[] {
    return [...this.#workspaceGitAutonomySettings.values()].map((setting) =>
      workspaceGitAutonomyStatus(
        setting,
        this.#workspaceGitAutonomyActivations.get(setting.koeId),
        this.#workspaceGitAutonomyBroker !== undefined,
        this.#now(),
      )
    );
  }

  async presentWorkspaceGitAutonomyControl(
    koeId: string,
    operation: WorkspaceGitAutonomyCardOperation,
  ): Promise<void> {
    if (this.#restartPending) {
      throw new Error("Gateway restart is in progress");
    }
    if (this.#workspaceGitAutonomyBroker === undefined) {
      throw new Error("Workspace Git autonomy is not configured");
    }
    const setting = this.#workspaceGitAutonomySettings.get(koeId);
    if (setting === undefined) throw new Error("Unknown Koe");
    const activation = this.#workspaceGitAutonomyActivations.get(koeId);
    if (operation === "enable" && setting.candidate === undefined) {
      throw new Error("Workspace Git autonomy profile candidate is not configured");
    }
    if (operation === "enable" && activation?.state === "enabled" && Date.parse(activation.expiresAt) > this.#now()) {
      throw new Error("Workspace Git autonomy is already enabled for this Koe");
    }
    if (operation === "disable" && activation?.state !== "enabled") {
      throw new Error("Workspace Git autonomy is not currently enabled for this Koe");
    }
    const candidate = setting.candidate ?? {
      profileId: activation!.profileId,
      profileRevision: activation!.profileRevision,
      requestedTtlMinutes: 1,
    };
    const token = this.#workspaceGitAutonomyCards.createToken();
    const posted = await this.#app.client.chat.postMessage({
      channel: setting.channelId,
      text: operation === "enable"
        ? `Workspace Git自動運転の有効化確認: ${koeId}`
        : `Workspace Git自動運転の無効化確認: ${koeId}`,
      ...this.#presentation(setting.channelId),
    });
    if (typeof posted.ts !== "string") {
      throw new Error("Slack did not return an autonomy control message timestamp");
    }
    const route = {
      token,
      operation,
      koeId,
      channelId: setting.channelId,
      rootThreadTs: posted.ts,
      messageTs: posted.ts,
      candidate,
      koeBindingRevision: setting.koeBindingRevision,
      principalPolicyRevision: setting.principalPolicyRevision,
      requestedExpiresAt: new Date(
        this.#now() + candidate.requestedTtlMinutes * 60_000,
      ).toISOString(),
      ...(operation === "disable" && activation !== undefined
        ? { activationHandle: activation.activationHandle }
        : {}),
    };
    this.#workspaceGitAutonomyCards.remember(route);
    try {
      await this.#app.client.chat.update({
        channel: setting.channelId,
        ts: posted.ts,
        text: operation === "enable"
          ? `Workspace Git自動運転の有効化確認: ${koeId}`
          : `Workspace Git自動運転の無効化確認: ${koeId}`,
        blocks: buildWorkspaceGitAutonomyBlocks(route),
      });
    } catch (error) {
      this.#workspaceGitAutonomyCards.forget(token);
      await this.#app.client.chat.delete({ channel: setting.channelId, ts: posted.ts }).catch(() => undefined);
      throw error;
    }
  }

  async #persistWorkspaceGitAutonomyActivations(): Promise<void> {
    await this.#persistWorkspaceGitAutonomy?.(
      [...this.#workspaceGitAutonomyActivations.values()],
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
      await this.#permissionApprovalCards.rememberRoute(request.requestId, route);
    } catch (error) {
      await this.#permissionApprovalCards
        .discardUnroutedSettlement(request.requestId)
        .catch(() => undefined);
      if (route !== undefined) {
        await this.#app.client.chat
          .update(
            permissionApprovalSettlementUpdateArguments(route, {
              requestId: request.requestId,
              reason: "caller_cancelled",
            }),
          )
          .catch(() => undefined);
      }
      throw error;
    }
    if (this.#permissionApprovalCards.settlementFor(request.requestId) !== undefined) {
      await this.#applyPermissionApprovalSettlement(request.requestId).catch(
        reportPermissionApprovalUpdateError,
      );
    }
  }

  async settlePermissionApproval(
    settlement: PermissionApprovalSettlement,
  ): Promise<void> {
    await this.#permissionApprovalCards.rememberSettlement(settlement);
    await this.#applyPermissionApprovalSettlement(settlement.requestId).catch(
      reportPermissionApprovalUpdateError,
    );
  }

  async #recoverPermissionApprovalCards(): Promise<void> {
    await this.#permissionApprovalCards.closeUnsettled();
    for (const card of this.#permissionApprovalCards.list()) {
      await this.#applyPermissionApprovalSettlement(card.requestId).catch(
        () => undefined,
      );
    }
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

  async #terminalizeExpiredGitApprovalCard(
    client: WebClient,
    details: WorkspaceGitApprovalDetails,
  ): Promise<boolean> {
    if (this.#now() < details.expiresAt) return false;
    const fallback = "Git操作の承認期限が切れました。この計画は実行できません。";
    const blocks = buildExpiredWorkspaceGitApprovalBlocks(
      details.plan,
      new Date(details.expiresAt).toISOString(),
    );
    await client.chat.update({
      channel: details.routing.channelId,
      ts: details.routing.messageTs,
      text: fallback,
      blocks:
        details.sourceUserMention === undefined
          ? blocks
          : [gitApprovalMentionBlock(details.sourceUserMention), ...blocks],
    });
    this.#gitApprovalDetails.forget(details.routing);
    return true;
  }

  async #terminalizeUnavailableGitApprovalCard(
    client: WebClient,
    routing: UserInputActionValue,
  ): Promise<void> {
    await client.chat.update({
      channel: routing.channelId,
      ts: routing.messageTs,
      text: "このGit承認は利用できません。承認画面を再作成してください。",
      blocks: buildUnavailableWorkspaceGitApprovalBlocks(),
    });
  }

  async #closeFailedPrivateGitDecision(
    client: WebClient,
    details: WorkspaceGitApprovalDetails,
    failure: unknown,
  ): Promise<void> {
    // A failed human decision write must not leave Codex blocked indefinitely.
    // Persist a fail-closed rejection intent first, then answer the single-use
    // App Server request as reject and replace the stale approval buttons with
    // inert guidance that cannot restart a turn or carry Git authority.
    await closeFailedPrivateGitDecisionBeforeRecovery(
      this.#workspaceGitSystemRejectionRecorder,
      details.plan,
      () => this.#gateway.resolveUserInput(
        details.routing.channelId,
        details.routing.rootThreadTs,
        {
          requestId: details.routing.requestId,
          optionId: "reject",
          plan: details.plan,
        },
      ),
      async () => {
        this.#gitApprovalDetails.forget(details.routing);
        const reason = publicErrorMessage(failure);
        const message =
          `Git承認をprivate stateへ記録できなかったため、このSlack承認要求を終了しました。${reason}` +
          " Git操作は承認されていません。必要なら最新状態で新しく依頼してください。";
        const blocks = buildGitApprovalRecoveryBlocks(message, {
          version: 1,
          channelId: details.routing.channelId,
          rootThreadTs: details.routing.rootThreadTs,
          messageTs: details.routing.messageTs,
        });
        await client.chat.update({
          channel: details.routing.channelId,
          ts: details.routing.messageTs,
          text: message,
          blocks:
            details.sourceUserMention === undefined
              ? blocks
              : [gitApprovalMentionBlock(details.sourceUserMention), ...blocks],
        });
      },
    );
  }

  async #rejectUnprojectedGitApproval(
    client: WebClient,
    sessionId: string,
    channelId: string,
    rootThreadTs: string,
    requestId: string,
    plan: WorkspaceGitApprovalPlan,
  ): Promise<void> {
    let resolutionError: unknown;
    try {
      await recordGitProjectionFailureBeforeAppServerResume(
        this.#workspaceGitSystemRejectionRecorder,
        plan,
        () => this.#gateway.resolveSessionUserInput(sessionId, {
          requestId,
          optionId: "reject",
          plan,
        }),
      );
    } catch (error) {
      resolutionError = error;
    }

    const details = this.#gitApprovalDetails.getForRequest(
      requestId,
      channelId,
      rootThreadTs,
    );
    if (details !== undefined) {
      let terminalizationError: unknown;
      try {
        await client.chat.update({
          channel: details.routing.channelId,
          ts: details.routing.messageTs,
          text:
            resolutionError === undefined
              ? "Git承認UIを表示できなかったため、このSlack承認要求を終了しました。" +
                "Git操作は承認されていません。"
              : "Git承認UIを表示できませんでした。Git操作は実行されていません。" +
                "この画面は使用できません。状態確認後に再作成してください。",
          blocks:
            details.sourceUserMention === undefined
              ? buildUnavailableWorkspaceGitApprovalBlocks()
              : [
                  gitApprovalMentionBlock(details.sourceUserMention),
                  ...buildUnavailableWorkspaceGitApprovalBlocks(),
                ],
        });
        this.#gitApprovalDetails.forget(details.routing);
      } catch (error) {
        terminalizationError = error;
      }
      if (
        resolutionError !== undefined &&
        terminalizationError !== undefined
      ) {
        throw new AggregateError(
          [resolutionError, terminalizationError],
          "Invisible Git approval could not be safely closed",
        );
      }
    }
    if (resolutionError !== undefined) throw resolutionError;
    // A terminal Slack update is cosmetic once the configured private reject
    // recorder (when present) and App Server response both succeeded. In the
    // OSS runtime the local reject still leaves the Git plan unapproved.
  }

  async #settleExternallyResolvedGitApproval(
    projector: SlackThreadProjector,
    event: Extract<AgentEvent, { type: "git_approval.resolved_externally" }>,
  ): Promise<void> {
    let settlementError: unknown;
    if (event.systemRejectionRecorded !== true) {
      try {
        await recordSystemGitRejection(
          this.#workspaceGitSystemRejectionRecorder,
          event.plan,
          "showtalk:external-app-server-resolution",
        );
      } catch (error) {
        settlementError = error;
      }
    }
    let projectionError: unknown;
    try {
      await projector.project(event);
    } catch (error) {
      projectionError = error;
    }
    if (settlementError !== undefined && projectionError !== undefined) {
      throw new AggregateError(
        [settlementError, projectionError],
        "Externally resolved Git approval could not be fully settled",
      );
    }
    if (settlementError !== undefined) throw settlementError;
    // With a configured private recorder the exact rejection intent is
    // durable. Without one, the resolved App Server request still cannot grant
    // Git authority. A cosmetic card failure must not abort Codex.
  }

  #requireTrustedChoiceContinuation(
    body: unknown,
    continuationId: string,
  ): StructuredChoiceContinuation {
    const continuation = this.#choiceContinuations.get(continuationId);
    if (continuation === undefined) {
      throw new Error("This structured choice continuation is unavailable or expired");
    }
    const allowedUsers = continuation.responderUserId === undefined
      ? this.#approvers
      : new Set([continuation.responderUserId]);
    validateSlackActionSource(body, {
      channelId: continuation.channelId,
      rootThreadTs: continuation.rootThreadTs,
      messageTs: continuation.messageTs,
    }, allowedUsers);
    return continuation;
  }

  async #continueStructuredChoice(
    client: WebClient,
    available: StructuredChoiceContinuation,
    answer: string,
    userId: string,
  ): Promise<void> {
    validateChoiceResponder(
      userId,
      available.responderUserId,
      this.#approvers,
    );
    assertContinuationStartAllowed(this.#restartPending);
    const continuation = this.#choiceContinuations.begin(
      available.continuationId,
    );
    try {
      const status = await this.#gateway.status(
        continuation.channelId,
        continuation.rootThreadTs,
        continuation.messageTs,
      );
      if (status.sessionId !== continuation.sessionId) {
        throw new Error("The persistent Koe session changed before this answer was sent");
      }
      const projector = new SlackThreadProjector(
        client,
        continuation.channelId,
        continuation.rootThreadTs,
        {
          sourceUserId: userId,
          presentation: this.#presentation(continuation.channelId),
          gitApprovalDetailsStore: this.#gitApprovalDetails,
          choiceContinuationStore: this.#choiceContinuations,
          interactionAudit: this.#interactionAudit,
        },
      );
      const results = this.#gateway.handleHumanMessage({
        channelId: continuation.channelId,
        rootThreadTs: continuation.rootThreadTs,
        messageTs: continuation.messageTs,
        slackUserId: userId,
        expectedSessionId: continuation.sessionId,
        notAfterMs: continuation.expiresAt,
        text: structuredChoiceContinuationPrompt(continuation, answer),
      })[Symbol.asyncIterator]();
      await consumeContinuationIterator(
        results,
        async () => {
          await client.chat.update({
            channel: continuation.channelId,
            ts: continuation.messageTs,
            text: choiceReceiptText(
              userId,
              continuation.question.purpose,
              true,
            ),
            blocks: [],
          });
        },
        async (result) => {
          projector.setSessionId(result.sessionId);
          if (result.event.type === "git_approval.resolved_externally") {
            await this.#settleExternallyResolvedGitApproval(projector, result.event);
          } else {
            try {
              await projector.project(result.event);
            } catch (error) {
              if (result.event.type === "choice.requested") {
                await this.#gateway.resolveSessionUserInput(result.sessionId, {
                  requestId: result.event.requestId,
                  cancelled: true,
                });
                throw new AggregateError(
                  [error],
                  "Continuation choice controls could not be displayed and were cancelled",
                );
              }
              if (result.event.type === "user_input.requested") {
                await this.#rejectUnprojectedGitApproval(
                  client,
                  result.sessionId,
                  continuation.channelId,
                  continuation.rootThreadTs,
                  result.event.requestId,
                  result.event.plan,
                );
              } else if (result.event.type === "approval.requested") {
                await this.#gateway.resolveSessionApproval(result.sessionId, {
                  requestId: result.event.requestId,
                  decision: "cancel",
                });
              } else {
                throw error;
              }
            }
          }
        },
      );
      await projector.complete();
    } catch (error) {
      await client.chat.update({
        channel: continuation.channelId,
        ts: continuation.messageTs,
        text:
          "この選択を新しいターンへ送信できませんでした。" +
          "通常のSlackメッセージで回答し直してください。",
        blocks: [],
      }).catch(() => undefined);
      throw error;
    } finally {
      // Once a new turn may have started, replay is unsafe even if its final
      // Slack projection failed. The user can send a fresh ordinary message.
      this.#choiceContinuations.consume(continuation.continuationId);
    }
  }

  #registerListeners(): void {
    this.#app.event("message", async ({ event, body, client, logger }) => {
      if (this.#durableEventLedger?.has(body.event_id) === true) return;
      if (!this.#deduplicator.accept(body.event_id)) return;
      const message = parseHumanSlackMessage(event);
      if (message === undefined) return;
      const slackEnvelopeIdentity = parseSlackEventEnvelopeIdentity(body);
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
              choiceContinuationStore: this.#choiceContinuations,
              interactionAudit: this.#interactionAudit,
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
            ...(slackEnvelopeIdentity === undefined
              ? {}
              : {
                  slackTeamId: slackEnvelopeIdentity.teamId,
                  slackAppId: slackEnvelopeIdentity.appId,
                }),
          })) {
            projector.setSessionId(result.sessionId);
            if (result.event.type === "git_approval.resolved_externally") {
              await this.#settleExternallyResolvedGitApproval(
                projector,
                result.event,
              );
              continue;
            }
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
                  await this.#rejectUnprojectedGitApproval(
                    client,
                    result.sessionId,
                    message.channel,
                    rootThreadTs,
                    result.event.requestId,
                    result.event.plan,
                  );
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
        let auditRoute: {
          readonly requestId: string;
          readonly channelId: string;
          readonly rootThreadTs: string;
          readonly messageTs: string;
        } | undefined;
        try {
          const { kind, routing, source } = parseTrustedChoiceAction(
            body,
            action,
            this.#approvers,
          );
          auditRoute = routing;
          this.#interactionAudit({
            event: "choice.action_received",
            ...routing,
            outcome: kind,
          });
          const continuation =
            this.#choiceContinuations.getForOriginalRequest(routing.requestId);
          if (continuation !== undefined) {
            assertOriginalChoiceMatchesContinuation(routing, continuation);
            if (kind === "other") {
              if (!continuation.question.allowsOther) {
                throw new Error("This structured choice does not allow free text");
              }
              const triggerId = asString(bodyRecord?.trigger_id);
              if (triggerId === undefined) {
                throw new Error("Slack did not provide a modal trigger");
              }
              await client.views.open({
                trigger_id: triggerId,
                view: buildChoiceContinuationOtherModal(
                  continuation.continuationId,
                  continuation.question.header,
                ),
              });
              return;
            }
            const option = continuation.question.options.find(
              (candidate) => candidate.id === routing.optionId,
            );
            if (option === undefined) {
              throw new Error("Structured choice continuation option is invalid");
            }
            await this.#continueStructuredChoice(
              client,
              continuation,
              option.label,
              source.userId,
            );
            return;
          }
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
          this.#interactionAudit({
            event: "choice.answer_applied",
            ...routing,
          });
          this.#choiceContinuations.forgetDisplayed(
            routing.requestId,
            routing.messageTs,
          );
          await client.chat.update({
            channel: source.channelId,
            ts: source.messageTs,
            text: choiceReceiptText(source.userId, routing.purpose),
            blocks: [],
          }).then(() => this.#interactionAudit({
            event: "choice.card_terminalized",
            ...routing,
            outcome: "answered",
          })).catch((error) => logger.error(error));
        } catch (error) {
          this.#interactionAudit({
            event: "choice.action_failed",
            ...auditRoute,
            outcome: error instanceof Error ? error.name : "unknown_error",
          });
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
          const continuation =
            this.#choiceContinuations.getForOriginalRequest(routing.requestId);
          if (continuation !== undefined) {
            assertOriginalChoiceMatchesContinuation(routing, continuation);
            if (!continuation.question.allowsOther) {
              throw new Error("This structured choice does not allow free text");
            }
            await this.#continueStructuredChoice(
              client,
              continuation,
              parsed.answer,
              userId,
            );
            return;
          }
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
          this.#choiceContinuations.forgetDisplayed(
            routing.requestId,
            routing.messageTs,
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
      new RegExp(`^${escapeRegExp(CHOICE_CONTINUATION_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        try {
          const actionRecord = asRecord(action);
          const parsedAction = parseChoiceContinuationActionId(
            asString(actionRecord?.action_id) ?? "",
          );
          if (parsedAction === undefined) {
            throw new Error("Unsupported structured choice continuation action");
          }
          const continuationId = parseChoiceContinuationId(actionRecord?.value);
          const continuation = this.#requireTrustedChoiceContinuation(
            body,
            continuationId,
          );
          if (parsedAction.kind === "other") {
            if (!continuation.question.allowsOther) {
              throw new Error("This structured choice does not allow free text");
            }
            const triggerId = asString(bodyRecord?.trigger_id);
            if (triggerId === undefined) {
              throw new Error("Slack did not provide a modal trigger");
            }
            await client.views.open({
              trigger_id: triggerId,
              view: buildChoiceContinuationOtherModal(
                continuationId,
                continuation.question.header,
              ),
            });
            return;
          }
          const option = continuation.question.options.find(
            (candidate) => candidate.id === parsedAction.optionId,
          );
          if (option === undefined) {
            throw new Error("Structured choice continuation option is invalid");
          }
          await this.#continueStructuredChoice(
            client,
            continuation,
            option.label,
            userId ?? "",
          );
        } catch (error) {
          logger.error(error);
          if (userId !== undefined && channelId !== undefined) {
            await client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text: `選択肢を新しいターンへ送信できませんでした: ${publicErrorMessage(error)}`,
              ...this.#presentation(channelId),
            }).catch((postError) => logger.error(postError));
          }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.view(
      CHOICE_CONTINUATION_VIEW_CALLBACK_ID,
      async ({ ack, body, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        let userId: string | undefined;
        let continuation: StructuredChoiceContinuation | undefined;
        try {
          const parsed = parseChoiceContinuationOtherSubmission(body);
          userId = parsed.userId;
          continuation = this.#choiceContinuations.get(parsed.continuationId);
          if (continuation === undefined) {
            throw new Error("This structured choice continuation is unavailable or expired");
          }
          validateChoiceResponder(
            userId,
            continuation.responderUserId,
            this.#approvers,
          );
          await this.#continueStructuredChoice(
            client,
            continuation,
            parsed.answer,
            userId,
          );
        } catch (error) {
          logger.error(error);
          if (userId !== undefined && continuation !== undefined) {
            await client.chat.postEphemeral({
              channel: continuation.channelId,
              user: userId,
              text: `自由入力を新しいターンへ送信できませんでした: ${publicErrorMessage(error)}`,
              ...this.#presentation(continuation.channelId),
            }).catch((postError) => logger.error(postError));
          }
        } finally {
          finishHandler();
        }
      },
    );

    this.#app.action(
      new RegExp(`^${escapeRegExp(WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX)}`),
      async ({ ack, body, action, client, logger }) => {
        await ack();
        const finishHandler = this.#beginSlackHandler();
        const bodyRecord = asRecord(body);
        const userId = asString(asRecord(bodyRecord?.user)?.id);
        const channelId = asString(asRecord(bodyRecord?.channel)?.id);
        try {
          const actionRecord = asRecord(action);
          const operation = parseWorkspaceGitAutonomyAction(
            asString(actionRecord?.action_id) ?? "",
          );
          if (operation === undefined) {
            throw new Error("Unsupported Workspace Git autonomy action");
          }
          const token = parseWorkspaceGitAutonomyToken(actionRecord?.value);
          const route = this.#workspaceGitAutonomyCards.get(token);
          if (route === undefined) {
            throw new Error("This Workspace Git autonomy control is unavailable or expired");
          }
          const source = validateSlackActionSource(
            body,
            {
              channelId: route.channelId,
              rootThreadTs: route.rootThreadTs,
              messageTs: route.messageTs,
            },
            this.#approvers,
          );
          if (operation === "hold") {
            this.#workspaceGitAutonomyCards.forget(token);
            await client.chat.update({
              channel: source.channelId,
              ts: source.messageTs,
              text: `Workspace Git自動運転の変更を保留しました（<@${source.userId}>）。`,
              blocks: [],
            });
            return;
          }
          if (operation !== route.operation) {
            throw new Error("Workspace Git autonomy action does not match its card");
          }
          const current = this.#workspaceGitAutonomySettings.get(route.koeId);
          const currentActivation =
            this.#workspaceGitAutonomyActivations.get(route.koeId);
          const settingsChanged = current === undefined ||
            current.channelId !== route.channelId ||
            (operation === "enable" &&
              (current.candidate === undefined ||
                current.koeBindingRevision !== route.koeBindingRevision ||
                current.principalPolicyRevision !== route.principalPolicyRevision ||
                current.candidate.profileId !== route.candidate.profileId ||
                current.candidate.profileRevision !== route.candidate.profileRevision)) ||
            (operation === "disable" &&
              (route.activationHandle === undefined ||
                currentActivation?.state !== "enabled" ||
                currentActivation.activationHandle !== route.activationHandle));
          if (settingsChanged) {
            throw new Error("Workspace Git autonomy settings changed after this card was posted");
          }
          if (this.#workspaceGitAutonomyBroker === undefined) {
            throw new Error("Workspace Git autonomy control is unavailable");
          }
          const decisionId = workspaceGitAutonomyDecisionId({
            operation,
            token,
            teamId: source.teamId,
            appId: source.apiAppId,
            channelId: source.channelId,
            rootThreadTs: route.rootThreadTs,
            messageTs: source.messageTs,
            userId: source.userId,
            koeId: route.koeId,
            profileId: route.candidate.profileId,
            profileRevision: route.candidate.profileRevision,
            koeBindingRevision: route.koeBindingRevision,
            principalPolicyRevision: route.principalPolicyRevision,
          });
          if (operation === "enable") {
            const result = validateWorkspaceGitAutonomyEnableResult(
              await this.#workspaceGitAutonomyBroker.enable({
                version: 4,
                decision_id: decisionId,
                profile_id: route.candidate.profileId,
                profile_revision: route.candidate.profileRevision,
                team_id: source.teamId,
                app_id: source.apiAppId,
                koe_id: route.koeId,
                koe_binding_revision: route.koeBindingRevision,
                principal_policy_revision: route.principalPolicyRevision,
                activated_by_user_id: source.userId,
                requested_expires_at: route.requestedExpiresAt,
                issued_from: {
                  channel_id: source.channelId,
                  root_thread_ts: route.rootThreadTs,
                  source_message_ts: source.messageTs,
                },
              }),
            );
            this.#workspaceGitAutonomyActivations.set(route.koeId, {
              koeId: route.koeId,
              profileId: route.candidate.profileId,
              profileRevision: route.candidate.profileRevision,
              activationHandle: result.activation_handle,
              expiresAt: result.expires_at,
              state: "enabled",
              updatedAt: new Date(this.#now()).toISOString(),
            });
            await this.#persistWorkspaceGitAutonomyActivations();
            await client.chat.update({
              channel: source.channelId,
              ts: source.messageTs,
              text: `Workspace Git自動運転を有効化しました（<@${source.userId}>）。`,
              blocks: [],
            });
          } else {
            if (route.activationHandle === undefined) {
              throw new Error("Workspace Git autonomy activation handle is unavailable");
            }
            validateWorkspaceGitAutonomyDisableResult(
              await this.#workspaceGitAutonomyBroker.disable({
                version: 4,
                activation_handle: route.activationHandle,
                decision_id: decisionId,
                disabled_by_user_id: source.userId,
              }),
              route.activationHandle,
            );
            const previous = this.#workspaceGitAutonomyActivations.get(route.koeId);
            if (previous !== undefined) {
              this.#workspaceGitAutonomyActivations.set(route.koeId, {
                ...previous,
                state: "disabled",
                updatedAt: new Date(this.#now()).toISOString(),
              });
            }
            await this.#persistWorkspaceGitAutonomyActivations();
            await client.chat.update({
              channel: source.channelId,
              ts: source.messageTs,
              text: `Workspace Git自動運転を無効化しました（<@${source.userId}>）。`,
              blocks: [],
            });
          }
          this.#workspaceGitAutonomyCards.forget(token);
        } catch (error) {
          logger.error("Workspace Git autonomy control failed");
          if (userId !== undefined && channelId !== undefined) {
            await client.chat.postEphemeral({
              channel: channelId,
              user: userId,
              text: "Workspace Git自動運転を変更できませんでした。設定・期限・権限を確認して、新しい確認カードからやり直してください。",
              ...this.#presentation(channelId),
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
        let auditRoute: UserInputActionValue | undefined;
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
            await this.#gitApprovalDetails.serialize(routing, async () => {
              const details = this.#gitApprovalDetails.get(routing);
              if (details === undefined) {
                await this.#terminalizeUnavailableGitApprovalCard(client, routing);
                return;
              }
              if (await this.#terminalizeExpiredGitApprovalCard(client, details)) {
                return;
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
                  expiresAt: new Date(details.expiresAt).toISOString(),
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
          auditRoute = routing;
          this.#interactionAudit({
            event: "git_approval.action_received",
            ...routing,
            outcome: decision,
          });
          await this.#gitApprovalDetails.serialize(routing, async () => {
            const details = this.#gitApprovalDetails.get(routing);
            if (details === undefined) {
              await this.#terminalizeUnavailableGitApprovalCard(client, routing);
              return;
            }
            if (await this.#terminalizeExpiredGitApprovalCard(client, details)) {
              return;
            }
            try {
              const koeId = this.#agentIdsByChannel.get(routing.channelId);
              if (koeId === undefined || details.sessionId === undefined) {
                throw new Error(
                  "The authenticated workspace-git decision context is unavailable",
                );
              }
              await recordGitDecisionBeforeAppServerResume(
                this.#workspaceGitDecisionBroker,
                details.plan,
                decision,
                createWorkspaceGitHumanDecisionDeliveryId({
                  channelId: routing.channelId,
                  rootThreadTs: routing.rootThreadTs,
                  messageTs: routing.messageTs,
                  requestId: routing.requestId,
                  userId: source.userId,
                  decision,
                  operationId: details.plan.operationId,
                  planHash: details.plan.planHash,
                }),
                {
                  callerId: source.userId,
                  koeId,
                  channelId: routing.channelId,
                  rootThreadTs: routing.rootThreadTs,
                  sessionId: details.sessionId,
                },
                () => this.#gateway.resolveUserInput(
                  routing.channelId,
                  routing.rootThreadTs,
                  {
                    requestId: routing.requestId,
                    optionId: decision,
                    plan: details.plan,
                  },
                ),
              );
              this.#interactionAudit({
                event: "git_approval.answer_applied",
                ...routing,
                outcome: decision,
              });
            } catch (error) {
              logger.error(error);
              if (!canSafelyRejectAfterPrivateGitDecisionFailure(error)) {
                // A timeout or transport failure can race with a durable
                // approval that completed after the local wait ended. Keep
                // the App Server request and original Slack controls pending;
                // retrying the same bound button reconciles by delivery ID.
                throw error;
              }
              await this.#closeFailedPrivateGitDecision(client, details, error);
              return;
            }
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
              this.#interactionAudit({
                event: "git_approval.card_terminalized",
                ...routing,
                outcome: decision,
              });
            } catch (error) {
              // The App Server response is already single-use. A cosmetic Slack
              // update failure must never cause a second approval attempt.
              logger.error(error);
            }
          });
        } catch (error) {
          this.#interactionAudit({
            event: "git_approval.action_failed",
            ...auditRoute,
            outcome: error instanceof Error ? error.name : "unknown_error",
          });
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
        try {
          const { decision, routing, source } = parseTrustedGitApprovalRecoveryAction(
            body,
            action,
            this.#approvers,
          );
          const recoveryKey = `${source.channelId}\u0000${source.messageTs}`;
          if (!this.#gitApprovalRecoveryActions.tryStart(recoveryKey)) {
            throw new Error("This Git approval recovery action was already handled");
          }

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
              `Git approval recovery instructions requested by <@${source.userId}>. ` +
              "The previous operation remains unapproved and no turn was started.",
            blocks: [],
          });
          await client.chat.postEphemeral({
            channel: routing.channelId,
            user: source.userId,
            text:
              "古い承認カードからはターンを再開しません。対象のGit操作を" +
              "このスレッドへ新しいメッセージとして明記してください。Koeは最新状態を確認し、" +
              "新しいexact planを作成してから承認画面を表示します。",
            ...this.#presentation(routing.channelId),
          });
        } catch (error) {
          logger.error(error);
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
          if (route === undefined) {
            const orphaned = parseOrphanedPermissionActionSource(
              body,
              action,
              this.#approvers,
            );
            await client.chat.update({
              channel: orphaned.channelId,
              ts: orphaned.messageTs,
              text:
                "These permission controls are no longer active after the Gateway state changed. " +
                "This click did not authorize any new action; check later operation status separately.",
              blocks: [],
            });
            return;
          }
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
          await this.#permissionApprovals.resolve(approval.requestId, decision, {
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

function reportPermissionApprovalUpdateError(error: unknown): void {
  console.error(
    `ShowTalk Taishi could not close a permission approval card: ${
      error instanceof Error ? error.message : "unknown error"
    }`,
  );
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

function parseSlackEventEnvelopeIdentity(
  value: unknown,
): { readonly teamId: string; readonly appId: string } | undefined {
  const body = asRecord(value);
  const teamId = asString(body?.team_id);
  const appId = asString(body?.api_app_id);
  if (
    teamId === undefined ||
    appId === undefined ||
    !/^T[A-Z0-9]{1,127}$/u.test(teamId) ||
    !/^A[A-Z0-9]{1,127}$/u.test(appId)
  ) {
    return undefined;
  }
  return { teamId, appId };
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
  const { routing, source } = parseTrustedGitPlanRouting(
    body,
    action,
    approvers,
  );
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

/** Fail-closed recovery for cards whose process-owned route was lost on restart. */
export function parseOrphanedPermissionActionSource(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  if (
    parsePermissionDecision(asString(actionRecord?.action_id) ?? "") === undefined
  ) {
    throw new Error("Unsupported permission approval action ID");
  }
  const approval = parsePermissionActionValue(
    asString(actionRecord?.value) ?? "",
  );
  const bodyRecord = asRecord(body);
  const message = asRecord(bodyRecord?.message);
  const messageTs = asString(message?.ts);
  const rootThreadTs = asString(message?.thread_ts) ?? messageTs;
  if (messageTs === undefined || rootThreadTs === undefined) {
    throw new Error("Permission approval source is incomplete");
  }
  const source = validateSlackActionSource(
    body,
    {
      channelId: approval.channelId,
      rootThreadTs,
      messageTs,
    },
    approvers,
  );
  return { ...source, requestId: approval.requestId };
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
  const { routing, source } = parseTrustedGitPlanRouting(
    body,
    action,
    approvers,
  );
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
  const { routing, source } = parseTrustedGitPlanRouting(
    body,
    action,
    approvers,
  );
  return { visibility, routing, source };
}

function parseTrustedGitPlanRouting(
  body: unknown,
  action: unknown,
  approvers: ReadonlySet<string>,
) {
  const actionRecord = asRecord(action);
  const rawValue = asString(actionRecord?.value) ?? "";
  let token: ReturnType<typeof parseUserInputActionToken> | undefined;
  try {
    token = parseUserInputActionToken(rawValue);
  } catch {
    // Older cards carried the message timestamp in the action payload.
    // Continue below and accept that format for cards already in Slack.
  }
  if (token !== undefined) {
    const source = validateSlackActionSource(body, token, approvers);
    return {
      routing: {
        ...token,
        messageTs: source.messageTs,
      },
      source,
    };
  }
  const routing = parseUserInputActionValue(rawValue);
  const source = validateSlackActionSource(body, routing, approvers);
  return { routing, source };
}

/**
 * Keeps the private workspace-git approval write ahead of the single-use App
 * Server response. A broker failure must leave the structured request pending.
 */
export async function recordGitDecisionBeforeAppServerResume(
  broker: WorkspaceGitHumanDecisionBroker | undefined,
  plan: WorkspaceGitApprovalPlan,
  decision: "approve" | "reject",
  deliveryId: string,
  context: {
    readonly callerId: string;
    readonly koeId: string;
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly sessionId: string;
  },
  resume: () => Promise<void>,
): Promise<void> {
  if (broker === undefined) {
    throw new Error("The private workspace-git approval broker is not configured");
  }
  await broker.recordDecision({
    decision,
    plan,
    deliveryId,
    context,
  });
  await resume();
}

export function canSafelyRejectAfterPrivateGitDecisionFailure(
  error: unknown,
): boolean {
  if (!isWorkspaceGitHumanDecisionBrokerError(error)) return false;
  switch (error.code) {
    case "invalid_decision":
    case "operation_not_found":
    case "plan_mismatch":
    case "expired":
      return true;
    case "decision_replay":
    case "status_conflict":
    case "decision_outcome_unknown":
    case "state_write_failed":
      return false;
  }
}

/** Records a non-human safety rejection before closing an invisible request. */
export async function recordGitProjectionFailureBeforeAppServerResume(
  recorder: WorkspaceGitSystemRejectionRecorder | undefined,
  plan: WorkspaceGitApprovalPlan,
  resume: () => Promise<void>,
): Promise<void> {
  await recordSystemGitRejection(
    recorder,
    plan,
    "showtalk:slack-projection-failure",
  );
  await resume();
}

export async function recordSystemGitRejection(
  recorder: WorkspaceGitSystemRejectionRecorder | undefined,
  plan: WorkspaceGitApprovalPlan,
  actor: WorkspaceGitSystemRejectionActor,
): Promise<void> {
  // The OSS manual-only runtime intentionally has no private system-decision
  // transport. Rejecting the App Server request still fails closed: no human
  // approval is recorded and the pending workspace-git plan cannot execute.
  // Private hosts may additionally persist a terminal rejection here.
  if (recorder === undefined) return;
  await recorder.recordRejection(plan, actor);
}

/**
 * Converts a failed private human-decision write into one durable fail-closed
 * rejection before the single-use App Server request and Slack card are closed.
 */
export async function closeFailedPrivateGitDecisionBeforeRecovery(
  recorder: WorkspaceGitSystemRejectionRecorder | undefined,
  plan: WorkspaceGitApprovalPlan,
  closeAppServerRequest: () => Promise<void>,
  projectRecovery: () => Promise<void>,
): Promise<void> {
  await recordSystemGitRejection(
    recorder,
    plan,
    "showtalk:private-decision-failure",
  );
  await closeAppServerRequest();
  await projectRecovery();
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
  const parsedAction = parseChoiceActionId(
    asString(actionRecord?.action_id) ?? "",
  );
  if (parsedAction === undefined) {
    throw new Error("Unsupported structured choice action ID");
  }
  const routing = parseChoiceActionValue(
    asString(actionRecord?.value) ?? "",
  );
  if (
    (parsedAction.kind === "select" &&
      routing.optionId !== parsedAction.optionId) ||
    (parsedAction.kind === "other" && routing.optionId !== undefined)
  ) {
    throw new Error("Structured choice action does not match its payload");
  }
  const allowedUsers = routing.responderUserId === undefined
    ? approvers
    : new Set([routing.responderUserId]);
  const source = validateSlackActionSource(body, routing, allowedUsers);
  return { kind: parsedAction.kind, routing, source };
}

export function assertOriginalChoiceMatchesContinuation(
  routing: {
    readonly requestId: string;
    readonly questionId: string;
    readonly purpose?: "external_action_confirmation";
    readonly channelId: string;
    readonly rootThreadTs: string;
    readonly messageTs: string;
    readonly responderUserId?: string;
  },
  continuation: StructuredChoiceContinuation,
): void {
  if (
    routing.requestId !== continuation.requestId ||
    routing.questionId !== continuation.question.id ||
    routing.purpose !== continuation.question.purpose ||
    routing.channelId !== continuation.channelId ||
    routing.rootThreadTs !== continuation.rootThreadTs ||
    routing.messageTs !== continuation.messageTs ||
    routing.responderUserId !== continuation.responderUserId
  ) {
    throw new Error("This structured choice belongs to an older question");
  }
}

export function assertContinuationStartAllowed(restartPending: boolean): void {
  if (!restartPending) return;
  throw new Error(
    "Gateway restart is in progress. Send a new message after Taishi reconnects.",
  );
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

export function choiceReceiptText(
  userId: string,
  purpose: "ordinary" | "external_action_confirmation" | undefined,
  continued = false,
): string {
  if (purpose === "external_action_confirmation") {
    const accepted = continued
      ? "外部操作への回答を新しいターンとして受け付けました"
      : "外部操作への回答を受け付けました";
    return `${accepted}（<@${userId}>）。workspace-gitのGit操作は承認されていません。`;
  }
  return continued
    ? `回答を新しいターンとして受け付けました（<@${userId}>）。`
    : `回答を受け付けました（<@${userId}>）。`;
}

function structuredChoiceContinuationPrompt(
  continuation: StructuredChoiceContinuation,
  answer: string,
): string {
  return [
    "ShowTalk Taishi structured-choice continuation.",
    "The original ordinary request_user_input RPC ended before Slack supplied a human answer.",
    "Treat this as a normal authenticated human message in the same persistent conversation.",
    "It is not workspace-git approval and does not authorize any old or unbound Git plan.",
    ...(continuation.completedAnswers.length === 0
      ? []
      : [
        "Earlier answers from the same structured request:",
        ...continuation.completedAnswers.map((completed, index) =>
          `${index + 1}. ${completed.prompt}\nHuman answer: ${completed.answers.join(", ")}`
        ),
      ]),
    `Question: ${continuation.question.prompt}`,
    `Slack answer: ${answer}`,
    "Continue the original request using this answer. If a new protected operation needs approval, prepare and request a fresh exact approval normally.",
  ].join("\n");
}

export async function consumeContinuationIterator<T>(
  iterator: AsyncIterator<T>,
  onAdmitted: () => Promise<void>,
  onResult: (result: T) => Promise<void>,
): Promise<void> {
  let completed = false;
  let iterationError: unknown;
  try {
    let next = await iterator.next();
    await onAdmitted();
    while (!next.done) {
      await onResult(next.value);
      next = await iterator.next();
    }
    completed = true;
  } catch (error) {
    iterationError = error;
    throw error;
  } finally {
    if (!completed && iterator.return !== undefined) {
      try {
        await iterator.return();
      } catch (cleanupError) {
        if (iterationError !== undefined) {
          throw new AggregateError(
            [iterationError, cleanupError],
            "Structured choice continuation failed and its turn could not be released",
          );
        }
        throw cleanupError;
      }
    }
  }
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
