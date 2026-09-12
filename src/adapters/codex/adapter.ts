import { randomUUID } from "node:crypto";
import { access, constants, stat } from "node:fs/promises";

import {
  AgentWorkspaceUnavailableError,
  AdapterSessionUnavailableError,
  CoreError,
} from "../../core/errors.js";
import type {
  AdapterSession,
  AgentAdapter,
  AgentApproval,
  AgentCapabilities,
  AgentChoiceAnswer,
  AgentDefinition,
  AgentEvent,
  AgentGitApprovalInputResponse,
  AgentStatus,
  AgentUserInputResponse,
  CreateSessionRequest,
  JsonValue,
  ResumeSessionRequest,
  SendMessageRequest,
} from "../../core/index.js";
import {
  CodexRpcError,
  type ApprovalsReviewer,
  type CodexAdditionalContextEntry,
  type CodexThread,
  type CodexTurn,
  type CommandApprovalDecision,
  type FileChangeApprovalDecision,
  type McpServerElicitationResponse,
  type ModelListParams,
  type ModelListResponse,
  type PermissionsApprovalResponse,
  type RpcError,
  type RpcId,
  type ToolRequestUserInputResponse,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadTurnsListParams,
  type ThreadTurnsListResponse,
  type TurnStartParams,
} from "./protocol.js";
import type { ServerRequestEvent } from "./app-server-client.js";
import { CodexModelCatalog } from "./model-catalog.js";
import {
  normalizeAppOpsPrepareCompletion,
  type AppOpsApprovalPlanCapture,
} from "./appops-approval.js";
import type {
  AppOpsApprovalProofBroker,
  AppOpsApprovalProofPlan,
  AppOpsApprovalProofSigner,
} from "../../approvals/appops-approval-proof.js";
import {
  normalizeWorkspaceGitPrepareCompletion,
  toolRequestUserInputParams,
  validateWorkspaceGitPlanQuestion,
} from "./workspace-git-approval.js";
import {
  hasFullTurnItems,
  sameExactWorkspaceGitApprovalPlan,
  WorkspaceGitApprovalLifecycle,
} from "./workspace-git-approval-lifecycle.js";
import {
  MAX_CODEX_GENERATED_IMAGE_FILES,
  MAX_CODEX_GENERATED_IMAGE_TOTAL_BYTES,
  normalizeCodexDynamicToolImageCompletions,
  normalizeCodexImageGenerationCompletion,
} from "./image-generation.js";
import type { WorkspaceGitApprovalPlan } from "../../core/index.js";
import {
  hasExternalActionApprovalQuestionId,
  hasWorkspaceGitApprovalQuestionId,
  looksLikeWorkspaceGitApproval,
  validateOrdinaryChoiceRequest,
  type ValidatedChoiceQuestion,
} from "./structured-input.js";
import {
  WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION,
  WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4,
  validateWorkspaceGitAutomationResult,
  validateWorkspaceGitAutomationResultV4,
  type WorkspaceGitAutomationContext,
  type WorkspaceGitAutomationContextV4,
  type WorkspaceGitAutomationInput,
  type WorkspaceGitAutomationInputV4,
  type WorkspaceGitAutomationProviderAny,
  type WorkspaceGitPreparedPlan,
} from "../../approvals/workspace-git-automation-provider.js";

const MAX_AGENT_MESSAGE_CHARS = 128_000;
const MAX_EVENT_JSON_CHARS = 64_000;
const MAX_QUEUED_EVENTS = 256;
const MAX_QUEUED_DELTA_CHARS = 128_000;
const MAX_COALESCED_DELTA_CHARS = 32_000;
const MAX_STRUCTURED_INPUT_ID_LENGTH = 128;
const SHOWTALK_SLACK_PERSONA_CONTEXT_KEY = "showtalk_taishi.slack_persona";
const SHOWTALK_PAGINATED_THREAD_CONTEXT_KEY =
  "showtalk_taishi.paginated_thread_compatibility";
const SHOWTALK_GIT_APPROVAL_CONTINUATION_CONTEXT_KEY =
  "showtalk_taishi.git_approval_continuation";

class AppOpsApprovalBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppOpsApprovalBindingError";
  }
}
const SHOWTALK_SLACK_ARTIFACT_INSTRUCTIONS = [
  "# ShowTalk Slack artifact delivery",
  "A local Markdown link or local filesystem path is not an attachment and cannot be opened by the Slack user.",
  "When the user asks to receive a screenshot, image, audio file, or other supported workspace artifact, create or locate the file inside the configured Koe workspace and call the showtalk_taishi slack.reply tool with attachments.",
  "For the originating Slack thread, omit both channel and thread_ts so the Gateway binds the upload to the exact active turn.",
  "The user's explicit request to receive the artifact authorizes an attachment-only call bound to that originating thread; omit message as well as channel and thread_ts, and do not request a separate attachment approval or call request_user_input for it.",
  "Do not claim that an artifact was attached or reposted unless slack.reply returns success. If upload is unavailable or fails, report that exact failure instead of returning a local Markdown link.",
].join("\n");
const SHOWTALK_INTERACTIVE_EXECUTION_INSTRUCTIONS = [
  "# ShowTalk interactive execution mode",
  "This is an execution turn, not a planning-only turn. Continue to inspect, edit, test, and use available tools as the user's request requires.",
  "The App Server collaboration-mode marker exists so request_user_input can block until Slack returns the bound human answer. It does not prohibit implementation work.",
  "Codex 0.149 may reject update_plan and suppress automatic goal continuation under this internal marker. Track progress in concise commentary instead, and continue an active goal only from an explicit new ShowTalk turn.",
  "Use request_user_input only when it is available and required by the active ShowTalk approval or decision rules.",
  SHOWTALK_SLACK_ARTIFACT_INSTRUCTIONS,
].join("\n\n");
const SHOWTALK_KOE_CONSULTATION_INSTRUCTIONS = [
  "ShowTalk Taishi Koe consultation rules:",
  "- Codex internal subagents run inside the current Codex task. They are not Slack channels or ShowTalk Koe.",
  "- agent.send starts a visible conversation with another persistent Koe assigned to another Slack channel. It is not an internal subagent tool and never satisfies AGENTS.md subagent-delegation requirements.",
  "- Use agent.send only for targets explicitly listed in this Koe's configured consultations and only for work inside that target's stated scope.",
  "- Operator-facing call names returned by agent.list are exact aliases for their Koe IDs. Use them only as listed; never infer a Koe from similar prose.",
  "- For a user-requested sequence across multiple Koe, send one bounded step at a time, continue from each returned result, and stop with a clear blocker if a bounded review/fix cycle does not converge.",
  "- If request_user_input returns `answers: {}`, do not treat it as approval and do not execute the gated action. When `showtalk` is a configured consultation target, immediately use agent.send to ask `showtalk` whether the empty answer is expected for that blocking mode and request a bounded diagnosis and fix when it is not. Include only sanitized context such as whether the call was direct, whether Slack controls appeared, the question ID, and its blocking mode; never send credentials, private approval authority, or hidden plan state. If `showtalk` is unavailable or this Koe is `showtalk`, diagnose locally and report the action as blocked.",
  "- Never choose an unrelated Koe because it is idle, available, or appears in a directory. If no configured consultation matches, continue locally or use Codex internal subagents.",
].join("\n");
const SHOWTALK_GIT_APPROVAL_INSTRUCTIONS = [
  "ShowTalk Taishi Git approval routing rules:",
  "- A Git approval belongs to the Koe that called a workspace-git plan-producing operation (`prepare_*` or `update_repository_main`) and to the Slack thread that started that same turn.",
  "- Call workspace-git plan-producing operations and execute_approved_* only as direct MCP tools. Never invoke them through functions.exec, another dynamic/code-mode wrapper, shell, or a relaying agent: ShowTalk cannot bind nested or model-forwarded output as approval authority.",
  "- When workspace-git returns awaiting_human_approval, immediately call request_user_input in that same turn with question ID `git_approval` and exactly two options named `承認して実行` and `拒否・保留`.",
  "- Keep ordinary decisions flexible: use an ordinary question ID and two or three task-specific options. If that decision selects a non-Git external write, ask a separate final confirmation before executing it.",
  "- For that non-Git final confirmation, call request_user_input as a direct tool call, never from functions.exec, code mode, another dynamic tool, shell, or a relaying agent. Nested request_user_input calls cannot preserve the blocking Slack answer and may return `answers: {}` even after the button is clicked.",
  "- The direct request_user_input call must contain exactly one blocking question whose ID is `external_action_approval` and exactly two options in this order: `承認して実行` (or `承認して実行 (Recommended)` when the client requires its recommended suffix), then `拒否・保留`. Do not otherwise rename or reorder them, or add a third option. The Gateway canonicalizes the optional suffix and returns `承認して実行`. Give both options non-empty descriptions and put the exact details in three separate question lines named `Target:`, `Scope:`, and `Impact:`. A non-blocking request or `answers: {}` is not approval. That answer never approves Git.",
  "- A turn may contain multiple sequential external-action confirmations. Each distinct external write requires its own blocking confirmation with its current Target, Scope, and Impact; an earlier approval never grants blanket authority for later writes. Do not open a second confirmation while another is still awaiting its Slack answer.",
  "- Store release operations do not use AppOps MCP, Store MCP tools, or proof-injection hooks. Present the exact repo-local fastlane command and its target app, platform, working directory, version/build, track, metadata scope, and automatic-release setting in the blocking external-action confirmation, then run only that command after approval.",
  "- If App Server returns `EXTERNAL_ACTION_APPROVAL_RETRY_REQUIRED`, retry request_user_input exactly once in the same turn with that fixed shape. Do not execute the external action unless the corrected structured input returns `承認して実行`.",
  "- If that retry is malformed or App Server returns `EXTERNAL_ACTION_APPROVAL_REPAIR_EXHAUSTED`, stop requesting approval and do not execute the external action in that turn.",
  "- Never use another question ID with either fixed Git approval label. Never redisplay or reconstruct a workspace-git approval as an ordinary structured choice; prepare a fresh exact plan in the current turn first.",
  "- A `承認して実行` answer returned from that exact request_user_input is a fresh authenticated human decision. It is not the assistant approving its own plan, even though App Server resumes the same turn after the human interaction.",
  "- Before the App Server receives `承認して実行`, ShowTalk records the bound human decision through workspace-git's model-inaccessible private broker. Continue the resumed turn instead of ending with prose or deferring execution to another user message. Re-read the exact workspace-git operation status and call the matching execute_approved_* tool exactly once when it is approved and operation ID, full plan hash, approval target, worktree, HEAD/snapshot or PR state, scope, and expiry still match.",
  "- One App Server turn has a pre-approval phase and a post-approval phase separated by the blocking request_user_input. A generic rule that forbids autonomous prepare-and-execute in one turn applies to the pre-approval phase; it does not require another Slack message after the bound human response. The post-approval phase may execute only the exact approved plan.",
  "- If request_user_input returns WORKSPACE_GIT_AUTOMATION_TERMINAL_EXECUTED, a private provider already completed that exact plan. Do not call any public execute tool or retry it; inspect status only if needed and continue reporting the terminal result.",
  "- If request_user_input returns WORKSPACE_GIT_AUTOMATION_BLOCKED, do not retry, switch to manual approval, or use another Git path in that turn. Report the fail-closed reason.",
  "- If the answer is `拒否・保留`, or revalidation is stale, mismatched, expired, rejected, already executed, or inconclusive, do not approve or execute and report the exact blocker.",
  "- Never use agent.send, slack.post, or slack.reply to ask another Koe or channel to display, relay, approve, or reconstruct a Git approval.",
  "- If the exact plan is found unbound, expired, or invalidated by a Gateway restart before request_user_input is called, inspect status and re-run the matching workspace-git plan-producing operation in this Koe's current turn before requesting approval. Never reconstruct authority from IDs or prose.",
  "- get_git_operation_status never binds an approval plan, even when it reports awaiting_human_approval. Only a fresh plan-producing operation completion observed in this same turn can be approved.",
  "- If request_user_input reports REPREPARE_REQUIRED, do not call request_user_input again in that turn. Do not claim that approval is still available. End the turn; Slack may explain how the human can send a new explicit Git request, but must not restart one automatically.",
  "- Never claim that approval controls were displayed unless request_user_input is currently waiting for the human response. If a prepared plan is still awaiting approval, do not finish the turn with prose instead of opening that structured request.",
].join("\n");
const SHOWTALK_TURN_DEVELOPER_INSTRUCTIONS = [
  SHOWTALK_INTERACTIVE_EXECUTION_INSTRUCTIONS,
  SHOWTALK_GIT_APPROVAL_INSTRUCTIONS,
].join("\n\n");

export interface CodexAppServer {
  startThread(params: ThreadStartParams): Promise<CodexThread>;
  resumeThread(params: ThreadResumeParams): Promise<CodexThread>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThread>;
  listThreadTurns(
    threadId: string,
    params?: ThreadTurnsListParams,
  ): Promise<ThreadTurnsListResponse>;
  listModels(params?: ModelListParams): Promise<ModelListResponse>;
  unsubscribeThread(threadId: string): Promise<void>;
  startTurn(params: TurnStartParams): Promise<CodexTurn>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  close(): Promise<void>;
  respondToCommandApproval(id: RpcId, decision: CommandApprovalDecision): void;
  respondToFileChangeApproval(id: RpcId, decision: FileChangeApprovalDecision): void;
  respondToPermissionsApproval(id: RpcId, response: PermissionsApprovalResponse): void;
  respondToUserInput(id: RpcId, response: ToolRequestUserInputResponse): void;
  respondToMcpServerElicitation(id: RpcId, response: McpServerElicitationResponse): void;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onServerRequest(listener: (event: ServerRequestEvent) => void): () => void;
  onProtocolError(listener: (error: Error) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  respondError(id: RpcId, error: RpcError): void;
}

interface PendingApproval {
  readonly rpcId: RpcId;
  readonly method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/permissions/requestApproval"
    | "mcpServer/elicitation/request";
  readonly sessionId: string;
  readonly requestedPermissions?: Readonly<Record<string, JsonValue>>;
  readonly availableDecisions?: readonly AgentApproval["decision"][];
  /** Exact App Server decisions keyed by the protocol-neutral Slack choice. */
  readonly commandDecisions?: ReadonlyMap<
    AgentApproval["decision"],
    CommandApprovalDecision
  >;
  readonly expiresAt: number;
  readonly expirationTimer: NodeJS.Timeout;
}

interface PendingGitUserInput {
  readonly kind: "git_approval";
  readonly rpcId: RpcId;
  readonly sessionId: string;
  readonly turnId: string;
  readonly questionId: string;
  readonly approveLabel: "承認して実行";
  readonly rejectLabel: "拒否・保留";
  readonly plan: WorkspaceGitApprovalPlan;
  readonly expiresAt: number;
  readonly expirationTimer: NodeJS.Timeout;
}

interface PendingChoiceUserInput {
  readonly kind: "choice";
  readonly rpcId: RpcId;
  readonly sessionId: string;
  readonly questions: readonly ValidatedChoiceQuestion[];
  readonly answers: Map<string, readonly string[]>;
  readonly appOpsPlan?: AppOpsApprovalProofPlan;
  readonly appOpsTurnId?: string;
  currentQuestionIndex: number;
  readonly expiresAt: number;
  readonly expirationTimer: NodeJS.Timeout;
}

type PendingUserInput = PendingGitUserInput | PendingChoiceUserInput;

interface ExternallyResolvedGitUserInput {
  readonly sessionId: string;
  readonly plan: WorkspaceGitApprovalPlan;
}

interface PendingUserInputBinding {
  readonly rpcId: RpcId;
  readonly serverRequest: ServerRequestEvent;
  readonly sessionId: string;
  readonly turnId: string;
  readonly queue: AsyncEventQueue;
  readonly receivedAt: number;
  readonly expirationTimer: NodeJS.Timeout;
}

interface ExternallyResolvedUserInputBinding {
  readonly sessionId: string;
  readonly turnId: string;
  readonly queue: AsyncEventQueue;
}

interface PendingExternalGitRejection {
  readonly requestId: string;
  readonly sessionId: string;
  readonly plan: WorkspaceGitApprovalPlan;
  readonly queue: AsyncEventQueue;
}

interface WorkspaceGitAutomationSlackOrigin {
  readonly teamId: string;
  readonly appId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly userId: string;
}

interface PendingWorkspaceGitAutomation {
  readonly sessionId: string;
  readonly rpcId: RpcId;
  readonly turnId: string;
  readonly plan: WorkspaceGitApprovalPlan;
  readonly abortController: AbortController;
}

export interface CodexAdapterOptions {
  kind?: string;
  /** Authenticated runtime Koe identity used only for private provider context. */
  koeId?: string;
  model?: string;
  reasoningEffort?: string;
  automaticChoiceMode?: "off" | "ordinary_top_choice";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  /** Override who reviews approvals; omit to inherit Codex App Server configuration. */
  approvalsReviewer?: ApprovalsReviewer;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalTimeoutMs?: number;
  /** Same-turn transport-ordering grace for requestUserInput before prepare completion. */
  gitPlanBindingGraceMs?: number;
  terminalWatchdogMs?: number;
  /** Maximum consecutive failures to reconcile the exact owned turn. */
  terminalWatchdogMaxRetries?: number;
  ambiguousStartRetryMs?: number;
  externalTurnPollMs?: number;
  externalTurnWaitMs?: number;
  /** Delay between durable external Git rejection write retries. */
  externalGitRejectionRetryMs?: number;
  /** Per-thread Codex config overrides, used to attach the authenticated Taishi MCP. */
  threadConfig?: Readonly<Record<string, JsonValue>>;
  /** Durably rejects a private plan before an external-resolution event is released. */
  recordExternallyResolvedGitPlan?: (
    plan: WorkspaceGitApprovalPlan,
  ) => Promise<void>;
  /** Synchronously invalidates the Slack card when its App Server RPC disappears. */
  onGitUserInputResolvedExternally?: (
    requestId: string,
    sessionId: string,
    plan: WorkspaceGitApprovalPlan,
  ) => void;
  /** Optional opaque provider; manual approval remains the default. */
  workspaceGitAutomationProvider?: WorkspaceGitAutomationProviderAny;
  workspaceGitAutomationRevisions?: {
    readonly koeBindingRevision: number;
    readonly principalPolicyRevision: number;
  };
  /** Issues a short-lived proof only after the bound Slack choice is approved. */
  appOpsApprovalProofSigner?: AppOpsApprovalProofSigner;
  /** One-shot handoff consumed only by Codex's AppOps PreToolUse hook. */
  appOpsApprovalProofBroker?: AppOpsApprovalProofBroker;
}

export interface CodexRuntimeModelSettings {
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

export type CodexAutomaticChoiceMode = "off" | "ordinary_top_choice";

export class CodexAdapter implements AgentAdapter {
  readonly kind: string;
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    approval: true,
    interrupt: true,
    resume: true,
    toolEvents: true,
    structuredInput: true,
    imageInput: true,
    audioFileInput: true,
  };

