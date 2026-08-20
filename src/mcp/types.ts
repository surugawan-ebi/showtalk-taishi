export type MaybePromise<T> = T | Promise<T>;

/** Identity established by the HTTP bearer credential, never by tool input. */
export interface McpCallerContext {
  readonly agentId: string;
  readonly signal: AbortSignal;
  /** Host transport identity; this is never accepted from tool arguments. */
  readonly requestId: string;
}

export interface McpAgentSummary {
  readonly id: string;
  readonly call_name?: string;
  readonly adapter?: string;
  readonly channel?: string;
  readonly status?: string;
  readonly consultation_scope?: string;
}

export interface McpAgentListResult {
  readonly agents: readonly McpAgentSummary[];
}

export interface McpAgentStatusResult {
  readonly agent_id: string;
  readonly status: string;
  readonly session_id?: string;
}

export interface McpAgentSendResult {
  readonly target: string;
  readonly status: string;
  readonly message?: string;
  readonly delegation_id?: string;
}

export interface McpGatewayRestartResult {
  readonly status: "scheduled";
}

export interface McpSlackAttachmentInput {
  readonly path: string;
  readonly title?: string;
  readonly alt_text?: string;
}

export interface McpSlackWriteResult {
  readonly channel: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly file_ids?: readonly string[];
}

/**
 * Adapter-neutral application boundary used by the MCP transport.
 *
 * Implementations are responsible for routing, permission checks, and Slack
 * activity projection. The authenticated caller is always supplied separately
 * from model-controlled tool arguments.
 */
export interface SwitchboardMcpService {
  isKnownAgent(agentId: string): MaybePromise<boolean>;
  agentList(context: McpCallerContext): MaybePromise<McpAgentListResult>;
  agentStatus(
    context: McpCallerContext,
    target: string,
  ): MaybePromise<McpAgentStatusResult>;
  agentSend(
    context: McpCallerContext,
    target: string,
    message: string,
  ): MaybePromise<McpAgentSendResult>;
  gatewayRestart(
    context: McpCallerContext,
  ): MaybePromise<McpGatewayRestartResult>;
  slackPost(
    context: McpCallerContext,
    channel: string,
    message?: string,
    attachments?: readonly McpSlackAttachmentInput[],
  ): MaybePromise<McpSlackWriteResult>;
  slackReply(
    context: McpCallerContext,
    channel: string,
    threadTs: string,
    message?: string,
    attachments?: readonly McpSlackAttachmentInput[],
  ): MaybePromise<McpSlackWriteResult>;
}

/** A deliberately public, bounded error that may be returned to an Agent. */
export class McpServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpServiceError";
    this.code = code;
  }
}

export interface AgentMcpCredential {
  readonly agentId: string;
  readonly url: string;
  readonly token: string;
}

export interface McpHttpEndpoint {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly path: string;
  readonly url: string;
}
