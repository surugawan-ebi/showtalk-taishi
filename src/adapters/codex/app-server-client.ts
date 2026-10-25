import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  CodexProtocolError,
  CodexRpcError,
  type CodexThread,
  type CodexTurn,
  type CommandApprovalDecision,
  type FileChangeApprovalDecision,
  type McpServerElicitationResponse,
  type McpServerConnectionStatus,
  type ModelListParams,
  type ModelListResponse,
  type PermissionsApprovalResponse,
  type ToolRequestUserInputResponse,
  type RpcError,
  type RpcId,
  type RpcInboundMessage,
  type RpcRequest,
  type ThreadResumeParams,
  type ThreadStartParams,
  type ThreadTurnsListParams,
  type ThreadTurnsListResponse,
  type TurnStartParams,
} from "./protocol.js";

export interface AppServerTransport {
  input: Readable;
  output: Writable;
  close(): Promise<void>;
}

export interface CodexAppServerClientOptions {
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  /** Receives only the bounded, sanitized lifecycle diagnostic shape below. */
  onDiagnostic?: (event: CodexAppServerDiagnosticEvent) => void;
}

export type CodexAppServerDiagnosticStage =
  | "spawn_started"
  | "initialize_sent"
  | "initialize_response"
  | "initialized_notification"
  | "thread_start_sent"
  | "thread_start_response"
  | "thread_resume_sent"
  | "thread_resume_response"
  | "mcp_server_status_list_sent"
  | "mcp_server_status_list_response";

export type CodexAppServerDiagnosticErrorClassification =
  | "timeout"
  | "rpc_error"
  | "protocol_error"
  | "client_closed"
  | "transport_or_unknown_error";

export type CodexAppServerCwdClassification =
  | "absent"
  | "absolute"
  | "relative";

export type CodexMcpStatusListClassification =
  | "success"
  | "partial_result"
  | "empty_result"
  | "api_unsupported"
  | "timeout"
  | "rpc_error"
  | "invalid_result"
  | "client_closed"
  | "transport_or_unknown_error";

export interface CodexEffectiveMcpRegistrationStatus {
  readonly name: string;
  readonly status: McpServerConnectionStatus | null;
}

export interface CodexAppServerDiagnosticEvent {
  readonly source: "codex_app_server";
  readonly stage: CodexAppServerDiagnosticStage;
  readonly outcome: "started" | "sent" | "response" | "error";
  readonly cwd?: CodexAppServerCwdClassification;
  readonly configKeyNames?: readonly string[];
  readonly configuredMcpRegistrationNames?: readonly string[];
  readonly effectiveMcpRegistrations?: readonly CodexEffectiveMcpRegistrationStatus[];
  readonly mcpStatusListClassification?: CodexMcpStatusListClassification;
  readonly errorClassification?: CodexAppServerDiagnosticErrorClassification;
}

export interface CodexAppServerDiagnosticSnapshot {
  readonly spawn: "not_observed" | "started";
  readonly initialize: "not_started" | "sent" | "responded";
  readonly initializedNotification: "not_sent" | "sent";
  readonly threadStart?: CodexAppServerThreadDiagnosticSnapshot;
  readonly threadResume?: CodexAppServerThreadDiagnosticSnapshot;
  readonly mcpServerStatusList?: {
    readonly classification: CodexMcpStatusListClassification;
    readonly registrations: readonly CodexEffectiveMcpRegistrationStatus[];
  };
  readonly lastError?: {
    readonly stage: CodexAppServerDiagnosticStage;
    readonly classification: CodexAppServerDiagnosticErrorClassification;
  };
}

export interface CodexAppServerThreadDiagnosticSnapshot {
  readonly state: "sent" | "responded" | "error";
  readonly cwd: CodexAppServerCwdClassification;
  readonly configKeyNames: readonly string[];
  readonly configuredMcpRegistrationNames: readonly string[];
  readonly errorClassification?: CodexAppServerDiagnosticErrorClassification;
}

export interface CodexAppServerCloseOptions {
  /**
   * Treat an explicit close as an unexpected backend failure for adapter
   * listeners. Runtime shutdowns disable this so an intentional SIGINT/SIGTERM
   * is not projected to Slack as a failed Agent turn.
   */
  reportAsFailure?: boolean;
}

export const DEFAULT_CODEX_APP_SERVER_ARGS = Object.freeze(["app-server"]);

export function resolveCodexAppServerArgs(
  args?: readonly string[],
): string[] {
  return [...(args ?? DEFAULT_CODEX_APP_SERVER_ARGS)];
}

