import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";

import type { AgentEvent } from "../core/index.js";
import { buildApprovalBlocks } from "./blocks.js";
import { buildGitApprovalRecoveryBlocks } from "./git-approval-recovery-blocks.js";
import { buildWorkspaceGitApprovalBlocks } from "./user-input-blocks.js";
import type { SlackMessagePresentation } from "./presentation.js";
import { formatAgentTextForSlack, splitSlackText } from "./text-format.js";

const MAX_RETAINED_AGENT_TEXT = 64_000;
const MAX_SLACK_MESSAGE_TEXT = 3_800;
const MAX_STREAM_AGENT_TEXT = 3_300;
const MAX_FINAL_AGENT_TEXT = 12_000;
const MAX_FINAL_CHUNK_BODY = 3_000;
const MAX_FINAL_CHUNKS = 4;
const MAX_ACTIVE_TOOL_CALLS = 256;
const MAX_SETTLED_TOOL_CALL_IDS = 512;
const UPDATE_INTERVAL_MS = 1_200;
const HEARTBEAT_INTERVAL_MS = 5_000;
const WORKING_FRAMES = ["◐", "◓", "◑", "◒"] as const;

type HeartbeatScheduler = (
  task: () => Promise<void>,
  delayMs: number,
) => () => void;

export interface SlackThreadProjectorOptions {
  readonly sourceUserId?: string;
  readonly presentation?: SlackMessagePresentation;
  readonly now?: () => number;
  readonly heartbeatScheduler?: HeartbeatScheduler;
  readonly maxFinalChunks?: number;
}

export class SlackThreadProjector {
  readonly #client: WebClient;
  readonly #channelId: string;
  readonly #rootThreadTs: string;
  readonly #sourceUserMention: string | undefined;
  readonly #presentation: SlackMessagePresentation;
  readonly #now: () => number;
  readonly #heartbeatScheduler: HeartbeatScheduler;
  readonly #maxFinalChunks: number;
  readonly #startedAtMs: number;
  #messageTs: string | undefined;
  #text = "";
  #lastPostedText = "";
  #lastUpdateAt = 0;
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
  #messageProjectionDisabled = false;
  #turnActivityStarted = false;
  #cancelHeartbeat: (() => void) | undefined;
  #activityWriteTail: Promise<void> = Promise.resolve();
  readonly #activeTools = new Set<string>();
  readonly #settledToolIds = new Set<string>();

