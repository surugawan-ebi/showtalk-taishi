import { randomUUID } from "node:crypto";

import type {
  CodexEffectiveMcpRegistrationStatus,
  CodexMcpStatusListClassification,
} from "../adapters/codex/app-server-client.js";

const LOCAL_MCP_AGENT_ID = "local-mcp";
const WORKSPACE_GIT_NAMESPACE = "mcp__workspace_git";
const WORKSPACE_GIT_REGISTRATION_NAMES = new Set([
  "workspace-git",
  "workspace_git",
]);
const LIST_REPOSITORIES_TOOL = "list_repositories";

export type CorrelationTargetMatch = "yes" | "no" | "insufficient_evidence";

export type LocalMcpCorrelationClassification =
  | CodexMcpStatusListClassification
  | "caller_callable";

export interface LocalMcpCorrelationEntry {
  readonly registered_name: string;
  readonly runtime_status: CodexEffectiveMcpRegistrationStatus["status"];
  readonly classification: LocalMcpCorrelationClassification;
  readonly target_match: CorrelationTargetMatch;
}

export interface LocalMcpCorrelationReport {
  readonly entries: readonly LocalMcpCorrelationEntry[];
}

export interface ExistingMcpStatusSnapshot {
  readonly classification: CodexMcpStatusListClassification;
  readonly registrations: readonly CodexEffectiveMcpRegistrationStatus[];
}

export interface ModelVisibleToolCallObservation {
  readonly namespace: string;
  readonly tool: string;
  readonly outcome: "success" | "failure";
}

export interface SameCallerToolEvidence {
  /** The exact App Server client object that owns the status snapshot. */
  readonly client: object;
  /** Omit when the caller's model-visible inventory was not observed. */
  readonly modelVisibleNamespaces?: readonly string[];
  /** Omit when direct tool-call outcomes were not observed. */
  readonly directToolCalls?: readonly ModelVisibleToolCallObservation[];
}

export interface LocalMcpCorrelationInternalState {
  readonly observedAt: string;
  readonly correlationRef: string;
}

export interface LocalMcpCorrelationSnapshotOptions {
  /** Must come from the configured local-mcp Koe record. */
  readonly agentId: string;
  /** Must come from that Koe's existing configured Slack channel. */
  readonly channelId: string;
  /** Exact App Server client instance owned by that Koe. */
  readonly client: object;
  /** Reads already-observed state only; it must never issue an RPC. */
  readonly readExistingStatusSnapshot: () => ExistingMcpStatusSnapshot | undefined;
  /** Optional evidence captured independently from status/list. */
  readonly callerToolEvidence?: SameCallerToolEvidence;
  readonly now?: () => Date;
  readonly correlationRefFactory?: () => string;
  /** Internal persistence seam; receives no channel, session, thread, or Git data. */
  readonly recordInternalState?: (state: LocalMcpCorrelationInternalState) => void;
}

export interface LocalMcpCorrelationRequest {
  readonly agentId: string;
  readonly channelId: string;
  readonly client: object;
}

export interface LocalMcpCorrelationReadRequest {
  readonly agentId: string;
  readonly channelId: string;
}

export interface LocalMcpCorrelationRuntimeBinding {
  readonly agentId: string;
  readonly channelId: string;
  readonly client: object;
  /** Resolves the client currently owned by the requested runtime agent. */
  readonly resolveClient: (agentId: string) => object | undefined;
  /** Reads only the client-owned in-memory diagnostic snapshot. */
  readonly readExistingStatusSnapshot: () => ExistingMcpStatusSnapshot | undefined;
}

export class LocalMcpCorrelationScopeError extends Error {
  constructor() {
    super("Local MCP correlation snapshot scope does not match");
    this.name = "LocalMcpCorrelationScopeError";
  }
}

/**
 * A read-only, one-snapshot diagnostic bound to the configured local-mcp Koe.
 * It deliberately has no App Server request or MCP tool-call capability.
 */
export class LocalMcpCorrelationSnapshotDiagnostic {
  readonly #agentId: string;
  readonly #channelId: string;
  readonly #client: object;
  readonly #internalState: LocalMcpCorrelationInternalState;
  readonly #report: LocalMcpCorrelationReport;

