export type AgentId = string;
export type SessionId = string;
export type SlackChannelId = string;
export type SlackRootThreadTs = string;
export type ConversationScope = "channel" | "slack_thread";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface AgentCapabilities {
  readonly streaming: boolean;
  readonly approval: boolean;
  readonly interrupt: boolean;
  readonly resume: boolean;
  readonly toolEvents: boolean;
  /** Adapter can project bounded structured choices and accept one exact response. */
  readonly structuredInput?: boolean;
  /** Adapter can pass one or more images as native model inputs. */
  readonly imageInput?: boolean;
  /** Adapter can expose an audio attachment as a local file to the Agent. */
  readonly audioFileInput?: boolean;
}

export interface AgentDefinition {
  readonly id: AgentId;
  /** Short operator-facing name accepted anywhere a Koe target is requested. */
  readonly callName?: string;
  readonly adapter: string;
  readonly channelId: SlackChannelId;
  /** Selects whether Slack roots share one backend thread or own one each. */
  readonly conversationScope?: ConversationScope;
  /** Trusted operator-defined persona applied only to turns started by ShowTalk. */
  readonly slackPersona?: string;
  readonly role?: string;
  readonly allowSelfDelegation?: boolean;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "interrupted"
  | "failed";

/** Adapter-owned session handle. Its state must remain JSON serializable. */
export interface AdapterSession {
  readonly id: string;
  readonly state?: Readonly<Record<string, JsonValue>>;
}

/** Identifies the concrete request that currently owns an Agent turn. */
export type ActiveTurnContext =
  | {
      readonly type: "slack";
      readonly channelId: SlackChannelId;
      readonly rootThreadTs: SlackRootThreadTs;
      readonly messageTs: string;
      /** Slack user that initiated this turn, retained for delayed replies. */
      readonly slackUserId?: string;
      /** Host-owned causation retained while delivering a late routed result. */
      readonly continuationDelegationId?: string;
      readonly continuationDepth?: number;
      readonly startedAt: string;
    }
  | {
      readonly type: "agent";
      readonly sourceAgentId: AgentId;
      readonly delegationId: string;
      readonly startedAt: string;
    };

/** Persistable core record that relates an adapter session to an Agent identity. */
export interface AgentSessionRecord {
  readonly id: SessionId;
  readonly agentId: AgentId;
  readonly adapter: string;
  readonly adapterSession: AdapterSession;
  readonly status: AgentStatus;
  readonly activeTurn?: ActiveTurnContext;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A Slack reply location associated with one backend session. Channel-scoped
 * Koe may share a session across roots; thread-scoped Koe bind one per root.
 */
export interface ConversationBinding {
  readonly channelId: SlackChannelId;
  readonly rootThreadTs: SlackRootThreadTs;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
}

export interface AgentApproval {
  readonly requestId: string;
  readonly decision: "allow_once" | "allow_session" | "deny" | "cancel";
}

export type WorkspaceGitPublicationMode =
  | "commit_only"
  | "push_existing"
  | "commit_and_push"
  | "push_existing_and_open_draft_pr"
  | "commit_push_and_open_draft_pr"
  | "initial_commit_and_push"
  | "initial_push_existing";

interface WorkspaceGitApprovalPlanBase {
  readonly operationId: string;
  readonly planHash: string;
  readonly repoId: string;
  readonly branch: string;
  readonly paths: readonly string[];
  readonly expiresAt: string;
}

interface WorkspaceGitPublicationPlanFields extends WorkspaceGitApprovalPlanBase {
  readonly operation: "git_publication";
  readonly expectedSnapshotId: string;
  readonly worktreeId: string;
  readonly commitMessage?: string;
  readonly pushTarget?: string;
  readonly pullRequestTitle?: string;
  readonly pullRequestBody?: string;
  readonly pullRequestBaseBranch?: string;
  readonly pullRequestNumber?: never;
  readonly pullRequestUrl?: never;
  readonly baseBranch?: never;
  readonly mergeMethod?: never;
}

type WorkspaceGitInitialCommitApprovalPlan =
  WorkspaceGitPublicationPlanFields & {
    readonly mode: "initial_commit_and_push";
    readonly branch: "main";
    readonly expectedHead: null;
    readonly worktreeId: "primary";
    readonly commitMessage: string;
    readonly pushTarget: "origin/main";
  };

type WorkspaceGitInitialPushApprovalPlan =
  WorkspaceGitPublicationPlanFields & {
    readonly mode: "initial_push_existing";
    readonly branch: "main";
    readonly paths: readonly [];
    readonly expectedHead: string;
    readonly worktreeId: "primary";
    readonly commitMessage?: never;
    readonly pushTarget: "origin/main";
    readonly pullRequestTitle?: never;
    readonly pullRequestBody?: never;
    readonly pullRequestBaseBranch?: never;
  };

type WorkspaceGitEstablishedPublicationApprovalPlan =
  WorkspaceGitPublicationPlanFields & {
    readonly mode: Exclude<
      WorkspaceGitPublicationMode,
      "initial_commit_and_push" | "initial_push_existing"
    >;
    readonly expectedHead: string;
  };

interface WorkspaceGitPullRequestApprovalPlan extends WorkspaceGitApprovalPlanBase {
  readonly operation: "pull_request_ready" | "pull_request_merge";
  readonly mode: "mark_ready_for_review" | "merge";
  readonly paths: readonly string[];
  readonly expectedHead: string;
  readonly expectedSnapshotId?: never;
  readonly worktreeId?: never;
  readonly commitMessage?: never;
  readonly pushTarget?: never;
  readonly pullRequestTitle?: never;
  readonly pullRequestBody?: never;
  readonly pullRequestBaseBranch?: never;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly baseBranch?: string;
  readonly mergeMethod?: "merge" | "squash" | "rebase";
}

/** Exact workspace-git plan that is safe to project onto the Slack approval UI. */
export type WorkspaceGitApprovalPlan =
  | WorkspaceGitInitialCommitApprovalPlan
  | WorkspaceGitInitialPushApprovalPlan
  | WorkspaceGitEstablishedPublicationApprovalPlan
  | WorkspaceGitPullRequestApprovalPlan;

export interface AgentUserInputResponse {
  readonly requestId: string;
  readonly optionId: "approve" | "reject";
}

export type AgentEvent =
  | {
      readonly type: "message.delta";
      readonly text: string;
    }
  | {
      readonly type: "message.completed";
      readonly text?: string;
    }
  | {
      readonly type: "status.changed";
      readonly status: AgentStatus;
    }
  | {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly name: string;
      readonly input?: JsonValue;
    }
  | {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly output?: JsonValue;
      readonly isError?: boolean;
    }
  | {
      readonly type: "approval.requested";
      readonly requestId: string;
      readonly summary: string;
      readonly details?: JsonValue;
    }
  | {
      readonly type: "user_input.requested";
      readonly requestId: string;
      readonly prompt: string;
      readonly options: readonly [
        { readonly id: "approve"; readonly label: "承認して実行" },
        { readonly id: "reject"; readonly label: "拒否・保留" },
      ];
      readonly plan: WorkspaceGitApprovalPlan;
    }
  | {
      /**
       * The model requested Git approval without a fresh exact plan in this
       * turn. Slack may offer a safe new-turn recovery action, but must never
       * present the stale operation as approvable.
       */
      readonly type: "git_approval.reprepare_required";
      readonly message: string;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly code?: string;
      readonly retryable?: boolean;
    };

export interface PrimarySessionBinding {
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
}

/** Versioned now so state.json can evolve without leaking Map-specific storage. */
export interface CoreStateSnapshot {
  readonly version: 1;
  readonly agents: readonly AgentDefinition[];
  readonly sessions: readonly AgentSessionRecord[];
  readonly conversations: readonly ConversationBinding[];
  readonly primarySessions: readonly PrimarySessionBinding[];
  /** Delegation results accepted for source-turn continuation (durable replay guard). */
  readonly handledDelegationResults?: readonly string[];
  /** Delayed results that have already started their one permitted next Koe step. */
  readonly usedContinuationDelegations?: readonly string[];
}
