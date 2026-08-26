export type RpcId = number | string;

export type CodexJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly CodexJsonValue[]
  | { readonly [key: string]: CodexJsonValue };

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccessResponse {
  id: RpcId;
  result: unknown;
}

export interface RpcErrorResponse {
  id: RpcId;
  error: RpcError;
}

export interface InitializeCapabilities {
  readonly experimentalApi: boolean;
  readonly requestAttestation: boolean;
  readonly mcpServerOpenaiFormElicitation?: boolean;
  readonly optOutNotificationMethods?: readonly string[] | null;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;
export type RpcInboundMessage = RpcRequest | RpcNotification | RpcResponse;

export interface CodexThread {
  id: string;
  sessionId?: string;
  name?: string | null;
  ephemeral?: boolean;
  historyMode?: "legacy" | "paginated";
  status?: unknown;
  turns?: CodexTurn[];
}

export interface CodexTurn {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed" | string;
  itemsView?: "notLoaded" | "summary" | "full";
  items?: unknown[];
  error?: unknown;
}

export interface ModelListParams {
  /** Opaque pagination cursor returned by a previous model/list call. */
  cursor?: string | null;
  /** Include models hidden from the default picker. */
  includeHidden?: boolean | null;
  /** Page size represented by an app-server uint32. */
  limit?: number | null;
}

export type CodexModelInputModality = "text" | "image";

export interface CodexModelReasoningEffort {
  readonly reasoningEffort: string;
  readonly description: string;
}

export interface CodexModelUpgradeInfo {
  readonly model: string;
  readonly migrationMarkdown?: string | null;
  readonly modelLink?: string | null;
  readonly upgradeCopy?: string | null;
}

export interface CodexModel {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly hidden: boolean;
  readonly isDefault: boolean;
  readonly defaultReasoningEffort: string;
  readonly supportedReasoningEfforts: readonly CodexModelReasoningEffort[];
  readonly inputModalities?: readonly CodexModelInputModality[];
  readonly supportsPersonality?: boolean;
  readonly upgrade?: string | null;
  readonly upgradeInfo?: CodexModelUpgradeInfo | null;
}

export interface ModelListResponse {
  readonly data: readonly CodexModel[];
  readonly nextCursor?: string | null;
}

export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export interface ThreadStartParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  config?: Readonly<Record<string, CodexJsonValue>>;
  developerInstructions?: string;
  serviceName?: string;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string;
  cwd?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  config?: Readonly<Record<string, CodexJsonValue>>;
  developerInstructions?: string;
  /** Avoid full-history hydration and support paginated Codex App threads. */
  excludeTurns?: boolean;
}

export interface ThreadTurnsListParams {
  readonly cursor?: string | null;
  readonly limit?: number | null;
  readonly sortDirection?: "asc" | "desc" | null;
  readonly itemsView?: "notLoaded" | "summary" | "full" | null;
}

export interface ThreadTurnsListResponse {
  readonly data: readonly CodexTurn[];
  readonly nextCursor: string | null;
  readonly backwardsCursor: string | null;
}

export interface TurnStartParams {
  threadId: string;
  /** Correlates this client-owned turn before the turn/start response arrives. */
  clientUserMessageId?: string | null;
  input: CodexUserInput[];
  /** Per-turn client context. Unlike thread settings, this is not sticky. */
  additionalContext?: Readonly<Record<string, CodexAdditionalContextEntry>>;
  cwd?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  approvalsReviewer?: ApprovalsReviewer;
  model?: string;
  effort?: string;
}

export interface CodexAdditionalContextEntry {
  readonly value: string;
  readonly kind: "untrusted" | "application";
}

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export interface CommandApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  environmentId: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: unknown[] | null;
  /** Ordered choices the App Server allows this client to present. */
  availableDecisions?: readonly unknown[] | null;
}

export interface FileChangeApprovalRequest {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export interface PermissionsApprovalResponse {
  readonly permissions: Readonly<Record<string, CodexJsonValue>>;
  readonly scope: "turn" | "session";
}

export interface ToolRequestUserInputOption {
  readonly label: string;
  readonly description: string;
}

export interface ToolRequestUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  /** App Server defaults this to false when omitted on the wire. */
  readonly isOther?: boolean;
  /** App Server defaults this to false when omitted on the wire. */
  readonly isSecret?: boolean;
  readonly options?: readonly ToolRequestUserInputOption[] | null;
}

export interface ToolRequestUserInputParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly questions: readonly ToolRequestUserInputQuestion[];
  readonly isBlocking: boolean;
  /** Experimental schema permits omission and treats it the same as null. */
  readonly autoResolutionMs?: number | null;
}

export interface ToolRequestUserInputResponse {
  readonly answers: Readonly<
    Record<string, { readonly answers: readonly string[] }>
  >;
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export class CodexProtocolError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CodexProtocolError";
  }
}
