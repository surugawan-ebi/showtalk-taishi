import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type { AgentEvent } from "../core/index.js";
import { buildApprovalBlocks } from "./blocks.js";
import { buildGitApprovalRecoveryBlocks } from "./git-approval-recovery-blocks.js";
import { buildChoiceBlocks } from "./choice-blocks.js";
import {
  StructuredChoiceContinuationStore,
  buildChoiceContinuationBlocks,
} from "./choice-continuation.js";
import {
  WorkspaceGitApprovalDetailsStore,
  buildExpiredWorkspaceGitApprovalBlocks,
  buildUnavailableWorkspaceGitApprovalBlocks,
  buildWorkspaceGitApprovalBlocks,
} from "./user-input-blocks.js";
import { uploadSlackAttachments } from "./file-upload.js";
import type { SlackMessagePresentation } from "./presentation.js";
import type { InteractionAudit } from "./interaction-audit.js";
import {
  formatAgentTextForSlack,
  splitSlackText,
  utf8ByteLength,
} from "./text-format.js";

const MAX_RETAINED_AGENT_TEXT = 64_000;
const MAX_SLACK_MESSAGE_TEXT = 3_800;
const MAX_SLACK_MESSAGE_UTF8_BYTES = 3_800;
const MAX_STREAM_AGENT_TEXT = 3_300;
const MAX_STREAM_AGENT_UTF8_BYTES = 3_300;
const MAX_COMPACT_STREAM_AGENT_TEXT = 1_200;
const MAX_COMPACT_STREAM_AGENT_UTF8_BYTES = 1_200;
const MAX_FINAL_AGENT_TEXT = 12_000;
const MAX_FINAL_AGENT_UTF8_BYTES = 12_000;
const MAX_FINAL_CHUNK_BODY = 3_000;
const MAX_FINAL_CHUNK_UTF8_BYTES = 3_000;
const MAX_FINAL_CHUNKS = 4;
const MAX_ACTIVE_TOOL_CALLS = 256;
const MAX_SETTLED_TOOL_CALL_IDS = 512;
const UPDATE_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const TERMINAL_UPDATE_RETRY_DELAYS_MS = [100, 500] as const;
const WORKING_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const GIT_APPROVAL_RECOVERY_FINAL_TEXT =
  "Git操作は承認されませんでした。元の依頼の処理は終了しました。";

type HeartbeatScheduler = (
  task: () => Promise<void>,
  delayMs: number,
) => () => void;

type AttachmentUploader = (
  client: WebClient,
  channelId: string,
  rootThreadTs: string,
  attachments: readonly Extract<
    AgentEvent,
    { readonly type: "attachment.generated" }
  >["attachment"][],
) => Promise<void>;

export interface SlackThreadProjectorOptions {
  readonly sourceUserId?: string;
  readonly presentation?: SlackMessagePresentation;
  readonly now?: () => number;
  readonly heartbeatScheduler?: HeartbeatScheduler;
  readonly maxFinalChunks?: number;
  readonly gitApprovalDetailsStore?: WorkspaceGitApprovalDetailsStore;
  readonly choiceContinuationStore?: StructuredChoiceContinuationStore;
  readonly attachmentUploader?: AttachmentUploader;
  readonly interactionAudit?: InteractionAudit;
}

export class SlackThreadProjector {
  readonly #client: WebClient;
  readonly #channelId: string;
  readonly #rootThreadTs: string;
  readonly #sourceUserId: string | undefined;
  readonly #sourceUserMention: string | undefined;
  readonly #presentation: SlackMessagePresentation;
  readonly #now: () => number;
  readonly #heartbeatScheduler: HeartbeatScheduler;
  readonly #maxFinalChunks: number;
  readonly #gitApprovalDetailsStore: WorkspaceGitApprovalDetailsStore | undefined;
  readonly #choiceContinuationStore: StructuredChoiceContinuationStore | undefined;
  readonly #attachmentUploader: AttachmentUploader;
  readonly #interactionAudit: InteractionAudit | undefined;
  readonly #startedAtMs: number;
  #messageTs: string | undefined;
  #text = "";
  #lastPostedText = "";
  #lastUpdateAt = 0;
  #lastHeartbeatAttemptAt = 0;
  #sessionId: string | undefined;
  #toolStartedCount = 0;
  #toolCompletedCount = 0;
  #toolFailedCount = 0;
  #commandCount = 0;
  #fileChangeCount = 0;
  #mcpCallCount = 0;
  #otherToolCount = 0;
  #overflowRunningToolCount = 0;
  #unfinishedToolCount = 0;
  #toolProgressFinalized = false;
  #finalMessagesPublished = false;
  #activityCollapsed = false;
  #completion: Promise<void> | undefined;
  #finalReplyMessages: string[] | undefined;
  #finalReplyPublishedCount = 0;
  #activityFinalMessages: string[] | undefined;
  #activityFinalPublishedCount = 0;
  #messageProjectionDisabled = false;
  #compactActivityProjection = false;
  #turnActivityStarted = false;
  #terminalErrorPosted = false;
  #pendingGitApprovalRecovery:
    | Extract<AgentEvent, { type: "git_approval.reprepare_required" }>
    | undefined;
  #gitApprovalRecoveryPublished = false;
  #cancelHeartbeat: (() => void) | undefined;
  #activityWriteTail: Promise<void> = Promise.resolve();
  readonly #activeTools = new Set<string>();
  readonly #settledToolIds = new Set<string>();
  readonly #settledGeneratedAttachmentIds = new Set<string>();

