import type {
  AdapterSession,
  AgentApproval,
  AgentCapabilities,
  AgentDefinition,
  AgentEvent,
  AgentStatus,
  AgentUserInputResponse,
  JsonValue,
} from "./types.js";

export interface CreateSessionRequest {
  readonly agent: AgentDefinition;
  readonly reason: "slack_conversation" | "delegation" | "manual";
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ResumeSessionRequest {
  readonly agent: AgentDefinition;
  readonly adapterSessionId: string;
  readonly state?: Readonly<Record<string, JsonValue>>;
}

export interface AgentInputAttachment {
  readonly kind: "image" | "audio";
  readonly path: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

export interface SendMessageRequest {
  readonly text: string;
  readonly attachments?: readonly AgentInputAttachment[];
  /** Internal deadline after which a queued continuation must not start. */
  readonly startNotAfterMs?: number;
  readonly source:
    | { readonly type: "human"; readonly slackUserId?: string }
    | {
        readonly type: "agent";
        readonly agentId: string;
        readonly delegationId: string;
        readonly depth: number;
      };
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

/**
 * The core contract implemented by Codex, Claude Code, Gemini CLI, and future
 * adapters. Optional operations are advertised by capabilities.
 */
export interface AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities;

  createSession(request: CreateSessionRequest): Promise<AdapterSession>;
  resumeSession?(request: ResumeSessionRequest): Promise<AdapterSession>;
  sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent>;
  interrupt?(session: AdapterSession): Promise<void>;
  approve?(session: AdapterSession, approval: AgentApproval): Promise<void>;
  respondToUserInput?(
    session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void>;
  status?(session: AdapterSession): Promise<AgentStatus>;
}