  constructor(
    client: WebClient,
    channelId: string,
    rootThreadTs: string,
    options: SlackThreadProjectorOptions = {},
  ) {
    this.#client = client;
    this.#channelId = channelId;
    this.#rootThreadTs = rootThreadTs;
    this.#sourceUserMention = options.sourceUserId === undefined
      ? undefined
      : formatSlackUserMention(options.sourceUserId);
    this.#presentation = options.presentation ?? {};
    this.#now = options.now ?? Date.now;
    this.#heartbeatScheduler =
      options.heartbeatScheduler ?? scheduleHeartbeat;
    this.#maxFinalChunks = options.maxFinalChunks ?? MAX_FINAL_CHUNKS;
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
        await this.#upsertAgentMessage();
        break;
      case "approval.requested":
        this.#turnActivityStarted = true;
        await this.#upsertAgentMessage();
        await this.#post(
          event.summary,
          buildApprovalBlocks(event.summary, {
            requestId: event.requestId,
            channelId: this.#channelId,
            rootThreadTs: this.#rootThreadTs,
            ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
          }),
          true,
        );
        break;
      case "user_input.requested":
        this.#turnActivityStarted = true;
        await this.#upsertAgentMessage();
        await this.#postUserInput(event);
        break;
      case "git_approval.reprepare_required":
        this.#turnActivityStarted = true;
        await this.#upsertAgentMessage();
        await this.#postGitApprovalRecovery(event);
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
            this.#runningToolCount() === 0 ||
            this.#messageTs === undefined ||
            this.#now() - this.#lastUpdateAt >= UPDATE_INTERVAL_MS)
        ) {
          await this.#upsertAgentMessage();
        }
        break;
      }
      case "error":
        await this.#upsertAgentMessage();
        await this.#post(`:warning: ${event.message}`, undefined, true);
        break;
      case "status.changed":
        if (
          event.status === "starting" ||
          event.status === "running" ||
          event.status === "waiting_for_approval"
        ) {
          this.#turnActivityStarted = true;
          await this.#upsertAgentMessage();
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
      return;
    }
    try {
      await this.#collapseActivityMessage();
    } finally {
      await this.#publishFinalReply();
    }
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
      this.#lastPostedText = text;
      this.#lastUpdateAt = this.#now();
      return;
    }
    await this.#client.chat.update({
      channel: this.#channelId,
      ts: this.#messageTs,
      text,
    });
    this.#lastPostedText = text;
    this.#lastUpdateAt = this.#now();
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
    const agentText = formatAgentTextForSlack(this.#text, MAX_STREAM_AGENT_TEXT);
    const toolProgress = this.#renderToolProgress();
    if (agentText.length === 0) return toolProgress;
    if (toolProgress.length === 0) return agentText;
    return `${agentText}\n\n${toolProgress}`;
  }

  async #publishFinalMessagesToActivity(): Promise<void> {
    if (this.#finalMessagesPublished || this.#messageProjectionDisabled) return;
    this.#finalMessagesPublished = true;

    const messages = this.#renderFinalMessages();
    const toolProgress = this.#renderToolProgress();
    await this.#upsertPrimaryMessage(messages[0] ?? toolProgress);
    for (const message of messages.slice(1)) {
      const result = await this.#client.chat.postMessage({
        channel: this.#channelId,
        thread_ts: this.#rootThreadTs,
        text: message,
        ...this.#presentation,
      });
      if (typeof result.ts !== "string") {
        throw new Error("Slack did not return a timestamp for Koe continuation");
      }
    }
  }

  #renderFinalMessages(): string[] {

    const agentText = formatAgentTextForSlack(this.#text, MAX_FINAL_AGENT_TEXT);
    const allChunks = splitSlackText(agentText, MAX_FINAL_CHUNK_BODY);
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

  #runningToolCount(): number {
    return this.#activeTools.size + this.#overflowRunningToolCount;
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

    const elapsedSinceUpdate = Math.max(0, this.#now() - this.#lastUpdateAt);
    const delayMs = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsedSinceUpdate);
    this.#cancelHeartbeat = this.#heartbeatScheduler(async () => {
      this.#cancelHeartbeat = undefined;
      if (
        this.#toolProgressFinalized ||
        !this.#turnActivityStarted ||
        this.#messageProjectionDisabled
      ) {
        return;
      }
      try {
        await this.#upsertAgentMessage();
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
    const fallback = this.#formatActionableMessage(
      `Git操作の承認待ち: ${event.plan.repoId} / ${event.plan.mode}`,
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
      throw new Error("Slack did not return a timestamp for Git approval UI");
    }
    const blocks = buildWorkspaceGitApprovalBlocks(event.prompt, event.plan, {
      version: 1,
      requestId: event.requestId,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
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
  }

  async #postGitApprovalRecovery(
    event: Extract<AgentEvent, { type: "git_approval.reprepare_required" }>,
  ): Promise<void> {
    const fallback = this.#formatActionableMessage(
      "Git承認画面を安全に再作成できます。",
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
      throw new Error("Slack did not return a timestamp for Git approval recovery UI");
    }
    const blocks = buildGitApprovalRecoveryBlocks(event.message, {
      version: 1,
      channelId: this.#channelId,
      rootThreadTs: this.#rootThreadTs,
      messageTs: posted.ts,
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
  }

  #formatActionableMessage(text: string, includeSourceMention: boolean): string {
    const suffix =
      includeSourceMention && this.#sourceUserMention !== undefined
        ? `\n\n${this.#sourceUserMention}`
        : "";
    const body = formatAgentTextForSlack(
      text,
      MAX_SLACK_MESSAGE_TEXT - suffix.length,
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
  if (text.length > MAX_SLACK_MESSAGE_TEXT) {
    throw new Error("Slack Koe response exceeded the safe message limit");
  }
}