export interface ServerRequestEvent {
  id: RpcId;
  method: string;
  params: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timeout: NodeJS.Timeout;
}

class CodexAppServerRequestTimeoutError extends Error {}

export class CodexAppServerClient {
  readonly #events = new EventEmitter();
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #timedOutRequestIds = new Map<RpcId, NodeJS.Timeout>();
  readonly #transport: AppServerTransport;
  readonly #options: {
    readonly clientName: string;
    readonly clientTitle: string;
    readonly clientVersion: string;
    readonly requestTimeoutMs: number;
    readonly onDiagnostic?: (event: CodexAppServerDiagnosticEvent) => void;
  };
  #diagnostics: CodexAppServerDiagnosticSnapshot = {
    spawn: "not_observed",
    initialize: "not_started",
    initializedNotification: "not_sent",
  };
  #nextRequestId = 1;
  #started = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    transport: AppServerTransport,
    options: CodexAppServerClientOptions = {},
  ) {
    this.#transport = transport;
    this.#options = {
      clientName: options.clientName ?? "showtalk_taishi",
      clientTitle: options.clientTitle ?? "ShowTalk Taishi",
      clientVersion: options.clientVersion ?? "0.0.1",
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      ...(options.onDiagnostic === undefined
        ? {}
        : { onDiagnostic: options.onDiagnostic }),
    };
  }

  static async spawn(
    options: CodexAppServerClientOptions & {
      command?: string;
      args?: string[];
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    } = {},
  ): Promise<CodexAppServerClient> {
    emitDiagnostic(options.onDiagnostic, {
      source: "codex_app_server",
      stage: "spawn_started",
      outcome: "started",
      cwd: classifyCwd(options.cwd),
    });
    const child = spawn(options.command ?? "codex", resolveCodexAppServerArgs(options.args), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const transport = new ChildProcessTransport(child);
    const client = new CodexAppServerClient(transport, options);
    client.#diagnostics = { ...client.#diagnostics, spawn: "started" };
    child.once("error", (error) => client.#handleTransportError(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => client.#events.emit("stderr", chunk));
    try {
      await client.start();
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#closed) throw new Error("Codex app-server client is closed");
    this.#started = true;

    const lines = createInterface({ input: this.#transport.input });
    lines.on("line", (line) => this.#handleLine(line));
    lines.on("close", () => this.#handleTransportClose());
    this.#transport.input.on("error", (error) => this.#handleTransportError(error));
    this.#transport.output.on("error", (error) => this.#handleTransportError(error));

    this.#diagnostics = { ...this.#diagnostics, initialize: "sent" };
    this.#emitDiagnostic({
      source: "codex_app_server",
      stage: "initialize_sent",
      outcome: "sent",
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: this.#options.clientName,
          title: this.#options.clientTitle,
          version: this.#options.clientVersion,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      this.#diagnostics = { ...this.#diagnostics, initialize: "responded" };
      this.#emitDiagnostic({
        source: "codex_app_server",
        stage: "initialize_response",
        outcome: "response",
      });
      this.notify("initialized", {});
      this.#diagnostics = {
        ...this.#diagnostics,
        initializedNotification: "sent",
      };
      this.#emitDiagnostic({
        source: "codex_app_server",
        stage: "initialized_notification",
        outcome: "sent",
      });
    } catch (error) {
      this.#recordDiagnosticError("initialize_response", error);
      throw error;
    }
  }

  /** Returns already-observed state and never sends an App Server request. */
  getDiagnosticSnapshot(): CodexAppServerDiagnosticSnapshot {
    return structuredClone(this.#diagnostics);
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.#events.on("notification", listener);
    return () => this.#events.off("notification", listener);
  }

  onServerRequest(listener: (event: ServerRequestEvent) => void): () => void {
    this.#events.on("serverRequest", listener);
    return () => this.#events.off("serverRequest", listener);
  }

  onProtocolError(listener: (error: Error) => void): () => void {
    this.#events.on("protocolError", listener);
    return () => this.#events.off("protocolError", listener);
  }

  onStderr(listener: (text: string) => void): () => void {
    this.#events.on("stderr", listener);
    return () => this.#events.off("stderr", listener);
  }

  onClose(listener: (error: Error) => void): () => void {
    this.#events.on("close", listener);
    return () => this.#events.off("close", listener);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (this.#closed) throw new Error("Codex app-server client is closed");
    const id = this.#nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        this.#rememberTimedOutRequest(id);
        reject(new CodexAppServerRequestTimeoutError(
          `Codex app-server request timed out: ${method}`,
        ));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
    });
    try {
      this.#write({ id, method, params });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending !== undefined) clearTimeout(pending.timeout);
      this.#pending.delete(id);
      throw error;
    }
    if (method !== "mcpServerStatus/list" || this.#options.onDiagnostic === undefined) {
      return promise as Promise<T>;
    }
    // Observe only an ordinary request already made by the caller. Diagnostics
    // never initiate this request or add one to thread start/resume.
    this.#emitDiagnostic({
      source: "codex_app_server",
      stage: "mcp_server_status_list_sent",
      outcome: "sent",
    });
    try {
      const result = await promise;
      const observation = sanitizeMcpServerStatusListResult(result);
      this.#diagnostics = { ...this.#diagnostics, mcpServerStatusList: observation };
      this.#emitDiagnostic({
        source: "codex_app_server",
        stage: "mcp_server_status_list_response",
        outcome: "response",
        effectiveMcpRegistrations: observation.registrations,
        mcpStatusListClassification: observation.classification,
      });
      return result as T;
    } catch (error) {
      const classification = classifyMcpStatusListError(error);
      this.#diagnostics = {
        ...this.#diagnostics,
        mcpServerStatusList: { classification, registrations: [] },
      };
      this.#emitDiagnostic({
        source: "codex_app_server",
        stage: "mcp_server_status_list_response",
        outcome: "error",
        effectiveMcpRegistrations: [],
        mcpStatusListClassification: classification,
      });
      throw error;
    }
  }

  notify(method: string, params: unknown): void {
    if (this.#closed) throw new Error("Codex app-server client is closed");
    this.#write({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.#write({ id, result });
  }

  respondError(id: RpcId, error: RpcError): void {
    this.#write({ id, error });
  }

  async startThread(params: ThreadStartParams): Promise<CodexThread> {
    return this.#observeThreadRequest("thread/start", params, "threadStart");
  }

  async resumeThread(params: ThreadResumeParams): Promise<CodexThread> {
    return this.#observeThreadRequest("thread/resume", params, "threadResume");
  }

  async readThread(threadId: string, includeTurns = false): Promise<CodexThread> {
    const result = await this.request<{ thread: CodexThread }>("thread/read", {
      threadId,
      includeTurns,
    });
    return result.thread;
  }

  async listThreadTurns(
    threadId: string,
    params: ThreadTurnsListParams = {},
  ): Promise<ThreadTurnsListResponse> {
    return this.request<ThreadTurnsListResponse>("thread/turns/list", {
      threadId,
      ...params,
    });
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    await this.request("thread/unsubscribe", { threadId });
  }

  async listModels(params: ModelListParams = {}): Promise<ModelListResponse> {
    return this.request<ModelListResponse>("model/list", params);
  }

  async startTurn(params: TurnStartParams): Promise<CodexTurn> {
    const result = await this.request<{ turn: CodexTurn }>("turn/start", params);
    return result.turn;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  respondToCommandApproval(id: RpcId, decision: CommandApprovalDecision): void {
    this.respond(id, { decision });
  }

  respondToFileChangeApproval(id: RpcId, decision: FileChangeApprovalDecision): void {
    this.respond(id, { decision });
  }

  respondToPermissionsApproval(
    id: RpcId,
    response: PermissionsApprovalResponse,
  ): void {
    this.respond(id, response);
  }

  respondToUserInput(id: RpcId, response: ToolRequestUserInputResponse): void {
    this.respond(id, response);
  }

  async respondToUserInputAndDrain(
    id: RpcId,
    response: ToolRequestUserInputResponse,
  ): Promise<void> {
    await this.#writeAndDrain({ id, result: response });
  }

  respondToMcpServerElicitation(
    id: RpcId,
    response: McpServerElicitationResponse,
  ): void {
    this.respond(id, response);
  }

  async close(options: CodexAppServerCloseOptions = {}): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      const error = new Error("Codex app-server client closed");
      this.#rejectPending(error);
      if (options.reportAsFailure ?? true) {
        this.#events.emit("close", error);
      }
    }
    await this.#beginTransportClose();
  }

  async #observeThreadRequest(
    method: "thread/start" | "thread/resume",
    params: ThreadStartParams | ThreadResumeParams,
    snapshotKey: "threadStart" | "threadResume",
  ): Promise<CodexThread> {
    const sentStage = method === "thread/start"
      ? "thread_start_sent"
      : "thread_resume_sent";
    const responseStage = method === "thread/start"
      ? "thread_start_response"
      : "thread_resume_response";
    const metadata = threadDiagnosticMetadata(params);
    this.#diagnostics = {
      ...this.#diagnostics,
      [snapshotKey]: { state: "sent", ...metadata },
    };
    this.#emitDiagnostic({
      source: "codex_app_server",
      stage: sentStage,
      outcome: "sent",
      ...metadata,
    });
    try {
      const result = await this.request<{ thread: CodexThread }>(method, params);
      this.#diagnostics = {
        ...this.#diagnostics,
        [snapshotKey]: { state: "responded", ...metadata },
      };
      this.#emitDiagnostic({
        source: "codex_app_server",
        stage: responseStage,
        outcome: "response",
        ...metadata,
      });
      return result.thread;
    } catch (error) {
      const classification = classifyDiagnosticError(error);
      this.#diagnostics = {
        ...this.#diagnostics,
        [snapshotKey]: {
          state: "error",
          ...metadata,
          errorClassification: classification,
        },
        lastError: { stage: responseStage, classification },
      };
      this.#emitDiagnostic({
        source: "codex_app_server",
        stage: responseStage,
        outcome: "error",
        ...metadata,
        errorClassification: classification,
      });
      throw error;
    }
  }

  #recordDiagnosticError(
    stage: CodexAppServerDiagnosticStage,
    error: unknown,
  ): void {
    const classification = classifyDiagnosticError(error);
    this.#diagnostics = {
      ...this.#diagnostics,
      lastError: { stage, classification },
    };
    this.#emitDiagnostic({
      source: "codex_app_server",
      stage,
      outcome: "error",
      errorClassification: classification,
    });
  }

  #emitDiagnostic(event: CodexAppServerDiagnosticEvent): void {
    emitDiagnostic(this.#options.onDiagnostic, event);
  }

  #write(message: object): void {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.#transport.output.write(line)) {
      this.#events.emit("backpressure");
    }
  }

  async #writeAndDrain(message: object): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      const accepted = this.#transport.output.write(line, (error) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
      if (!accepted) this.#events.emit("backpressure");
    });
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      this.#events.emit(
        "protocolError",
        new CodexProtocolError("Codex app-server emitted invalid JSON", error),
      );
      return;
    }
    if (!isRpcMessageRecord(parsed)) {
      this.#events.emit(
        "protocolError",
        new CodexProtocolError("Unknown Codex app-server message shape"),
      );
      return;
    }
    const message = parsed as unknown as RpcInboundMessage;

    if ("id" in message && !("method" in message)) {
      if (!isRpcId(message.id)) {
        this.#events.emit(
          "protocolError",
          new CodexProtocolError("Codex app-server response has an invalid id"),
        );
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) {
        const tombstone = this.#timedOutRequestIds.get(message.id);
        if (tombstone !== undefined) {
          clearTimeout(tombstone);
          this.#timedOutRequestIds.delete(message.id);
          return;
        }
        this.#events.emit(
          "protocolError",
          new CodexProtocolError(`Unexpected response id: ${String(message.id)}`),
        );
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timeout);
      if ("error" in message) {
        if (!isRpcError(message.error)) {
          pending.reject(
            new CodexProtocolError("Codex app-server response has an invalid error"),
          );
          return;
        }
        pending.reject(
          new CodexRpcError(message.error.message, message.error.code, message.error.data),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message && "id" in message) {
      if (typeof message.method !== "string" || !isRpcId(message.id)) {
        this.#events.emit(
          "protocolError",
          new CodexProtocolError("Codex app-server request has an invalid method or id"),
        );
        return;
      }
      const request = message as RpcRequest;
      this.#events.emit("serverRequest", {
        id: request.id,
        method: request.method,
        params: request.params,
      } satisfies ServerRequestEvent);
      return;
    }

    if ("method" in message) {
      if (typeof message.method !== "string") {
        this.#events.emit(
          "protocolError",
          new CodexProtocolError("Codex app-server notification has an invalid method"),
        );
        return;
      }
      this.#events.emit("notification", message.method, message.params);
      return;
    }

    this.#events.emit(
      "protocolError",
      new CodexProtocolError("Unknown Codex app-server message shape"),
    );
  }

  #handleTransportError(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#events.emit("protocolError", error);
    this.#rejectPending(error);
    this.#events.emit("close", error);
    void this.#beginTransportClose().catch(() => undefined);
  }

  #handleTransportClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error("Codex app-server transport closed");
    this.#rejectPending(error);
    this.#events.emit("close", error);
    void this.#beginTransportClose().catch(() => undefined);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const timeout of this.#timedOutRequestIds.values()) clearTimeout(timeout);
    this.#timedOutRequestIds.clear();
  }

  #rememberTimedOutRequest(id: RpcId): void {
    const timeout = setTimeout(() => {
      this.#timedOutRequestIds.delete(id);
    }, 5 * 60 * 1_000);
    timeout.unref();
    this.#timedOutRequestIds.set(id, timeout);
    while (this.#timedOutRequestIds.size > 1_024) {
      const oldest = this.#timedOutRequestIds.keys().next().value as RpcId | undefined;
      if (oldest === undefined) break;
      const oldestTimeout = this.#timedOutRequestIds.get(oldest);
      if (oldestTimeout !== undefined) clearTimeout(oldestTimeout);
      this.#timedOutRequestIds.delete(oldest);
    }
  }

  #beginTransportClose(): Promise<void> {
    this.#closePromise ??= Promise.resolve().then(() => this.#transport.close());
    return this.#closePromise;
  }
}

