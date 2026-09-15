export type CoreErrorCode =
  | "AGENT_ALREADY_REGISTERED"
  | "AGENT_ADDRESS_ALREADY_REGISTERED"
  | "CHANNEL_ALREADY_REGISTERED"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_CHANNEL"
  | "SESSION_ALREADY_REGISTERED"
  | "UNKNOWN_SESSION"
  | "SESSION_AGENT_MISMATCH"
  | "CONVERSATION_ALREADY_BOUND"
  | "UNKNOWN_CONVERSATION"
  | "SESSION_ALREADY_BOUND"
  | "ADAPTER_NOT_REGISTERED"
  | "ADAPTER_CAPABILITY_UNAVAILABLE"
  | "ADAPTER_KIND_MISMATCH"
  | "INVALID_ADAPTER_SESSION"
  | "SELF_DELEGATION_DENIED"
  | "INVALID_DELEGATION_DEPTH"
  | "DELEGATION_DEPTH_EXCEEDED"
  | "DELEGATION_CONTINUATION_ALREADY_USED"
  | "DELEGATION_RESULT_ALREADY_HANDLED"
  | "AGENT_BUSY"
  | "CONVERSATION_BUSY"
  | "PERMISSION_DENIED"
  | "PERMISSION_APPROVAL_REQUIRED"
  | "UNKNOWN_APPROVAL_REQUEST"
  | "REQUEST_CANCELLED"
  | "INVALID_STATE_SNAPSHOT";

export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoreError";
    this.code = code;
  }
}

/** The adapter's durable backend session no longer exists and cannot be resumed. */
export class AdapterSessionUnavailableError extends Error {
  readonly adapterSessionId: string;

  constructor(adapterSessionId: string, options?: ErrorOptions) {
    super(`Adapter session ${adapterSessionId} is unavailable`, options);
    this.name = "AdapterSessionUnavailableError";
    this.adapterSessionId = adapterSessionId;
  }
}

/** The operator-configured project workspace is missing or inaccessible. */
export class AgentWorkspaceUnavailableError extends Error {
  readonly agentId: string;
  readonly workspacePath: string;

  constructor(agentId: string, workspacePath: string, options?: ErrorOptions) {
    super(`Koe ${agentId} workspace is unavailable: ${workspacePath}`, options);
    this.name = "AgentWorkspaceUnavailableError";
    this.agentId = agentId;
    this.workspacePath = workspacePath;
  }
}
