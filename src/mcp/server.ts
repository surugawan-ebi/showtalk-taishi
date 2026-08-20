import { createHash, randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { agentIdSchema } from "./schemas.js";
import { createAgentMcpServer } from "./tools.js";
import type {
  AgentMcpCredential,
  McpHttpEndpoint,
  SwitchboardMcpService,
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const DEFAULT_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type Lifecycle = "new" | "starting" | "listening" | "closing" | "closed";

interface ActiveMcpRequest {
  close(): Promise<void>;
}

export interface AuthenticatedMcpHttpServerOptions {
  /** Port 0 selects an ephemeral port and is the default. */
  readonly port?: number;
  readonly path?: string;
  readonly maxBodyBytes?: number;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

/**
 * Loopback-only, stateless Streamable HTTP MCP boundary.
 *
 * Every POST authenticates independently and creates a request-local MCP server.
 * No mutable global caller context exists, so concurrent Agents cannot exchange
 * identities through request interleaving.
 */
export class AuthenticatedMcpHttpServer {
  readonly #service: SwitchboardMcpService;
  readonly #requestedPort: number;
  readonly #path: string;
  readonly #maxBodyBytes: number;
  readonly #serverName: string;
  readonly #serverVersion: string;
  readonly #credentialsByAgent = new Map<string, AgentMcpCredential>();
  readonly #callerByTokenDigest = new Map<string, string>();
  readonly #activeRequests = new Set<ActiveMcpRequest>();
  readonly #idleWaiters = new Set<() => void>();

  #state: Lifecycle = "new";
  #draining = false;
  #activeHttpRequests = 0;
  #httpServer: HttpServer | undefined;
  #endpoint: McpHttpEndpoint | undefined;
  #startPromise: Promise<McpHttpEndpoint> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(
    service: SwitchboardMcpService,
    options: AuthenticatedMcpHttpServerOptions = {},
  ) {
    this.#service = service;
    this.#requestedPort = validatePort(options.port ?? 0);
    this.#path = validatePath(options.path ?? DEFAULT_PATH);
    this.#maxBodyBytes = validateBodyLimit(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    this.#serverName = options.serverName ?? "showtalk-taishi";
    this.#serverVersion = options.serverVersion ?? "0.0.1";
  }

  get endpoint(): McpHttpEndpoint | undefined {
    return this.#endpoint;
  }

  start(): Promise<McpHttpEndpoint> {
    if (this.#state === "listening" && this.#endpoint !== undefined) {
      return Promise.resolve(this.#endpoint);
    }
    if (this.#state === "starting" && this.#startPromise !== undefined) {
      return this.#startPromise;
    }
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error("MCP HTTP server is closed"));
    }

    this.#state = "starting";
    const promise = this.#listen();
    this.#startPromise = promise;
    void promise.then(
      () => {
        this.#startPromise = undefined;
      },
      () => {
        this.#startPromise = undefined;
      },
    );
    return promise;
  }

  async provisionAgent(agentId: string): Promise<AgentMcpCredential> {
    const parsedAgentId = agentIdSchema.parse(agentId);
    if (this.#state !== "listening" || this.#endpoint === undefined) {
      throw new Error("MCP HTTP server must be listening before provisioning an Agent");
    }

    const known = await this.#service.isKnownAgent(parsedAgentId);
    if (!known) throw new Error(`Cannot provision unknown Agent: ${parsedAgentId}`);
    if (this.#state !== "listening" || this.#endpoint === undefined) {
      throw new Error("MCP HTTP server closed while provisioning the Agent");
    }

    const existing = this.#credentialsByAgent.get(parsedAgentId);
    if (existing !== undefined) return existing;

    let token: string;
    let digest: string;
    do {
      token = randomBytes(TOKEN_BYTES).toString("base64url");
      digest = tokenDigest(token);
    } while (this.#callerByTokenDigest.has(digest));

    const credential = Object.freeze({
      agentId: parsedAgentId,
      url: this.#endpoint.url,
      token,
    });
    this.#credentialsByAgent.set(parsedAgentId, credential);
    this.#callerByTokenDigest.set(digest, parsedAgentId);
    return credential;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const promise = this.#closeInternal();
    this.#closePromise = promise;
    return promise;
  }

  /** Stops admitting MCP HTTP work while allowing accepted responses to finish. */
  beginDrain(): void {
    this.#draining = true;
  }

  isIdle(): boolean {
    return this.#activeHttpRequests === 0;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }

  async #listen(): Promise<McpHttpEndpoint> {
    const server = createServer((request, response) => {
      void this.#handleRequest(request, response).catch(() => {
        if (!response.headersSent) {
          writeError(response, 500, "Internal server error");
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 1_000;
    server.on("clientError", (_error, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    this.#httpServer = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.#requestedPort, LOOPBACK_HOST);
      });
    } catch (error) {
      this.#httpServer = undefined;
      this.#state = "new";
      throw error;
    }

    const address = server.address() as AddressInfo | null;
    if (address === null || address.address !== LOOPBACK_HOST) {
      await closeHttpServer(server);
      this.#httpServer = undefined;
      this.#state = "closed";
      throw new Error("MCP HTTP server did not bind to the IPv4 loopback interface");
    }
    const endpoint = Object.freeze({
      host: LOOPBACK_HOST,
      port: address.port,
      path: this.#path,
      url: `http://${LOOPBACK_HOST}:${address.port}${this.#path}`,
    });
    this.#endpoint = endpoint;
    this.#state = "listening";
    return endpoint;
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);
    if (
      this.#state !== "listening" ||
      this.#endpoint === undefined ||
      this.#draining
    ) {
      writeError(response, 503, "Service unavailable");
      return;
    }

    this.#activeHttpRequests += 1;
    try {
      await this.#handleAcceptedRequest(request, response);
    } finally {
      this.#activeHttpRequests -= 1;
      this.#resolveIdleWaitersIfIdle();
    }
  }

  async #handleAcceptedRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {

    const requestUrl = parseRequestUrl(request.url);
    if (requestUrl === undefined || requestUrl.pathname !== this.#path || requestUrl.search !== "") {
      writeError(response, 404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      writeError(response, 405, "Method not allowed");
      return;
    }
    if (!this.#hasExpectedHost(request) || request.headers.origin !== undefined) {
      writeError(response, 403, "Forbidden");
      return;
    }

    const callerAgentId = this.#authenticate(request);
    if (callerAgentId === undefined) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="showtalk-taishi-mcp"');
      writeError(response, 401, "Unauthorized");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request, this.#maxBodyBytes);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        writeError(response, error.status, error.message);
        return;
      }
      throw error;
    }

    if (this.#state !== "listening") {
      writeError(response, 503, "Service unavailable");
      return;
    }

    const mcpServer = createAgentMcpServer(this.#service, callerAgentId, {
      name: this.#serverName,
      version: this.#serverVersion,
    });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    let closePromise: Promise<void> | undefined;
    const active: ActiveMcpRequest = {
      close: () => {
        closePromise ??= Promise.allSettled([mcpServer.close(), transport.close()]).then(
          () => undefined,
        );
        return closePromise;
      },
    };
    this.#activeRequests.add(active);

    try {
      // SDK 1.30's optional callback declarations conflict under
      // exactOptionalPropertyTypes even though this class implements Transport.
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response, body);
    } finally {
      await active.close();
      this.#activeRequests.delete(active);
    }
  }

  #authenticate(request: IncomingMessage): string | undefined {
    let authorizationCount = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "authorization") authorizationCount += 1;
    }
    if (authorizationCount !== 1) return undefined;

    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") return undefined;
    const match = /^Bearer ([A-Za-z0-9_-]+)$/iu.exec(authorization);
    const token = match?.[1];
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    return this.#callerByTokenDigest.get(tokenDigest(token));
  }

  #hasExpectedHost(request: IncomingMessage): boolean {
    if (this.#endpoint === undefined) return false;
    return request.headers.host === `${LOOPBACK_HOST}:${this.#endpoint.port}`;
  }

  async #closeInternal(): Promise<void> {
    if (this.#state === "closed") return;
    if (this.#state === "new") {
      this.#state = "closed";
      this.#credentialsByAgent.clear();
      this.#callerByTokenDigest.clear();
      return;
    }
    if (this.#state === "starting" && this.#startPromise !== undefined) {
      await this.#startPromise.catch(() => undefined);
    }

    this.#state = "closing";
    const server = this.#httpServer;
    const closeServer = server === undefined ? Promise.resolve() : closeHttpServer(server);
    await Promise.allSettled([...this.#activeRequests].map((active) => active.close()));
    await closeServer;
    this.#activeRequests.clear();
    this.#resolveIdleWaitersIfIdle();
    this.#credentialsByAgent.clear();
    this.#callerByTokenDigest.clear();
    this.#httpServer = undefined;
    this.#endpoint = undefined;
    this.#state = "closed";
  }

  #resolveIdleWaitersIfIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }
}

class HttpRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim() !== "application/json") {
    throw new HttpRequestError(415, "Content-Type must be application/json");
  }

  const contentLength = request.headers["content-length"];
  if (Array.isArray(contentLength)) throw new HttpRequestError(400, "Invalid Content-Length");
  if (contentLength !== undefined) {
    if (!/^\d+$/u.test(contentLength)) throw new HttpRequestError(400, "Invalid Content-Length");
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) throw new HttpRequestError(400, "Invalid Content-Length");
    if (declaredBytes > maxBytes) throw new HttpRequestError(413, "Request body is too large");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) throw new HttpRequestError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (totalBytes === 0) throw new HttpRequestError(400, "Request body is required");

  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown;
  } catch {
    throw new HttpRequestError(400, "Request body must be valid JSON");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function writeError(response: ServerResponse, status: number, message: string): void {
  if (response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_000, message },
      id: null,
    }),
  );
}

function parseRequestUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value, `http://${LOOPBACK_HOST}`);
  } catch {
    return undefined;
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("MCP HTTP port must be an integer from 0 through 65535");
  }
  return port;
}

function validatePath(path: string): string {
  if (
    path.length < 2 ||
    path.length > 128 ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    /[\u0000-\u0020\u007f]/u.test(path)
  ) {
    throw new TypeError("MCP HTTP path must be a non-root absolute path without whitespace or a query");
  }
  return path;
}

function validateBodyLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1_024 || limit > 8_388_608) {
    throw new RangeError("MCP maxBodyBytes must be an integer from 1024 through 8388608");
  }
  return limit;
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
