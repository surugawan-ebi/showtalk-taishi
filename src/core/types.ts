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
  /** Operator-declared backend session used by the legacy channel binding. */
  readonly configuredAdapterSessionId?: string;
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
  | "waiting_for_input"
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
  readonly decision:
    | "allow_once"
    | "allow_session"
    | "allow_command_rule"
    | "deny"
    | "cancel";
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
  /** Exact private approval target emitted by a workspace-git plan operation. */
  readonly approvalTarget: string;
  /**
   * Exact, bounded approval projection emitted by workspace-git itself.
   * ShowTalk validates this against the human-facing plan, then passes the
   * unchanged value to the model-inaccessible private broker.
   */
  readonly approvalScope?: Readonly<Record<string, unknown>>;
  readonly repoId: string;
  /** Present only for main-update plans; null records a detached HEAD. */
  readonly currentBranch?: string | null;
  /** Exact prepare input; omitted only for operations without an environment. */
  readonly environment?: string;
  readonly expiresAt: string;
}

interface WorkspaceGitPublicationPlanFields extends WorkspaceGitApprovalPlanBase {
  readonly operation: "git_publication";
  readonly branch: string;
  readonly paths: readonly string[];
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
  readonly branch: string;
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
  readonly targetPullRequestTitle: string;
  readonly baseBranch?: string;
  readonly basePolicy: "catalog_publication_branch" | "same_repo_stacked_pr";
  readonly baseSha?: string;
  readonly autoMergeEnabled: boolean;
  readonly headRepositoryOwner: string;
  readonly expectedIsDraft: boolean;
  readonly parentPullRequestNumber?: number;
  readonly parentPullRequestUrl?: string;
  readonly parentHeadRefName?: string;
  readonly parentHeadSha?: string;
  readonly parentHeadRepositoryOwner?: string;
  readonly parentState?: "OPEN";
  readonly parentIsDraft?: boolean;
  readonly parentAutoMergeEnabled?: boolean;
  readonly mergeMethod?: "merge" | "squash" | "rebase";
}

interface WorkspaceGitExistingPullRequestUpdateApprovalPlan
  extends WorkspaceGitApprovalPlanBase {
  readonly operation: "existing_pull_request_update";
  readonly mode: "existing_pull_request_update";
  readonly branch: string;
  readonly paths: readonly string[];
  readonly expectedHead: string;
  readonly expectedSnapshotId: string;
  readonly worktreeId?: never;
  readonly temporaryWorkspaceId: string;
  readonly commitMessage: string;
  readonly pushTarget: string;
  readonly pullRequestTitle?: never;
  readonly pullRequestBody?: never;
  readonly pullRequestBaseBranch?: never;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly baseBranch: string;
  readonly mergeMethod?: never;
  readonly expectedPullRequestHead: string;
  readonly expectedRemoteHead: string;
  readonly expectedTree: string;
  readonly cloneIdentity: string;
  readonly configuredRootIdentity: string;
  readonly relativePath: string;
  readonly pushRef: string;
}

export type WorkspaceGitDependabotSecurityUpdateState =
  | "enabled"
  | "paused"
  | "disabled";

export interface WorkspaceGitRepositorySettingsState {
  readonly description: string | null;
  readonly topics: readonly string[];
  readonly dependabotSecurityUpdates: WorkspaceGitDependabotSecurityUpdateState;
}

export interface WorkspaceGitRepositorySettingsDesired {
  readonly description?: string | null;
  readonly topics?: readonly string[];
  readonly dependabotSecurityUpdates?: boolean;
}

interface WorkspaceGitRepositorySettingsApprovalPlan
  extends WorkspaceGitApprovalPlanBase {
  readonly operation: "github_repository_settings";
  readonly mode: "repository_settings";
  readonly paths: readonly [];
  readonly branch?: never;
  readonly expectedHead?: never;
  readonly expectedSnapshotId?: never;
  readonly worktreeId?: never;
  readonly commitMessage?: never;
  readonly pushTarget?: never;
  readonly pullRequestTitle?: never;
  readonly pullRequestBody?: never;
  readonly pullRequestBaseBranch?: never;
  readonly pullRequestNumber?: never;
  readonly pullRequestUrl?: never;
  readonly baseBranch?: never;
  readonly mergeMethod?: never;
  readonly repositorySettingsBefore: WorkspaceGitRepositorySettingsState;
  readonly repositorySettingsDesired: WorkspaceGitRepositorySettingsDesired;
  readonly repositorySettingsResultingState: WorkspaceGitRepositorySettingsState;
}

