import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { z } from "zod";

import { ConfigError } from "../config/loader.js";
import {
  MAX_KOE_CALL_NAME_LENGTH,
  MAX_KOE_ID_LENGTH,
} from "../core/koe-address.js";
import {
  AdminConfigConflictError,
  type AdminConfigSnapshot,
  type AdminConfigUpdate,
} from "./config-repository.js";
import { renderAdminPage } from "./ui.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 1_048_576;
const ADMIN_SESSION_COOKIE_NAME = "showtalk_taishi_admin_session";
const ADMIN_SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const ADMIN_SESSION_HMAC_CONTEXT = "showtalk-taishi-local-admin-session-v1";

const optionalText = z.string().max(4_000).optional();
const adminAgentSchema = z
  .object({
    id: z.string().min(1).max(MAX_KOE_ID_LENGTH),
    adapter: z.string().min(1),
    adapter_session_id: z.string().max(256).optional(),
    model: z.string().min(1).max(256).optional(),
    reasoning_effort: z.string().min(1).max(64).optional(),
    workspace_path: z.string().min(1),
    slack: z
      .object({
        channel_id: z.string().min(1),
        conversation_scope: z.enum(["channel", "slack_thread"]),
        call_name: z.string().max(MAX_KOE_CALL_NAME_LENGTH).optional(),
        persona: optionalText,
        display_name: z.string().max(80).optional(),
        icon_url: z.string().max(2_048).optional(),
        icon_emoji: z.string().max(100).optional(),
      })
      .strict(),
    role: z.string().min(1),
    consultations: z.record(
      z.string().min(1).max(MAX_KOE_ID_LENGTH),
      z.object({ scope: z.string().min(1).max(2_000) }).strict(),
    ),
  })
  .strict();

const adminUpdateSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/u),
    agents: z.array(adminAgentSchema).min(1).max(256),
  })
  .strict();

export interface AdminConfigPort {
  read(): Promise<AdminConfigSnapshot>;
  save(update: AdminConfigUpdate): Promise<AdminConfigSnapshot>;
}

export interface AdminReasoningEffort {
  readonly value: string;
  readonly description: string;
}

export interface AdminModelOption {
  readonly id: string;
  readonly model: string;
  readonly display_name: string;
  readonly description: string;
  readonly is_default: boolean;
  readonly default_reasoning_effort: string;
  readonly supported_reasoning_efforts: readonly AdminReasoningEffort[];
  readonly input_modalities: readonly string[];
}

export interface AdminModelCatalogSnapshot {
  readonly agent_id: string;
  readonly fetched_at: string;
  readonly models: readonly AdminModelOption[];
}

export interface AdminModelCatalogPort {
  list(agentId: string, options?: { readonly refresh?: boolean }): Promise<AdminModelCatalogSnapshot>;
}

export interface LocalAdminServerOptions {
  readonly port: number;
  readonly accessToken: string;
  readonly repository: AdminConfigPort;
  readonly modelCatalog?: AdminModelCatalogPort;
  readonly onConfigSaved?: (snapshot: AdminConfigSnapshot) => void;
  readonly onRestartRequested: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface AdminRequestHandlerOptions
  extends Omit<LocalAdminServerOptions, "port"> {
  readonly csrfToken: string;
}

export class LocalAdminServer {
  readonly #options: LocalAdminServerOptions;
  #server: Server | undefined;

  constructor(options: LocalAdminServerOptions) {
    this.#options = options;
  }

