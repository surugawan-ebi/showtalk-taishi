import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";

import type {
  CanUseTool,
  Options as ClaudeQueryOptions,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  AgentAdapter,
  CreateSessionRequest,
  ResumeSessionRequest,
  SendMessageRequest,
} from "../../core/adapter.js";
import {
  AdapterSessionUnavailableError,
  AgentWorkspaceUnavailableError,
  CoreError,
} from "../../core/errors.js";
import type {
  AdapterSession,
  AgentApproval,
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentStatus,
  JsonValue,
} from "../../core/types.js";

/** MCP server name under which the Gateway's local MCP endpoint is mounted. */
export const CLAUDE_SHOWTALK_MCP_SERVER = "showtalk_taishi";
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_AGENT_MESSAGE_CHARS = 40_000;
const MAX_TOOL_PAYLOAD_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 2_500;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Tools that would bypass the Slack conversation or cannot be answered there. */
const CLAUDE_DISALLOWED_TOOLS = ["AskUserQuestion"] as const;

export type ClaudePermissionMode = Extract<
  PermissionMode,
  "default" | "acceptEdits" | "plan"
>;

export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Minimal surface of the Agent SDK `Query` object used by the adapter. */
export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
}

export type ClaudeQueryFunction = (params: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: ClaudeQueryOptions;
}) => ClaudeQueryHandle;

export type ClaudeSessionLookup = (
  sessionId: string,
  workspacePath: string | undefined,
) => Promise<boolean>;

export interface ClaudeMcpConnection {
  readonly url: string;
  /**
   * Child environment variable that holds the bearer token. Claude Code
   * expands `${VAR}` in MCP headers, so the token never appears in argv.
   */
  readonly bearerTokenEnvVar: string;
}

export interface ClaudeCodeAdapterOptions {
  readonly kind?: string;
  readonly koeId?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly permissionMode?: ClaudePermissionMode;
  /** Tool permission rules that never need a Slack approval (e.g. `Read`). */
  readonly allowedTools?: readonly string[];
  readonly settingSources?: readonly ("user" | "project" | "local")[];
  readonly maxTurns?: number;
  /** Explicit `claude` executable; the SDK-bundled binary is used otherwise. */
  readonly pathToClaudeCodeExecutable?: string;
  /** Complete child environment; Gateway credentials must already be removed. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly mcp?: ClaudeMcpConnection;
  readonly approvalTimeoutMs?: number;
  readonly query?: ClaudeQueryFunction;
  readonly sessionExists?: ClaudeSessionLookup;
  readonly now?: () => number;
  readonly onStderr?: (line: string) => void;
}

interface ClaudeSessionContext {
  readonly agent: AgentDefinition;
  /** True once a transcript may exist on disk, so the next turn must resume. */
  started: boolean;
}