function threadDiagnosticMetadata(
  params: ThreadStartParams | ThreadResumeParams,
): Omit<CodexAppServerThreadDiagnosticSnapshot, "state" | "errorClassification"> {
  const config = params.config;
  const mcpServers = isRecord(config?.mcp_servers)
    ? config.mcp_servers
    : undefined;
  return {
    cwd: classifyCwd(params.cwd),
    configKeyNames: Object.keys(config ?? {}).sort(),
    configuredMcpRegistrationNames: Object.keys(mcpServers ?? {}).sort(),
  };
}

const MCP_SERVER_CONNECTION_STATUSES = new Set<McpServerConnectionStatus>([
  "notStarted",
  "starting",
  "connected",
  "authenticationRequired",
  "failed",
  "cancelled",
  "disabled",
]);

function sanitizeMcpServerStatusListResult(
  result: unknown,
): NonNullable<CodexAppServerDiagnosticSnapshot["mcpServerStatusList"]> {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    return { classification: "invalid_result", registrations: [] };
  }
  if (!(result.nextCursor === null || typeof result.nextCursor === "string")) {
    return { classification: "invalid_result", registrations: [] };
  }
  const registrations: CodexEffectiveMcpRegistrationStatus[] = [];
  for (const entry of result.data) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !(
        entry.runtimeStatus === null ||
        (
          typeof entry.runtimeStatus === "string" &&
          MCP_SERVER_CONNECTION_STATUSES.has(
            entry.runtimeStatus as McpServerConnectionStatus,
          )
        )
      )
    ) {
      return { classification: "invalid_result", registrations: [] };
    }
    registrations.push({
      name: entry.name,
      status: entry.runtimeStatus as McpServerConnectionStatus | null,
    });
  }
  registrations.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  if (registrations.length === 0) {
    return { classification: "empty_result", registrations: [] };
  }
  return {
    classification: result.nextCursor === null ? "success" : "partial_result",
    registrations,
  };
}