  constructor(
    client: WebClient,
    channelId: string,
    rootThreadTs: string,
    options: SlackThreadProjectorOptions = {},
  ) {
    this.#client = client;
    this.#channelId = channelId;
    this.#rootThreadTs = rootThreadTs;
    this.#sourceUserId = options.sourceUserId;
    this.#sourceUserMention = options.sourceUserId === undefined
      ? undefined
      : formatSlackUserMention(options.sourceUserId);
    this.#presentation = options.presentation ?? {};
    this.#now = options.now ?? Date.now;
    this.#heartbeatScheduler =
      options.heartbeatScheduler ?? scheduleHeartbeat;
    this.#maxFinalChunks = options.maxFinalChunks ?? MAX_FINAL_CHUNKS;
    this.#gitApprovalDetailsStore = options.gitApprovalDetailsStore;
    this.#choiceContinuationStore = options.choiceContinuationStore;
    this.#attachmentUploader =
      options.attachmentUploader ??
      ((client, channelId, rootThreadTs, attachments) =>
        uploadSlackAttachments(client, channelId, rootThreadTs, attachments));
    this.#interactionAudit = options.interactionAudit;
    if (
      !Number.isSafeInteger(this.#maxFinalChunks) ||
      this.#maxFinalChunks < 1 ||
      this.#maxFinalChunks > MAX_FINAL_CHUNKS
    ) {
      throw new TypeError(
        `maxFinalChunks must be an integer from 1 to ${MAX_FINAL_CHUNKS}`,
      );
    }
    this.#startedAtMs = this.#now();
  }

  setSessionId(sessionId: string): void {
    if (sessionId.trim().length === 0) throw new TypeError("Session ID must not be empty");
    if (this.#sessionId !== undefined && this.#sessionId !== sessionId) {
      throw new Error("Slack projector cannot switch backend sessions");
    }
    this.#sessionId = sessionId;
  }

  async project(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message.delta":
        this.#turnActivityStarted = true;
        this.#text = appendBounded(
          this.#text,
          event.text,
          MAX_RETAINED_AGENT_TEXT,
        );
        if (
          this.#messageTs === undefined ||
          this.#now() - this.#lastUpdateAt >= UPDATE_INTERVAL_MS
        ) {
          await this.#upsertAgentMessage();
        }
        break;
      case "message.completed":
        if (event.text !== undefined) {
          this.#text = appendBounded("", event.text, MAX_RETAINED_AGENT_TEXT);
        }
        if (this.#activityUpdateDue()) await this.#upsertAgentMessage();
        break;
      case "attachment.generated":
        this.#turnActivityStarted = true;
        if (this.#settledGeneratedAttachmentIds.has(event.attachmentId)) break;
        this.#settledGeneratedAttachmentIds.add(event.attachmentId);
        try {
          await this.#attachmentUploader(
            this.#client,
            this.#channelId,
            this.#rootThreadTs,
            [event.attachment],
          );
        } catch {
          await this.#post(
            ":warning: 生成画像をSlackへ添付できませんでした。",
            undefined,
            true,
          );
        }
        break;
      case "approval.requested":
        this.#turnActivityStarted = true;
        await this.#upsertAgentMessage();
        await this.#postApproval(event);
        break;
      case "user_input.requested":
        this.#turnActivityStarted = true;
        await this.#upsertAgentMessage();
        await this.#postUserInput(event);
        break;
      case "git_approval.expired":
        await this.#expireGitApproval(event.requestId);
        break;
      case "git_approval.resolved_externally":
        await this.#resolveGitApprovalExternally(event.requestId);
        break;
      case "choice.requested":
        this.#turnActivityStarted = true;
        await this.#upsertAgentMessage();
        await this.#postChoice(event);
        break;
      case "choice.resolved_externally":
        await this.#resolveChoiceExternally(event.requestId);
        break;
      case "choice.auto_selected":
        this.#turnActivityStarted = true;
        await this.#post(
          `:fast_forward: *通常の選択肢を自動選択しました*\n${formatAgentTextForSlack(event.header, 150, 600)}: ${formatAgentTextForSlack(event.optionLabel, 75, 300)}`,
          undefined,
          true,
        );
        break;
      case "git_automation.executed":
        this.#turnActivityStarted = true;
        await this.#post(
          `:white_check_mark: *Git自動運転が完了しました*\n${formatAgentTextForSlack(event.plan.repoId, 100, 300)} / ${formatAgentTextForSlack(event.plan.mode, 100, 300)}`,
          undefined,
          true,
        );
        break;
      case "git_automation.blocked":
        this.#turnActivityStarted = true;
        await this.#post(
          `:no_entry: *Git自動運転を安全停止しました*\n${formatAgentTextForSlack(event.plan.repoId, 100, 300)} / ${formatAgentTextForSlack(event.plan.mode, 100, 300)}\n理由: ${formatAgentTextForSlack(event.reason, 100, 300)}\n同じ操作を自動再実行せず、manual承認にも切り替えていません。`,
          undefined,
          true,
        );
        break;
      case "git_approval.reprepare_required":
        this.#turnActivityStarted = true;
        this.#pendingGitApprovalRecovery ??= event;
        await this.#upsertAgentMessage();
        break;
      case "tool.started": {
        this.#turnActivityStarted = true;
        const isFirstTool = this.#toolStartedCount === 0;
        const recorded = this.#recordToolStart(event.toolCallId, event.name);
        if (
          recorded &&
          (isFirstTool ||
            this.#messageTs === undefined ||
            this.#now() - this.#lastUpdateAt >= UPDATE_INTERVAL_MS)
        ) {
          await this.#upsertAgentMessage();
        }
        break;
      }
      case "tool.completed": {
        const recorded = this.#recordToolCompletion(
          event.toolCallId,
          event.isError === true,
        );
        if (
          recorded &&
          (event.isError === true ||
            this.#activityUpdateDue())
        ) {
          await this.#upsertAgentMessage();
        }
        break;
      }
      case "error":
        if (event.code === "UNSUPPORTED_STRUCTURED_INPUT") {
          this.#interactionAudit?.({
            event: "structured_input.rejected_before_display",
            channelId: this.#channelId,
            rootThreadTs: this.#rootThreadTs,
            ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
            outcome: event.code,
          });
        }
        this.#terminalErrorPosted = true;
        await this.#upsertAgentMessage();
        await this.#post(`:warning: ${event.message}`, undefined, true);
        break;
      case "status.changed":
        if (
          event.status === "starting" ||
          event.status === "running" ||
          event.status === "waiting_for_approval" ||
          event.status === "waiting_for_input"
        ) {
          this.#turnActivityStarted = true;
          if (
            event.status === "waiting_for_approval" ||
            event.status === "waiting_for_input" ||
            this.#activityUpdateDue()
          ) {
            await this.#upsertAgentMessage();
          }
        }
        break;
    }
    this.#syncHeartbeat();
  }

  async complete(): Promise<void> {
    this.#stopHeartbeat();
    this.#finalizeToolProgress();
    if (this.#completion !== undefined) {
      await this.#completion;
      return;
    }
    const completion = this.#completeProjection();
    this.#completion = completion;
    try {
      await completion;
    } finally {
      if (this.#completion === completion) this.#completion = undefined;
    }
  }

  /** Stops heartbeat/progress work without publishing a misleading final reply. */
  async abandon(): Promise<void> {
    this.#stopHeartbeat();
    this.#finalizeToolProgress();
    await this.#activityWriteTail.catch(() => undefined);
  }

  hasPublishedFinalResponse(): boolean {
    return this.#finalMessagesPublished;
  }

  async #completeProjection(): Promise<void> {
    if (this.#sourceUserMention === undefined) {
      await this.#publishFinalMessagesToActivity();
      if (this.#finalMessagesPublished) {
        await this.#publishPendingGitApprovalRecovery();
      }
      return;
    }
    let collapseError: unknown;
    try {
      await this.#collapseActivityMessage();
    } catch (error) {
      collapseError = error;
    }
    await this.#publishFinalReply();
    if (this.#finalMessagesPublished) {
      await this.#publishPendingGitApprovalRecovery();
    }
    if (collapseError !== undefined) throw collapseError;
  }

  async #upsertAgentMessage(): Promise<void> {
    await this.#serializeActivityWrite(async () => {
      await this.#upsertAgentMessageLocked();
    });
  }

  async #upsertAgentMessageLocked(): Promise<void> {
    if (this.#messageProjectionDisabled) return;
    const text = this.#renderActivityMessage();
    if (text.length === 0) return;
    assertSafeSlackMessage(text);
    if (text === this.#lastPostedText) return;
    if (this.#messageTs === undefined) {
      const { result, postedText } = await this.#postActivityMessage(text);
      if (typeof result.ts !== "string") {
        this.#messageProjectionDisabled = true;
        throw new Error("Slack did not return a timestamp for Koe activity");
      }
      this.#messageTs = result.ts;
      this.#lastPostedText = postedText;
      this.#lastUpdateAt = this.#now();
      return;
    }
    const postedText = await this.#updateActivityMessage(text);
    this.#lastPostedText = postedText;
    this.#lastUpdateAt = this.#now();
  }

  async #postActivityMessage(text: string): Promise<{
    readonly result: Awaited<ReturnType<WebClient["chat"]["postMessage"]>>;
    readonly postedText: string;
  }> {
    try {
      const result = await this.#client.chat.postMessage({
        channel: this.#channelId,
        thread_ts: this.#rootThreadTs,
        text,
        ...this.#presentation,
      });
      return { result, postedText: text };
    } catch (error) {
      if (!isSlackMessageTooLong(error)) throw error;
      const compactText = this.#compactActivityMessage();
      try {
        const result = await this.#client.chat.postMessage({
          channel: this.#channelId,
          thread_ts: this.#rootThreadTs,
          text: compactText,
          ...this.#presentation,
        });
        return { result, postedText: compactText };
      } catch (retryError) {
        if (isSlackMessageTooLong(retryError)) {
          this.#messageProjectionDisabled = true;
        }
        throw retryError;
      }
    }
  }

  async #updateActivityMessage(text: string): Promise<string> {
    try {
      await this.#client.chat.update({
        channel: this.#channelId,
        ts: this.#messageTs!,
        text,
      });
      return text;
    } catch (error) {
      if (!isSlackMessageTooLong(error)) throw error;
      const compactText = this.#compactActivityMessage();
      try {
        await this.#client.chat.update({
          channel: this.#channelId,
          ts: this.#messageTs!,
          text: compactText,
        });
        return compactText;
      } catch (retryError) {
        if (isSlackMessageTooLong(retryError)) {
          this.#messageProjectionDisabled = true;
        }
        throw retryError;
      }
    }
  }

  #compactActivityMessage(): string {
    this.#compactActivityProjection = true;
    const text = this.#renderActivityMessage();
    assertSafeSlackMessage(text);
    return text;
  }

  #recordToolStart(toolCallId: string, name: string): boolean {
    if (
      this.#toolProgressFinalized ||
      this.#activeTools.has(toolCallId) ||
      this.#settledToolIds.has(toolCallId)
    ) {
      return false;
    }
    if (this.#activeTools.size < MAX_ACTIVE_TOOL_CALLS) {
      this.#activeTools.add(toolCallId);
    } else {
      this.#overflowRunningToolCount += 1;
    }
    this.#toolStartedCount += 1;
    if (name === "commandExecution") {
      this.#commandCount += 1;
    } else if (name === "fileChange") {
      this.#fileChangeCount += 1;
    } else if (name.includes(".")) {
      this.#mcpCallCount += 1;
    } else {
      this.#otherToolCount += 1;
    }
    return true;
  }

  #recordToolCompletion(toolCallId: string, isError: boolean): boolean {
    if (this.#toolProgressFinalized || this.#settledToolIds.has(toolCallId)) {
      return false;
    }
    if (this.#activeTools.has(toolCallId)) {
      this.#activeTools.delete(toolCallId);
    } else if (this.#overflowRunningToolCount > 0) {
      this.#overflowRunningToolCount -= 1;
    } else {
      // Preserve a coherent summary if App Server delivers a terminal item
      // after its start notification was missed.
      this.#toolStartedCount += 1;
      this.#otherToolCount += 1;
    }
    this.#toolCompletedCount += 1;
    if (isError) this.#toolFailedCount += 1;
    this.#rememberSettledTool(toolCallId);
    return true;
  }

  #rememberSettledTool(toolCallId: string): void {
    if (this.#settledToolIds.size >= MAX_SETTLED_TOOL_CALL_IDS) {
      const oldest = this.#settledToolIds.values().next().value;
      if (typeof oldest === "string") this.#settledToolIds.delete(oldest);
    }
    this.#settledToolIds.add(toolCallId);
  }

  #finalizeToolProgress(): void {
    if (this.#toolProgressFinalized) return;
    this.#toolProgressFinalized = true;
    this.#unfinishedToolCount =
      this.#activeTools.size + this.#overflowRunningToolCount;
    this.#activeTools.clear();
    this.#overflowRunningToolCount = 0;
  }

  #renderActivityMessage(): string {
    const toolProgress = this.#renderToolProgress();
    const separator = toolProgress.length === 0 ? "" : "\n\n";
    const maxAgentText = this.#compactActivityProjection
      ? MAX_COMPACT_STREAM_AGENT_TEXT
      : MAX_STREAM_AGENT_TEXT;
    const maxAgentUtf8Bytes = this.#compactActivityProjection
      ? MAX_COMPACT_STREAM_AGENT_UTF8_BYTES
      : MAX_STREAM_AGENT_UTF8_BYTES;
    const agentText = formatAgentTextForSlack(
      this.#text,
      Math.min(
        maxAgentText,
        MAX_SLACK_MESSAGE_TEXT - separator.length - toolProgress.length,
      ),
      Math.min(
        maxAgentUtf8Bytes,
        MAX_SLACK_MESSAGE_UTF8_BYTES -
          utf8ByteLength(separator) -
          utf8ByteLength(toolProgress),
      ),
    );
    if (agentText.length === 0) return toolProgress;
    if (toolProgress.length === 0) return agentText;
    return `${agentText}${separator}${toolProgress}`;
  }

  async #publishFinalMessagesToActivity(): Promise<void> {
    if (this.#finalMessagesPublished || this.#messageProjectionDisabled) return;
    this.#activityFinalMessages ??= this.#renderFinalMessages();
    const messages = this.#activityFinalMessages;
    const toolProgress = this.#renderToolProgress();
    await this.#upsertPrimaryMessage(messages[0] ?? toolProgress);
    while (this.#activityFinalPublishedCount < messages.length - 1) {
      const message = messages[this.#activityFinalPublishedCount + 1];
      if (message === undefined) break;
      const result = await this.#client.chat.postMessage({
        channel: this.#channelId,
        thread_ts: this.#rootThreadTs,
        text: message,
        ...this.#presentation,
      });
      if (typeof result.ts !== "string") {
        throw new Error("Slack did not return a timestamp for Koe continuation");
      }
      this.#activityFinalPublishedCount += 1;
    }
    this.#finalMessagesPublished = true;
  }

  #renderFinalMessages(): string[] {

    const projectedAgentText = formatAgentTextForSlack(
      this.#text,
      MAX_FINAL_AGENT_TEXT,
      MAX_FINAL_AGENT_UTF8_BYTES,
    );
    const agentText =
      projectedAgentText.length === 0 && this.#pendingGitApprovalRecovery !== undefined
        ? GIT_APPROVAL_RECOVERY_FINAL_TEXT
        : projectedAgentText;
    const allChunks = splitSlackText(
      agentText,
      MAX_FINAL_CHUNK_BODY,
      MAX_FINAL_CHUNK_UTF8_BYTES,
    );
    let chunks = allChunks.slice(0, this.#maxFinalChunks);
    if (allChunks.length > this.#maxFinalChunks && chunks.length > 0) {
      chunks[chunks.length - 1] = `${chunks.at(-1)}\n\n_(Response truncated in Slack.)_`;
    }
    if (chunks.length === 0) chunks = [""];
    const toolProgress = this.#renderToolProgress();
    const messageCount = chunks.length;
    const messages = chunks.map((chunk, index) => {
      const heading = messageCount > 1 ? `*Response ${index + 1}/${messageCount}*\n` : "";
      const progress = index === messageCount - 1 && toolProgress.length > 0
        ? `${chunk.length === 0 ? "" : "\n\n"}${toolProgress}`
        : "";
      return `${heading}${chunk}${progress}`;
    });

    messages.forEach(assertSafeSlackMessage);
    return messages;
  }

  async #collapseActivityMessage(): Promise<void> {
    await this.#serializeActivityWrite(async () => {
      if (
        this.#activityCollapsed ||
        this.#messageProjectionDisabled ||
        this.#messageTs === undefined
      ) {
        return;
      }
      const completedAtMs = this.#now();
      const text = formatThinkingDuration(completedAtMs - this.#startedAtMs);
      assertSafeSlackMessage(text);
      await this.#client.chat.update({
        channel: this.#channelId,
        ts: this.#messageTs,
        text,
      });
      this.#lastPostedText = text;
      this.#lastUpdateAt = completedAtMs;
      this.#activityCollapsed = true;
    });
  }

  async #publishFinalReply(): Promise<void> {
    if (this.#finalMessagesPublished || this.#sourceUserMention === undefined) return;

    if (this.#terminalErrorPosted && this.#text.trim().length === 0) {
      // The actionable error already notified the source user. Do not append a
      // contradictory generic success message to a failed, text-less turn.
      this.#finalMessagesPublished = true;
      return;
    }

    if (this.#finalReplyMessages === undefined) {
      const messages = this.#renderFinalMessages();
      if (messages.length === 0 || messages.every((message) => message.length === 0)) {
        messages.splice(0, messages.length, "処理が完了しました。");
      }
      const firstMessage = messages[0] ?? "処理が完了しました。";
      messages[0] = `${this.#sourceUserMention}\n\n${firstMessage}`;
      messages.forEach(assertSafeSlackMessage);
      this.#finalReplyMessages = messages;
    }

    while (this.#finalReplyPublishedCount < this.#finalReplyMessages.length) {
      const message = this.#finalReplyMessages[this.#finalReplyPublishedCount];
      if (message === undefined) break;
      const result = await this.#client.chat.postMessage({
        channel: this.#channelId,
        thread_ts: this.#rootThreadTs,
        text: message,
        ...this.#presentation,
      });
      if (typeof result.ts !== "string") {
        throw new Error("Slack did not return a timestamp for final Koe response");
      }
      this.#finalReplyPublishedCount += 1;
    }
    this.#finalMessagesPublished = true;
  }

  async #upsertPrimaryMessage(text: string): Promise<void> {
    await this.#serializeActivityWrite(async () => {
      if (text.length === 0 || text === this.#lastPostedText) return;
      assertSafeSlackMessage(text);
      if (this.#messageTs === undefined) {
        const result = await this.#client.chat.postMessage({
          channel: this.#channelId,
          thread_ts: this.#rootThreadTs,
          text,
          ...this.#presentation,
        });
        if (typeof result.ts !== "string") {
          this.#messageProjectionDisabled = true;
          throw new Error("Slack did not return a timestamp for Koe activity");
        }
        this.#messageTs = result.ts;
      } else {
        await this.#client.chat.update({
          channel: this.#channelId,
          ts: this.#messageTs,
          text,
        });
      }
      this.#lastPostedText = text;
      this.#lastUpdateAt = this.#now();
    });
  }

  #renderToolProgress(): string {
    const working = !this.#toolProgressFinalized && this.#turnActivityStarted;
    if (
      !working &&
      this.#toolStartedCount === 0 &&
      this.#toolCompletedCount === 0
    ) {
      return "";
    }

    const completed = Math.max(0, this.#toolCompletedCount - this.#toolFailedCount);
    const running = this.#activeTools.size + this.#overflowRunningToolCount;
    const metrics: string[] = [];
    if (completed > 0) metrics.push(`${completed} completed`);
    if (this.#toolFailedCount > 0) metrics.push(`${this.#toolFailedCount} failed`);
    if (running > 0) metrics.push(`${running} running`);
    if (this.#unfinishedToolCount > 0) {
      metrics.push(`${this.#unfinishedToolCount} unfinished`);
    }
    if (metrics.length === 0 && this.#toolStartedCount > 0) {
      metrics.push(`${this.#toolStartedCount} started`);
    }

    const kinds: string[] = [];
    if (this.#commandCount > 0) kinds.push(`Commands ${this.#commandCount}`);
    if (this.#fileChangeCount > 0) kinds.push(`File changes ${this.#fileChangeCount}`);
    if (this.#mcpCallCount > 0) kinds.push(`MCP calls ${this.#mcpCallCount}`);
    if (this.#otherToolCount > 0) kinds.push(`Other tools ${this.#otherToolCount}`);

    const icon =
      this.#toolFailedCount > 0 || this.#unfinishedToolCount > 0
        ? ":warning:"
        : working
          ? ":gear:"
          : ":white_check_mark:";
    const label = working ? "Working" : "Tool activity";
    const heartbeat = working
      ? ` ${workingFrame(this.#now() - this.#startedAtMs)}`
      : "";
    const details: string[] = [];
    if (metrics.length > 0) details.push(metrics.join(", "));
    if (kinds.length > 0) details.push(kinds.join(" · "));
    if (working) {
      details.push(`${formatElapsedDuration(this.#now() - this.#startedAtMs)}経過`);
    }
    return `${icon} ${label}${heartbeat}${
      details.length === 0 ? "" : ` — ${details.join(" · ")}`
    }`;
  }

  #activityUpdateDue(): boolean {
    return (
      this.#messageTs === undefined ||
      this.#now() - this.#lastUpdateAt >= UPDATE_INTERVAL_MS
    );
  }

  #syncHeartbeat(): void {
    if (
      this.#toolProgressFinalized ||
      !this.#turnActivityStarted ||
      this.#messageProjectionDisabled ||
      this.#messageTs === undefined
    ) {
      this.#stopHeartbeat();
      return;
    }
    if (this.#cancelHeartbeat !== undefined) return;

    const lastActivityAt = Math.max(
      this.#lastUpdateAt,
      this.#lastHeartbeatAttemptAt,
    );
    const elapsedSinceActivity = Math.max(0, this.#now() - lastActivityAt);
    const delayMs = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsedSinceActivity);
    this.#cancelHeartbeat = this.#heartbeatScheduler(async () => {
      this.#cancelHeartbeat = undefined;
      if (
        this.#toolProgressFinalized ||
        !this.#turnActivityStarted ||
        this.#messageProjectionDisabled
      ) {
        return;
      }
      this.#lastHeartbeatAttemptAt = this.#now();
      try {
        if (
          this.#now() - this.#lastUpdateAt >= HEARTBEAT_INTERVAL_MS
        ) {
          await this.#upsertAgentMessage();
        }
      } catch {
        // Heartbeats are best-effort. Event and final-response projection must
        // continue even if a cosmetic Slack update fails.
      } finally {
        this.#syncHeartbeat();
      }
    }, delayMs);
  }

  #stopHeartbeat(): void {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = undefined;
  }

  async #serializeActivityWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.#activityWriteTail
      .catch(() => undefined)
      .then(operation);
    this.#activityWriteTail = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async #post(
    text: string,
    blocks?: KnownBlock[],
    notifySourceUser = false,
  ): Promise<void> {
    const includesSourceMention =
      notifySourceUser && this.#sourceUserMention !== undefined;
    const postedText = this.#formatActionableMessage(text, includesSourceMention);
    // Slack clients can derive notification copy from either the top-level
    // fallback or Block Kit text, so keep the actionable mention in both.
    const postedBlocks = includesSourceMention && blocks !== undefined
      ? [sourceMentionBlock(this.#sourceUserMention), ...blocks]
      : blocks;
    if (includesSourceMention) assertSafeSlackMessage(postedText);
    await this.#client.chat.postMessage({
      channel: this.#channelId,
      thread_ts: this.#rootThreadTs,
      text: postedText,
      mrkdwn: includesSourceMention,
      ...(postedBlocks === undefined ? {} : { blocks: postedBlocks }),
      ...this.#presentation,
    });
  }

  async #postUserInput(
    event: Extract<AgentEvent, { type: "user_input.requested" }>,
  ): Promise<void> {
    this.#interactionAudit?.({
      event: "git_approval.request_received",
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    });
    const actionToken = {
      version: 1 as const,
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
    };
    const fallback = this.#formatActionableMessage(
      `Git操作の承認待ち: ${event.plan.repoId} / ${event.plan.mode}`,
      this.#sourceUserMention !== undefined,
    );
    const canToggleDetails = this.#gitApprovalDetailsStore !== undefined;
    const expiresAt = Date.parse(event.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      throw new Error("Git approval UI received an invalid expiry");
    }
    const blocks = buildWorkspaceGitApprovalBlocks(
      event.prompt,
      event.plan,
      actionToken,
      {
        pathsExpanded: !canToggleDetails,
        allowPathToggle: canToggleDetails,
        bodyExpanded: !canToggleDetails,
        allowBodyToggle: canToggleDetails,
        expiresAt: event.expiresAt,
      },
    );
    const posted = await this.#client.chat.postMessage({
      channel: this.#channelId,
      thread_ts: this.#rootThreadTs,
      text: fallback,
      mrkdwn: this.#sourceUserMention !== undefined,
      blocks:
        this.#sourceUserMention === undefined
          ? blocks
          : [sourceMentionBlock(this.#sourceUserMention), ...blocks],
      ...this.#presentation,
    });
    if (typeof posted.ts !== "string") {
      throw new Error("Slack did not return a timestamp for Git approval UI");
    }
    this.#interactionAudit?.({
      event: "git_approval.card_posted",
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    });
    const routing = {
      ...actionToken,
      messageTs: posted.ts,
    } as const;
    this.#gitApprovalDetailsStore?.remember({
      prompt: event.prompt,
      plan: event.plan,
      routing,
      expiresAt,
      fallbackText: fallback,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      display: {
        pathsExpanded: !canToggleDetails,
        bodyExpanded: !canToggleDetails,
      },
      ...(this.#sourceUserMention === undefined
        ? {}
        : { sourceUserMention: this.#sourceUserMention }),
    });
  }

  async #resolveGitApprovalExternally(requestId: string): Promise<void> {
    const initial = this.#gitApprovalDetailsStore?.getForTerminalProjection(
      requestId,
      this.#channelId,
      this.#rootThreadTs,
    );
    if (initial === undefined || this.#gitApprovalDetailsStore === undefined) return;
    await this.#gitApprovalDetailsStore.serialize(initial.routing, async () => {
      const details = this.#gitApprovalDetailsStore?.getIncludingTerminal(
        initial.routing,
      );
      if (details === undefined) return;
      const fallback =
        "このGit承認は別のCodexクライアントで解決されました。Slackからは実行できません。";
      const blocks = buildUnavailableWorkspaceGitApprovalBlocks();
      const updated = await retryTerminalSlackUpdate(() =>
        this.#client.chat.update({
          channel: details.routing.channelId,
          ts: details.routing.messageTs,
          text: fallback,
          blocks:
            details.sourceUserMention === undefined
              ? blocks
              : [sourceMentionBlock(details.sourceUserMention), ...blocks],
        }).then(() => undefined)
      );
      // The App Server request is already terminal. Never retain actionable
      // private plan state merely to retry a cosmetic Slack update: the stale
      // button could otherwise record a new private human decision after its
      // request has disappeared.
      this.#gitApprovalDetailsStore?.forget(initial.routing);
      this.#gitApprovalDetailsStore?.releaseTerminalRequest(requestId);
      if (updated) {
        this.#interactionAudit?.({
          event: "git_approval.resolved_externally",
          ...details.routing,
          ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
          outcome: "unavailable",
        });
      }
    });
  }

  async #expireGitApproval(requestId: string): Promise<void> {
    const initial = this.#gitApprovalDetailsStore?.getForTerminalProjection(
      requestId,
      this.#channelId,
      this.#rootThreadTs,
    );
    if (initial === undefined || this.#gitApprovalDetailsStore === undefined) return;
    await this.#gitApprovalDetailsStore.serialize(initial.routing, async () => {
      const details = this.#gitApprovalDetailsStore?.getIncludingTerminal(
        initial.routing,
      );
      if (details === undefined) return;
      const fallback = this.#formatActionableMessage(
        "Git操作の承認期限が切れました。この計画は実行できません。",
        this.#sourceUserMention !== undefined,
      );
      const blocks = buildExpiredWorkspaceGitApprovalBlocks(
        details.plan,
        new Date(details.expiresAt).toISOString(),
      );
      const updated = await retryTerminalSlackUpdate(() =>
        this.#client.chat.update({
          channel: details.routing.channelId,
          ts: details.routing.messageTs,
          text: fallback,
          blocks:
            details.sourceUserMention === undefined
              ? blocks
              : [sourceMentionBlock(details.sourceUserMention), ...blocks],
        }).then(() => undefined)
      );
      if (updated) {
        this.#interactionAudit?.({
          event: "git_approval.expired",
          ...details.routing,
          ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
          outcome: "expired",
        });
        this.#gitApprovalDetailsStore?.forget(details.routing);
        this.#gitApprovalDetailsStore?.releaseTerminalRequest(requestId);
      }
      // If every bounded update attempt fails, retain the exact route. A stale
      // click can then retry the same cosmetic terminal update without ever
      // resolving or reconstructing the expired App Server request.
    });
  }

  async #postApproval(
    event: Extract<AgentEvent, { type: "approval.requested" }>,
  ): Promise<void> {
    const fallback = this.#formatActionableMessage(
      event.summary,
      this.#sourceUserMention !== undefined,
    );
    const posted = await this.#client.chat.postMessage({
      channel: this.#channelId,
      thread_ts: this.#rootThreadTs,
      text: fallback,
      mrkdwn: this.#sourceUserMention !== undefined,
      ...this.#presentation,
    });
    if (typeof posted.ts !== "string") {
      throw new Error("Slack did not return a timestamp for approval UI");
    }
    const blocks = buildApprovalBlocks(event.summary, {
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    }, event.availableDecisions);
    await this.#client.chat.update({
      channel: this.#channelId,
      ts: posted.ts,
      text: fallback,
      blocks:
        this.#sourceUserMention === undefined
          ? blocks
          : [sourceMentionBlock(this.#sourceUserMention), ...blocks],
    });
  }

  async #resolveChoiceExternally(requestId: string): Promise<void> {
    const displayed = this.#choiceContinuationStore?.getDisplayed(requestId);
    const auditSessionId = displayed?.sessionId ?? this.#sessionId;
    this.#interactionAudit?.({
      event: "choice.resolved_externally",
      requestId,
      channelId: displayed?.channelId ?? this.#channelId,
      rootThreadTs: displayed?.rootThreadTs ?? this.#rootThreadTs,
      ...(displayed?.messageTs === undefined
        ? {}
        : { messageTs: displayed.messageTs }),
      ...(auditSessionId === undefined ? {} : { sessionId: auditSessionId }),
    });
    if (displayed?.question.purpose === "external_action_confirmation") {
      this.#choiceContinuationStore?.forgetDisplayed(
        requestId,
        displayed.messageTs,
      );
      await this.#client.chat.update({
        channel: displayed.channelId,
        ts: displayed.messageTs,
        text:
          "Codex側の外部操作承認は回答前に終了したため、" +
          "未承認として閉じました。このカードは操作を承認しません。" +
          "実行するには新しい最終承認が必要です。",
        blocks: [],
      });
      this.#interactionAudit?.({
        event: "choice.card_terminalized",
        requestId,
        channelId: displayed.channelId,
        rootThreadTs: displayed.rootThreadTs,
        messageTs: displayed.messageTs,
        sessionId: displayed.sessionId,
        outcome: "external_unapproved",
      });
      return;
    }
    const continuation = this.#choiceContinuationStore?.resolveExternally(requestId);
    if (continuation === undefined) return;
    const blocks = buildChoiceContinuationBlocks(continuation);
    await this.#client.chat.update({
      channel: continuation.channelId,
      ts: continuation.messageTs,
      text:
        "Codex側の元の質問は先に終了しました。" +
        "この選択を通常の新しいターンとして送信できます。" +
        (continuation.question.purpose === "external_action_confirmation"
          ? " workspace-gitのGit承認ではありません。"
          : ""),
      blocks:
        continuation.responderUserId === undefined
          ? blocks
          : [sourceMentionBlock(`<@${continuation.responderUserId}>`), ...blocks],
    });
  }

  async #postChoice(
    event: Extract<AgentEvent, { type: "choice.requested" }>,
  ): Promise<void> {
    this.#interactionAudit?.({
      event: "choice.request_received",
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    });
    const fallback = this.#formatActionableMessage(
      event.question.purpose === "external_action_confirmation"
        ? `外部操作の確認（Git承認ではありません）: ${event.question.header}`
        : `選択してください: ${event.question.header}`,
      this.#sourceUserMention !== undefined,
    );
    const posted = await this.#client.chat.postMessage({
      channel: this.#channelId,
      thread_ts: this.#rootThreadTs,
      text: fallback,
      mrkdwn: this.#sourceUserMention !== undefined,
      ...this.#presentation,
    });
    if (typeof posted.ts !== "string") {
      throw new Error("Slack did not return a timestamp for structured choice UI");
    }
    this.#interactionAudit?.({
      event: "choice.card_posted",
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    });
    const blocks = buildChoiceBlocks(event.question, {
      version: 1,
      requestId: event.requestId,
      questionId: event.question.id,
      ...(event.question.purpose === "external_action_confirmation"
        ? { purpose: event.question.purpose }
        : {}),
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
      ...(this.#sourceUserId === undefined
        ? {}
        : { responderUserId: this.#sourceUserId }),
    });
    await this.#client.chat.update({
      channel: this.#channelId,
      ts: posted.ts,
      text: fallback,
      blocks:
        this.#sourceUserMention === undefined
          ? blocks
          : [sourceMentionBlock(this.#sourceUserMention), ...blocks],
    });
    this.#interactionAudit?.({
      event: "choice.controls_attached",
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
    });
    if (this.#sessionId !== undefined) {
      this.#choiceContinuationStore?.rememberDisplayed({
        requestId: event.requestId,
        sessionId: this.#sessionId,
        question: event.question,
        completedAnswers: event.completedAnswers,
        channelId: this.#channelId,
        rootThreadTs: this.#rootThreadTs,
        messageTs: posted.ts,
        ...(this.#sourceUserId === undefined
          ? {}
          : { responderUserId: this.#sourceUserId }),
        expiresAt: Date.parse(event.expiresAt),
      });
    }
  }

  async #publishPendingGitApprovalRecovery(): Promise<void> {
    const event = this.#pendingGitApprovalRecovery;
    if (event === undefined || this.#gitApprovalRecoveryPublished) return;
    const fallback = this.#formatActionableMessage(
      "Git操作は承認されていません。必要な操作を新しいメッセージとして依頼してください。",
      this.#sourceUserMention !== undefined,
    );
    await this.#client.chat.postMessage({
      channel: this.#channelId,
      thread_ts: this.#rootThreadTs,
      text: fallback,
      mrkdwn: this.#sourceUserMention !== undefined,
      blocks:
        this.#sourceUserMention === undefined
          ? buildGitApprovalRecoveryBlocks(event.message)
          : [
              sourceMentionBlock(this.#sourceUserMention),
              ...buildGitApprovalRecoveryBlocks(event.message),
            ],
      ...this.#presentation,
    });
    this.#gitApprovalRecoveryPublished = true;
  }

  #formatActionableMessage(text: string, includeSourceMention: boolean): string {
    const suffix =
      includeSourceMention && this.#sourceUserMention !== undefined
        ? `\n\n${this.#sourceUserMention}`
        : "";
    const body = formatAgentTextForSlack(
      text,
      MAX_SLACK_MESSAGE_TEXT - suffix.length,
      MAX_SLACK_MESSAGE_UTF8_BYTES - utf8ByteLength(suffix),
    );
    if (body.length === 0) return suffix.trimStart();
    return `${body}${suffix}`;
  }
}