interface PendingClaudeApproval {
  readonly sessionId: string;
  readonly suggestions: readonly PermissionUpdate[];
  readonly availableDecisions: readonly AgentApproval["decision"][];
  readonly input: Record<string, unknown>;
  readonly settle: (result: PermissionResult) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveClaudeTurn {
  readonly query: ClaudeQueryHandle;
  readonly abort: AbortController;
}

/**
 * Runs Claude Code through the Claude Agent SDK. Each ShowTalk turn starts one
 * Agent SDK query that resumes the persistent Claude session, so the Koe keeps
 * its conversation across Slack messages and Gateway restarts. Tool permission
 * prompts become native Slack approval cards via `approval.requested`.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    approval: true,
    interrupt: true,
    resume: true,
    toolEvents: true,
    structuredInput: false,
    imageInput: true,
    audioFileInput: true,
  };

  readonly #options: ClaudeCodeAdapterOptions;
  readonly #query: ClaudeQueryFunction;
  readonly #sessionExists: ClaudeSessionLookup;
  readonly #now: () => number;
  readonly #sessions = new Map<string, ClaudeSessionContext>();
  readonly #statuses = new Map<string, AgentStatus>();
  readonly #activeTurns = new Map<string, ActiveClaudeTurn>();
  readonly #pendingApprovals = new Map<string, PendingClaudeApproval>();
  #model: string | undefined;
  #reasoningEffort: string | undefined;
  #shutdown = false;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.#options = options;
    this.kind = options.kind ?? "claude-code";
    this.#query = options.query ?? defaultClaudeQuery;
    this.#sessionExists = options.sessionExists ?? defaultClaudeSessionExists;
    this.#now = options.now ?? Date.now;
    this.#model = options.model;
    this.#reasoningEffort = options.reasoningEffort;
    if (
      options.mcp !== undefined &&
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(options.mcp.bearerTokenEnvVar)
    ) {
      throw new Error("Invalid MCP bearer token environment variable name");
    }
  }

  updateModelSettings(settings: {
    readonly model?: string | undefined;
    readonly reasoningEffort?: string | undefined;
  }): void {
    this.#model = settings.model;
    this.#reasoningEffort = settings.reasoningEffort;
  }

  async createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    this.#assertRunning();
    await validateWorkspace(request.agent.id, getWorkspacePath(request.agent));
    const id = randomUUID();
    this.#sessions.set(id, { agent: request.agent, started: false });
    this.#statuses.set(id, "idle");
    return toAdapterSession(id);
  }

  async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    this.#assertRunning();
    const workspacePath = getWorkspacePath(request.agent);
    await validateWorkspace(request.agent.id, workspacePath);
    const id = request.adapterSessionId;
    const known = this.#sessions.get(id);
    if (known === undefined || !known.started) {
      let exists: boolean;
      try {
        exists = await this.#sessionExists(id, workspacePath);
      } catch (error) {
        throw new AdapterSessionUnavailableError(id, { cause: error });
      }
      if (!exists) throw new AdapterSessionUnavailableError(id);
    }
    this.#sessions.set(id, { agent: request.agent, started: true });
    this.#statuses.set(id, this.#statuses.get(id) ?? "idle");
    return toAdapterSession(id);
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    this.#assertRunning();
    const context = this.#sessions.get(session.id);
    if (context === undefined) {
      throw new CoreError(
        "UNKNOWN_SESSION",
        `Claude session ${session.id} is not loaded`,
      );
    }
    if (this.#activeTurns.has(session.id)) {
      throw new CoreError(
        "AGENT_BUSY",
        `Claude session ${session.id} already has an active turn`,
      );
    }
    if (
      request.startNotAfterMs !== undefined &&
      this.#now() >= request.startNotAfterMs
    ) {
      throw new CoreError(
        "SESSION_AGENT_MISMATCH",
        "The queued continuation expired before the Claude turn started",
      );
    }

    const userMessage = await buildUserMessage(session.id, request);
    const events = new EventQueue<AgentEvent>();
    const abort = new AbortController();
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const prompt = (async function* () {
      yield userMessage;
      // Keep stdin open until the turn produces its result, so permission
      // callbacks and interrupts stay available for the whole turn.
      await finished;
    })();

    const query = this.#query({
      prompt,
      options: this.#queryOptions(session.id, context, abort, events),
    });
    this.#activeTurns.set(session.id, { query, abort });
    this.#setStatus(session.id, "running", events);

    const pump = (async () => {
      const toolNames = new Map<string, string>();
      let sawResult = false;
      try {
        for await (const message of query) {
          if (message.type === "system" && message.subtype === "init") {
            context.started = true;
          }
          if (message.type === "result") sawResult = true;
          for (const event of normalizeClaudeMessage(message, toolNames)) {
            events.push(event);
          }
          if (message.type === "result") resolveFinished();
        }
        if (!sawResult && !abort.signal.aborted) {
          events.push({
            type: "error",
            code: "CLAUDE_TURN_INCOMPLETE",
            message: "Claude Code ended the turn without a result",
            retryable: true,
          });
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          events.push({
            type: "error",
            code: "CLAUDE_QUERY_FAILED",
            message: sanitizeError(error),
            retryable: true,
          });
        }
      } finally {
        resolveFinished();
        events.end();
      }
    })();

    try {
      for await (const event of events) yield event;
      await pump;
      const terminal: AgentStatus =
        this.#statuses.get(session.id) === "interrupted" ? "interrupted" : "idle";
      this.#statuses.set(session.id, terminal);
      yield { type: "status.changed", status: terminal };
    } finally {
      this.#cancelPendingApprovals(session.id, "Claude turn ended");
      if (!events.ended) {
        // The consumer stopped early; stop the backend turn as well.
        abort.abort();
      }
      resolveFinished();
      this.#activeTurns.delete(session.id);
      const current = this.#statuses.get(session.id);
      if (current === "running" || current === "waiting_for_approval") {
        this.#statuses.set(session.id, "idle");
      }
    }
  }

  async interrupt(session: AdapterSession): Promise<void> {
    const active = this.#activeTurns.get(session.id);
    if (active !== undefined) this.#statuses.set(session.id, "interrupted");
    this.#cancelPendingApprovals(session.id, "Interrupted from Slack");
    if (active === undefined) return;
    try {
      await active.query.interrupt();
    } catch {
      active.abort.abort();
    }
  }

  async approve(session: AdapterSession, approval: AgentApproval): Promise<void> {
    const pending = this.#pendingApprovals.get(approval.requestId);
    if (pending === undefined || pending.sessionId !== session.id) {
      throw new CoreError(
        "UNKNOWN_APPROVAL_REQUEST",
        "This Claude approval request is no longer pending",
      );
    }
    if (!pending.availableDecisions.includes(approval.decision)) {
      throw new CoreError(
        "PERMISSION_DENIED",
        `This decision is not available for the Claude approval request: ${approval.decision}`,
      );
    }
    this.#pendingApprovals.delete(approval.requestId);
    clearTimeout(pending.timer);
    pending.settle(permissionResultFor(approval.decision, pending));
  }

  async status(session: AdapterSession): Promise<AgentStatus> {
    return this.#statuses.get(session.id) ?? "idle";
  }

  shutdown(): void {
    this.#shutdown = true;
    for (const sessionId of [...this.#activeTurns.keys()]) {
      this.#cancelPendingApprovals(sessionId, "ShowTalk Gateway is shutting down");
      this.#activeTurns.get(sessionId)?.abort.abort();
    }
  }

  #queryOptions(
    sessionId: string,
    context: ClaudeSessionContext,
    abort: AbortController,
    events: EventQueue<AgentEvent>,
  ): ClaudeQueryOptions {
    const workspacePath = getWorkspacePath(context.agent);
    const effort = normalizeEffort(this.#reasoningEffort);
    // Gateway MCP tools are allowed in canUseTool rather than by a bare
    // allow rule, so the SDK never shadows the permission callback.
    const allowedTools = [...(this.#options.allowedTools ?? [])];
    const options: ClaudeQueryOptions = {
      abortController: abort,
      ...(context.started ? { resume: sessionId } : { sessionId }),
      ...(workspacePath === undefined ? {} : { cwd: workspacePath }),
      ...(this.#model === undefined || this.#model === "default"
        ? {}
        : { model: this.#model }),
      ...(effort === undefined ? {} : { effort }),
      ...(this.#options.maxTurns === undefined
        ? {}
        : { maxTurns: this.#options.maxTurns }),
      ...(this.#options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.#options.pathToClaudeCodeExecutable }),
      ...(this.#options.env === undefined ? {} : { env: { ...this.#options.env } }),
      ...(this.#options.onStderr === undefined
        ? {}
        : { stderr: this.#options.onStderr }),
      permissionMode: this.#options.permissionMode ?? "default",
      settingSources: [...(this.#options.settingSources ?? ["user", "project", "local"])],
      allowedTools,
      disallowedTools: [...CLAUDE_DISALLOWED_TOOLS],
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: claudeShowTalkInstructions(context.agent),
      },
      ...(this.#options.mcp === undefined
        ? {}
        : {
            mcpServers: {
              [CLAUDE_SHOWTALK_MCP_SERVER]: {
                type: "http",
                url: this.#options.mcp.url,
                headers: {
                  Authorization: `Bearer \${${this.#options.mcp.bearerTokenEnvVar}}`,
                },
              },
            },
          }),
      canUseTool: this.#canUseTool(sessionId, events),
    };
    return options;
  }

  #canUseTool(sessionId: string, events: EventQueue<AgentEvent>): CanUseTool {
    return async (toolName, input, callbackOptions) => {
      if (toolName.startsWith(`mcp__${CLAUDE_SHOWTALK_MCP_SERVER}__`)) {
        // The Gateway MCP endpoint enforces its own permission policy.
        return { behavior: "allow", updatedInput: input };
      }
      if ((CLAUDE_DISALLOWED_TOOLS as readonly string[]).includes(toolName)) {
        return {
          behavior: "deny",
          message:
            "Ask the question in your reply text. The human answers in the Slack thread.",
        };
      }
      if (callbackOptions.signal.aborted) {
        return { behavior: "deny", message: "The Claude turn was aborted" };
      }
      const requestId = `claude:${randomUUID()}`;
      const timeoutMs = this.#options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
      const expiresAt = this.#now() + timeoutMs;
      const suggestions = callbackOptions.suggestions ?? [];
      const availableDecisions: readonly AgentApproval["decision"][] =
        suggestions.length > 0
          ? ["allow_once", "allow_session", "deny", "cancel"]
          : ["allow_once", "deny", "cancel"];
      const decision = new Promise<PermissionResult>((resolve) => {
        const timer = setTimeout(() => {
          if (!this.#pendingApprovals.delete(requestId)) return;
          events.push({
            type: "error",
            code: "APPROVAL_EXPIRED",
            message: "Approval request expired and was cancelled",
          });
          resolve({
            behavior: "deny",
            message: "The Slack approval request expired.",
            interrupt: true,
          });
        }, timeoutMs);
        timer.unref();
        this.#pendingApprovals.set(requestId, {
          sessionId,
          suggestions,
          availableDecisions,
          input,
          settle: resolve,
          timer,
        });
        callbackOptions.signal.addEventListener(
          "abort",
          () => {
            const pending = this.#pendingApprovals.get(requestId);
            if (pending === undefined) return;
            this.#pendingApprovals.delete(requestId);
            clearTimeout(pending.timer);
            resolve({ behavior: "deny", message: "The Claude turn was aborted" });
          },
          { once: true },
        );
      });
      this.#setStatus(sessionId, "waiting_for_approval", events);
      events.push({
        type: "approval.requested",
        requestId,
        expiresAt: new Date(expiresAt).toISOString(),
        summary: approvalSummary(toolName, input, callbackOptions),
        details: toJsonValue({
          toolName,
          input: truncateJson(input),
          ...(callbackOptions.blockedPath === undefined
            ? {}
            : { blockedPath: callbackOptions.blockedPath }),
          ...(callbackOptions.decisionReason === undefined
            ? {}
            : { decisionReason: callbackOptions.decisionReason }),
        }),
        availableDecisions,
      });
      const result = await decision;
      if (
        this.#activeTurns.has(sessionId) &&
        !callbackOptions.signal.aborted &&
        this.#statuses.get(sessionId) === "waiting_for_approval"
      ) {
        this.#setStatus(sessionId, "running", events);
      }
      return result;
    };
  }

  #setStatus(
    sessionId: string,
    status: AgentStatus,
    events: EventQueue<AgentEvent>,
  ): void {
    this.#statuses.set(sessionId, status);
    events.push({ type: "status.changed", status });
  }

  #cancelPendingApprovals(sessionId: string, message: string): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.sessionId !== sessionId) continue;
      this.#pendingApprovals.delete(requestId);
      clearTimeout(pending.timer);
      pending.settle({ behavior: "deny", message, interrupt: true });
    }
  }

  #assertRunning(): void {
    if (this.#shutdown) {
      throw new CoreError(
        "ADAPTER_CAPABILITY_UNAVAILABLE",
        "Claude adapter is shutting down",
      );
    }
  }
}

/** Converts one Agent SDK message into zero or more ShowTalk core events. */
export function normalizeClaudeMessage(
  message: SDKMessage,
  toolNames: Map<string, string> = new Map(),
): AgentEvent[] {
  switch (message.type) {
    case "stream_event": {
      if (message.parent_tool_use_id !== null) return [];
      const event = message.event as {
        readonly type?: string;
        readonly delta?: { readonly type?: string; readonly text?: unknown };
      };
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string" &&
        event.delta.text.length > 0
      ) {
        return [{ type: "message.delta", text: event.delta.text }];
      }
      return [];
    }
    case "assistant": {
      if (message.parent_tool_use_id !== null) return [];
      const events: AgentEvent[] = [];
      const content = message.message.content as readonly unknown[];
      for (const block of content) {
        const record = asRecord(block);
        if (record === undefined) continue;
        if (record.type === "text" && typeof record.text === "string") {
          if (record.text.trim().length === 0) continue;
          events.push({
            type: "message.completed",
            text: truncateText(record.text, MAX_AGENT_MESSAGE_CHARS),
          });
        } else if (
          (record.type === "tool_use" || record.type === "server_tool_use" ||
            record.type === "mcp_tool_use") &&
          typeof record.id === "string" &&
          typeof record.name === "string"
        ) {
          toolNames.set(record.id, record.name);
          events.push({
            type: "tool.started",
            toolCallId: record.id,
            name: record.name,
            input: toJsonValue(truncateJson(record.input)),
          });
        }
      }
      if (message.error !== undefined) {
        events.push({
          type: "error",
          code: "CLAUDE_ASSISTANT_ERROR",
          message: sanitizeClaudeDiagnostic(
            `Claude Code reported an error: ${String(message.error)}`,
          ),
          retryable: true,
        });
      }
      return events;
    }
    case "user": {
      if (message.parent_tool_use_id !== null) return [];
      const content = message.message.content;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const block of content as readonly unknown[]) {
        const record = asRecord(block);
        if (
          record?.type !== "tool_result" ||
          typeof record.tool_use_id !== "string"
        ) {
          continue;
        }
        events.push({
          type: "tool.completed",
          toolCallId: record.tool_use_id,
          output: toolResultText(record.content),
          ...(record.is_error === true ? { isError: true } : {}),
        });
      }
      return events;
    }
    case "result": {
      if (message.subtype === "success" && !message.is_error) return [];
      const detail =
        message.subtype === "success"
          ? message.result
          : "errors" in message && Array.isArray(message.errors)
            ? message.errors.join("; ")
            : message.subtype;
      return [{
        type: "error",
        code: `CLAUDE_${message.subtype.toUpperCase()}`,
        message: sanitizeClaudeDiagnostic(
          `Claude Code turn failed (${message.subtype})${
            detail ? `: ${detail}` : ""
          }`,
        ),
        retryable: message.subtype !== "error_max_turns",
      }];
    }
    default:
      return [];
  }
}

