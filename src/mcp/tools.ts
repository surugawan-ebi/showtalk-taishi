import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import {
  agentListInputSchema,
  agentListOutputSchema,
  agentSendInputSchema,
  agentSendOutputSchema,
  agentStatusInputSchema,
  agentStatusOutputSchema,
  appOpsPreToolUseInputSchema,
  appOpsPreToolUseOutputSchema,
  gatewayRestartInputSchema,
  gatewayRestartOutputSchema,
  publicErrorCodeSchema,
  publicErrorMessageSchema,
  slackPostInputSchema,
  slackReplyInputSchema,
  slackWriteOutputSchema,
} from "./schemas.js";
import {
  McpServiceError,
  type McpCallerContext,
  type McpAppOpsPreToolUseResult,
  type McpSlackAttachmentInput,
  type SwitchboardMcpService,
} from "./types.js";

export const MCP_SERVER_INSTRUCTIONS =
  "Taishi is the Slack App and switchboard; a Koe (voice) is the persistent AI conversation assigned to one channel. " +
  "Stable internal tool names retain the agent.* prefix. agent.send visits another Koe directly through the ShowTalk Taishi Gateway. " +
  "agent.send is not a Codex internal subagent tool and must never be used to satisfy AGENTS.md subagent-delegation rules. " +
  "agent.list returns each configured target's canonical ID and optional operator-facing call_name. Use agent.send only for a returned ID or exact call_name and only within its consultation_scope; never infer an unlisted name or select an unrelated Koe because it is idle. " +
  "For a user-requested sequence, delegate one bounded step at a time and continue from each result; delayed results resume the original request, while review/fix retries must be bounded. " +
  "Slack makes the channel visit visible but is never the Koe-to-Koe transport. " +
  "Git approval UI belongs to the Koe that prepared the operation and its originating Slack turn; never use agent.send or Slack write tools to relay, recreate, or move an approval to another Koe or channel. " +
  "slack.post and slack.reply can upload workspace-relative images and audio files from the authenticated Koe's workspace. " +
  "When the current Slack user asks to receive a screenshot or other workspace file, use slack.reply with attachments and omit channel and thread_ts so the Gateway binds the upload to the current originating thread. " +
  "That explicit artifact request authorizes an attachment-only call bound to the originating thread, so omit message too and do not request a separate attachment approval. " +
  "gateway.restart is the only safe way to restart the Gateway; never use kill or signal commands, and call it only when a human explicitly requests a restart. " +
  "The authenticated caller identity is bound by the server and must never be supplied as a tool argument.";

export interface CreateAgentMcpServerOptions {
  readonly name?: string;
  readonly version?: string;
  readonly deferUntilResponseFinished?: (effect: () => void) => void;
}

