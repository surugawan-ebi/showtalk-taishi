import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import {
  CodexProtocolError,
  CodexRpcError,
  type CodexThread,
  type CodexTurn,
  type CommandApprovalDecision,
  type FileChangeApprovalDecision,
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

export class CodexAppServerClient {
  readonly #events = new EventEmitter();
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #timedOutRequestIds = new Map<RpcId, NodeJS.Timeout>();
  readonly #transport: AppServerTransport;
  readonly #options: Required<CodexAppServerClientOptions>;
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
    const child = spawn(options.command ?? "codex", resolveCodexAppServerArgs(options.args), {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const transport = new ChildProcessTransport(child);
    const client = new CodexAppServerClient(transport, options);
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
    this.notify("initialized", {});
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
        reject(new Error(`Codex app-server request timed out: ${method}`));
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
    return promise as Promise<T>;
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
    const result = await this.request<{ thread: CodexThread }>("thread/start", params);
    return result.thread;
  }

  async resumeThread(params: ThreadResumeParams): Promise<CodexThread> {
    const result = await this.request<{ thread: CodexThread }>("thread/resume", params);
    return result.thread;
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

  #write(message: object): void {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.#transport.output.write(line)) {
      this.#events.emit("backpressure");
    }
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