function permissionResultFor(
  decision: AgentApproval["decision"],
  pending: PendingClaudeApproval,
): PermissionResult {
  switch (decision) {
    case "allow_once":
      return { behavior: "allow", updatedInput: pending.input };
    case "allow_session":
    case "allow_command_rule":
      return {
        behavior: "allow",
        updatedInput: pending.input,
        // Session-scoped grants never persist to settings files.
        updatedPermissions: pending.suggestions.map((suggestion) => ({
          ...suggestion,
          destination: "session",
        })) as PermissionUpdate[],
      };
    case "deny":
      return {
        behavior: "deny",
        message: "The human denied this action in Slack. Do not retry it; ask how to proceed.",
      };
    case "cancel":
      return {
        behavior: "deny",
        message: "The human cancelled this action in Slack.",
        interrupt: true,
      };
  }
}

function approvalSummary(
  toolName: string,
  input: Record<string, unknown>,
  options: { readonly title?: string; readonly blockedPath?: string; readonly decisionReason?: string },
): string {
  const lines: string[] = [];
  lines.push(options.title ?? `Claude wants to use ${toolName}`);
  const command = typeof input.command === "string" ? input.command : undefined;
  const filePath = typeof input.file_path === "string"
    ? input.file_path
    : typeof input.path === "string"
      ? input.path
      : undefined;
  if (command !== undefined) {
    lines.push("```", truncateText(command, 1_500), "```");
  } else if (filePath !== undefined) {
    lines.push(`File: \`${filePath}\``);
  } else {
    const rendered = JSON.stringify(input);
    if (rendered !== undefined && rendered !== "{}") {
      lines.push("```", truncateText(rendered, 1_200), "```");
    }
  }
  if (typeof input.description === "string" && input.description.length > 0) {
    lines.push(truncateText(input.description, 300));
  }
  if (options.blockedPath !== undefined) lines.push(`Blocked path: \`${options.blockedPath}\``);
  if (options.decisionReason !== undefined) {
    lines.push(`Reason: ${truncateText(options.decisionReason, 300)}`);
  }
  return truncateText(lines.join("\n"), MAX_SUMMARY_CHARS);
}