/** Builds one request-local MCP server with caller identity fixed in its closure. */
export function createAgentMcpServer(
  service: SwitchboardMcpService,
  callerAgentId: string,
  options: CreateAgentMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    {
      name: options.name ?? "showtalk-taishi",
      version: options.version ?? "0.0.1",
    },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "agent.list",
    {
      title: "List Koe",
      description:
        "List only Koe configured as consultation targets for the authenticated caller, including each operator-facing call name and allowed consultation scope.",
      inputSchema: agentListInputSchema,
      outputSchema: agentListOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_input, extra) =>
      executeTool(agentListOutputSchema, () =>
        service.agentList(
          context(
            callerAgentId,
            extra.signal,
            "agent.list",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
        ),
      ),
  );

  server.registerTool(
    "agent.status",
    {
      title: "Get Koe Status",
      description: "Get the current status of one Koe.",
      inputSchema: agentStatusInputSchema,
      outputSchema: agentStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target }, extra) =>
      executeTool(agentStatusOutputSchema, () =>
        service.agentStatus(
          context(
            callerAgentId,
            extra.signal,
            "agent.status",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
          target,
        ),
      ),
  );

  server.registerTool(
    "agent.send",
    {
      title: "Talk to Another Koe",
      description:
        "Talk directly to a configured consultation target through the Gateway using its canonical ID or exact call_name from agent.list. This creates a visible visit to another persistent Koe and Slack channel; it is not a Codex internal subagent. The request must stay within consultation_scope. Never infer an unlisted name. Never use this tool to display, relay, approve, or reconstruct a Git approval owned by the caller Koe.",
      inputSchema: agentSendInputSchema,
      outputSchema: agentSendOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ target, message }, extra) =>
      executeTool(agentSendOutputSchema, () =>
        service.agentSend(
          context(
            callerAgentId,
            extra.signal,
            "agent.send",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
          target,
          message,
        ),
      ),
  );

  server.registerTool(
    "gateway.restart",
    {
      title: "Restart Gateway Worker",
      description:
        "The only safe way to restart the Gateway. Never use kill or signal commands. Use only when a human explicitly requests a restart.",
      inputSchema: gatewayRestartInputSchema,
      outputSchema: gatewayRestartOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_input, extra) =>
      executeTool(gatewayRestartOutputSchema, () =>
        service.gatewayRestart(
          context(
            callerAgentId,
            extra.signal,
            "gateway.restart",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
        ),
      ),
  );

  server.registerTool(
    "internal.appops-pre-tool-use",
    {
      title: "Bind AppOps Approval Proof",
      description:
        "Internal Codex PreToolUse hook endpoint. Do not call directly. It atomically binds one same-turn approved AppOps proof to the matching execute arguments or denies the call.",
      inputSchema: appOpsPreToolUseInputSchema,
      outputSchema: appOpsPreToolUseOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, extra) =>
      executeAppOpsPreToolUseHook(() =>
        service.appOpsPreToolUse(
          context(
            callerAgentId,
            extra.signal,
            "internal.appops-pre-tool-use",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
          input,
        ),
      ),
  );

  server.registerTool(
    "slack.post",
    {
      title: "Post to Slack",
      description:
        "Post a message and/or upload workspace-relative image or audio files through the Gateway permission boundary.",
      inputSchema: slackPostInputSchema,
      outputSchema: slackWriteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ channel, message, attachments }, extra) =>
      executeTool(slackWriteOutputSchema, () =>
        service.slackPost(
          context(
            callerAgentId,
            extra.signal,
            "slack.post",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
          channel,
          message,
          normalizeSlackAttachments(attachments),
        ),
      ),
  );

  server.registerTool(
    "slack.reply",
    {
      title: "Reply in Slack",
      description:
        "Reply in a Slack thread with a message and/or workspace-relative image or audio files through the Gateway permission boundary. Omit channel and thread_ts to bind the reply to the current originating Slack thread.",
      inputSchema: slackReplyInputSchema,
      outputSchema: slackWriteOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ channel, thread_ts: threadTs, message, attachments }, extra) =>
      executeTool(slackWriteOutputSchema, () =>
        service.slackReply(
          context(
            callerAgentId,
            extra.signal,
            "slack.reply",
            extra.requestId,
            options.deferUntilResponseFinished,
          ),
          channel,
          threadTs,
          message,
          normalizeSlackAttachments(attachments),
        ),
      ),
  );

  return server;
}

function normalizeSlackAttachments(
  attachments:
    | readonly {
        path: string;
        title?: string | undefined;
        alt_text?: string | undefined;
      }[]
    | undefined,
): readonly McpSlackAttachmentInput[] | undefined {
  return attachments?.map((attachment) => ({
    path: attachment.path,
    ...(attachment.title === undefined ? {} : { title: attachment.title }),
    ...(attachment.alt_text === undefined ? {} : { alt_text: attachment.alt_text }),
  }));
}

function context(
  agentId: string,
  signal: AbortSignal,
  operation: string,
  requestId: string | number,
  deferUntilResponseFinished?: (effect: () => void) => void,
): McpCallerContext {
  return Object.freeze({
    agentId,
    signal,
    requestId: `${operation}:${typeof requestId}:${String(requestId)}`,
    ...(deferUntilResponseFinished === undefined
      ? {}
      : { deferUntilResponseFinished }),
  });
}

async function executeTool<T extends Record<string, unknown>>(
  outputSchema: z.ZodType<T>,
  operation: () => unknown | Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const output = outputSchema.safeParse(await operation());
    if (!output.success) return toolError("SERVICE_RESULT_INVALID", "The service returned an invalid result");
    return {
      content: [{ type: "text", text: JSON.stringify(output.data) }],
      structuredContent: output.data,
    };
  } catch (error) {
    if (error instanceof McpServiceError) {
      const code = publicErrorCodeSchema.safeParse(error.code);
      const message = publicErrorMessageSchema.safeParse(error.message);
      if (code.success && message.success) return toolError(code.data, message.data);
    }
    return toolError("SERVICE_ERROR", "The switchboard service could not complete the request");
  }
}

function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

async function executeAppOpsPreToolUseHook(
  operation: () => McpAppOpsPreToolUseResult | Promise<McpAppOpsPreToolUseResult>,
): Promise<CallToolResult> {
  let result: McpAppOpsPreToolUseResult;
  try {
    const parsed = appOpsPreToolUseOutputSchema.safeParse(await operation());
    result = parsed.success
      ? parsed.data
      : appOpsHookDenial("The AppOps hook returned an invalid decision");
  } catch {
    result = appOpsHookDenial("The AppOps approval proof handoff failed closed");
  }
  // Keep the proof out of ordinary MCP text content. Codex's MCP-hook path
  // consumes structuredContent as the hook result.
  return { content: [], structuredContent: result };
}

function appOpsHookDenial(reason: string): McpAppOpsPreToolUseResult {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