  readonly #client: CodexAppServer;
  readonly #modelCatalog: CodexModelCatalog;
  readonly #options: {
    model?: string;
    reasoningEffort?: string;
    automaticChoiceMode: CodexAutomaticChoiceMode;
    approvalPolicy?: "untrusted" | "on-request" | "never";
    approvalsReviewer?: ApprovalsReviewer;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approvalTimeoutMs: number;
    gitPlanBindingGraceMs: number;
    terminalWatchdogMs: number;
    terminalWatchdogMaxRetries: number;
    ambiguousStartRetryMs: number;
    externalTurnPollMs: number;
    externalTurnWaitMs: number;
    externalGitRejectionRetryMs: number;
    threadConfig?: Readonly<Record<string, JsonValue>>;
  };
  readonly #activeTurns = new Map<string, string>();
  readonly #runningSessions = new Set<string>();
  readonly #statuses = new Map<string, AgentStatus>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #pendingUserInputs = new Map<string, PendingUserInput>();
  readonly #externallyResolvedGitUserInputs = new Map<
    string,
    ExternallyResolvedGitUserInput
  >();
  readonly #pendingUserInputBindings = new Map<string, PendingUserInputBinding>();
  readonly #externalActionApprovalRepairStates = new Map<
    string,
    "retry_pending" | "closed"
  >();
  readonly #externallyResolvedUserInputBindings = new Map<
    string,
    ExternallyResolvedUserInputBinding
  >();
  readonly #externalResolutionSettlementsBySession = new Map<
    string,
    Promise<void>
  >();
  readonly #pendingExternalGitRejections = new Map<
    string,
    PendingExternalGitRejection
  >();
  readonly #recordExternallyResolvedGitPlan:
    | ((plan: WorkspaceGitApprovalPlan) => Promise<void>)
    | undefined;
  readonly #onGitUserInputResolvedExternally:
    | ((requestId: string, sessionId: string, plan: WorkspaceGitApprovalPlan) => void)
    | undefined;
  readonly #workspaceGitAutomationProvider:
    | WorkspaceGitAutomationProviderAny
    | undefined;
  #workspaceGitAutomationRevisions:
    | {
        readonly koeBindingRevision: number;
        readonly principalPolicyRevision: number;
      }
    | undefined;
  readonly #koeId: string | undefined;
  readonly #workspaceGitAutomationOrigins = new Map<
    string,
    WorkspaceGitAutomationSlackOrigin
  >();
  readonly #pendingWorkspaceGitAutomations = new Map<
    string,
    PendingWorkspaceGitAutomation
  >();
  readonly #workspaceGitApprovals = new WorkspaceGitApprovalLifecycle();
  readonly #activeQueues = new Map<string, AsyncEventQueue>();
  readonly #deferredServerRequestsBySession = new Map<
    string,
    ServerRequestEvent[]
  >();
  readonly #startedItems = new Map<string, Record<string, unknown>>();
  readonly #appOpsPlansByTurn = new Map<string, AppOpsApprovalPlanCapture[]>();
  readonly #appOpsApprovalProofSigner: AppOpsApprovalProofSigner | undefined;
  readonly #appOpsApprovalProofBroker: AppOpsApprovalProofBroker | undefined;
  readonly #loadedSessions = new Set<string>();
  /**
   * App Server ignores resume overrides while a thread is active. These
   * sessions must be cold-resumed once they become idle before a new turn may
   * start, otherwise an old tool surface can survive a Gateway restart.
   */
  readonly #resumeOverridesPendingSessions = new Set<string>();
  readonly #resumeParamsBySession = new Map<string, ThreadResumeParams>();
  readonly #slackPersonasBySession = new Map<string, string>();
  readonly #legacyPaginatedCompatibilitySessions = new Set<string>();
  #turnPaginationSupported: boolean | undefined;
  #transportFailed = false;

  constructor(client: CodexAppServer, options: CodexAdapterOptions = {}) {
    this.#client = client;
    this.#modelCatalog = new CodexModelCatalog(client);
    this.kind = options.kind ?? "codex";
    this.#recordExternallyResolvedGitPlan =
      options.recordExternallyResolvedGitPlan;
    this.#onGitUserInputResolvedExternally =
      options.onGitUserInputResolvedExternally;
    this.#workspaceGitAutomationProvider =
      options.workspaceGitAutomationProvider;
    this.#workspaceGitAutomationRevisions = options.workspaceGitAutomationRevisions;
    this.#koeId = options.koeId;
    this.#appOpsApprovalProofSigner = options.appOpsApprovalProofSigner;
    this.#appOpsApprovalProofBroker = options.appOpsApprovalProofBroker;
    if (
      this.#workspaceGitAutomationProvider !== undefined &&
      this.#workspaceGitAutomationProvider.contract_version !==
        WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION &&
      this.#workspaceGitAutomationProvider.contract_version !==
        WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4
    ) {
      throw new Error("Unsupported workspace-git automation provider contract");
    }
    if (
      this.#workspaceGitAutomationProvider !== undefined &&
      (this.#koeId === undefined ||
        this.#koeId.length < 1 ||
        this.#koeId.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(this.#koeId))
    ) {
      throw new Error("Workspace-git automation requires an authenticated Koe ID");
    }
    if (
      this.#workspaceGitAutomationProvider?.contract_version ===
        WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4 &&
      !validWorkspaceGitAutomationRevisions(this.#workspaceGitAutomationRevisions)
    ) {
      throw new Error("Workspace-git v4 automation requires authenticated revisions");
    }
    this.#options = {
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
      automaticChoiceMode: options.automaticChoiceMode ?? "off",
      ...(options.threadConfig === undefined
        ? {}
        : { threadConfig: structuredClone(options.threadConfig) }),
      ...(options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: options.approvalPolicy }),
      ...(options.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: options.approvalsReviewer }),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      approvalTimeoutMs: options.approvalTimeoutMs ?? 30 * 60 * 1_000,
      gitPlanBindingGraceMs: options.gitPlanBindingGraceMs ?? 2_000,
      terminalWatchdogMs: options.terminalWatchdogMs ?? 5 * 60 * 1_000,
      terminalWatchdogMaxRetries: options.terminalWatchdogMaxRetries ?? 4,
      ambiguousStartRetryMs: options.ambiguousStartRetryMs ?? 100,
      externalTurnPollMs: options.externalTurnPollMs ?? 1_000,
      externalTurnWaitMs: options.externalTurnWaitMs ?? 30 * 60 * 1_000,
      externalGitRejectionRetryMs:
        options.externalGitRejectionRetryMs ?? 1_000,
    };
    if (
      this.#options.approvalTimeoutMs < 1 ||
      this.#options.gitPlanBindingGraceMs < 1 ||
      this.#options.terminalWatchdogMs < 1 ||
      !Number.isSafeInteger(this.#options.terminalWatchdogMaxRetries) ||
      this.#options.terminalWatchdogMaxRetries < 1 ||
      this.#options.ambiguousStartRetryMs < 1 ||
      this.#options.externalTurnPollMs < 1 ||
      this.#options.externalTurnWaitMs < 1 ||
      this.#options.externalGitRejectionRetryMs < 1
    ) {
      throw new Error("Codex adapter timeouts must be positive");
    }
    this.#client.onServerRequest((request) => this.#handleServerRequest(request));
    this.#client.onClose((error) => this.#failActiveStreams(error));
  }

  /**
   * Replace only the turn-level model controls. An active turn keeps the
   * values captured when it started; subsequent turns read these settings.
   */
  updateModelSettings(settings: CodexRuntimeModelSettings): void {
    const model = settings.model?.trim();
    const reasoningEffort = settings.reasoningEffort?.trim();
    if (model === undefined || model.length === 0) delete this.#options.model;
    else this.#options.model = model;
    if (reasoningEffort === undefined || reasoningEffort.length === 0) {
      delete this.#options.reasoningEffort;
    } else {
      this.#options.reasoningEffort = reasoningEffort;
    }
  }

  updateWorkspaceGitAutomationRevisions(revisions: {
    readonly koeBindingRevision: number;
    readonly principalPolicyRevision: number;
  }): void {
    if (!validWorkspaceGitAutomationRevisions(revisions)) {
      throw new Error("Workspace-git automation revisions are invalid");
    }
    this.#workspaceGitAutomationRevisions = { ...revisions };
  }

  updateAutomaticChoiceMode(mode: CodexAutomaticChoiceMode): void {
    this.#options.automaticChoiceMode = mode;
  }

  async #buildInteractiveCollaborationMode(): Promise<
    NonNullable<TurnStartParams["collaborationMode"]>
  > {
    let model = this.#options.model;
    let reasoningEffort = this.#options.reasoningEffort;
    if (model === undefined) {
      const catalog = await this.#modelCatalog.list();
      const selected = catalog.models.find((candidate) => candidate.isDefault) ??
        catalog.models[0];
      if (selected === undefined) {
        throw new Error(
          "Codex model catalog is empty; a blocking-capable ShowTalk turn cannot be started",
        );
      }
      model = selected.model;
      reasoningEffort ??= selected.defaultReasoningEffort;
    }
    return {
      // Codex 0.149 derives request_user_input's blocking lifetime from the
      // mode kind. Custom developer instructions preserve normal execution
      // behavior while keeping authority-bearing Slack questions pending.
      mode: "plan",
      settings: {
        model,
        reasoning_effort: reasoningEffort ?? null,
        developer_instructions: SHOWTALK_TURN_DEVELOPER_INSTRUCTIONS,
      },
    };
  }

  /** Ends process-local streams during an intentional Gateway shutdown. */
  shutdown(): void {
    if (this.#transportFailed) return;
    this.#failActiveStreams(
      new Error("ShowTalk Taishi is shutting down the Codex adapter"),
      true,
    );
  }