const CLAUDE_SLACK_INSTRUCTIONS = [
  "# ShowTalk Taishi Slack Koe",
  "You are a persistent Koe operated from a Slack channel through ShowTalk Taishi. Your final reply text is posted to the Slack thread.",
  "Keep replies concise and Slack-friendly. When you need a decision from the human, ask in your reply text and end the turn; the next Slack message continues this same session.",
  "Tool calls that need permission are shown to the human as Slack approval cards. A denial is final for this turn: do not retry the same action, explain what you need instead.",
  "A local Markdown link or filesystem path is not an attachment. To deliver an image, audio file, or other artifact, create or locate it inside the Koe workspace and call the showtalk_taishi slack.reply tool with attachments, omitting channel and thread_ts so it binds to the originating thread. Do not claim an artifact was attached unless slack.reply succeeds.",
  "ShowTalk Koe consultation rules:",
  "- agent.send (showtalk_taishi MCP) starts a visible conversation with another persistent Koe in another Slack channel. It is not one of your internal subagents (Task/Agent tool).",
  "- Use agent.send only for targets explicitly listed in this Koe's configured consultations and only for work inside that target's stated scope. Never pick a Koe because it is idle or listed by agent.list.",
  "- The ShowTalk workspace-git Slack approval flow is not available to Claude Koe. Do not attempt to bypass it; Git publication commands go through ordinary tool approvals.",
].join("\n");