interface WorkspaceGitMainUpdateApprovalPlan extends WorkspaceGitApprovalPlanBase {
  readonly operation: "main_update";
  readonly mode: "main_update";
  readonly paths: readonly [];
  /** Branch checked when the plan was prepared; null means detached HEAD. */
  readonly currentBranch: string | null;
  readonly branch?: never;
  readonly expectedHead: string;
  readonly expectedSnapshotId: string;
  readonly worktreeId: "primary";
  readonly commitMessage?: never;
  readonly pushTarget?: never;
  readonly pullRequestTitle?: never;
  readonly pullRequestBody?: never;
  readonly pullRequestBaseBranch?: never;
  readonly pullRequestNumber?: never;
  readonly pullRequestUrl?: never;
  readonly baseBranch?: never;
  readonly mergeMethod?: never;
}

/** Exact workspace-git plan that is safe to project onto the Slack approval UI. */
export type WorkspaceGitApprovalPlan =
  | WorkspaceGitInitialCommitApprovalPlan
  | WorkspaceGitInitialPushApprovalPlan
  | WorkspaceGitEstablishedPublicationApprovalPlan
  | WorkspaceGitPullRequestApprovalPlan
  | WorkspaceGitExistingPullRequestUpdateApprovalPlan
  | WorkspaceGitRepositorySettingsApprovalPlan
  | WorkspaceGitMainUpdateApprovalPlan;

export interface AgentGitApprovalInputResponse {
  readonly requestId: string;
  readonly optionId: "approve" | "reject";
  /**
   * Exact plan required only for a fail-closed rejection that may race an
   * App Server `serverRequest/resolved` notification. It never grants approval.
   */
  readonly plan?: WorkspaceGitApprovalPlan;
}

export type AgentChoiceAnswer =
  | {
      readonly questionId: string;
      readonly optionId: string;
      readonly text?: never;
    }
  | {
      readonly questionId: string;
      readonly text: string;
      readonly optionId?: never;
    };

/** One exact answer to the currently displayed ordinary structured question. */
export interface AgentChoiceInputResponse {
  readonly requestId: string;
  readonly answer: AgentChoiceAnswer;
}

/** Safely releases an App Server request when its interaction cannot be shown. */
export interface AgentUserInputCancellation {
  readonly requestId: string;
  readonly cancelled: true;
}

export type AgentUserInputResponse =
  | AgentGitApprovalInputResponse
  | AgentChoiceInputResponse
  | AgentUserInputCancellation;

export interface AgentChoiceOption {
  /** Request-local opaque identifier; never the model-provided label. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface AgentChoiceQuestion {
  /** Request-local opaque identifier; never the model-provided question ID. */
  readonly id: string;
  /** Distinguishes an ordinary choice from a non-Git external action confirmation. */
  readonly purpose?: "ordinary" | "external_action_confirmation";
  readonly header: string;
  readonly prompt: string;
  readonly options: readonly AgentChoiceOption[];
  readonly allowsOther: boolean;
}

export interface AgentChoiceCompletedAnswer {
  readonly header: string;
  readonly prompt: string;
  readonly answers: readonly string[];
}

/** Immutable binary output produced by an Agent during the current turn. */
export interface AgentOutputAttachment {
  readonly kind: "image" | "audio";
  readonly payload: Blob;
  readonly name: string;
  readonly mimeType: string;
  readonly title?: string;
  readonly altText?: string;
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
      readonly type: "attachment.generated";
      /** Adapter-scoped opaque ID used only to suppress duplicate projection. */
      readonly attachmentId: string;
      readonly attachment: AgentOutputAttachment;
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
      readonly availableDecisions?: readonly AgentApproval["decision"][];
    }
  | {
      readonly type: "user_input.requested";
      readonly requestId: string;
      /** Effective deadline after adapter and plan timeouts are intersected. */
      readonly expiresAt: string;
      readonly prompt: string;
      readonly options: readonly [
        { readonly id: "approve"; readonly label: "承認して実行" },
        { readonly id: "reject"; readonly label: "拒否・保留" },
      ];
      readonly plan: WorkspaceGitApprovalPlan;
    }
  | {
      /** The exact Git approval request expired and is no longer actionable. */
      readonly type: "git_approval.expired";
      readonly requestId: string;
    }
  | {
      /** Another App Server client resolved this request before Slack did. */
      readonly type: "git_approval.resolved_externally";
      readonly requestId: string;
      readonly plan: WorkspaceGitApprovalPlan;
      /** The private rejection intent was persisted before this event. */
      readonly systemRejectionRecorded?: true;
    }
  | {
      /**
       * Ordinary, non-secret model question or non-Git external action
       * confirmation. It never grants workspace-git approval authority.
       */
      readonly type: "choice.requested";
      readonly requestId: string;
      readonly expiresAt: string;
      readonly question: AgentChoiceQuestion;
      /** Earlier answers from the same multi-question App Server request. */
      readonly completedAnswers: readonly AgentChoiceCompletedAnswer[];
    }
  | {
      /** The original ordinary-choice RPC ended before Slack supplied an answer. */
      readonly type: "choice.resolved_externally";
      readonly requestId: string;
    }
  | {
      /** A Koe-local opt-in selected the first option of an ordinary question. */
      readonly type: "choice.auto_selected";
      readonly header: string;
      readonly optionLabel: string;
    }
  | {
      /** A private provider terminally executed the exact prepared Git plan. */
      readonly type: "git_automation.executed";
      readonly plan: WorkspaceGitApprovalPlan;
    }
  | {
      /** Automation failed closed; no manual or public-execute fallback is safe. */
      readonly type: "git_automation.blocked";
      readonly plan: WorkspaceGitApprovalPlan;
      readonly reason:
        | "contract_mismatch"
        | "policy_blocked"
        | "provider_unavailable"
        | "outcome_uncertain"
        | "outcome_unknown"
        | "activation_ambiguous"
        | "activation_scope_mismatch"
        | "activation_revision_mismatch"
        | "activation_digest_mismatch"
        | "activation_expired"
        | "activation_security_revoked"
        | "profile_scope_mismatch"
        | "quota_exhausted"
        | "gateway_fence_mismatch";
    }
  | {
      /**
       * The model requested Git approval without a fresh exact plan in this
       * turn. Slack may explain how to send a new explicit request, but must
       * never restart a turn or present the stale operation as approvable.
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

export interface QueuedDelegationSlackSource {
  readonly type: "slack";
  readonly agentId: AgentId;
  readonly channelId: SlackChannelId;
  readonly rootThreadTs: SlackRootThreadTs;
  readonly messageTs: string;
  readonly slackUserId?: string;
  readonly sessionId: SessionId;
  readonly adapterSessionId: string;
  readonly turnStartedAt: string;
}

export interface QueuedDelegationJobSource {
  readonly type: "job";
  readonly agentId: AgentId;
  /** The durable parent job whose target turn issued this child request. */
  readonly ownerJobId: string;
  readonly sessionId: SessionId;
  readonly adapterSessionId: string;
  readonly turnStartedAt: string;
}