  /** Waits until every already-captured external Git rejection is durable. */
  async waitForSystemRejections(): Promise<void> {
    const sessionIds = new Set(
      [...this.#pendingExternalGitRejections.values()]
        .map((pending) => pending.sessionId),
    );
    await Promise.all(
      [...sessionIds].map((sessionId) =>
        this.#waitForSessionSystemRejections(sessionId)
      ),
    );
  }

  async #waitForSessionSystemRejections(sessionId: string): Promise<void> {
    while (
      [...this.#pendingExternalGitRejections.values()]
        .some((pending) => pending.sessionId === sessionId)
    ) {
      this.#startExternalGitRejectionWorker(sessionId);
      const task = this.#externalResolutionSettlementsBySession.get(sessionId);
      if (task === undefined) {
        throw new Error("External Git rejections are pending without a worker");
      }
      await task;
    }
  }

  async createSession(request: CreateSessionRequest): Promise<AdapterSession> {
    const workspacePath = getWorkspacePath(request);
    await validateWorkspace(request.agent.id, workspacePath);
    const thread = await this.#client.startThread({
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      ...(workspacePath === undefined ? {} : { cwd: workspacePath }),
      ...(this.#options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: this.#options.approvalPolicy }),
      ...(this.#options.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: this.#options.approvalsReviewer }),
      ...(this.#options.sandbox === undefined
        ? {}
        : { sandbox: this.#options.sandbox }),
      ...(this.#options.threadConfig === undefined
        ? {}
        : { config: this.#options.threadConfig }),
      developerInstructions: codexDeveloperInstructions(request.agent.role),
      serviceName: "showtalk_taishi",
    });
    this.#statuses.set(thread.id, "idle");
    this.#loadedSessions.add(thread.id);
    this.#resumeOverridesPendingSessions.delete(thread.id);
    this.#resumeParamsBySession.set(
      thread.id,
      this.#buildResumeParams(request.agent, thread.id),
    );
    this.#rememberSlackPersona(thread.id, request.agent.slackPersona);
    return toAdapterSession(thread);
  }

  async resumeSession(request: ResumeSessionRequest): Promise<AdapterSession> {
    await validateWorkspace(request.agent.id, getWorkspacePath(request));
    const params = this.#buildResumeParams(request.agent, request.adapterSessionId);
    let thread: CodexThread;
    try {
      thread = await this.#resumeThreadWithCompatibility(params);
    } catch (error) {
      if (isMissingCodexThreadError(error)) {
        throw new AdapterSessionUnavailableError(request.adapterSessionId, {
          cause: error,
        });
      }
      throw error;
    }
    this.#statuses.set(thread.id, "idle");
    this.#loadedSessions.add(thread.id);
    if (threadStatusType(thread) === "active") {
      this.#resumeOverridesPendingSessions.add(thread.id);
    } else {
      this.#resumeOverridesPendingSessions.delete(thread.id);
    }
    this.#resumeParamsBySession.set(thread.id, params);
    this.#rememberSlackPersona(thread.id, request.agent.slackPersona);
    return toAdapterSession(thread);
  }

  async *sendMessage(
    session: AdapterSession,
    request: SendMessageRequest,
  ): AsyncIterable<AgentEvent> {
    if (this.#transportFailed) {
      throw new Error("Codex app-server transport is unavailable");
    }
    if (this.#runningSessions.has(session.id)) {
      throw new Error(`Codex session ${session.id} already has an active turn`);
    }
    this.#runningSessions.add(session.id);
    const automationOrigin = workspaceGitAutomationSlackOrigin(request);
    if (automationOrigin === undefined) {
      this.#workspaceGitAutomationOrigins.delete(session.id);
    } else {
      this.#workspaceGitAutomationOrigins.set(session.id, automationOrigin);
    }
    let collaborationMode: TurnStartParams["collaborationMode"];
    try {
      assertTurnStartDeadline(request);
      await this.#prepareSessionForTurn(session.id);
      assertTurnStartDeadline(request);
      collaborationMode = await this.#buildInteractiveCollaborationMode();
      assertTurnStartDeadline(request);
    } catch (error) {
      this.#runningSessions.delete(session.id);
      this.#workspaceGitAutomationOrigins.delete(session.id);
      await this.#unsubscribeSession(session.id);
      throw error;
    }

    const queue = new AsyncEventQueue();
    this.#activeQueues.set(session.id, queue);
    let terminal = false;
    let failed = false;
    let ownedTurnId: string | undefined;
    let completingTurnId: string | undefined;
    let clientUserMessageId = randomUUID();
    const generatedAttachmentIds = new Set<string>();
    let generatedAttachmentBytes = 0;
    const pushAgentEvent = (event: AgentEvent): void => {
      if (event.type === "attachment.generated") {
        if (generatedAttachmentIds.has(event.attachmentId)) return;
        if (
          generatedAttachmentIds.size >= MAX_CODEX_GENERATED_IMAGE_FILES ||
          generatedAttachmentBytes + event.attachment.payload.size >
            MAX_CODEX_GENERATED_IMAGE_TOTAL_BYTES
        ) {
          queue.push({
            type: "error",
            code: "CODEX_GENERATED_IMAGE_LIMIT_EXCEEDED",
            message: "生成画像が1ターンのSlack転送上限を超えたため、一部を省略しました。",
          });
          return;
        }
        generatedAttachmentIds.add(event.attachmentId);
        generatedAttachmentBytes += event.attachment.payload.size;
      }
      queue.push(event);
    };
    const deferredNotifications: Array<{
      readonly method: string;
      readonly params: unknown;
    }> = [];
    let reconciliationFailures = 0;
    let terminalWatchdog: NodeJS.Timeout | undefined;
    const clearTerminalWatchdog = () => {
      if (terminalWatchdog !== undefined) clearTimeout(terminalWatchdog);
      terminalWatchdog = undefined;
    };
    const scheduleTerminalWatchdog = (delayMs = this.#options.terminalWatchdogMs) => {
      clearTerminalWatchdog();
      terminalWatchdog = setTimeout(() => {
        const watchedTurnId = ownedTurnId;
        if (watchedTurnId === undefined) return;
        void this.#reconcileTurnStatus(session.id, watchedTurnId).then(async (result) => {
          if (
            terminal ||
            failed ||
            completingTurnId !== undefined ||
            ownedTurnId !== watchedTurnId ||
            this.#activeTurns.get(session.id) !== watchedTurnId
          ) {
            return;
          }
          if (result.kind === "terminal") {
            const params = { threadId: session.id, turn: result.turn };
            admitCompletedTurn(
              params,
              asRecord(result.turn),
              normalizeNotification("turn/completed", params),
            );
          } else if (result.kind === "retry") {
            reconciliationFailures += 1;
            if (
              reconciliationFailures >=
              this.#options.terminalWatchdogMaxRetries
            ) {
              let interrupted = false;
              if (
                ownedTurnId === watchedTurnId &&
                this.#activeTurns.get(session.id) === watchedTurnId
              ) {
                try {
                  await this.#client.interruptTurn(session.id, watchedTurnId);
                  interrupted = true;
                } catch {
                  // Closing the transport is the fail-closed fallback below.
                }
              }
              if (
                terminal ||
                failed ||
                completingTurnId !== undefined ||
                ownedTurnId !== watchedTurnId ||
                this.#activeTurns.get(session.id) !== watchedTurnId
              ) {
                return;
              }
              if (!interrupted) {
                this.#transportFailed = true;
                await this.#client.close().catch(() => undefined);
              }
              terminal = true;
              this.#activeTurns.delete(session.id);
              this.#runningSessions.delete(session.id);
              this.#statuses.set(session.id, "failed");
              await this.#rejectPendingUserInputBindings(
                session.id,
                queue,
                "The Codex turn could not be reconciled with thread/read",
              );
              this.#removePendingApprovals(session.id);
              this.#removePendingUserInputs(session.id);
              this.#workspaceGitApprovals.clearTurnArtifacts(session.id);
              this.#removeStartedItems(session.id);
              queue.push({
                type: "error",
                code: "CODEX_TURN_RECONCILIATION_FAILED",
                message: "Codex stopped reporting the exact ShowTalk-owned turn",
              });
              queue.push({ type: "status.changed", status: "failed" });
              queue.close();
              return;
            }
            scheduleTerminalWatchdog(
              Math.min(
                this.#options.terminalWatchdogMs * 2 ** reconciliationFailures,
                this.#options.terminalWatchdogMs * 8,
              ),
            );
          } else {
            reconciliationFailures = 0;
            scheduleTerminalWatchdog();
          }
        });
      }, delayMs);
    };
    const claimOwnedTurn = (turnId: string): void => {
      if (ownedTurnId !== undefined && ownedTurnId !== turnId) {
        throw new Error(
          `Codex turn ownership conflict: ${ownedTurnId} != ${turnId}`,
        );
      }
      ownedTurnId = turnId;
      this.#activeTurns.set(session.id, turnId);
    };
    const completeTurn = async (
      params: unknown,
      turn: Record<string, unknown> | undefined,
      event: AgentEvent | undefined,
    ): Promise<void> => {
      const completedTurnId = notificationTurnId(params);
      if (completedTurnId !== undefined) {
        this.#rejectDeferredServerRequestsForTurn(
          session.id,
          completedTurnId,
          queue,
          "The Codex turn completed before the request was correlated",
        );
      }
      await this.#rejectPendingUserInputBindings(
        session.id,
        queue,
        "The Codex turn completed before its workspace-git plan could be bound",
      );
      clearTerminalWatchdog();
      this.#activeTurns.delete(session.id);
      const status = turnStatus(params);
      const hasExecutionWatch =
        this.#workspaceGitApprovals.hasExecutionWatch(session.id);
      let finalTurn = turn;
      if (completedTurnId !== undefined) {
        this.#externalActionApprovalRepairStates.delete(
          turnKey(session.id, completedTurnId),
        );
      }
      if (
        hasExecutionWatch &&
        !hasFullTurnItems(finalTurn) &&
        completedTurnId !== undefined
      ) {
        finalTurn =
          (await this.#hydrateCompletedTurn(session.id, completedTurnId)) ??
          finalTurn;
        if (terminal || failed) return;
      }
      if (hasExecutionWatch) {
        this.#observeApprovedGitTurnSnapshot(session.id, finalTurn, queue);
      }
      const completion = this.#workspaceGitApprovals.assessTurnCompletion(
        session.id,
        status,
        hasFullTurnItems(finalTurn),
      );
      if (completion.kind === "continue") {
        completingTurnId = undefined;
        ownedTurnId = undefined;
        this.#statuses.set(session.id, "starting");
        this.#removePendingApprovals(session.id);
        this.#removePendingUserInputs(session.id);
        this.#workspaceGitApprovals.clearTurnArtifacts(session.id);
        this.#removeStartedItems(session.id);
        queue.push({ type: "status.changed", status: "starting" });
        startApprovedGitContinuation(completion.plan);
        return;
      }
      if (completion.kind === "execution_incomplete") {
        queue.push({
          type: "error",
          code: "GIT_APPROVAL_EXECUTION_INCOMPLETE",
          message:
            "承認済みGit実行が失敗したか、完了状態を確認できませんでした。" +
            "同じoperationは自動再実行していません。",
        });
      } else if (completion.kind === "final_state_incomplete") {
        queue.push({
          type: "error",
          code: "GIT_APPROVAL_FINAL_STATE_INCOMPLETE",
          message:
            "承認後ターンの完全な最終item一覧を確認できないため、" +
            "二重実行を避けて自動継続を停止しました。",
        });
      } else if (completion.kind === "execution_not_observed") {
        queue.push({
          type: "error",
          code: "GIT_APPROVAL_EXECUTION_NOT_OBSERVED",
          message:
            "承認後のGit実行が確認できませんでした。" +
            "自動継続は1回で停止し、同じoperationを再実行していません。",
        });
      }
      terminal = true;
      completingTurnId = undefined;
      this.#runningSessions.delete(session.id);
      this.#statuses.set(session.id, status);
      if (event !== undefined) queue.push(event);
      this.#removePendingApprovals(session.id);
      this.#removePendingUserInputs(session.id);
      this.#workspaceGitApprovals.clearSession(session.id);
      this.#clearExternalActionApprovalRepairStates(session.id);
      this.#removeStartedItems(session.id);
      queue.close();
    };
    const admitCompletedTurn = (
      params: unknown,
      turn: Record<string, unknown> | undefined,
      event: AgentEvent | undefined,
    ): boolean => {
      const completedTurnId = notificationTurnId(params);
      if (
        completedTurnId === undefined ||
        terminal ||
        failed ||
        completingTurnId !== undefined ||
        ownedTurnId !== completedTurnId ||
        this.#activeTurns.get(session.id) !== completedTurnId
      ) {
        return false;
      }
      completingTurnId = completedTurnId;
      clearTerminalWatchdog();
      void completeTurn(params, turn, event).catch((error: unknown) => {
        queue.fail(
          error instanceof Error
            ? error
            : new Error("Could not reconcile the completed Codex turn"),
        );
      });
      return true;
    };
    const processNotification = (method: string, params: unknown) => {
      if (!belongsToThread(params, session.id)) return;
      let claimedTurn = false;
      if (isTurnScopedNotification(method)) {
        const notifiedTurnId = notificationTurnId(params);
        if (notifiedTurnId === undefined) return;
        if (ownedTurnId === undefined) {
          if (notificationClientUserMessageId(params) === clientUserMessageId) {
            try {
              claimOwnedTurn(notifiedTurnId);
              claimedTurn = true;
              const pending = deferredNotifications.splice(0);
              for (const deferred of pending.sort(deferredNotificationOrder)) {
                processNotification(deferred.method, deferred.params);
              }
            } catch (error) {
              queue.fail(error);
              return;
            }
          } else {
            if (deferredNotifications.length >= 512) {
              queue.fail(new Error("Codex emitted too many uncorrelated turn notifications"));
              return;
            }
            deferredNotifications.push({ method, params });
            return;
          }
        }
        if (notifiedTurnId !== ownedTurnId) return;
      }
      const notification = asRecord(params);
      if (
        method === "serverRequest/resolved" &&
        (typeof notification?.requestId === "string" ||
          typeof notification?.requestId === "number")
      ) {
        this.#removePendingServerRequestByRpcId(
          session.id,
          notification.requestId,
          queue,
        );
      }
      const item = asRecord(notification?.item);
      if (method === "item/started" && typeof item?.id === "string") {
        this.#startedItems.set(itemKey(session.id, item.id), item);
        this.#observeApprovedGitExecution(session.id, item, queue);
      } else if (method === "item/completed" && typeof item?.id === "string") {
        this.#observeApprovedGitExecution(session.id, item, queue);
        const startedItem = this.#startedItems.get(itemKey(session.id, item.id));
        try {
          const capture = normalizeWorkspaceGitPrepareCompletion(
            params,
            startedItem,
          );
          if (capture !== undefined) {
            this.#rememberWorkspaceGitPlan(session.id, capture.turnId, capture.plan);
            this.#queueExternallyResolvedUserInputPlans(
              session.id,
              capture.turnId,
            );
            // Let adjacent App Server completion notifications settle before
            // deciding that exactly one plan exists. This preserves the
            // fail-closed rule when parallel prepares complete together.
            setImmediate(() => {
              this.#retryPendingUserInputBindings(session.id, capture.turnId);
            });
          }
          const appOpsCapture = normalizeAppOpsPrepareCompletion(
            params,
            startedItem,
          );
          if (appOpsCapture !== undefined) {
            const key = turnKey(session.id, appOpsCapture.turnId);
            const captures = this.#appOpsPlansByTurn.get(key) ?? [];
            if (
              !captures.some(
                ({ plan }) =>
                  plan.operationId === appOpsCapture.plan.operationId &&
                  plan.planHash === appOpsCapture.plan.planHash,
              )
            ) {
              captures.push(appOpsCapture);
              this.#appOpsPlansByTurn.set(key, captures);
            }
            setImmediate(() => {
              this.#retryPendingUserInputBindings(
                session.id,
                appOpsCapture.turnId,
              );
            });
          }
        } catch (error) {
          queue.push({
            type: "error",
            message:
              error instanceof Error
                ? error.message
                : "An approval prepare tool returned an invalid pending plan",
            code: "INVALID_EXTERNAL_APPROVAL_PLAN",
          });
        }
        this.#startedItems.delete(itemKey(session.id, item.id));
      }
      const turn = asRecord(notification?.turn);
      if (method === "item/completed" && item !== undefined) {
        for (const imageEvent of normalizeCodexDynamicToolImageCompletions(item)) {
          pushAgentEvent(imageEvent);
        }
      }
      const event = normalizeNotification(method, params);
      if (method !== "turn/completed" && event !== undefined) pushAgentEvent(event);
      if (method === "turn/completed") {
        admitCompletedTurn(params, turn, event);
      }
      if (
        claimedTurn &&
        completingTurnId === undefined &&
        ownedTurnId !== undefined
      ) {
        this.#flushDeferredServerRequests(session.id, ownedTurnId);
      }
    };
    const startApprovedGitContinuation = (
      approvedPlan: WorkspaceGitApprovalPlan,
    ): void => {
      clientUserMessageId = randomUUID();
      void this.#client
        .startTurn({
          threadId: session.id,
          clientUserMessageId,
          input: [
            {
              type: "text",
              text:
                "Continue the exact workspace-git operation already approved " +
                "through ShowTalk's bound Slack structured input. Revalidate and " +
                "execute that exact plan now, or report the exact fail-closed blocker. " +
                "Do not request another approval merely because this is a continuation.",
              text_elements: [],
            },
          ],
          ...slackTurnAdditionalContext(
            this.#slackPersonasBySession.get(session.id),
            this.#legacyPaginatedCompatibilitySessions.has(session.id),
            approvedPlan,
          ),
          ...(this.#options.approvalPolicy === undefined
            ? {}
            : { approvalPolicy: this.#options.approvalPolicy }),
          ...(this.#options.approvalsReviewer === undefined
            ? {}
            : { approvalsReviewer: this.#options.approvalsReviewer }),
          ...(this.#options.model === undefined
            ? {}
            : { model: this.#options.model }),
          ...(this.#options.reasoningEffort === undefined
            ? {}
            : { effort: this.#options.reasoningEffort }),
          collaborationMode,
        })
        .then((turn) => {
          if (ownedTurnId !== undefined && ownedTurnId !== turn.id) {
            throw new Error(
              `Codex turn ownership conflict: ${ownedTurnId} != ${turn.id}`,
            );
          }
          claimOwnedTurn(turn.id);
          if (terminal) return;
          const pending = deferredNotifications.splice(0);
          for (const notification of pending.sort(deferredNotificationOrder)) {
            processNotification(notification.method, notification.params);
          }
          this.#flushDeferredServerRequests(session.id, turn.id);
          if (!terminal) {
            this.#statuses.set(session.id, "running");
            queue.push({ type: "status.changed", status: "running" });
            scheduleTerminalWatchdog();
          }
        })
        .catch((error: unknown) => {
          queue.fail(
            error instanceof Error
              ? error
              : new Error("Could not continue the approved Git operation"),
          );
        });
    };
    const unsubscribeNotification = this.#client.onNotification(processNotification);

    try {
      this.#statuses.set(session.id, "starting");
      queue.push({ type: "status.changed", status: "starting" });
      const turn = await this.#client.startTurn({
        threadId: session.id,
        clientUserMessageId,
        input: buildTurnInput(request),
        ...slackTurnAdditionalContext(
          this.#slackPersonasBySession.get(session.id),
          this.#legacyPaginatedCompatibilitySessions.has(session.id),
        ),
        ...(this.#options.approvalPolicy === undefined
          ? {}
          : { approvalPolicy: this.#options.approvalPolicy }),
        ...(this.#options.approvalsReviewer === undefined
          ? {}
          : { approvalsReviewer: this.#options.approvalsReviewer }),
        ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
        ...(this.#options.reasoningEffort === undefined
          ? {}
          : { effort: this.#options.reasoningEffort }),
        collaborationMode,
      });
      if (ownedTurnId !== undefined && ownedTurnId !== turn.id) {
        const notifiedTurnId = ownedTurnId;
        await Promise.allSettled([
          this.#client.interruptTurn(session.id, notifiedTurnId),
          this.#client.interruptTurn(session.id, turn.id),
        ]);
        this.#transportFailed = true;
        await this.#client.close().catch(() => undefined);
        throw new Error(
          `Codex turn ownership conflict: ${notifiedTurnId} != ${turn.id}`,
        );
      }
      claimOwnedTurn(turn.id);
      if (!terminal) {
        const pending = deferredNotifications.splice(0);
        for (const notification of pending.sort(deferredNotificationOrder)) {
          processNotification(notification.method, notification.params);
        }
        this.#flushDeferredServerRequests(session.id, turn.id);
        if (!terminal) {
          this.#statuses.set(session.id, "running");
          queue.push({ type: "status.changed", status: "running" });
          scheduleTerminalWatchdog();
        }
      }
      for await (const event of queue) yield event;
    } catch (error) {
      const safelyStopped =
        this.#transportFailed ||
        (await this.#reconcileAndInterruptAmbiguousTurn(session.id));
      if (!safelyStopped) {
        await this.#client.close().catch(() => undefined);
      }
      failed = true;
      this.#activeTurns.delete(session.id);
      this.#runningSessions.delete(session.id);
      this.#statuses.set(session.id, "failed");
      queue.fail(error);
      throw error;
    } finally {
      if (!terminal && !failed) {
        const safelyStopped =
          this.#transportFailed ||
          (await this.#reconcileAndInterruptAmbiguousTurn(session.id));
        if (!safelyStopped) {
          this.#transportFailed = true;
          await this.#client.close().catch(() => undefined);
        }
        this.#activeTurns.delete(session.id);
        this.#statuses.set(session.id, safelyStopped ? "interrupted" : "failed");
      }
      this.#runningSessions.delete(session.id);
      this.#activeQueues.delete(session.id);
      this.#workspaceGitAutomationOrigins.delete(session.id);
      this.#abortWorkspaceGitAutomations(session.id);
      this.#removePendingApprovals(session.id);
      this.#removePendingUserInputs(session.id);
      await this.#rejectPendingUserInputBindings(
        session.id,
        queue,
        "The Slack turn ended before its workspace-git plan could be bound",
      );
      this.#workspaceGitApprovals.clearSession(session.id);
      this.#clearAppOpsPlans(session.id);
      this.#clearExternalActionApprovalRepairStates(session.id);
      this.#removeStartedItems(session.id);
      this.#rejectDeferredServerRequests(
        session.id,
        "The exact ShowTalk-owned Codex turn ended before the request was correlated",
      );
      clearTerminalWatchdog();
      unsubscribeNotification();
      await this.#unsubscribeSession(session.id);
    }
  }

  async interrupt(session: AdapterSession): Promise<void> {
    const turnId = this.#activeTurns.get(session.id);
    if (turnId === undefined) {
      await this.#unsubscribeSession(session.id);
      throw new Error(`Codex session ${session.id} has no active turn`);
    }
    await this.#client.interruptTurn(session.id, turnId);
  }

  async approve(session: AdapterSession, approval: AgentApproval): Promise<void> {
    const pending = this.#pendingApprovals.get(approval.requestId);
    if (pending === undefined || pending.sessionId !== session.id) {
      throw new Error(`Unknown approval request: ${approval.requestId}`);
    }
    if (Date.now() > pending.expiresAt) {
      try {
        this.#respondToPendingApproval(pending, "cancel");
      } finally {
        clearTimeout(pending.expirationTimer);
        this.#pendingApprovals.delete(approval.requestId);
      }
      throw new Error(`Approval request expired: ${approval.requestId}`);
    }
    if (
      pending.availableDecisions !== undefined &&
      !pending.availableDecisions.includes(approval.decision)
    ) {
      throw new Error(
        `Approval decision is not available for this request: ${approval.decision}`,
      );
    }
    const decision =
      pending.commandDecisions?.get(approval.decision) ??
      mapApprovalDecision(approval.decision);
    if (decision === undefined) {
      throw new Error(
        `Approval decision is not available for this request: ${approval.decision}`,
      );
    }
    try {
      this.#respondToPendingApproval(pending, decision);
    } finally {
      clearTimeout(pending.expirationTimer);
      this.#pendingApprovals.delete(approval.requestId);
    }
    this.#statuses.set(session.id, "running");
    this.#activeQueues.get(session.id)?.push({
      type: "status.changed",
      status: "running",
    });
  }

  async respondToUserInput(
    session: AdapterSession,
    response: AgentUserInputResponse,
  ): Promise<void> {
    const pending = this.#pendingUserInputs.get(response.requestId);
    if (pending === undefined || pending.sessionId !== session.id) {
      const externallyResolved = this.#externallyResolvedGitUserInputs.get(
        response.requestId,
      );
      if (
        externallyResolved?.sessionId === session.id &&
        "optionId" in response &&
        response.optionId === "reject" &&
        response.plan !== undefined &&
        sameExactWorkspaceGitApprovalPlan(externallyResolved.plan, response.plan)
      ) {
        return;
      }
      throw new Error(`Unknown structured input request: ${response.requestId}`);
    }
    if (Date.now() >= pending.expiresAt) {
      this.#expireUserInput(response.requestId, pending);
      throw new Error(`Structured input request expired: ${response.requestId}`);
    }
    if ("cancelled" in response) {
      this.#cancelUserInput(response.requestId, pending);
      this.#resumeAfterUserInput(session.id);
      return;
    }
    if (pending.kind === "git_approval") {
      if (!("optionId" in response)) {
        throw new Error("Git approval requires one fixed approval decision");
      }
      this.#settleGitUserInput(response.requestId, pending, response.optionId);
      this.#resumeAfterUserInput(session.id);
      return;
    }
    if (!("answer" in response)) {
      throw new Error("Ordinary structured input requires one question answer");
    }
    const completed = this.#acceptChoiceAnswer(
      response.requestId,
      pending,
      response.answer,
    );
    if (completed) this.#resumeAfterUserInput(session.id);
  }

  async status(session: AdapterSession): Promise<AgentStatus> {
    try {
      const thread = await this.#client.readThread(session.id);
      const type = threadStatusType(thread);
      const status: AgentStatus =
        type === "active"
          ? "running"
          : type === "systemError"
            ? "failed"
            : type === "idle" || type === "notLoaded"
              ? "idle"
              : this.#statuses.get(session.id) ?? "idle";
      this.#statuses.set(session.id, status);
      return status;
    } catch {
      return this.#statuses.get(session.id) ?? "idle";
    } finally {
      if (!this.#runningSessions.has(session.id)) {
        await this.#unsubscribeSession(session.id);
      }
    }
  }

  async #prepareSessionForTurn(sessionId: string): Promise<void> {
    const deadline = Date.now() + this.#options.externalTurnWaitMs;
    while (true) {
      const stored = await this.#client.readThread(sessionId);
      const storedStatus = threadStatusType(stored);
      // systemError is the terminal status of the previous failed turn, not
      // proof that the persisted thread disappeared. In particular, model
      // capacity failures leave the thread reusable. Resume the same thread
      // when necessary and let turn/start report any current model error.
      if (storedStatus !== "active") {
        const overridesPending =
          this.#resumeOverridesPendingSessions.has(sessionId);
        if (this.#loadedSessions.has(sessionId) && !overridesPending) return;
        if (this.#loadedSessions.has(sessionId)) {
          await this.#unsubscribeSession(sessionId);
        }
        const thread = await this.#resumeThreadWithCompatibility(
          this.#resumeParamsBySession.get(sessionId) ?? { threadId: sessionId },
        );
        this.#loadedSessions.add(sessionId);
        if (threadStatusType(thread) !== "active") {
          this.#resumeOverridesPendingSessions.delete(sessionId);
          return;
        }
        this.#resumeOverridesPendingSessions.add(sessionId);
      }

      this.#statuses.set(sessionId, "running");
      await this.#unsubscribeSession(sessionId);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.#statuses.set(sessionId, "running");
        throw new CoreError(
          "AGENT_BUSY",
          "This Codex thread stayed active in another client for too long; the queued Slack turn was not started",
        );
      }
      await delay(Math.min(this.#options.externalTurnPollMs, remaining));
    }
  }

  async #unsubscribeSession(sessionId: string): Promise<void> {
    if (this.#transportFailed || !this.#loadedSessions.has(sessionId)) return;
    try {
      await this.#client.unsubscribeThread(sessionId);
    } catch {
      // The next turn will resume from persisted storage even if the server did
      // not acknowledge this best-effort release.
    } finally {
      this.#loadedSessions.delete(sessionId);
    }
  }

  #buildResumeParams(
    agent: AgentDefinition,
    threadId: string,
  ): ThreadResumeParams {
    const workspacePath = getWorkspacePath({ agent });
    return {
      threadId,
      ...(this.#options.model === undefined ? {} : { model: this.#options.model }),
      ...(workspacePath === undefined ? {} : { cwd: workspacePath }),
      ...(this.#options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: this.#options.approvalPolicy }),
      ...(this.#options.approvalsReviewer === undefined
        ? {}
        : { approvalsReviewer: this.#options.approvalsReviewer }),
      ...(this.#options.sandbox === undefined
        ? {}
        : { sandbox: this.#options.sandbox }),
      ...(this.#options.threadConfig === undefined
        ? {}
        : { config: this.#options.threadConfig }),
      developerInstructions: codexDeveloperInstructions(agent.role),
      excludeTurns: true,
    };
  }

  async #resumeThreadWithCompatibility(
    params: ThreadResumeParams,
  ): Promise<CodexThread> {
    if (this.#legacyPaginatedCompatibilitySessions.has(params.threadId)) {
      return this.#client.resumeThread(withoutExcludeTurns(params));
    }
    try {
      const thread = await this.#client.resumeThread(params);
      this.#legacyPaginatedCompatibilitySessions.delete(params.threadId);
      this.#legacyPaginatedCompatibilitySessions.delete(thread.id);
      return thread;
    } catch (error) {
      if (
        params.excludeTurns !== true ||
        !isPaginatedThreadsUnsupported(error)
      ) {
        throw error;
      }
      const thread = await this.#client.resumeThread(withoutExcludeTurns(params));
      this.#legacyPaginatedCompatibilitySessions.add(params.threadId);
      this.#legacyPaginatedCompatibilitySessions.add(thread.id);
      return thread;
    }
  }

  #rememberSlackPersona(sessionId: string, persona: string | undefined): void {
    const configured = persona?.trim();
    if (configured === undefined || configured.length === 0) {
      this.#slackPersonasBySession.delete(sessionId);
      return;
    }
    this.#slackPersonasBySession.set(sessionId, configured);
  }

  #handleServerRequest(serverRequest: ServerRequestEvent): void {
    const params = asRecord(serverRequest.params);
    const sessionId = typeof params?.threadId === "string" ? params.threadId : undefined;
    const queue = sessionId === undefined ? undefined : this.#activeQueues.get(sessionId);
    const requestTurnId = typeof params?.turnId === "string" ? params.turnId : undefined;
    const activeTurnId =
      sessionId === undefined ? undefined : this.#activeTurns.get(sessionId);
    if (
      sessionId !== undefined &&
      queue !== undefined &&
      requestTurnId !== undefined &&
      activeTurnId === undefined &&
      this.#runningSessions.has(sessionId)
    ) {
      const deferred = this.#deferredServerRequestsBySession.get(sessionId) ?? [];
      if (deferred.length >= 64) {
        this.#client.respondError(serverRequest.id, {
          code: -32603,
          message: "Too many Codex requests arrived before exact turn correlation",
        });
        return;
      }
      deferred.push(serverRequest);
      this.#deferredServerRequestsBySession.set(sessionId, deferred);
      return;
    }
    if (
      sessionId === undefined ||
      queue === undefined ||
      requestTurnId === undefined ||
      requestTurnId !== activeTurnId
    ) {
      this.#client.respondError(serverRequest.id, {
        code: -32601,
        message:
          "ShowTalk Taishi cannot handle this server request outside its exact active turn",
      });
      return;
    }
    if (serverRequest.method === "item/tool/requestUserInput") {
      this.#handleUserInputRequest(serverRequest, sessionId, queue);
      return;
    }
    const mcpToolApproval =
      serverRequest.method === "mcpServer/elicitation/request"
        ? parseMcpToolApprovalRequest(serverRequest.params)
        : undefined;
    if (
      serverRequest.method === "mcpServer/elicitation/request" &&
      mcpToolApproval === undefined
    ) {
      this.#client.respondToMcpServerElicitation(serverRequest.id, {
        action: "cancel",
        content: null,
        _meta: null,
      });
      queue.push({
        type: "error",
        message:
          "Codex requested an MCP elicitation that ShowTalk cannot safely render",
        code: "UNSUPPORTED_MCP_ELICITATION",
      });
      return;
    }
    if (!isApprovalMethod(serverRequest.method)) {
      this.#client.respondError(serverRequest.id, {
        code: -32601,
        message: `Unsupported Codex server request: ${serverRequest.method}`,
      });
      queue.push({
        type: "error",
        message: `Codex requested unsupported interaction: ${serverRequest.method}`,
        code: "UNSUPPORTED_SERVER_REQUEST",
      });
      return;
    }

    const requestId = `codex:${randomUUID()}`;
    const commandApprovalOptions =
      serverRequest.method === "item/commandExecution/requestApproval"
        ? commandApprovalDecisionOptions(serverRequest.params)
        : undefined;
    const availableDecisions =
      mcpToolApproval?.availableDecisions ??
      commandApprovalOptions?.availableDecisions;
    if (availableDecisions !== undefined && availableDecisions.length === 0) {
      if (serverRequest.method === "item/commandExecution/requestApproval") {
        this.#client.respondToCommandApproval(serverRequest.id, "cancel");
      } else if (serverRequest.method === "item/fileChange/requestApproval") {
        this.#client.respondToFileChangeApproval(serverRequest.id, "cancel");
      } else if (serverRequest.method === "mcpServer/elicitation/request") {
        this.#client.respondToMcpServerElicitation(serverRequest.id, {
          action: "cancel",
          content: null,
          _meta: null,
        });
      } else {
        this.#client.respondToPermissionsApproval(serverRequest.id, {
          permissions: {},
          scope: "turn",
        });
      }
      queue.push({
        type: "error",
        code: "UNSUPPORTED_APPROVAL_DECISIONS",
        message: "Codex offered no approval decision that ShowTalk can safely present",
      });
      return;
    }
    const itemId = typeof params?.itemId === "string" ? params.itemId : undefined;
    const item =
      itemId === undefined ? undefined : this.#startedItems.get(itemKey(sessionId, itemId));
    const expirationTimer = setTimeout(() => {
      const current = this.#pendingApprovals.get(requestId);
      if (current === undefined) return;
      try {
        this.#respondToPendingApproval(current, "cancel");
      } catch (error) {
        queue.fail(error);
      } finally {
        this.#pendingApprovals.delete(requestId);
      }
      queue.push({
        type: "error",
        message: "Approval request expired and was cancelled",
        code: "APPROVAL_EXPIRED",
      });
    }, this.#options.approvalTimeoutMs);
    expirationTimer.unref();
    this.#pendingApprovals.set(requestId, {
      rpcId: serverRequest.id,
      method: serverRequest.method,
      sessionId,
      ...(serverRequest.method === "item/permissions/requestApproval"
        ? { requestedPermissions: requestedPermissions(serverRequest.params) }
        : {}),
      ...(availableDecisions === undefined ? {} : { availableDecisions }),
      ...(commandApprovalOptions?.commandDecisions === undefined
        ? {}
        : { commandDecisions: commandApprovalOptions.commandDecisions }),
      expiresAt: Date.now() + this.#options.approvalTimeoutMs,
      expirationTimer,
    });
    this.#statuses.set(sessionId, "waiting_for_approval");
    queue.push({
      type: "status.changed",
      status: "waiting_for_approval",
    });
    queue.push({
      type: "approval.requested",
      requestId,
      summary:
        mcpToolApproval !== undefined
          ? mcpToolApproval.summary
          : serverRequest.method === "item/commandExecution/requestApproval"
          ? commandSummary(
              serverRequest.params,
              item,
              commandApprovalOptions?.execPolicyAmendment,
            )
          : serverRequest.method === "item/fileChange/requestApproval"
            ? fileChangeSummary(serverRequest.params, item)
            : permissionsSummary(serverRequest.params),
      details:
        mcpToolApproval === undefined
          ? toJsonValue({ request: serverRequest.params, item: item ?? null })
          : toJsonValue({
              serverName: mcpToolApproval.serverName,
              toolName: mcpToolApproval.toolName ?? null,
            }),
      ...(availableDecisions === undefined ? {} : { availableDecisions }),
    });
  }

  #flushDeferredServerRequests(sessionId: string, turnId: string): void {
    const deferred = this.#deferredServerRequestsBySession.get(sessionId) ?? [];
    this.#deferredServerRequestsBySession.delete(sessionId);
    for (const request of deferred) {
      const params = asRecord(request.params);
      if (params?.turnId === turnId) {
        this.#handleServerRequest(request);
      } else {
        this.#client.respondError(request.id, {
          code: -32601,
          message: "Codex request belongs to another turn",
        });
      }
    }
  }

  #rejectDeferredServerRequests(sessionId: string, message: string): void {
    const deferred = this.#deferredServerRequestsBySession.get(sessionId) ?? [];
    this.#deferredServerRequestsBySession.delete(sessionId);
    for (const request of deferred) {
      this.#client.respondError(request.id, { code: -32601, message });
    }
  }

  #rejectDeferredServerRequestsForTurn(
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue,
    message: string,
  ): void {
    const deferred = this.#deferredServerRequestsBySession.get(sessionId) ?? [];
    const remaining: ServerRequestEvent[] = [];
    for (const request of deferred) {
      const params = asRecord(request.params);
      if (params?.turnId !== turnId) {
        remaining.push(request);
        continue;
      }
      if (
        request.method === "item/tool/requestUserInput" &&
        (hasWorkspaceGitApprovalQuestionId(request.params) ||
          looksLikeWorkspaceGitApproval(request.params))
      ) {
        this.#externallyResolvedUserInputBindings.set(rpcKey(request.id), {
          sessionId,
          turnId,
          queue,
        });
        this.#queueExternallyResolvedUserInputPlans(sessionId, turnId);
      }
      this.#client.respondError(request.id, { code: -32601, message });
    }
    if (remaining.length === 0) {
      this.#deferredServerRequestsBySession.delete(sessionId);
    } else {
      this.#deferredServerRequestsBySession.set(sessionId, remaining);
    }
  }

  #handleUserInputRequest(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    queue: AsyncEventQueue,
    allowBindingWait = true,
    receivedAt = Date.now(),
  ): void {
    let requestTurnId: string | undefined;
    const hasGitApprovalQuestionId = hasWorkspaceGitApprovalQuestionId(
      serverRequest.params,
    );
    const hasExternalActionApprovalId =
      hasExternalActionApprovalQuestionId(serverRequest.params);
    const hasReservedGitApprovalShape =
      looksLikeWorkspaceGitApproval(serverRequest.params);
    const shouldWaitForGitPlan =
      hasGitApprovalQuestionId || hasReservedGitApprovalShape;
    let mustUseGitApprovalPath = shouldWaitForGitPlan;
    try {
      let params: ReturnType<typeof toolRequestUserInputParams>;
      try {
        params = toolRequestUserInputParams(serverRequest.params);
      } catch (error) {
        const identity = hasExternalActionApprovalId
          ? structuredInputTurnIdentity(serverRequest.params)
          : undefined;
        if (identity !== undefined) {
          requestTurnId = identity.turnId;
          if (identity.threadId !== sessionId) {
            throw new InvalidGitApprovalRequestError(
              "Structured input thread does not match the active session",
            );
          }
          const binding = this.#workspaceGitApprovals.inspectPlanBinding(
            sessionId,
            identity.turnId,
          );
          if (
            binding.kind === "missing" &&
            allowBindingWait &&
            shouldWaitForGitPlan
          ) {
            this.#waitForWorkspaceGitPlan(
              serverRequest,
              sessionId,
              identity.turnId,
              queue,
              receivedAt,
            );
            return;
          }
          if (
            binding.kind === "missing" &&
            !hasGitApprovalQuestionId
          ) {
            this.#handleOrdinaryChoiceRequest(
              serverRequest,
              sessionId,
              identity.turnId,
              queue,
              receivedAt,
            );
            return;
          }
        }
        throw new InvalidGitApprovalRequestError(publicStructuredInputError(error));
      }
      requestTurnId = params.turnId;
      if (params.threadId !== sessionId) {
        throw new InvalidGitApprovalRequestError(
          "Structured input thread does not match the active session",
        );
      }
      const binding = this.#workspaceGitApprovals.inspectPlanBinding(
        sessionId,
        params.turnId,
      );
      if (binding.kind !== "missing") mustUseGitApprovalPath = true;
      if (
        mustUseGitApprovalPath &&
        this.#workspaceGitApprovals.isRequestInvalid(sessionId, params.turnId)
      ) {
        this.#workspaceGitApprovals.discardTurnPlans(sessionId, params.turnId);
        this.#rejectInvalidGitApprovalRequest(
          serverRequest.id,
          sessionId,
          params.turnId,
          queue,
          new Error("A malformed Git approval request already terminated this turn"),
        );
        return;
      }
      if (
        binding.kind === "missing" &&
        allowBindingWait &&
        shouldWaitForGitPlan
      ) {
        this.#waitForWorkspaceGitPlan(
          serverRequest,
          sessionId,
          params.turnId,
          queue,
          receivedAt,
        );
        return;
      }
      if (
        binding.kind === "missing" &&
        (!mustUseGitApprovalPath ||
          (hasExternalActionApprovalId && !hasGitApprovalQuestionId))
      ) {
        this.#handleOrdinaryChoiceRequest(
          serverRequest,
          sessionId,
          params.turnId,
          queue,
          receivedAt,
        );
        return;
      }
      if (
        binding.kind === "missing" &&
        mustUseGitApprovalPath &&
        !hasGitApprovalQuestionId &&
        !hasExternalActionApprovalId
      ) {
        throw new RepreparableGitApprovalError(
          "Fixed Git approval choices used a non-Git question ID without a fresh exact plan",
        );
      }
      let question: ReturnType<typeof validateWorkspaceGitPlanQuestion>;
      try {
        question = validateWorkspaceGitPlanQuestion(serverRequest.params);
      } catch (error) {
        if (binding.kind === "exact") {
          this.#workspaceGitApprovals.consumeExactPlan(
            sessionId,
            params.turnId,
            binding.plan,
          );
        }
        this.#rejectInvalidGitApprovalRequest(
          serverRequest.id,
          sessionId,
          params.turnId,
          queue,
          error,
        );
        return;
      }
      if (binding.kind !== "exact") {
        throw new RepreparableGitApprovalError(
          binding.kind === "missing"
            ? "No exact workspace-git plan is bound to this structured request"
            : "More than one workspace-git plan is pending in this turn",
        );
      }
      const plan = binding.plan;
      if (
        this.#workspaceGitApprovals.isCompletedOperation(
          sessionId,
          plan.operationId,
        )
      ) {
        this.#workspaceGitApprovals.consumeExactPlan(
          sessionId,
          params.turnId,
          plan,
        );
        this.#rejectCompletedGitUserInput(
          serverRequest.id,
          sessionId,
          queue,
        );
        return;
      }
      if (
        this.#workspaceGitApprovals.approvedPlan(sessionId) !== undefined ||
        this.#hasPendingGitUserInput(sessionId)
      ) {
        this.#workspaceGitApprovals.consumeExactPlan(
          sessionId,
          params.turnId,
          plan,
        );
        this.#rejectConcurrentGitUserInput(
          serverRequest.id,
          sessionId,
          queue,
        );
        return;
      }
      const planExpiry = Date.parse(plan.expiresAt);
      const now = Date.now();
      const timeoutMs = Math.min(
        this.#options.approvalTimeoutMs - (now - receivedAt),
        planExpiry - now,
        question.autoResolutionMs === undefined
          ? Number.POSITIVE_INFINITY
          : receivedAt + question.autoResolutionMs - now,
      );
      if (!Number.isFinite(planExpiry) || timeoutMs <= 0) {
        throw new RepreparableGitApprovalError(
          "The workspace-git plan has already expired",
        );
      }
      const presentManualApproval = () => {
        this.#workspaceGitApprovals.consumeExactPlan(sessionId, params.turnId, plan);
        const requestId = `codex-input:${randomUUID()}`;
        const expirationTimer = setTimeout(() => {
          const pending = this.#pendingUserInputs.get(requestId);
          if (pending === undefined || pending.kind !== "git_approval") return;
          try {
            this.#expireGitUserInput(requestId, pending);
          } catch (error) {
            queue.fail(error);
          }
        }, timeoutMs);
        expirationTimer.unref();
        this.#pendingUserInputs.set(requestId, {
          kind: "git_approval",
          rpcId: serverRequest.id,
          sessionId,
          turnId: params.turnId,
          questionId: question.questionId,
          approveLabel: question.approveLabel,
          rejectLabel: question.rejectLabel,
          plan,
          expiresAt: now + timeoutMs,
          expirationTimer,
        });
        this.#statuses.set(sessionId, "waiting_for_approval");
        queue.push({ type: "status.changed", status: "waiting_for_approval" });
        queue.push({
          type: "user_input.requested",
          requestId,
          expiresAt: new Date(now + timeoutMs).toISOString(),
          prompt: question.prompt,
          options: [
            { id: "approve", label: "承認して実行" },
            { id: "reject", label: "拒否・保留" },
          ],
          plan,
        });
      };
      const automationInput = this.#workspaceGitAutomationInput({
        serverRequest,
        sessionId,
        turnId: params.turnId,
        itemId: params.itemId,
        plan,
        deadlineAt: new Date(now + timeoutMs).toISOString(),
      });
      if (
        this.#workspaceGitAutomationProvider === undefined ||
        automationInput === undefined
      ) {
        presentManualApproval();
        return;
      }
      const automationKey = rpcKey(serverRequest.id);
      if (this.#pendingWorkspaceGitAutomations.has(automationKey)) {
        throw new Error("Workspace Git automation request is already pending");
      }
      const abortController = new AbortController();
      const pendingAutomation: PendingWorkspaceGitAutomation = {
        sessionId,
        rpcId: serverRequest.id,
        turnId: params.turnId,
        plan,
        abortController,
      };
      this.#pendingWorkspaceGitAutomations.set(
        automationKey,
        pendingAutomation,
      );
      void this.#resolveWorkspaceGitAutomation({
        key: automationKey,
        pending: pendingAutomation,
        input: { ...automationInput, signal: abortController.signal },
        plan,
        turnId: params.turnId,
        queue,
        presentManualApproval,
      });
      return;
    } catch (error) {
      if (!mustUseGitApprovalPath) {
        const reason = publicStructuredInputError(error);
        this.#client.respondError(serverRequest.id, {
          code: -32602,
          message: `UNSUPPORTED_STRUCTURED_INPUT: ${reason}`,
        });
        queue.push({
          type: "error",
          message:
            "この入力形式はSlackでは安全に表示できません。" +
            "通常の文章で質問し直してください。",
          code: "UNSUPPORTED_STRUCTURED_INPUT",
        });
        return;
      }
      if (error instanceof RepreparableGitApprovalError) {
        this.#rejectUnboundGitApproval(
          serverRequest,
          sessionId,
          requestTurnId,
          queue,
          error,
        );
        return;
      }
      this.#rejectInvalidGitApprovalRequest(
        serverRequest.id,
        sessionId,
        requestTurnId,
        queue,
        error,
      );
    }
  }

  #handleOrdinaryChoiceRequest(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue,
    receivedAt: number,
  ): void {
    const externalActionApproval = hasExternalActionApprovalQuestionId(
      serverRequest.params,
    );
    try {
      const request = validateOrdinaryChoiceRequest(serverRequest.params);
      const appOpsCapture = externalActionApproval
        ? this.#resolveAppOpsApprovalPlan(
            sessionId,
            turnId,
            externalActionQuestionPrompt(serverRequest.params),
          )
        : undefined;
      if (
        externalActionApproval &&
        looksLikeAppOpsApprovalPrompt(externalActionQuestionPrompt(serverRequest.params)) &&
        appOpsCapture === undefined
      ) {
        throw new AppOpsApprovalBindingError(
          "AppOps approval prompt does not match one exact same-turn prepare result",
        );
      }
      if (
        appOpsCapture !== undefined &&
        (this.#appOpsApprovalProofSigner === undefined ||
          this.#appOpsApprovalProofBroker === undefined ||
          this.#koeId === undefined)
      ) {
        throw new AppOpsApprovalBindingError(
          "AppOps approval proof handoff is not configured",
        );
      }
      if (
        externalActionApproval &&
        !this.#acceptExternalActionApprovalRepair(
          serverRequest.id,
          sessionId,
          turnId,
        )
      ) {
        return;
      }
      if (request.threadId !== sessionId) {
        throw new Error("Structured input thread does not match the active session");
      }
      const now = Date.now();
      const timeoutMs = Math.min(
        this.#options.approvalTimeoutMs - (now - receivedAt),
        request.autoResolutionMs === undefined
          ? Number.POSITIVE_INFINITY
          : receivedAt + request.autoResolutionMs - now,
        appOpsCapture === undefined
          ? Number.POSITIVE_INFINITY
          : Date.parse(appOpsCapture.plan.expiresAt) - now,
      );
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        if (appOpsCapture !== undefined) {
          throw new AppOpsApprovalBindingError(
            "AppOps approval plan has already expired",
          );
        }
        throw new Error("Structured input request has already expired");
      }
      if (
        this.#options.automaticChoiceMode === "ordinary_top_choice" &&
        request.questions.every((question) => question.purpose === "ordinary")
      ) {
        const answers: Record<string, { answers: string[] }> = {};
        for (const question of request.questions) {
          const option = question.options[0];
          if (option === undefined) {
            throw new Error("Structured input question has no first option");
          }
          answers[question.appServerQuestionId] = {
            answers: [option.appServerLabel],
          };
          queue.push({
            type: "choice.auto_selected",
            header: question.header,
            optionLabel: option.label,
          });
        }
        this.#client.respondToUserInput(serverRequest.id, { answers });
        return;
      }
      const requestId = `codex-choice:${randomUUID()}`;
      const expirationTimer = setTimeout(() => {
        const pending = this.#pendingUserInputs.get(requestId);
        if (pending === undefined || pending.kind !== "choice") return;
        try {
          this.#expireUserInput(requestId, pending);
        } catch (error) {
          queue.fail(error);
          return;
        }
        this.#statuses.set(sessionId, "running");
        queue.push({ type: "status.changed", status: "running" });
        queue.push({
          type: "error",
          message: "選択肢への回答待ちが期限切れになりました。",
          code: "STRUCTURED_INPUT_EXPIRED",
        });
      }, timeoutMs);
      expirationTimer.unref();
      const pending: PendingChoiceUserInput = {
        kind: "choice",
        rpcId: serverRequest.id,
        sessionId,
        questions: request.questions,
        answers: new Map(),
        ...(appOpsCapture === undefined
          ? {}
          : {
              appOpsPlan: appOpsCapture.plan,
              appOpsTurnId: appOpsCapture.turnId,
            }),
        currentQuestionIndex: 0,
        expiresAt: now + timeoutMs,
        expirationTimer,
      };
      this.#pendingUserInputs.set(requestId, pending);
      this.#statuses.set(sessionId, "waiting_for_input");
      queue.push({ type: "status.changed", status: "waiting_for_input" });
      this.#pushCurrentChoice(requestId, pending, queue);
    } catch (error) {
      if (error instanceof AppOpsApprovalBindingError) {
        this.#client.respondError(serverRequest.id, {
          code: -32602,
          message: `APPOPS_APPROVAL_BLOCKED: ${error.message}`,
          data: { recovery: "fresh_appops_prepare_required" },
        });
        this.#appOpsPlansByTurn.delete(turnKey(sessionId, turnId));
        queue.push({
          type: "error",
          code: "APPOPS_APPROVAL_BLOCKED",
          message:
            "AppOpsの承認計画を現在のターンへ安全に固定できないため、" +
            "外部操作を実行しません。新しいprepareからやり直してください。",
        });
        return;
      }
      if (
        externalActionApproval &&
        this.#requestExternalActionApprovalRepair(
          serverRequest.id,
          sessionId,
          turnId,
        )
      ) {
        return;
      }
      const reason = publicStructuredInputError(error);
      this.#client.respondError(serverRequest.id, {
        code: -32602,
        message: `UNSUPPORTED_STRUCTURED_INPUT: ${reason}`,
      });
      queue.push({
        type: "error",
        message:
          "この入力形式はSlackでは安全に表示できません。" +
          "通常の文章で質問し直してください。" +
          ` 診断: ${reason}`,
        code: "UNSUPPORTED_STRUCTURED_INPUT",
      });
    }
  }

  #workspaceGitAutomationInput(input: {
    readonly serverRequest: ServerRequestEvent;
    readonly sessionId: string;
    readonly turnId: string;
    readonly itemId: string;
    readonly plan: WorkspaceGitApprovalPlan;
    readonly deadlineAt: string;
  }): WorkspaceGitAutomationInput | WorkspaceGitAutomationInputV4 | undefined {
    const origin = this.#workspaceGitAutomationOrigins.get(input.sessionId);
    const plan = workspaceGitAutomationPlan(input.plan);
    if (origin === undefined || plan === undefined) return undefined;
    const context: WorkspaceGitAutomationContext = {
      invocation_id: randomUUID(),
      deadline_at: input.deadlineAt,
      koe_id: this.#koeId!,
      app_server: {
        method: "item/tool/requestUserInput",
        rpc_request_id: input.serverRequest.id,
        thread_id: input.sessionId,
        turn_id: input.turnId,
        item_id: input.itemId,
        question_id: "git_approval",
        is_blocking: true,
      },
      slack: {
        team_id: origin.teamId,
        app_id: origin.appId,
        channel_id: origin.channelId,
        root_thread_ts: origin.rootThreadTs,
        source_message_ts: origin.messageTs,
        user_id: origin.userId,
      },
    };
    if (
      this.#workspaceGitAutomationProvider?.contract_version ===
        WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4
    ) {
      const revisions = this.#workspaceGitAutomationRevisions;
      if (!validWorkspaceGitAutomationRevisions(revisions)) return undefined;
      const contextV4: WorkspaceGitAutomationContextV4 = {
        ...context,
        koe_binding_revision: revisions.koeBindingRevision,
        principal_policy_revision: revisions.principalPolicyRevision,
      };
      return {
        contract_version: WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4,
        plan,
        context: contextV4,
      };
    }
    return {
      contract_version: WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION,
      plan,
      context,
    };
  }

  async #resolveWorkspaceGitAutomation(input: {
    readonly key: string;
    readonly pending: PendingWorkspaceGitAutomation;
    readonly input: WorkspaceGitAutomationInput | WorkspaceGitAutomationInputV4;
    readonly plan: WorkspaceGitApprovalPlan;
    readonly turnId: string;
    readonly queue: AsyncEventQueue;
    readonly presentManualApproval: () => void;
  }): Promise<void> {
    let result;
    try {
      const provider = this.#workspaceGitAutomationProvider!;
      result = provider.contract_version === WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4 &&
          input.input.contract_version === WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION_V4
        ? validateWorkspaceGitAutomationResultV4(
            input.input,
            await provider.executePreparedPlan(input.input),
          )
        : provider.contract_version === WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION &&
            input.input.contract_version === WORKSPACE_GIT_AUTOMATION_CONTRACT_VERSION
          ? validateWorkspaceGitAutomationResult(
              input.input,
              await provider.executePreparedPlan(input.input),
            )
          : (() => {
              throw new Error("Workspace Git automation contract changed");
            })();
    } catch {
      result = {
        status: "blocked" as const,
        operation_id: input.input.plan.operation_id,
        plan_hash: input.input.plan.plan_hash,
        reason: "outcome_unknown" as const,
      };
    }
    const pending = this.#pendingWorkspaceGitAutomations.get(input.key);
    if (
      pending !== input.pending ||
      pending.abortController.signal.aborted
    ) {
      return;
    }
    this.#pendingWorkspaceGitAutomations.delete(input.key);
    if (result.status === "manual") {
      input.presentManualApproval();
      return;
    }
    try {
      this.#workspaceGitApprovals.consumeExactPlan(
        input.pending.sessionId,
        input.turnId,
        input.plan,
      );
    } catch {
      this.#client.respondError(input.pending.rpcId, {
        code: -32000,
        message:
          "WORKSPACE_GIT_AUTOMATION_BLOCKED: Exact plan binding changed; " +
          "do not retry or fall back to public execution",
      });
      input.queue.push({
        type: "git_automation.blocked",
        plan: input.plan,
        reason: "outcome_unknown",
      });
      return;
    }
    if (result.status === "terminal_executed") {
      this.#client.respondError(input.pending.rpcId, {
        code: -32000,
        message:
          "WORKSPACE_GIT_AUTOMATION_TERMINAL_EXECUTED: The private provider " +
          "completed this exact plan. Do not call a public execute tool or retry it.",
        data: {
          operation_id: result.operation_id,
          plan_hash: result.plan_hash,
          status: result.status,
        },
      });
      input.queue.push({
        type: "git_automation.executed",
        plan: input.plan,
      });
    } else {
      this.#client.respondError(input.pending.rpcId, {
        code: -32000,
        message:
          `WORKSPACE_GIT_AUTOMATION_BLOCKED: ${result.reason}. ` +
          "Do not retry or fall back to public execution.",
        data: {
          operation_id: result.operation_id,
          plan_hash: result.plan_hash,
          status: result.status,
          reason: result.reason,
        },
      });
      input.queue.push({
        type: "git_automation.blocked",
        plan: input.plan,
        reason: result.reason,
      });
    }
    this.#statuses.set(input.pending.sessionId, "running");
    input.queue.push({ type: "status.changed", status: "running" });
  }

  #abortWorkspaceGitAutomations(sessionId: string): void {
    for (const [key, pending] of this.#pendingWorkspaceGitAutomations) {
      if (pending.sessionId !== sessionId) continue;
      this.#pendingWorkspaceGitAutomations.delete(key);
      pending.abortController.abort();
    }
  }

  #requestExternalActionApprovalRepair(
    rpcId: RpcId,
    sessionId: string,
    turnId: string,
  ): boolean {
    const key = turnKey(sessionId, turnId);
    const state = this.#externalActionApprovalRepairStates.get(key);
    if (state === "closed") {
      this.#respondExternalActionApprovalRepairExhausted(rpcId);
      return true;
    }
    if (state !== undefined) {
      this.#externalActionApprovalRepairStates.set(key, "closed");
      return false;
    }
    this.#externalActionApprovalRepairStates.set(key, "retry_pending");
    this.#client.respondError(rpcId, {
      code: -32602,
      message:
        "EXTERNAL_ACTION_APPROVAL_RETRY_REQUIRED: Retry request_user_input " +
        "exactly once in this turn as a direct tool call, never through " +
        "functions.exec, code mode, another dynamic tool, shell, or a " +
        "relaying agent. Use one question whose id is " +
        "external_action_approval and exactly two options in this order: " +
        "承認して実行 (the client-required suffix (Recommended) is accepted), " +
        "拒否・保留. Do not otherwise rename, reorder, or add an option. " +
        "Both descriptions must be non-empty. " +
        "Use exactly one non-empty line for each required question field: " +
        "Target: <target>, Scope: <scope>, Impact: <impact>. isBlocking must " +
        "be true and isSecret must be false. Do not execute the external " +
        "action before the corrected answer approves it.",
      data: {
        recovery: "retry_external_action_approval",
        attempt: 1,
        questionId: "external_action_approval",
        requiredQuestionFields: ["Target", "Scope", "Impact"],
        requiredOptionLabels: ["承認して実行", "拒否・保留"],
        requireNonEmptyDescriptions: true,
        requireBlocking: true,
        forbidOtherAnswer: true,
        forbidSecret: true,
      },
    });
    return true;
  }

  #acceptExternalActionApprovalRepair(
    rpcId: RpcId,
    sessionId: string,
    turnId: string,
  ): boolean {
    const key = turnKey(sessionId, turnId);
    const state = this.#externalActionApprovalRepairStates.get(key);
    if (state === "closed") {
      this.#respondExternalActionApprovalRepairExhausted(rpcId);
      return false;
    }
    if (this.#hasPendingExternalActionApproval(sessionId)) {
      this.#client.respondError(rpcId, {
        code: -32602,
        message:
          "EXTERNAL_ACTION_APPROVAL_ALREADY_PENDING: Wait for the current " +
          "blocking external-action confirmation to resolve before requesting " +
          "another one. Do not execute either action without its own answer.",
        data: {
          recovery: "wait_for_external_action_approval",
          questionId: "external_action_approval",
        },
      });
      return false;
    }
    if (state === "retry_pending") {
      this.#externalActionApprovalRepairStates.delete(key);
    }
    return true;
  }

  #hasPendingExternalActionApproval(sessionId: string): boolean {
    for (const pending of this.#pendingUserInputs.values()) {
      if (
        pending.kind === "choice" &&
        pending.sessionId === sessionId &&
        pending.questions.some(
          (question) => question.purpose === "external_action_confirmation",
        )
      ) {
        return true;
      }
    }
    return false;
  }

  #respondExternalActionApprovalRepairExhausted(rpcId: RpcId): void {
    this.#client.respondError(rpcId, {
      code: -32602,
      message:
        "EXTERNAL_ACTION_APPROVAL_REPAIR_EXHAUSTED: The one same-turn " +
        "structured-input repair was already used. Do not call " +
        "request_user_input again or execute the external action in this turn.",
      data: {
        recovery: "stop_external_action_approval",
        questionId: "external_action_approval",
      },
    });
  }

  #clearExternalActionApprovalRepairStates(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#externalActionApprovalRepairStates.keys()) {
      if (key.startsWith(prefix)) {
        this.#externalActionApprovalRepairStates.delete(key);
      }
    }
  }

  #resolveAppOpsApprovalPlan(
    sessionId: string,
    turnId: string,
    approvalPrompt: string | undefined,
  ): AppOpsApprovalPlanCapture | undefined {
    if (approvalPrompt === undefined) return undefined;
    const captures = this.#appOpsPlansByTurn.get(turnKey(sessionId, turnId)) ?? [];
    const matches = captures.filter(
      (capture) => capture.approvalPrompt === approvalPrompt,
    );
    if (matches.length > 1) {
      throw new Error("More than one AppOps plan matches this approval request");
    }
    return matches[0];
  }

  #consumeAppOpsApprovalPlan(
    sessionId: string,
    plan: AppOpsApprovalProofPlan,
  ): void {
    for (const [key, captures] of this.#appOpsPlansByTurn) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue;
      const remaining = captures.filter(
        (capture) =>
          capture.plan.operationId !== plan.operationId ||
          capture.plan.planHash !== plan.planHash,
      );
      if (remaining.length === 0) this.#appOpsPlansByTurn.delete(key);
      else this.#appOpsPlansByTurn.set(key, remaining);
    }
  }

  #clearAppOpsPlans(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#appOpsPlansByTurn.keys()) {
      if (key.startsWith(prefix)) this.#appOpsPlansByTurn.delete(key);
    }
    if (this.#koeId !== undefined) {
      this.#appOpsApprovalProofBroker?.clearSession(this.#koeId, sessionId);
    }
  }

  #waitForWorkspaceGitPlan(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue,
    receivedAt: number,
  ): void {
    const key = rpcKey(serverRequest.id);
    if (this.#pendingUserInputBindings.has(key)) {
      throw new Error("Structured input request is already waiting for a Git plan");
    }
    const expirationTimer = setTimeout(() => {
      const pending = this.#pendingUserInputBindings.get(key);
      if (pending === undefined) return;
      this.#pendingUserInputBindings.delete(key);
      this.#handleUserInputRequest(
        pending.serverRequest,
        pending.sessionId,
        pending.queue,
        false,
        pending.receivedAt,
      );
    }, this.#options.gitPlanBindingGraceMs);
    expirationTimer.unref();
    this.#pendingUserInputBindings.set(key, {
      rpcId: serverRequest.id,
      serverRequest,
      sessionId,
      turnId,
      queue,
      receivedAt,
      expirationTimer,
    });
  }

  #retryPendingUserInputBindings(sessionId: string, turnId: string): void {
    for (const [key, pending] of this.#pendingUserInputBindings) {
      if (pending.sessionId !== sessionId || pending.turnId !== turnId) continue;
      clearTimeout(pending.expirationTimer);
      this.#pendingUserInputBindings.delete(key);
      this.#handleUserInputRequest(
        pending.serverRequest,
        pending.sessionId,
        pending.queue,
        false,
        pending.receivedAt,
      );
    }
  }

  #queueExternallyResolvedUserInputPlans(
    sessionId: string,
    turnId: string,
  ): void {
    const matchingBindings = [...this.#externallyResolvedUserInputBindings]
      .filter(([, pending]) =>
        pending.sessionId === sessionId && pending.turnId === turnId
      );
    if (matchingBindings.length === 0) return;

    const plans = this.#workspaceGitApprovals.takeTurnPlans(sessionId, turnId);
    if (plans.length === 0) return;

    // The App Server request has already been resolved elsewhere, so no Slack
    // decision can authorize any plan captured for this binding. Emit each
    // exact plan once so the frontend can durably reject its private broker
    // operation. Multiple plans are intentionally all rejected: their mapping
    // is ambiguous and choosing one would manufacture approval authority.
    const queue = matchingBindings[0]![1].queue;
    for (const plan of plans) {
      this.#enqueueExternalGitRejection({
        requestId: `codex-input:${randomUUID()}`,
        sessionId,
        plan,
        queue,
      });
    }
  }

  #enqueueExternalGitRejection(pending: PendingExternalGitRejection): void {
    const existing = this.#pendingExternalGitRejections.get(pending.requestId);
    if (existing !== undefined) {
      if (
        existing.sessionId !== pending.sessionId ||
        !sameExactWorkspaceGitApprovalPlan(existing.plan, pending.plan)
      ) {
        pending.queue.fail(
          new Error("Conflicting external Git rejection request identity"),
        );
      }
      return;
    }
    this.#pendingExternalGitRejections.set(pending.requestId, pending);
    this.#startExternalGitRejectionWorker(pending.sessionId);
  }

  #startExternalGitRejectionWorker(sessionId: string): void {
    if (this.#externalResolutionSettlementsBySession.has(sessionId)) return;
    const settle = async (): Promise<void> => {
      while (true) {
        const entry = [...this.#pendingExternalGitRejections]
          .find(([, pending]) => pending.sessionId === sessionId);
        if (entry === undefined) return;
        const [key, pending] = entry;
        const expiresAt = Date.parse(pending.plan.expiresAt);
        if (expiresAt <= Date.now()) {
          // workspace-git no longer accepts this plan, so there is no approval
          // authority left to preserve in the private broker. Close any
          // visible Slack card and release shutdown without manufacturing a
          // system decision after the exact plan's deadline.
          this.#pendingExternalGitRejections.delete(key);
          this.#rememberExternallyResolvedGitUserInput(
            pending.requestId,
            pending.sessionId,
            pending.plan,
          );
          pending.queue.push({
            type: "git_approval.expired",
            requestId: pending.requestId,
          });
          this.#statuses.set(pending.sessionId, "running");
          pending.queue.push({ type: "status.changed", status: "running" });
          continue;
        }
        if (this.#recordExternallyResolvedGitPlan !== undefined) {
          // A failed state write must not release or forget the private Git
          // operation. Keep retrying this exact plan in the worker itself so
          // recovery does not depend on another App Server event, turn
          // cleanup, or a caller invoking waitForSystemRejections(). Runtime
          // shutdown waits for this worker and therefore cannot report a
          // normal stop while an unrecorded rejection still exists.
          while (true) {
            if (expiresAt <= Date.now()) break;
            try {
              await this.#recordExternallyResolvedGitPlan(pending.plan);
              break;
            } catch {
              const remainingMs = expiresAt - Date.now();
              if (remainingMs <= 0) break;
              await delay(Math.min(
                this.#options.externalGitRejectionRetryMs,
                remainingMs,
              ));
            }
          }
          // The last write may have failed exactly as the plan expired. Let
          // the outer loop terminalize it as expired rather than releasing a
          // resolved event without a durable rejection.
          if (expiresAt <= Date.now()) continue;
        }
        // The exact plan remains in this queue until its durable rejection
        // succeeds. Once durable, losing only the cosmetic Slack event cannot
        // restore approval authority.
        this.#pendingExternalGitRejections.delete(key);
        this.#rememberExternallyResolvedGitUserInput(
          pending.requestId,
          pending.sessionId,
          pending.plan,
        );
        pending.queue.push({
          type: "git_approval.resolved_externally",
          requestId: pending.requestId,
          plan: pending.plan,
          ...(this.#recordExternallyResolvedGitPlan === undefined
            ? {}
            : { systemRejectionRecorded: true as const }),
        });
        this.#statuses.set(pending.sessionId, "running");
        pending.queue.push({ type: "status.changed", status: "running" });
      }
    };
    const task = settle();
    this.#externalResolutionSettlementsBySession.set(sessionId, task);
    void task.then(
      () => {
        if (this.#externalResolutionSettlementsBySession.get(sessionId) === task) {
          this.#externalResolutionSettlementsBySession.delete(sessionId);
        }
      },
      (error: unknown) => {
        if (this.#externalResolutionSettlementsBySession.get(sessionId) === task) {
          this.#externalResolutionSettlementsBySession.delete(sessionId);
        }
        const queue = [...this.#pendingExternalGitRejections.values()]
          .find((pending) => pending.sessionId === sessionId)?.queue ??
          this.#activeQueues.get(sessionId);
        queue?.fail(
          error instanceof Error
            ? error
            : new Error("The external Git rejection could not be persisted"),
        );
      },
    );
  }

  async #rejectPendingUserInputBindings(
    sessionId: string,
    queue: AsyncEventQueue,
    reason: string,
  ): Promise<void> {
    const externallyResolvedTurnIds = new Set<string>();
    for (const pending of this.#externallyResolvedUserInputBindings.values()) {
      if (pending.sessionId === sessionId) {
        externallyResolvedTurnIds.add(pending.turnId);
      }
    }
    for (const turnId of externallyResolvedTurnIds) {
      this.#queueExternallyResolvedUserInputPlans(sessionId, turnId);
    }
    await this.#waitForSessionSystemRejections(sessionId);
    for (const [key, pending] of this.#externallyResolvedUserInputBindings) {
      if (pending.sessionId === sessionId) {
        this.#externallyResolvedUserInputBindings.delete(key);
      }
    }
    for (const [key, pending] of this.#pendingUserInputBindings) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.expirationTimer);
      this.#pendingUserInputBindings.delete(key);
      this.#rejectUserInputBinding(
        pending.serverRequest,
        pending.sessionId,
        pending.turnId,
        queue,
        new Error(reason),
      );
    }
  }

  #rejectUserInputBinding(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string,
    queue: AsyncEventQueue,
    error: Error,
  ): void {
    this.#rejectUnboundGitApproval(
      serverRequest,
      sessionId,
      turnId,
      queue,
      error,
    );
  }

  #rejectUnboundGitApproval(
    serverRequest: ServerRequestEvent,
    sessionId: string,
    turnId: string | undefined,
    queue: AsyncEventQueue,
    error: unknown,
  ): void {
    const message = gitApprovalBindingErrorMessage(error);
    if (turnId !== undefined) {
      this.#workspaceGitApprovals.discardTurnPlans(sessionId, turnId);
    }
    this.#client.respondError(serverRequest.id, {
      code: -32602,
      message,
      data: { recovery: "fresh_workspace_git_prepare_required" },
    });
    if (turnId === undefined) {
      queue.push({
        type: "error",
        message,
        code: "UNBOUND_GIT_APPROVAL",
      });
      return;
    }
    if (!this.#workspaceGitApprovals.markRecoveryRequired(sessionId, turnId)) {
      return;
    }
    queue.push({
      type: "git_approval.reprepare_required",
      message:
        "このGit計画は現在のターンに紐づいていないか、すでに期限切れです。" +
        "古い計画は承認できません。対象のGit操作を新しいメッセージとして明記してください。",
    });
  }

  #failActiveStreams(error: Error, intentionalShutdown = false): void {
    this.#transportFailed = true;
    for (const [sessionId, queue] of this.#activeQueues) {
      if (intentionalShutdown) {
        this.#statuses.set(sessionId, "interrupted");
        queue.push({ type: "status.changed", status: "interrupted" });
        queue.close();
      } else {
        this.#statuses.set(sessionId, "failed");
        queue.fail(error);
      }
    }
    this.#activeQueues.clear();
    for (const sessionId of this.#deferredServerRequestsBySession.keys()) {
      this.#rejectDeferredServerRequests(
        sessionId,
        "Codex app-server transport closed before exact turn correlation",
      );
    }
    this.#activeTurns.clear();
    this.#runningSessions.clear();
    this.#loadedSessions.clear();
    this.#resumeOverridesPendingSessions.clear();
    for (const pending of this.#pendingApprovals.values()) {
      clearTimeout(pending.expirationTimer);
    }
    this.#pendingApprovals.clear();
    for (const pending of this.#pendingUserInputs.values()) {
      clearTimeout(pending.expirationTimer);
    }
    this.#pendingUserInputs.clear();
    for (const pending of this.#pendingWorkspaceGitAutomations.values()) {
      pending.abortController.abort();
    }
    this.#pendingWorkspaceGitAutomations.clear();
    this.#workspaceGitAutomationOrigins.clear();
    this.#externallyResolvedGitUserInputs.clear();
    this.#externallyResolvedUserInputBindings.clear();
    for (const pending of this.#pendingUserInputBindings.values()) {
      clearTimeout(pending.expirationTimer);
    }
    this.#pendingUserInputBindings.clear();
    this.#externalActionApprovalRepairStates.clear();
    this.#appOpsPlansByTurn.clear();
    this.#workspaceGitApprovals.clearAll();
    this.#startedItems.clear();
  }

  #removePendingApprovals(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingApprovals.delete(requestId);
      }
    }
  }

  #removePendingServerRequestByRpcId(
    sessionId: string,
    rpcId: RpcId,
    queue: AsyncEventQueue,
  ): void {
    const deferred = this.#deferredServerRequestsBySession.get(sessionId) ?? [];
    const remainingDeferred: ServerRequestEvent[] = [];
    for (const request of deferred) {
      if (request.id !== rpcId) {
        remainingDeferred.push(request);
        continue;
      }
      const params = asRecord(request.params);
      const turnId = typeof params?.turnId === "string" ? params.turnId : undefined;
      if (
        request.method === "item/tool/requestUserInput" &&
        turnId !== undefined &&
        (hasWorkspaceGitApprovalQuestionId(request.params) ||
          looksLikeWorkspaceGitApproval(request.params))
      ) {
        this.#externallyResolvedUserInputBindings.set(rpcKey(rpcId), {
          sessionId,
          turnId,
          queue,
        });
        this.#queueExternallyResolvedUserInputPlans(sessionId, turnId);
      }
    }
    if (remainingDeferred.length === 0) {
      this.#deferredServerRequestsBySession.delete(sessionId);
    } else {
      this.#deferredServerRequestsBySession.set(sessionId, remainingDeferred);
    }
    const automationKey = rpcKey(rpcId);
    const automation = this.#pendingWorkspaceGitAutomations.get(automationKey);
    if (automation !== undefined) {
      this.#pendingWorkspaceGitAutomations.delete(automationKey);
      automation.abortController.abort();
      try {
        this.#workspaceGitApprovals.consumeExactPlan(
          automation.sessionId,
          automation.turnId,
          automation.plan,
        );
      } catch {
        // The external resolver may already have consumed the exact binding.
      }
      queue.push({
        type: "git_automation.blocked",
        plan: automation.plan,
        reason: "outcome_unknown",
      });
    }
    for (const [requestId, pending] of this.#pendingApprovals) {
      if (pending.rpcId === rpcId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingApprovals.delete(requestId);
      }
    }
    for (const [requestId, pending] of this.#pendingUserInputs) {
      if (pending.rpcId === rpcId) {
        clearTimeout(pending.expirationTimer);
        if (pending.kind === "git_approval") {
          // This callback is synchronous so a queued Slack click cannot reach
          // the private broker after the App Server request disappeared but
          // before the terminal projection is consumed.
          this.#onGitUserInputResolvedExternally?.(
            requestId,
            pending.sessionId,
            pending.plan,
          );
        }
        this.#pendingUserInputs.delete(requestId);
        if (pending.kind === "git_approval") {
          this.#enqueueExternalGitRejection({
            requestId,
            sessionId: pending.sessionId,
            plan: pending.plan,
            queue,
          });
        } else {
          queue.push({
            type: "choice.resolved_externally",
            requestId,
          });
          this.#statuses.set(pending.sessionId, "running");
          queue.push({ type: "status.changed", status: "running" });
        }
      }
    }
    const bindingKey = rpcKey(rpcId);
    const binding = this.#pendingUserInputBindings.get(bindingKey);
    if (binding !== undefined) {
      clearTimeout(binding.expirationTimer);
      this.#pendingUserInputBindings.delete(bindingKey);
      this.#externallyResolvedUserInputBindings.set(bindingKey, {
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        queue: binding.queue,
      });
      this.#queueExternallyResolvedUserInputPlans(
        binding.sessionId,
        binding.turnId,
      );
    }
  }

  #removePendingUserInputs(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingUserInputs) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.expirationTimer);
        this.#pendingUserInputs.delete(requestId);
      }
    }
  }

  #hasPendingGitUserInput(sessionId: string): boolean {
    for (const pending of this.#pendingUserInputs.values()) {
      if (pending.kind === "git_approval" && pending.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  #rememberExternallyResolvedGitUserInput(
    requestId: string,
    sessionId: string,
    plan: WorkspaceGitApprovalPlan,
  ): void {
    this.#externallyResolvedGitUserInputs.delete(requestId);
    this.#externallyResolvedGitUserInputs.set(requestId, {
      sessionId,
      plan,
    });
    while (this.#externallyResolvedGitUserInputs.size > 1_024) {
      const oldest = this.#externallyResolvedGitUserInputs.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#externallyResolvedGitUserInputs.delete(oldest);
    }
  }

  #rejectConcurrentGitUserInput(
    rpcId: RpcId,
    sessionId: string,
    queue = this.#activeQueues.get(sessionId),
  ): void {
    const message =
      "CONCURRENT_GIT_APPROVAL_NOT_SUPPORTED: " +
      "Another exact workspace-git approval is already pending or executing in this turn";
    this.#client.respondError(rpcId, { code: -32000, message });
    queue?.push({
      type: "error",
      code: "CONCURRENT_GIT_APPROVAL_NOT_SUPPORTED",
      message:
        "未完了のGit承認を複数同時には処理できません。" +
        "先の承認処理を維持します。exact executeの完了後は、" +
        "同じターン内でも次の承認要求を表示できます。",
    });
  }

  #rejectInvalidGitApprovalRequest(
    rpcId: RpcId,
    sessionId: string,
    turnId: string | undefined,
    queue: AsyncEventQueue,
    error: unknown,
  ): void {
    const reason = publicStructuredInputError(error);
    const firstInvalidRequest = turnId === undefined
      ? true
      : this.#workspaceGitApprovals.markRequestInvalid(sessionId, turnId);
    if (turnId !== undefined) {
      this.#workspaceGitApprovals.discardTurnPlans(sessionId, turnId);
    }
    this.#client.respondError(rpcId, {
      code: -32602,
      message:
        `INVALID_GIT_APPROVAL_REQUEST: ${reason}. ` +
        "Do not call request_user_input again in this turn. " +
        "The operation remains unapproved; start a new turn and prepare a fresh exact plan.",
    });
    if (!firstInvalidRequest) return;
    queue.push({
      type: "error",
      code: "INVALID_GIT_APPROVAL_REQUEST",
      message:
        "Git承認要求の形式が現行App Server契約と一致しないため、" +
        "承認画面を表示しませんでした。操作は未承認です。" +
        `新しいターンで再試行してください。診断: ${reason}`,
    });
  }

  #rejectCompletedGitUserInput(
    rpcId: RpcId,
    sessionId: string,
    queue = this.#activeQueues.get(sessionId),
  ): void {
    const message =
      "GIT_APPROVAL_OPERATION_ALREADY_COMPLETED: " +
      "This exact workspace-git operation has already completed";
    this.#client.respondError(rpcId, { code: -32000, message });
    queue?.push({
      type: "error",
      code: "GIT_APPROVAL_OPERATION_ALREADY_COMPLETED",
      message:
        "このGit操作はすでに完了しているため、承認画面を再表示しません。" +
        "同じoperationの再実行も行いません。",
    });
  }

  #settleGitUserInput(
    requestId: string,
    pending: PendingGitUserInput,
    optionId: AgentGitApprovalInputResponse["optionId"],
  ): void {
    const label = optionId === "approve" ? pending.approveLabel : pending.rejectLabel;
    let executionStarted = false;
    if (optionId === "approve") {
      if (this.#workspaceGitApprovals.approvedPlan(pending.sessionId) !== undefined) {
        clearTimeout(pending.expirationTimer);
        this.#pendingUserInputs.delete(requestId);
        this.#rejectConcurrentGitUserInput(pending.rpcId, pending.sessionId);
        throw new Error("Another workspace-git approved execution is already active");
      }
      this.#workspaceGitApprovals.beginApprovedExecution(
        pending.sessionId,
        pending.plan,
      );
      executionStarted = true;
    }
    clearTimeout(pending.expirationTimer);
    this.#pendingUserInputs.delete(requestId);
    try {
      this.#client.respondToUserInput(pending.rpcId, {
        answers: { [pending.questionId]: { answers: [label] } },
      });
    } catch (error) {
      if (executionStarted) {
        this.#workspaceGitApprovals.clearApprovedExecution(
          pending.sessionId,
          pending.plan,
        );
      }
      throw error;
    }
  }

  #observeApprovedGitExecution(
    sessionId: string,
    item: Record<string, unknown>,
    queue: AsyncEventQueue,
  ): void {
    const observation = this.#workspaceGitApprovals.observeItem(sessionId, item);
    if (observation.duplicateExecutionDetected) {
      this.#pushDuplicateGitExecutionError(queue);
    }
  }

  async #hydrateCompletedTurn(
    sessionId: string,
    turnId: string,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      !this.#legacyPaginatedCompatibilitySessions.has(sessionId) &&
      this.#turnPaginationSupported !== false
    ) {
      try {
        const page = await this.#client.listThreadTurns(sessionId, {
          limit: 50,
          sortDirection: "desc",
          itemsView: "full",
        });
        this.#turnPaginationSupported = true;
        const paginatedTurn = asRecord(
          page.data.find((candidate) => candidate.id === turnId),
        );
        if (hasFullTurnItems(paginatedTurn)) return paginatedTurn;
      } catch (error) {
        if (isPaginatedThreadsUnsupported(error)) {
          this.#turnPaginationSupported = false;
        }
      }
    }

    try {
      const thread = await this.#client.readThread(sessionId, true);
      const legacyTurn = asRecord(
        thread.turns?.find((candidate) => candidate.id === turnId),
      );
      return hasFullTurnItems(legacyTurn) ? legacyTurn : undefined;
    } catch {
      return undefined;
    }
  }

  #observeApprovedGitTurnSnapshot(
    sessionId: string,
    turn: Record<string, unknown> | undefined,
    queue: AsyncEventQueue,
  ): void {
    const observation = this.#workspaceGitApprovals.observeTurnSnapshot(
      sessionId,
      turn,
    );
    if (observation.duplicateExecutionDetected) {
      this.#pushDuplicateGitExecutionError(queue);
    }
  }

  #pushDuplicateGitExecutionError(queue: AsyncEventQueue): void {
    queue.push({
      type: "error",
      code: "GIT_APPROVAL_EXECUTION_REPLAY",
      message:
        "同じ承認済みGit operationへの複数回の実行要求を検出しました。" +
        "workspace-gitの再実行防止結果を確認してください。",
    });
  }

  #acceptChoiceAnswer(
    requestId: string,
    pending: PendingChoiceUserInput,
    answer: AgentChoiceAnswer,
  ): boolean {
    const question = pending.questions[pending.currentQuestionIndex];
    if (question === undefined || answer.questionId !== question.id) {
      throw new Error("Structured input answer does not match the current question");
    }
    let value: string;
    if ("optionId" in answer && answer.optionId !== undefined) {
      const option = question.options.find(
        (candidate) => candidate.id === answer.optionId,
      );
      if (option === undefined) {
        throw new Error("Structured input answer is not one of the displayed options");
      }
      value = option.appServerLabel;
    } else {
      if (!question.allowsOther || !("text" in answer)) {
        throw new Error("This structured input question does not allow free text");
      }
      value = answer.text.trim();
      if (value.length < 1 || value.length > 1_000) {
        throw new Error("Structured input free text must be between 1 and 1000 characters");
      }
    }
    pending.answers.set(question.appServerQuestionId, Object.freeze([value]));
    pending.currentQuestionIndex += 1;
    if (pending.currentQuestionIndex < pending.questions.length) {
      const queue = this.#activeQueues.get(pending.sessionId);
      if (queue === undefined) {
        this.#cancelUserInput(requestId, pending);
        throw new Error("Structured input turn is no longer active");
      }
      this.#pushCurrentChoice(requestId, pending, queue);
      return false;
    }

    let appOpsApprovalProof: string | undefined;
    if (pending.appOpsPlan !== undefined && value === "承認して実行") {
      try {
        const signer = this.#appOpsApprovalProofSigner;
        const broker = this.#appOpsApprovalProofBroker;
        if (
          signer === undefined ||
          broker === undefined ||
          this.#koeId === undefined ||
          pending.appOpsTurnId === undefined
        ) {
          throw new Error("AppOps approval proof handoff is unavailable");
        }
        appOpsApprovalProof = signer.issue(pending.appOpsPlan);
        broker.register({
          agentId: this.#koeId,
          sessionId: pending.sessionId,
          turnId: pending.appOpsTurnId,
          plan: pending.appOpsPlan,
          proof: appOpsApprovalProof,
        });
      } catch {
        clearTimeout(pending.expirationTimer);
        this.#pendingUserInputs.delete(requestId);
        this.#consumeAppOpsApprovalPlan(pending.sessionId, pending.appOpsPlan);
        this.#client.respondError(pending.rpcId, {
          code: -32000,
          message:
            "APPOPS_APPROVAL_PROOF_FAILED: The approved AppOps proof could not " +
            "be issued. Do not call AppOps execute; prepare a fresh operation.",
        });
        throw new Error(
          "AppOps approval proof issuance failed; the Store operation remains blocked",
        );
      }
    }
    clearTimeout(pending.expirationTimer);
    this.#pendingUserInputs.delete(requestId);
    if (pending.appOpsPlan !== undefined) {
      this.#consumeAppOpsApprovalPlan(pending.sessionId, pending.appOpsPlan);
    }
    this.#client.respondToUserInput(pending.rpcId, {
      answers: Object.fromEntries(
        [...pending.answers].map(([questionId, answers]) => [
          questionId,
          { answers },
        ]),
      ),
    });
    return true;
  }

  #pushCurrentChoice(
    requestId: string,
    pending: PendingChoiceUserInput,
    queue: AsyncEventQueue,
  ): void {
    const question = pending.questions[pending.currentQuestionIndex];
    if (question === undefined) {
      throw new Error("Structured input has no current question");
    }
    queue.push({
      type: "choice.requested",
      requestId,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      completedAnswers: pending.questions
        .slice(0, pending.currentQuestionIndex)
        .flatMap((completedQuestion) => {
          const answers = pending.answers.get(
            completedQuestion.appServerQuestionId,
          );
          return answers === undefined
            ? []
            : [{
              header: completedQuestion.header,
              prompt: completedQuestion.prompt,
              answers,
            }];
        }),
      question: {
        id: question.id,
        ...(question.purpose === "external_action_confirmation"
          ? { purpose: question.purpose }
          : {}),
        header: question.header,
        prompt: question.prompt,
        options: question.options.map(({ id, label, description }) => ({
          id,
          label,
          description,
        })),
        allowsOther: question.allowsOther,
      },
    });
  }

  #expireUserInput(requestId: string, pending: PendingUserInput): void {
    if (pending.kind === "git_approval") {
      this.#expireGitUserInput(requestId, pending);
      return;
    }
    this.#cancelUserInput(requestId, pending, "Structured input request expired");
  }

  #expireGitUserInput(
    requestId: string,
    pending: PendingGitUserInput,
  ): void {
    clearTimeout(pending.expirationTimer);
    this.#pendingUserInputs.delete(requestId);
    this.#statuses.set(pending.sessionId, "running");
    const queue = this.#activeQueues.get(pending.sessionId);
    queue?.push({ type: "git_approval.expired", requestId });
    queue?.push({ type: "status.changed", status: "running" });
    try {
      this.#client.respondToUserInput(pending.rpcId, {
        answers: { [pending.questionId]: { answers: [pending.rejectLabel] } },
      });
    } catch (error) {
      // The Slack card must still become terminal even when the App Server
      // transport fails while rejecting the expired request. Preserve already
      // queued projection events, then surface the transport failure.
      queue?.failAfterQueued(error);
      throw error;
    }
  }

  #cancelUserInput(
    requestId: string,
    pending: PendingUserInput,
    reason = "Structured input could not be displayed",
  ): void {
    if (pending.kind === "git_approval") {
      this.#settleGitUserInput(requestId, pending, "reject");
      return;
    }
    clearTimeout(pending.expirationTimer);
    this.#pendingUserInputs.delete(requestId);
    this.#client.respondError(pending.rpcId, {
      code: -32000,
      message: reason,
    });
  }

  #resumeAfterUserInput(sessionId: string): void {
    this.#statuses.set(sessionId, "running");
    this.#activeQueues.get(sessionId)?.push({
      type: "status.changed",
      status: "running",
    });
  }

  #rememberWorkspaceGitPlan(
    sessionId: string,
    turnId: string,
    plan: WorkspaceGitApprovalPlan,
  ): void {
    this.#workspaceGitApprovals.rememberPlan(sessionId, turnId, plan);
  }

  #respondToPendingApproval(
    pending: PendingApproval,
    decision: CommandApprovalDecision,
  ): void {
    if (pending.method === "item/commandExecution/requestApproval") {
      this.#client.respondToCommandApproval(pending.rpcId, decision);
      return;
    }
    const simpleDecision = typeof decision === "string" ? decision : "cancel";
    if (pending.method === "item/fileChange/requestApproval") {
      this.#client.respondToFileChangeApproval(pending.rpcId, simpleDecision);
    } else if (pending.method === "mcpServer/elicitation/request") {
      this.#client.respondToMcpServerElicitation(pending.rpcId, {
        action:
          simpleDecision === "accept" || simpleDecision === "acceptForSession"
            ? "accept"
            : simpleDecision,
        content: null,
        _meta:
          simpleDecision === "acceptForSession"
            ? { persist: "session" }
            : null,
      });
    } else {
      const granted =
        simpleDecision === "accept" || simpleDecision === "acceptForSession"
          ? pending.requestedPermissions ?? {}
          : {};
      this.#client.respondToPermissionsApproval(pending.rpcId, {
        permissions: granted,
        scope: simpleDecision === "acceptForSession" ? "session" : "turn",
      });
    }
  }

  #removeStartedItems(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.#startedItems.keys()) {
      if (key.startsWith(prefix)) this.#startedItems.delete(key);
    }
  }

  async #reconcileTurnStatus(
    sessionId: string,
    ownedTurnId: string,
  ): Promise<
    | { readonly kind: "active" }
    | { readonly kind: "terminal"; readonly turn: CodexTurn }
    | { readonly kind: "retry" }
  > {
    if (this.#turnPaginationSupported !== false) {
      try {
        const page = await this.#client.listThreadTurns(sessionId, {
          limit: 50,
          sortDirection: "desc",
          itemsView: "notLoaded",
        });
        this.#turnPaginationSupported = true;
        const turn = page.data.find(({ id }) => id === ownedTurnId);
        if (turn === undefined) return { kind: "retry" };
        if (turn.status === "inProgress") {
          return { kind: "active" };
        }
        if (
          turn.status === "completed" ||
          turn.status === "interrupted" ||
          turn.status === "failed"
        ) {
          return { kind: "terminal", turn };
        }
        return { kind: "retry" };
      } catch (error) {
        if (!isPaginatedThreadsUnsupported(error)) return { kind: "retry" };
        this.#turnPaginationSupported = false;
      }
    }

    // Some App Server builds advertise thread/turns/list in their generated
    // schema while the selected backend still rejects paginated_threads. In
    // that compatibility mode, aggregate active is conservative: it never
    // declares our turn complete while any turn remains active.
    try {
      const thread = await this.#client.readThread(sessionId, true);
      const status = threadStatusType(thread);
      if (status === "active") return { kind: "active" };
      if (status === "idle" || status === "notLoaded") {
        return {
          kind: "terminal",
          turn: thread.turns?.find(({ id }) => id === ownedTurnId) ?? {
            id: ownedTurnId,
            status: "completed",
            itemsView: "notLoaded",
          },
        };
      }
      if (status === "systemError") {
        return {
          kind: "terminal",
          turn: thread.turns?.find(({ id }) => id === ownedTurnId) ?? {
            id: ownedTurnId,
            status: "failed",
            itemsView: "notLoaded",
          },
        };
      }
      return { kind: "retry" };
    } catch {
      return { kind: "retry" };
    }
  }

  async #reconcileAndInterruptAmbiguousTurn(sessionId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const knownTurnId = this.#activeTurns.get(sessionId);
      if (knownTurnId !== undefined) {
        try {
          await this.#client.interruptTurn(sessionId, knownTurnId);
          return true;
        } catch {
          // Reconcile again; if interruption cannot be confirmed, close app-server.
        }
      }
      try {
        const thread = await this.#client.readThread(sessionId);
        const status = threadStatusType(thread);
        if (status === "idle" || status === "notLoaded") {
          return true;
        }
        if (status === "systemError") {
          // The thread has no live turn to interrupt. A failed model request
          // may leave this terminal status while keeping the persisted thread
          // available for a later resume.
          return true;
        }
        if (status === "active" && knownTurnId === undefined) {
          // This may be a turn started concurrently by Codex App. Never
          // interrupt a turn that this adapter did not observe or create.
          // A rejected turn/start can also report active briefly before its
          // terminal systemError arrives, so re-read for a bounded interval
          // before closing the transport as an ambiguous-state fallback.
        }
      } catch {
        // A transient read failure is inconclusive; retry while notifications stay subscribed.
      }
      if (attempt < 2) {
        await delay(this.#options.ambiguousStartRetryMs * 2 ** attempt);
      }
    }
    return false;
  }
}