function formatThinkingDuration(elapsedMs: number): string {
  const duration = formatElapsedDuration(elapsedMs);
  return `:hourglass_flowing_sand: ${duration}考えました。`;
}

function formatElapsedDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}秒` : `${minutes}分${seconds}秒`;
}

function workingFrame(elapsedMs: number): string {
  const frame = Math.floor(Math.max(0, elapsedMs) / HEARTBEAT_INTERVAL_MS);
  return WORKING_FRAMES[frame % WORKING_FRAMES.length] ?? WORKING_FRAMES[0];
}

function scheduleHeartbeat(
  task: () => Promise<void>,
  delayMs: number,
): () => void {
  const timeout = setTimeout(() => {
    void task();
  }, delayMs);
  timeout.unref();
  return () => clearTimeout(timeout);
}

function sourceMentionBlock(sourceUserMention: string): KnownBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: sourceUserMention },
  };
}

function formatSlackUserMention(sourceUserId: string): string {
  if (
    sourceUserId.length === 0 ||
    sourceUserId.length > 255 ||
    !/^[A-Za-z0-9]+$/u.test(sourceUserId)
  ) {
    throw new TypeError("Slack source user ID is invalid");
  }
  return `<@${sourceUserId}>`;
}

function appendBounded(current: string, addition: string, limit: number): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  if (addition.length <= remaining) return current + addition;
  if (remaining === 1) return `${current}…`;
  return `${current}${addition.slice(0, remaining - 1)}…`;
}

function assertSafeSlackMessage(text: string): void {
  if (
    text.length > MAX_SLACK_MESSAGE_TEXT ||
    utf8ByteLength(text) > MAX_SLACK_MESSAGE_UTF8_BYTES
  ) {
    throw new Error("Slack Koe response exceeded the safe message limit");
  }
}

function isSlackMessageTooLong(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as {
    readonly code?: unknown;
    readonly data?: { readonly error?: unknown };
    readonly message?: unknown;
  };
  return (
    record.data?.error === "msg_too_long" ||
    record.code === "msg_too_long" ||
    (typeof record.message === "string" &&
      /\bmsg_too_long\b/u.test(record.message))
  );
}

async function retryTerminalSlackUpdate(
  update: () => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await update();
      return true;
    } catch {
      const delayMs = TERMINAL_UPDATE_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