export type QueuedDelegationSource =
  | QueuedDelegationSlackSource
  | QueuedDelegationJobSource;

export type QueuedDelegationOutcomeStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export interface QueuedDelegationOutcome {
  readonly status: QueuedDelegationOutcomeStatus;
  readonly text: string;
}

/**
 * Durable accepted Koe-to-Koe work. Adapter turns may stop and resume while one
 * job waits for child consultations; the job remains the result owner.
 */
export interface QueuedDelegationJob {
  readonly version: 1;
  readonly id: string;
  readonly requestKey: string;
  readonly source: QueuedDelegationSource;
  readonly targetAgentId: AgentId;
  readonly targetAdapter: string;
  readonly targetChannelId: SlackChannelId;
  readonly targetConversationScope: ConversationScope;
  readonly targetWorkspacePath?: string;
  readonly consultationScope: string;
  readonly permissionDecision: "allow" | "approval";
  readonly message: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  /** Causation depth for the next adapter turn of this job. */
  readonly depth: number;
  /** Immediate causation predecessor; distinct from source.ownerJobId. */
  readonly causationParentId?: string;
  readonly state:
    | "queued"
    | "running"
    | "waiting_for_children"
    | "result_pending"
    | "delivering";
  readonly pendingChildIds: readonly string[];
  readonly childOutcomes: readonly {
    readonly childJobId: string;
    readonly targetAgentId: AgentId;
    readonly depth: number;
    readonly outcome: QueuedDelegationOutcome;
  }[];
  readonly targetSessionId?: SessionId;
  readonly targetAdapterSessionId?: string;
  /** Slack root that displays this accepted job and survives adapter pauses. */
  readonly targetRootThreadTs?: SlackRootThreadTs;
  /** Present only when a child result is resuming this job's target session. */
  readonly resumeMessage?: string;
  /** Non-terminal adapter-turn failure retained while accepted children finish. */
  readonly turnFailure?: QueuedDelegationOutcome;
  /** Durable at-most-once fence set before starting the source Koe continuation. */
  readonly sourceContinuationStarted?: boolean;
  readonly outcome?: QueuedDelegationOutcome;
  readonly createdAt: string;
  readonly queueExpiresAt: string;
  readonly updatedAt: string;
}

/** Durable intent to fail-close a Git approval that no longer has a visible UI. */
export interface PendingWorkspaceGitSystemRejection {
  readonly operationId: string;
  readonly planHash: string;
  readonly approvalTarget: string;
  readonly approvalAuthorityId?: string;
  readonly repoId: string;
  readonly expiresAt: string;
  readonly actor:
    | "showtalk:slack-projection-failure"
    | "showtalk:external-app-server-resolution"
    | "showtalk:private-decision-failure";
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
  /** Accepted Koe-to-Koe work awaiting execution, children, or exact delivery. */
  readonly queuedDelegations?: readonly QueuedDelegationJob[];
  /** Recently completed Slack Events API deliveries (durable retry guard). */
  readonly handledSlackEvents?: readonly string[];
  /** Fail-closed Git decisions queued before an App Server request was released. */
  readonly pendingWorkspaceGitSystemRejections?: readonly PendingWorkspaceGitSystemRejection[];
}