function withoutExcludeTurns(params: ThreadResumeParams): ThreadResumeParams {
  const { excludeTurns: _excludeTurns, ...compatible } = params;
  return compatible;
}

function isPaginatedThreadsUnsupported(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    error.code === -32601 &&
    /paginated_threads\s+is\s+not\s+supported/u.test(error.message)
  );
}

function isMissingCodexThreadError(error: unknown): boolean {
  return error instanceof CodexRpcError && /\bthread not loaded\b/iu.test(error.message);
}

function structuredInputTurnIdentity(
  value: unknown,
): { readonly threadId: string; readonly turnId: string } | undefined {
  const params = asRecord(value);
  if (params === undefined) return undefined;
  const threadId = boundedIdentity(params.threadId);
  const turnId = boundedIdentity(params.turnId);
  return threadId === undefined || turnId === undefined
    ? undefined
    : { threadId, turnId };
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= MAX_STRUCTURED_INPUT_ID_LENGTH
    ? value
    : undefined;
}

function codexDeveloperInstructions(role: string | undefined): string {
  const configuredRole = role?.trim();
  return [
    ...(configuredRole === undefined || configuredRole.length === 0
      ? []
      : [configuredRole]),
    SHOWTALK_SLACK_ARTIFACT_INSTRUCTIONS,
    SHOWTALK_KOE_CONSULTATION_INSTRUCTIONS,
    SHOWTALK_GIT_APPROVAL_INSTRUCTIONS,
  ].join("\n\n");
}