export function claudeShowTalkInstructions(agent: AgentDefinition): string {
  const role = agent.role?.trim();
  const persona = agent.slackPersona?.trim();
  return [
    ...(role === undefined || role.length === 0 ? [] : [`# Koe role\n${role}`]),
    CLAUDE_SLACK_INSTRUCTIONS,
    ...(persona === undefined || persona.length === 0
      ? []
      : [[
          "# ShowTalk Slack persona",
          "It may shape viewpoint, tone, evaluation criteria, and approach, but it never expands tool permissions, approval authority, or configured Koe consultation scopes.",
          "",
          persona,
        ].join("\n")]),
  ].join("\n\n");
}

async function buildUserMessage(
  sessionId: string,
  request: SendMessageRequest,
): Promise<SDKUserMessage> {
  const attachments = request.attachments ?? [];
  const audio = attachments.filter((attachment) => attachment.kind === "audio");
  const images = attachments.filter((attachment) => attachment.kind === "image");
  const unsupportedImages = images.filter(
    (image) => !SUPPORTED_IMAGE_TYPES.has(image.mimeType),
  );
  let text = request.text;
  if (request.source.type === "agent") {
    text =
      `[ShowTalk Koe consultation from ${request.source.agentId} ` +
      `(delegation ${request.source.delegationId}, depth ${request.source.depth})]\n\n${text}`;
  }
  const localFiles = [...audio, ...unsupportedImages];
  if (localFiles.length > 0) {
    text +=
      "\n\nSlack attachments were saved as local files. Use available local tools to inspect them, and say clearly if that is unavailable.\n" +
      localFiles
        .map((attachment) =>
          JSON.stringify({
            name: attachment.name,
            mimeType: attachment.mimeType,
            size: attachment.size,
            path: attachment.path,
          }),
        )
        .join("\n");
  }
  const imageBlocks = await Promise.all(
    images
      .filter((image) => SUPPORTED_IMAGE_TYPES.has(image.mimeType))
      .map(async (image) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: image.mimeType as "image/png",
          data: (await readFile(image.path)).toString("base64"),
        },
      })),
  );
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content:
        imageBlocks.length === 0
          ? text
          : [{ type: "text", text }, ...imageBlocks],
    },
  } as SDKUserMessage;
}