  async start(): Promise<string> {
    if (this.#server !== undefined) {
      throw new Error("ShowTalk Taishi admin server is already running");
    }
    const csrfToken = randomBytes(32).toString("base64url");
    const server = createServer(
      createAdminRequestHandler({
        csrfToken,
        accessToken: this.#options.accessToken,
        repository: this.#options.repository,
        ...(this.#options.modelCatalog === undefined
          ? {}
          : { modelCatalog: this.#options.modelCatalog }),
        ...(this.#options.onConfigSaved === undefined
          ? {}
          : { onConfigSaved: this.#options.onConfigSaved }),
        onRestartRequested: this.#options.onRestartRequested,
        ...(this.#options.onError === undefined
          ? {}
          : { onError: this.#options.onError }),
      }),
    );
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 64;
    this.#server = server;
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
        server.listen(this.#options.port, LOOPBACK_HOST);
      });
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        throw new Error("ShowTalk Taishi admin server did not expose an address");
      }
      return `http://${LOOPBACK_HOST}:${address.port}/`;
    } catch (error) {
      this.#server = undefined;
      server.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server === undefined) return;
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeIdleConnections();
    });
  }
}

export function createAdminRequestHandler(
  options: AdminRequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  let restartScheduled = false;
  return (request, response) => {
    void handleRequest(request, response, options, () => {
      if (restartScheduled) return false;
      restartScheduled = true;
      return true;
    }, () => restartScheduled).catch((error: unknown) => {
      options.onError?.(error);
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: "管理画面で予期しないエラーが発生しました。Gatewayログを確認してください。",
        });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AdminRequestHandlerOptions,
  scheduleRestart: () => boolean,
  isRestartScheduled: () => boolean,
): Promise<void> {
  setSecurityHeaders(response);
  if (!isLoopbackRequest(request) || !isAllowedHost(request.headers.host)) {
    writeJson(response, 403, { error: "Localhostからのみ利用できます。" });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.search.length > 0) {
    writeJson(response, 400, { error: "Query parameters are not supported." });
    return;
  }
  if (url.pathname.startsWith("/api/") && !authorizeAccess(request, options.accessToken)) {
    response.setHeader("www-authenticate", 'Bearer realm="ShowTalk Taishi admin"');
    writeJson(response, 401, {
      error: "管理画面を再読み込みしてセッションを更新してください。",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.setHeader("set-cookie", createAdminSessionCookie(options.accessToken));
    response.setHeader(
      "content-security-policy",
      [
        "default-src 'none'",
        `script-src 'nonce-${options.csrfToken}'`,
        "style-src 'unsafe-inline'",
        "img-src https: data:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    response.end(renderAdminPage(options.csrfToken));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    writeJson(response, 200, await options.repository.read());
    return;
  }
  const modelRoute = parseModelRoute(url.pathname);
  if (
    modelRoute !== undefined &&
    ((request.method === "GET" && !modelRoute.refresh) ||
      (request.method === "POST" && modelRoute.refresh))
  ) {
    if (modelRoute.refresh && !authorizeMutation(request, options.csrfToken)) {
      writeJson(response, 403, { error: "操作トークンを確認できません。画面を再読み込みしてください。" });
      return;
    }
    if (options.modelCatalog === undefined) {
      writeJson(response, 503, { error: "モデル一覧は現在のGatewayから取得できません。" });
      return;
    }
    writeJson(
      response,
      200,
      await options.modelCatalog.list(modelRoute.agentId, {
        refresh: modelRoute.refresh,
      }),
    );
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    writeJson(response, 200, {
      status: isRestartScheduled() ? "restarting" : "running",
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    if (!authorizeMutation(request, options.csrfToken)) {
      writeJson(response, 403, { error: "操作トークンを確認できません。画面を再読み込みしてください。" });
      return;
    }
    try {
      const payload = adminUpdateSchema.parse(await readJsonBody(request));
      const current = await options.repository.read();
      await validateModelSettingChanges(
        payload.agents,
        current,
        options.modelCatalog,
      );
      const saved = await options.repository.save(payload);
      options.onConfigSaved?.(saved);
      writeJson(response, 200, saved);
    } catch (error) {
      writeAdminError(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/restart") {
    if (!authorizeMutation(request, options.csrfToken)) {
      writeJson(response, 403, { error: "操作トークンを確認できません。画面を再読み込みしてください。" });
      return;
    }
    if (!scheduleRestart()) {
      writeJson(response, 409, { error: "Gatewayの再起動はすでに進行中です。" });
      return;
    }
    response.once("finish", () => queueMicrotask(options.onRestartRequested));
    writeJson(response, 202, { status: "scheduled" });
    return;
  }

  response.setHeader("allow", "GET, PUT, POST");
  writeJson(response, 404, { error: "ページが見つかりません。" });
}

async function validateModelSettingChanges(
  incomingAgents: readonly z.infer<typeof adminAgentSchema>[],
  current: AdminConfigSnapshot,
  catalogPort: AdminModelCatalogPort | undefined,
): Promise<void> {
  const currentById = new Map(current.agents.map((agent) => [agent.id, agent]));
  for (const incoming of incomingAgents) {
    const existing = currentById.get(incoming.id);
    if (
      existing === undefined ||
      (incoming.model === existing.model &&
        incoming.reasoning_effort === existing.reasoning_effort)
    ) {
      continue;
    }
    if (catalogPort === undefined) {
      throw new ConfigError(
        `Koe ${incoming.id} model settings cannot be validated by the running Gateway`,
      );
    }
    const catalog = await catalogPort.list(incoming.id);
    const effectiveModel = incoming.model ?? existing.adapter_model;
    const model = effectiveModel === undefined
      ? catalog.models.find((candidate) => candidate.is_default) ?? catalog.models[0]
      : catalog.models.find(
          (candidate) =>
            candidate.model === effectiveModel || candidate.id === effectiveModel,
        );
    if (model === undefined) {
      throw new ConfigError(
        `Koe ${incoming.id} selected a model that is not available from its Codex App Server`,
      );
    }
    const effectiveEffort =
      incoming.reasoning_effort ??
      existing.adapter_reasoning_effort ??
      model.default_reasoning_effort;
    if (
      !model.supported_reasoning_efforts.some(
        (candidate) => candidate.value === effectiveEffort,
      )
    ) {
      throw new ConfigError(
        `Koe ${incoming.id} selected reasoning effort ${effectiveEffort}, which is not supported by ${model.display_name}`,
      );
    }
  }
}

function parseModelRoute(
  pathname: string,
): { readonly agentId: string; readonly refresh: boolean } | undefined {
  const match = /^\/api\/agents\/([^/]+)\/models(\/refresh)?$/u.exec(pathname);
  if (match === null) return undefined;
  try {
    const agentId = decodeURIComponent(match[1] ?? "");
    if (agentId.length === 0 || agentId.includes("/")) return undefined;
    return { agentId, refresh: match[2] !== undefined };
  } catch {
    return undefined;
  }
}

function authorizeMutation(request: IncomingMessage, csrfToken: string): boolean {
  const supplied = request.headers["x-showtalk-csrf"];
  if (supplied !== csrfToken) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  return host !== undefined && origin === `http://${host}`;
}

function authorizeAccess(request: IncomingMessage, accessToken: string): boolean {
  if (authorizeSessionCookie(request, accessToken)) return true;

  const authorization = request.headers.authorization;
  if (authorization === undefined || Array.isArray(authorization)) return false;
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) return false;
  return securelyMatches(authorization.slice(prefix.length), accessToken);
}

function authorizeSessionCookie(
  request: IncomingMessage,
  accessToken: string,
): boolean {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) return false;
  const expected = deriveAdminSessionValue(accessToken);
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    const name = cookie.slice(0, separator).trim();
    if (name !== ADMIN_SESSION_COOKIE_NAME) continue;
    const supplied = cookie.slice(separator + 1).trim();
    if (securelyMatches(supplied, expected)) return true;
  }
  return false;
}

function createAdminSessionCookie(accessToken: string): string {
  return [
    `${ADMIN_SESSION_COOKIE_NAME}=${deriveAdminSessionValue(accessToken)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${ADMIN_SESSION_MAX_AGE_SECONDS}`,
  ].join("; ");
}

function deriveAdminSessionValue(accessToken: string): string {
  return createHmac("sha256", accessToken)
    .update(ADMIN_SESSION_HMAC_CONTEXT)
    .digest("base64url");
}

function securelyMatches(suppliedValue: string, expectedValue: string): boolean {
  const supplied = Buffer.from(suppliedValue);
  const expected = Buffer.from(expectedValue);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function isAllowedHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new ConfigError("Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) {
      throw new ConfigError("The configuration update is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ConfigError("The request body is not valid JSON", error);
  }
}

function writeAdminError(response: ServerResponse, error: unknown): void {
  if (error instanceof AdminConfigConflictError) {
    writeJson(response, 409, { error: error.message });
    return;
  }
  if (error instanceof ConfigError || error instanceof z.ZodError) {
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        : error.message;
    writeJson(response, 400, { error: message });
    return;
  }
  throw error;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cross-origin-resource-policy", "same-origin");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(body)}\n`);
}