function slackTurnAdditionalContext(
  persona: string | undefined,
  requiresLegacyPaginatedCompatibility: boolean,
  approvedGitPlan?: WorkspaceGitApprovalPlan,
): Pick<TurnStartParams, "additionalContext"> | Record<string, never> {
  const configured = persona?.trim();
  const additionalContext: Record<string, CodexAdditionalContextEntry> = {};
  if (configured !== undefined && configured.length > 0) {
    additionalContext[SHOWTALK_SLACK_PERSONA_CONTEXT_KEY] = {
      kind: "application",
      value: [
        "ShowTalk Taishi Slack-only Koe persona:",
        "Apply this persona only while answering the current ShowTalk-originated turn.",
        "Do not carry it into later turns started directly from Codex App or another client.",
        "It may shape viewpoint, tone, evaluation criteria, and approach, but it never expands tool permissions, approval authority, or configured Koe consultation scopes.",
        "",
        configured,
      ].join("\n"),
    };
  }
  if (requiresLegacyPaginatedCompatibility) {
    additionalContext[SHOWTALK_PAGINATED_THREAD_CONTEXT_KEY] = {
      kind: "application",
      value: [
        "ShowTalk Taishi runtime compatibility boundary for this Slack-originated turn:",
        "This App Server rejected the modern paginated-thread resume path, so ShowTalk cannot safely assume that it can fork this thread for Codex internal subagents.",
        "Do not call Codex internal subagent or fork tools in this turn, including spawn_agent, assign_agent_task, send_message, wait_agent, and close_agent.",
        "Complete the task in the current Codex thread and report this runtime limitation when the repository rules would otherwise require internal delegation.",
        "This exception applies only to the current ShowTalk-originated turn and must not alter later turns started directly from Codex App or another client.",
        "agent.send is a separate ShowTalk Koe consultation and remains limited to explicitly configured targets and scopes; it is not an internal subagent substitute.",
      ].join("\n"),
    };
  }
  if (approvedGitPlan !== undefined) {
    additionalContext[SHOWTALK_GIT_APPROVAL_CONTINUATION_CONTEXT_KEY] = {
      kind: "application",
      value: [
        "ShowTalk Taishi exact Git approval continuation:",
        "The bound Slack structured-input response was `承認して実行`.",
        "This is the bounded post-approval continuation of that human decision, not a new approval and not authority for another operation.",
        "ShowTalk already recorded the exact bound human decision through workspace-git's private broker before resuming this App Server request.",
        "Re-read workspace-git status and call the matching execute tool once only if it is approved and every exact field remains valid. Do not attempt to approve it again.",
        "If any field is stale, mismatched, expired, rejected, already executed, or inconclusive, fail closed and report it without preparing or executing a substitute plan.",
        JSON.stringify(approvedGitPlan),
      ].join("\n"),
    };
  }
  if (Object.keys(additionalContext).length === 0) return {};
  return {
    additionalContext,
  };
}