function toolResultText(content: unknown): JsonValue {
  if (typeof content === "string") return truncateText(content, MAX_TOOL_PAYLOAD_CHARS);
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const record = asRecord(part);
        return record?.type === "text" && typeof record.text === "string"
          ? record.text
          : record?.type === undefined
            ? ""
            : `[${String(record.type)}]`;
      })
      .join("\n");
    return truncateText(text, MAX_TOOL_PAYLOAD_CHARS);
  }
  return null;
}

function normalizeEffort(value: string | undefined): ClaudeEffortLevel | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    case "minimal":
      return "low";
    default:
      return undefined;
  }
}

function toAdapterSession(id: string): AdapterSession {
  return { id, state: { claudeSessionId: id } };
}

function getWorkspacePath(agent: AgentDefinition): string | undefined {
  const value = agent.metadata?.workspacePath;
  return typeof value === "string" ? value : undefined;
}

async function validateWorkspace(
  agentId: string,
  workspacePath: string | undefined,
): Promise<void> {
  if (workspacePath === undefined) return;
  try {
    const info = await stat(workspacePath);
    if (!info.isDirectory()) throw new Error("not a directory");
    await access(workspacePath, constants.R_OK | constants.W_OK);
  } catch (error) {
    throw new AgentWorkspaceUnavailableError(agentId, workspacePath, {
      cause: error,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncateText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function truncateJson(value: unknown): unknown {
  let rendered: string | undefined;
  try {
    rendered = JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
  if (rendered === undefined) return null;
  return rendered.length <= MAX_TOOL_PAYLOAD_CHARS
    ? value
    : truncateText(rendered, MAX_TOOL_PAYLOAD_CHARS);
}

function toJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return null;
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  return sanitizeClaudeDiagnostic(`Claude Code failed: ${message}`);
}

function sanitizeClaudeDiagnostic(message: string): string {
  return truncateText(
    message
      .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
      .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/gu, "[redacted Anthropic credential]")
      .replace(/\b(?:xox[a-z]-|xapp-)[A-Za-z0-9_-]{8,}\b/gu, "[redacted Slack credential]")
      .replace(
        /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/gu,
        "[redacted Git credential]",
      ),
    MAX_SUMMARY_CHARS,
  );
}

const defaultClaudeQuery: ClaudeQueryFunction = (params) => {
  // Loaded lazily so Codex-only installations never spawn or import Claude.
  const handle = lazyQuery(params);
  return handle;
};

function lazyQuery(params: Parameters<ClaudeQueryFunction>[0]): ClaudeQueryHandle {
  const loaded = import("@anthropic-ai/claude-agent-sdk").then((sdk) =>
    sdk.query({ prompt: params.prompt, options: params.options })
  );
  return {
    async *[Symbol.asyncIterator]() {
      yield* await loaded;
    },
    async interrupt() {
      return (await loaded).interrupt();
    },
  };
}

const defaultClaudeSessionExists: ClaudeSessionLookup = async (
  sessionId,
  workspacePath,
) => {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const info = await sdk.getSessionInfo(
    sessionId,
    workspacePath === undefined ? undefined : { dir: workspacePath },
  );
  if (info !== undefined) return true;
  // A session without an extractable summary is still resumable; fall back to
  // a project-wide search before declaring it unavailable.
  return (await sdk.getSessionInfo(sessionId)) !== undefined;
};

/** Small single-consumer async queue bridging callbacks to an async iterator. */
class EventQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #waiter: (() => void) | undefined;
  #ended = false;

  get ended(): boolean {
    return this.#ended && this.#items.length === 0;
  }

  push(item: T): void {
    if (this.#ended) return;
    this.#items.push(item);
    this.#wake();
  }

  end(): void {
    this.#ended = true;
    this.#wake();
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }
}