  constructor(options: LocalMcpCorrelationSnapshotOptions) {
    if (options.agentId !== LOCAL_MCP_AGENT_ID || options.channelId.length === 0) {
      throw new LocalMcpCorrelationScopeError();
    }
    if (
      options.callerToolEvidence !== undefined &&
      options.callerToolEvidence.client !== options.client
    ) {
      throw new LocalMcpCorrelationScopeError();
    }

    this.#agentId = options.agentId;
    this.#channelId = options.channelId;
    this.#client = options.client;

    const snapshot = options.readExistingStatusSnapshot();
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const correlationRef = (options.correlationRefFactory ?? randomUUID)();
    this.#internalState = Object.freeze({ observedAt, correlationRef });
    options.recordInternalState?.(this.#internalState);
    this.#report = buildReport(snapshot, options.callerToolEvidence);
  }

  read(request: LocalMcpCorrelationRequest): LocalMcpCorrelationReport {
    if (
      request.agentId !== this.#agentId ||
      request.channelId !== this.#channelId ||
      request.client !== this.#client
    ) {
      throw new LocalMcpCorrelationScopeError();
    }
    return structuredClone(this.#report);
  }
}

/**
 * Runtime binding that fixes agent/channel/client identity at agent creation.
 * The first authorized read captures one already-observed snapshot; subsequent
 * reads return that cache and never ask the App Server for fresh status.
 */
export class LocalMcpCorrelationRuntimeReader {
  readonly #binding: LocalMcpCorrelationRuntimeBinding;
  #diagnostic: LocalMcpCorrelationSnapshotDiagnostic | undefined;

  constructor(binding: LocalMcpCorrelationRuntimeBinding) {
    if (
      binding.agentId !== LOCAL_MCP_AGENT_ID ||
      binding.channelId.length === 0 ||
      binding.resolveClient(binding.agentId) !== binding.client
    ) {
      throw new LocalMcpCorrelationScopeError();
    }
    this.#binding = binding;
  }

  read(request: LocalMcpCorrelationReadRequest): LocalMcpCorrelationReport {
    const client = this.#binding.resolveClient(request.agentId);
    if (
      request.agentId !== this.#binding.agentId ||
      request.channelId !== this.#binding.channelId ||
      client !== this.#binding.client
    ) {
      throw new LocalMcpCorrelationScopeError();
    }
    this.#diagnostic ??= new LocalMcpCorrelationSnapshotDiagnostic({
      agentId: this.#binding.agentId,
      channelId: this.#binding.channelId,
      client: this.#binding.client,
      readExistingStatusSnapshot: this.#binding.readExistingStatusSnapshot,
    });
    return this.#diagnostic.read({ ...request, client });
  }
}

function buildReport(
  snapshot: ExistingMcpStatusSnapshot | undefined,
  evidence: SameCallerToolEvidence | undefined,
): LocalMcpCorrelationReport {
  const registrations = snapshot?.registrations ?? [];
  const entries: LocalMcpCorrelationEntry[] = registrations.map((registration) => ({
    registered_name: registration.name,
    runtime_status: registration.status,
    classification: snapshot?.classification ?? "invalid_result",
    target_match: isWorkspaceGitRegistration(registration.name) ? "yes" : "no",
  }));
  const workspaceGit = registrations.find((registration) =>
    isWorkspaceGitRegistration(registration.name)
  );
  entries.push({
    registered_name: workspaceGit?.name ?? "workspace-git",
    runtime_status: workspaceGit?.status ?? null,
    classification: "caller_callable",
    target_match: callableMatch(evidence),
  });
  return Object.freeze({
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  });
}

function callableMatch(
  evidence: SameCallerToolEvidence | undefined,
): CorrelationTargetMatch {
  if (evidence?.modelVisibleNamespaces === undefined) {
    return "insufficient_evidence";
  }
  if (!evidence.modelVisibleNamespaces.includes(WORKSPACE_GIT_NAMESPACE)) {
    return "no";
  }
  if (evidence.directToolCalls === undefined) return "insufficient_evidence";
  const observations = evidence.directToolCalls.filter(
    (call) =>
      call.namespace === WORKSPACE_GIT_NAMESPACE &&
      call.tool === LIST_REPOSITORIES_TOOL,
  );
  if (observations.some((call) => call.outcome === "success")) return "yes";
  return observations.length > 0 ? "no" : "insufficient_evidence";
}

function isWorkspaceGitRegistration(name: string): boolean {
  return WORKSPACE_GIT_REGISTRATION_NAMES.has(name);
}