function gitApprovalBindingErrorMessage(error: unknown): string {
  const reason =
    error instanceof Error
      ? error.message
      : "Could not bind structured input to an exact Git plan";
  return (
    `REPREPARE_REQUIRED: ${reason}. ` +
    "Do not call request_user_input again in this turn. " +
    "get_git_operation_status does not bind an approval plan. " +
    "Do not use agent.send or another Slack channel to recover this approval. " +
    "End this turn without preparing or requesting another Git approval. " +
    "The human must send a new explicit Git request to the Koe that owns the operation. " +
    "Only in that new turn, inspect workspace-git status, re-run the matching " +
    "workspace-git plan operation, and request the fixed structured approval."
  );
}

class RepreparableGitApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepreparableGitApprovalError";
  }
}

class InvalidGitApprovalRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitApprovalRequestError";
  }
}

function publicStructuredInputError(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.slice(0, 500)
    : "Unsupported ordinary structured input";
}

function buildTurnInput(request: SendMessageRequest): TurnStartParams["input"] {
  const attachments = request.attachments ?? [];
  const audio = attachments.filter((attachment) => attachment.kind === "audio");
  const audioNotice =
    audio.length === 0
      ? ""
      :
        "\n\nSlack audio attachments were saved as local files. " +
        "Codex App Server does not provide native audio input for normal turns; " +
        "use available local tools to inspect or transcribe them, and say clearly if that is unavailable.\n" +
        audio
          .map((attachment) =>
            JSON.stringify({
              name: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
              path: attachment.path,
            }),
          )
          .join("\n");

  return [
    {
      type: "text",
      text: `${request.text}${audioNotice}`,
      text_elements: [],
    },
    ...attachments
      .filter((attachment) => attachment.kind === "image")
      .map((attachment) => ({
        type: "localImage" as const,
        path: attachment.path,
      })),
  ];
}