function classifyMcpStatusListError(
  error: unknown,
): CodexMcpStatusListClassification {
  if (error instanceof CodexRpcError && error.code === -32601) {
    return "api_unsupported";
  }
  const classification = classifyDiagnosticError(error);
  if (classification === "protocol_error") return "invalid_result";
  return classification;
}

function classifyCwd(cwd: string | undefined): CodexAppServerCwdClassification {
  if (cwd === undefined || cwd.length === 0) return "absent";
  return isAbsolute(cwd) ? "absolute" : "relative";
}

function classifyDiagnosticError(
  error: unknown,
): CodexAppServerDiagnosticErrorClassification {
  if (error instanceof CodexAppServerRequestTimeoutError) return "timeout";
  if (error instanceof CodexRpcError) return "rpc_error";
  if (error instanceof CodexProtocolError) return "protocol_error";
  if (error instanceof Error && /client (?:is )?closed/u.test(error.message)) {
    return "client_closed";
  }
  return "transport_or_unknown_error";
}

function emitDiagnostic(
  sink: ((event: CodexAppServerDiagnosticEvent) => void) | undefined,
  event: CodexAppServerDiagnosticEvent,
): void {
  try {
    sink?.(structuredClone(event));
  } catch {
    // Read-only diagnostics must never change App Server client behavior.
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcMessageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || typeof value === "number";
}

function isRpcError(value: unknown): value is RpcError {
  if (!isRpcMessageRecord(value)) return false;
  return typeof value.code === "number" && typeof value.message === "string";
}

class ChildProcessTransport implements AppServerTransport {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {}

  get input(): Readable {
    return this.child.stdout;
  }

  get output(): Writable {
    return this.child.stdin;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    if (await waitForChildExit(this.child, 1_000)) return;
    this.child.kill("SIGTERM");
    if (await waitForChildExit(this.child, 3_000)) return;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await waitForChildExit(this.child, 1_000);
    }
  }
}

function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