function assertTurnStartDeadline(request: SendMessageRequest): void {
  const deadline = request.startNotAfterMs;
  if (deadline === undefined) return;
  if (!Number.isSafeInteger(deadline) || deadline < 0 || Date.now() >= deadline) {
    throw new CoreError(
      "SESSION_AGENT_MISMATCH",
      "The structured answer expired before Codex turn/start",
    );
  }
}

function toAdapterSession(thread: CodexThread): AdapterSession {
  return {
    id: thread.id,
    state: {
      backendThreadId: thread.id,
      ...(thread.sessionId === undefined ? {} : { sessionId: thread.sessionId }),
    },
  };
}

function workspaceGitAutomationSlackOrigin(
  request: SendMessageRequest,
): WorkspaceGitAutomationSlackOrigin | undefined {
  if (request.source.type !== "human") return undefined;
  const metadata = request.metadata;
  const teamId = metadata?.showtalkSlackTeamId;
  const appId = metadata?.showtalkSlackAppId;
  const channelId = metadata?.showtalkChannelId;
  const rootThreadTs = metadata?.showtalkRootThreadTs;
  const messageTs = metadata?.showtalkMessageTs;
  const userId = metadata?.showtalkSlackUserId;
  if (
    typeof teamId !== "string" ||
    typeof appId !== "string" ||
    typeof channelId !== "string" ||
    typeof rootThreadTs !== "string" ||
    typeof messageTs !== "string" ||
    typeof userId !== "string" ||
    request.source.slackUserId !== userId ||
    !/^T[A-Z0-9]{1,127}$/u.test(teamId) ||
    !/^A[A-Z0-9]{1,127}$/u.test(appId) ||
    !/^[CGD][A-Z0-9]{1,127}$/u.test(channelId) ||
    !/^[UW][A-Z0-9]{1,127}$/u.test(userId) ||
    !/^\d{1,20}\.\d{1,20}$/u.test(rootThreadTs) ||
    !/^\d{1,20}\.\d{1,20}$/u.test(messageTs)
  ) {
    return undefined;
  }
  return { teamId, appId, channelId, rootThreadTs, messageTs, userId };
}

function workspaceGitAutomationPlan(
  plan: WorkspaceGitApprovalPlan,
): WorkspaceGitPreparedPlan | undefined {
  if (plan.branch === "main") return undefined;
  let capabilities: WorkspaceGitPreparedPlan["capabilities"];
  if (plan.operation === "existing_pull_request_update") {
    capabilities = ["commit", "push"];
  } else if (plan.operation === "git_publication") {
    switch (plan.mode) {
      case "commit_only":
        capabilities = ["commit"];
        break;
      case "push_existing":
        capabilities = ["push"];
        break;
      case "commit_and_push":
        capabilities = ["commit", "push"];
        break;
      case "push_existing_and_open_draft_pr":
        capabilities = ["push", "draft_pr"];
        break;
      case "commit_push_and_open_draft_pr":
        capabilities = ["commit", "push", "draft_pr"];
        break;
      case "initial_commit_and_push":
      case "initial_push_existing":
        return undefined;
    }
  } else {
    return undefined;
  }
  return {
    operation_id: plan.operationId,
    plan_hash: plan.planHash,
    approval_target: plan.approvalTarget,
    repo_id: plan.repoId,
    expires_at: plan.expiresAt,
    environment: plan.environment ?? "development",
    capabilities,
    branch: plan.branch,
    paths: plan.paths,
    expected_head: plan.expectedHead,
    expected_snapshot_id: plan.expectedSnapshotId,
  };
}

function validWorkspaceGitAutomationRevisions(
  value:
    | {
        readonly koeBindingRevision: number;
        readonly principalPolicyRevision: number;
      }
    | undefined,
): value is {
  readonly koeBindingRevision: number;
  readonly principalPolicyRevision: number;
} {
  return value !== undefined &&
    Number.isSafeInteger(value.koeBindingRevision) &&
    value.koeBindingRevision >= 1 &&
    Number.isSafeInteger(value.principalPolicyRevision) &&
    value.principalPolicyRevision >= 1;
}

function getWorkspacePath(
  request: { readonly agent: AgentDefinition },
): string | undefined {
  const value = request.agent.metadata?.workspacePath;
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

function belongsToThread(params: unknown, threadId: string): boolean {
  if (params === null || typeof params !== "object") return false;
  if ("threadId" in params) return params.threadId === threadId;
  if ("thread" in params && params.thread !== null && typeof params.thread === "object") {
    return "id" in params.thread && params.thread.id === threadId;
  }
  return false;
}

function normalizeNotification(method: string, params: unknown): AgentEvent | undefined {
  const record = asRecord(params);
  switch (method) {
    case "item/agentMessage/delta":
      return typeof record?.delta === "string"
        ? {
            type: "message.delta",
            text: truncateText(record.delta, MAX_AGENT_MESSAGE_CHARS),
          }
        : undefined;
    case "item/started": {
      const item = asRecord(record?.item);
      if (item === undefined || typeof item.id !== "string" || typeof item.type !== "string") {
        return undefined;
      }
      if (
        item.type === "commandExecution" ||
        item.type === "fileChange" ||
        item.type === "mcpToolCall" ||
        item.type === "dynamicToolCall" ||
        item.type === "collabAgentToolCall"
      ) {
        return {
          type: "tool.started",
          toolCallId: item.id,
          name: toolEventName(item),
          input: toJsonValue(redactApprovalProofs(item.arguments ?? item)),
        };
      }
      return undefined;
    }
    case "item/completed": {
      const item = asRecord(record?.item);
      if (item === undefined) return undefined;
      if (item.type === "agentMessage") {
        return {
          type: "message.completed",
          ...(typeof item.text === "string"
            ? { text: truncateText(item.text, MAX_AGENT_MESSAGE_CHARS) }
            : {}),
        };
      }
      if (item.type === "imageGeneration") {
        return normalizeCodexImageGenerationCompletion(item);
      }
      if (
        typeof item.id === "string" &&
        (item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "mcpToolCall" ||
          item.type === "dynamicToolCall" ||
          item.type === "collabAgentToolCall")
      ) {
        return {
          type: "tool.completed",
          toolCallId: item.id,
          output: toolCompletionOutput(item),
          ...(item.status === "failed" || item.status === "declined"
            ? { isError: true }
            : {}),
        };
      }
      return undefined;
    }
    case "turn/completed":
      return { type: "status.changed", status: turnStatus(params) };
    case "error": {
      if (record?.willRetry === true) return undefined;
      const error = asRecord(record?.error);
      return {
        type: "error",
        message:
          typeof error?.message === "string"
            ? truncateText(error.message, 4_000)
            : "Codex turn failed",
      };
    }
    default:
      return undefined;
  }
}

function toolCompletionOutput(item: Record<string, unknown>): JsonValue {
  if (item.type !== "dynamicToolCall") {
    return toJsonValue(item.result ?? item.error ?? item);
  }
  const contentTypes = Array.isArray(item.contentItems)
    ? item.contentItems.flatMap((value) => {
        const content = asRecord(value);
        return typeof content?.type === "string" ? [content.type] : [];
      })
    : [];
  return toJsonValue({
    status: item.status,
    success: item.success,
    contentTypes,
  });
}

function toolEventName(item: Record<string, unknown>): string {
  if (
    item.type === "mcpToolCall" &&
    typeof item.server === "string" &&
    typeof item.tool === "string"
  ) {
    return `${item.server}.${item.tool}`;
  }
  if (item.type === "collabAgentToolCall") return "collabAgent";
  if (item.type === "dynamicToolCall") return "dynamicTool";
  return typeof item.type === "string" ? item.type : "tool";
}

function threadStatusType(thread: CodexThread): string | undefined {
  return typeof asRecord(thread.status)?.type === "string"
    ? (asRecord(thread.status)?.type as string)
    : undefined;
}

function turnStatus(params: unknown): AgentStatus {
  const turn = asRecord(asRecord(params)?.turn);
  switch (turn?.status) {
    case "completed":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

function agentStatusForTurn(turn: CodexTurn): AgentStatus {
  switch (turn.status) {
    case "completed":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

function deferredNotificationOrder(
  left: { readonly method: string },
  right: { readonly method: string },
): number {
  return Number(right.method === "serverRequest/resolved") -
    Number(left.method === "serverRequest/resolved");
}

function notificationTurnId(params: unknown): string | undefined {
  const record = asRecord(params);
  if (typeof record?.turnId === "string") return record.turnId;
  const turn = asRecord(record?.turn);
  return typeof turn?.id === "string" ? turn.id : undefined;
}

function notificationClientUserMessageId(params: unknown): string | undefined {
  const turn = asRecord(asRecord(params)?.turn);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (const itemValue of items) {
    const item = asRecord(itemValue);
    if (item?.type === "userMessage" && typeof item.clientId === "string") {
      return item.clientId;
    }
  }
  return undefined;
}

function isTurnScopedNotification(method: string): boolean {
  return method.startsWith("turn/") || method.startsWith("item/") || method === "error";
}

function isApprovalMethod(
  method: string,
): method is PendingApproval["method"] {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "mcpServer/elicitation/request"
  );
}

interface McpToolApprovalRequest {
  readonly serverName: string;
  readonly toolName?: string;
  readonly summary: string;
  readonly availableDecisions: readonly AgentApproval["decision"][];
}

function parseMcpToolApprovalRequest(
  params: unknown,
): McpToolApprovalRequest | undefined {
  const request = asRecord(params);
  const meta = asRecord(request?._meta);
  const schema = asRecord(request?.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (
    request?.mode !== "form" ||
    typeof request.serverName !== "string" ||
    request.serverName.trim().length === 0 ||
    request.serverName.length > MAX_STRUCTURED_INPUT_ID_LENGTH ||
    typeof request.message !== "string" ||
    request.message.trim().length === 0 ||
    request.message.length > 2_000 ||
    meta?.codex_approval_kind !== "mcp_tool_call" ||
    schema?.type !== "object" ||
    properties === undefined ||
    Object.keys(properties).length !== 0 ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.length !== 0))
  ) {
    return undefined;
  }
  const toolName =
    typeof meta.tool_name === "string" &&
      meta.tool_name.trim().length > 0 &&
      meta.tool_name.length <= MAX_STRUCTURED_INPUT_ID_LENGTH
      ? meta.tool_name
      : undefined;
  const persist = meta.persist;
  const supportsSession =
    persist === "session" ||
    (Array.isArray(persist) && persist.includes("session"));
  const target = toolName === undefined
    ? request.serverName
    : `${request.serverName}.${toolName}`;
  return {
    serverName: request.serverName,
    ...(toolName === undefined ? {} : { toolName }),
    summary: `${request.message.trim()}\nMCP tool: ${target}`,
    availableDecisions: Object.freeze([
      "allow_once",
      ...(supportsSession ? ["allow_session" as const] : []),
      "cancel",
    ]),
  };
}

function commandSummary(
  params: unknown,
  item?: Record<string, unknown>,
  execPolicyAmendment?: readonly string[],
): string {
  const record = asRecord(params);
  const network = asRecord(record?.networkApprovalContext);
  if (typeof network?.host === "string") {
    const protocol = typeof network.protocol === "string" ? `${network.protocol}://` : "";
    return `Codex requests network access to: ${protocol}${network.host}`;
  }
  const command =
    typeof record?.command === "string"
      ? record.command
      : typeof item?.command === "string"
        ? item.command
        : "command";
  const request = `Codex requests permission to run: ${command}`;
  return execPolicyAmendment === undefined
    ? request
    : `Codex proposes this exact command rule for future requests: ${JSON.stringify(execPolicyAmendment)}\n${request}`;
}

function fileChangeSummary(
  params: unknown,
  item?: Record<string, unknown>,
): string {
  const record = asRecord(params);
  const reason = typeof record?.reason === "string" ? ` (${record.reason})` : "";
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change) => asRecord(change)?.path)
    .filter((path): path is string => typeof path === "string")
    .slice(0, 5);
  const files = paths.length === 0 ? "" : `\nFiles: ${paths.join(", ")}`;
  return `Codex requests permission to modify files${reason}${files}`;
}

function permissionsSummary(params: unknown): string {
  const record = asRecord(params);
  const reason =
    typeof record?.reason === "string" && record.reason.trim().length > 0
      ? `: ${truncateText(record.reason, 1_000)}`
      : "";
  const requested = requestedPermissions(params);
  const kinds = Object.keys(requested);
  return `Codex requests additional ${kinds.length === 0 ? "permissions" : kinds.join(" and ")} permissions${reason}`;
}

function requestedPermissions(
  params: unknown,
): Readonly<Record<string, JsonValue>> {
  const permissions = asRecord(asRecord(params)?.permissions);
  if (permissions === undefined) return {};
  const granted: Record<string, JsonValue> = {};
  for (const key of ["network", "fileSystem"] as const) {
    const value = permissions[key];
    if (value === undefined || value === null) continue;
    granted[key] = toJsonValue(value);
  }
  return granted;
}

function itemKey(sessionId: string, itemId: string): string {
  return `${sessionId}\u0000${itemId}`;
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`;
}

function rpcKey(rpcId: RpcId): string {
  return `${typeof rpcId}:${String(rpcId)}`;
}

function externalActionQuestionPrompt(value: unknown): string | undefined {
  const questions = asRecord(value)?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return undefined;
  const prompt = asRecord(questions[0])?.question;
  return typeof prompt === "string" ? prompt : undefined;
}

function looksLikeAppOpsApprovalPrompt(value: string | undefined): boolean {
  return value !== undefined &&
    (/^Target:\s*AppOps\b/mu.test(value) ||
      /\bexecute_approved_app_store_/u.test(value) ||
      /\bplan_hash=[0-9a-f]{64}\b/u.test(value));
}

function redactApprovalProofs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactApprovalProofs);
  const record = asRecord(value);
  if (record === undefined) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      key === "approval_proof" || key === "appops_approval_proof"
        ? "<redacted-approval-proof>"
        : redactApprovalProofs(child),
    ]),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function mapApprovalDecision(
  decision: AgentApproval["decision"],
): FileChangeApprovalDecision | undefined {
  switch (decision) {
    case "allow_once":
      return "accept";
    case "allow_session":
      return "acceptForSession";
    case "allow_command_rule":
      return undefined;
    case "deny":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

interface CommandApprovalDecisionOptions {
  readonly availableDecisions: readonly AgentApproval["decision"][];
  readonly commandDecisions: ReadonlyMap<
    AgentApproval["decision"],
    CommandApprovalDecision
  >;
  readonly execPolicyAmendment?: readonly string[];
}

function commandApprovalDecisionOptions(
  params: unknown,
): CommandApprovalDecisionOptions | undefined {
  const raw = asRecord(params)?.availableDecisions;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    return {
      availableDecisions: Object.freeze([]),
      commandDecisions: new Map(),
    };
  }
  const decisions: AgentApproval["decision"][] = [];
  const commandDecisions = new Map<
    AgentApproval["decision"],
    CommandApprovalDecision
  >();
  const amendmentCandidates = new Map<string, readonly string[]>();
  let amendmentPosition: number | undefined;
  for (const decision of raw) {
    const mapped = decision === "accept"
      ? "allow_once"
      : decision === "acceptForSession"
        ? "allow_session"
        : decision === "decline"
          ? "deny"
          : decision === "cancel"
            ? "cancel"
            : undefined;
    if (mapped !== undefined) {
      if (!decisions.includes(mapped)) decisions.push(mapped);
      commandDecisions.set(mapped, decision);
      continue;
    }
    const amendment = parseExecPolicyAmendmentDecision(decision, params);
    if (amendment === undefined) continue;
    amendmentPosition ??= decisions.length;
    amendmentCandidates.set(JSON.stringify(amendment), amendment);
  }
  let execPolicyAmendment: readonly string[] | undefined;
  if (amendmentCandidates.size === 1) {
    execPolicyAmendment = amendmentCandidates.values().next().value;
    if (execPolicyAmendment !== undefined) {
      const uiDecision = "allow_command_rule";
      decisions.splice(amendmentPosition ?? decisions.length, 0, uiDecision);
      commandDecisions.set(uiDecision, {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: execPolicyAmendment,
        },
      });
    }
  }
  return {
    availableDecisions: Object.freeze(decisions),
    commandDecisions,
    ...(execPolicyAmendment === undefined ? {} : { execPolicyAmendment }),
  };
}

function parseExecPolicyAmendmentDecision(
  value: unknown,
  params: unknown,
): readonly string[] | undefined {
  const decision = asRecord(value);
  if (
    decision === undefined ||
    Object.keys(decision).length !== 1 ||
    !("acceptWithExecpolicyAmendment" in decision)
  ) {
    return undefined;
  }
  const payload = asRecord(decision.acceptWithExecpolicyAmendment);
  if (
    payload === undefined ||
    Object.keys(payload).length !== 1 ||
    !("execpolicy_amendment" in payload)
  ) {
    return undefined;
  }
  const amendment = parseExecPolicyAmendment(payload.execpolicy_amendment);
  if (amendment === undefined) return undefined;
  const proposed = asRecord(params)?.proposedExecpolicyAmendment;
  if (proposed !== undefined && proposed !== null) {
    const parsedProposed = parseExecPolicyAmendment(proposed);
    if (
      parsedProposed === undefined ||
      JSON.stringify(parsedProposed) !== JSON.stringify(amendment)
    ) {
      return undefined;
    }
  }
  return amendment;
}

function parseExecPolicyAmendment(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    value.some(
      (part) =>
        typeof part !== "string" || part.length === 0 || part.length > 512,
    )
  ) {
    return undefined;
  }
  const amendment = value as string[];
  if (JSON.stringify(amendment).length > 1_500) return undefined;
  return Object.freeze([...amendment]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  if (serialized.length <= MAX_EVENT_JSON_CHARS) {
    return JSON.parse(serialized) as JsonValue;
  }
  return {
    truncated: true,
    preview: truncateText(serialized, MAX_EVENT_JSON_CHARS - 64),
  };
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  readonly #values: AgentEvent[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<AgentEvent>): void;
    reject(error: unknown): void;
  }> = [];
  #queuedDeltaChars = 0;
  #closed = false;
  #error: unknown;

  push(value: AgentEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }

    if (value.type === "message.delta") {
      const previous = this.#values.at(-1);
      if (
        previous?.type === "message.delta" &&
        previous.text.length + value.text.length <= MAX_COALESCED_DELTA_CHARS
      ) {
        this.#values[this.#values.length - 1] = {
          type: "message.delta",
          text: previous.text + value.text,
        };
      } else {
        this.#values.push(value);
      }
      this.#queuedDeltaChars += value.text.length;
    } else {
      this.#values.push(value);
    }

    if (
      this.#values.length > MAX_QUEUED_EVENTS ||
      this.#queuedDeltaChars > MAX_QUEUED_DELTA_CHARS
    ) {
      this.fail(new Error("Codex event queue exceeded its memory safety limit"));
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#values.length = 0;
    this.#queuedDeltaChars = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  failAfterQueued(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async (): Promise<IteratorResult<AgentEvent>> => {
        const value = this.#values.shift();
        if (value !== undefined) {
          if (value.type === "message.delta") {
            this.#queuedDeltaChars -= value.text.length;
          }
          return { done: false, value };
        }
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<AgentEvent>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}
