import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const APPOPS_APPROVAL_PROOF_VERSION = 1 as const;
export const APPOPS_APPROVAL_PROOF_AUDIENCE = "appops-mcp" as const;
export const APPOPS_APPROVAL_PROOF_ISSUER = "showtalk-taishi" as const;
export const APPOPS_APPROVAL_PROOF_TYPE =
  "showtalk-appops-approval+jws" as const;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PROOF_TTL_MS = 2 * 60 * 1_000;
const MAX_PROOF_LENGTH = 16_384;

const APPOPS_EXECUTE_TOOL_TO_SCOPE = {
  execute_approved_app_store_build_upload: "build_upload",
  execute_approved_app_store_version_setup: "version_setup",
  execute_approved_app_store_review_submission: "review_submission",
} as const;

export const APPOPS_EXECUTE_PRE_TOOL_USE_MATCHER =
  "^mcp__(?:appops|app_ops|app-ops)__(?:" +
  Object.keys(APPOPS_EXECUTE_TOOL_TO_SCOPE).join("|") +
  ")$";

export interface AppOpsApprovalProofPlan {
  readonly operationId: string;
  readonly planHash: string;
  readonly appId: string;
  readonly approvalScope:
    | "build_upload"
    | "version_setup"
    | "review_submission";
  readonly executeTool:
    | "execute_approved_app_store_build_upload"
    | "execute_approved_app_store_version_setup"
    | "execute_approved_app_store_review_submission";
  readonly expiresAt: string;
}

export interface AppOpsApprovalProofPayload {
  readonly v: typeof APPOPS_APPROVAL_PROOF_VERSION;
  readonly iss: typeof APPOPS_APPROVAL_PROOF_ISSUER;
  readonly aud: typeof APPOPS_APPROVAL_PROOF_AUDIENCE;
  readonly operation_id: string;
  readonly plan_hash: string;
  readonly app_id: string;
  readonly approval_scope: AppOpsApprovalProofPlan["approvalScope"];
  readonly execute_tool: AppOpsApprovalProofPlan["executeTool"];
  readonly issued_at: string;
  readonly expires_at: string;
  readonly nonce: string;
}

export interface AppOpsApprovalProofSigner {
  readonly keyId: string;
  readonly publicKeyPem: string;
  issue(plan: AppOpsApprovalProofPlan, now?: Date): string;
}

export interface AppOpsApprovalProofBinding {
  readonly agentId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly plan: AppOpsApprovalProofPlan;
  readonly proof: string;
}

export interface AppOpsPreToolUseInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

export type AppOpsPreToolUseDecision =
  | {
      readonly kind: "allow";
      readonly updatedInput: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "deny";
      readonly reason: string;
    };

interface PendingAppOpsApprovalProof extends AppOpsApprovalProofBinding {
  readonly expiresAtMs: number;
}

interface ConsumedAppOpsApprovalProof extends PendingAppOpsApprovalProof {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

/**
 * Process-local, one-shot handoff from a bound Slack approval to Codex's
 * PreToolUse hook. It never reads or mutates AppOps MCP approval state.
 */
export class AppOpsApprovalProofBroker {
  readonly #pending = new Map<string, PendingAppOpsApprovalProof>();
  readonly #consumed = new Map<string, ConsumedAppOpsApprovalProof>();

  register(binding: AppOpsApprovalProofBinding): void {
    validateBinding(binding);
    this.#sweepExpired();
    const key = proofBindingKey(
      binding.agentId,
      binding.sessionId,
      binding.turnId,
      binding.plan.operationId,
    );
    if (
      this.#pending.has(key) ||
      [...this.#consumed.keys()].some((consumedKey) =>
        consumedKey.startsWith(`${key}\u0000`)
      )
    ) {
      throw new Error("AppOps approval proof is already registered");
    }
    this.#pending.set(key, {
      ...binding,
      expiresAtMs: Math.min(
        Date.parse(binding.plan.expiresAt),
        Date.now() + MAX_PROOF_TTL_MS,
      ),
    });
  }

  consume(
    agentId: string,
    input: AppOpsPreToolUseInput,
  ): AppOpsPreToolUseDecision {
    this.#sweepExpired();
    const executeTool = appOpsExecuteToolName(input.toolName);
    if (executeTool === undefined) {
      return deny("The AppOps hook received an unsupported execute tool");
    }
    if (Object.hasOwn(input.toolInput, "approval_proof")) {
      return deny(
        "AppOps approval_proof must be supplied only by the bound PreToolUse hook",
      );
    }
    const operationId = input.toolInput.operation_id;
    const appId = input.toolInput.app_id;
    if (typeof operationId !== "string" || typeof appId !== "string") {
      return deny("The AppOps execute arguments are missing their exact identity");
    }
    const key = proofBindingKey(
      agentId,
      input.sessionId,
      input.turnId,
      operationId,
    );
    const invocationKey = proofInvocationKey(
      agentId,
      input.sessionId,
      input.turnId,
      operationId,
      input.toolUseId,
    );
    const binding = this.#pending.get(key);
    const consumed = this.#consumed.get(invocationKey);
    if (
      binding === undefined &&
      consumed !== undefined &&
      consumed.plan.appId === appId &&
      consumed.plan.executeTool === executeTool &&
      consumed.toolName === input.toolName &&
      consumed.toolUseId === input.toolUseId &&
      isDeepStrictEqual(consumed.toolInput, input.toolInput)
    ) {
      return {
        kind: "allow",
        updatedInput: Object.freeze({
          ...input.toolInput,
          approval_proof: consumed.proof,
        }),
      };
    }
    if (
      binding === undefined ||
      binding.plan.appId !== appId ||
      binding.plan.executeTool !== executeTool
    ) {
      return deny(
        "No exact one-time AppOps approval proof is bound to this tool call",
      );
    }

    // Consume before returning the rewritten arguments. A repeated hook or a
    // second execute call with a new tool-use ID fails closed. Codex can invoke
    // more than one configured PreToolUse hook for the same tool call, so an
    // exact duplicate hook invocation is idempotent until the proof expires.
    this.#pending.delete(key);
    this.#consumed.set(invocationKey, {
      ...binding,
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      toolInput: Object.freeze({ ...input.toolInput }),
    });
    return {
      kind: "allow",
      updatedInput: Object.freeze({
        ...input.toolInput,
        approval_proof: binding.proof,
      }),
    };
  }

  clearSession(agentId: string, sessionId: string): void {
    const prefix = `${agentId}\u0000${sessionId}\u0000`;
    for (const key of this.#pending.keys()) {
      if (key.startsWith(prefix)) this.#pending.delete(key);
    }
    for (const key of this.#consumed.keys()) {
      if (key.startsWith(prefix)) this.#consumed.delete(key);
    }
  }

  #sweepExpired(now = Date.now()): void {
    for (const [key, binding] of this.#pending) {
      if (binding.expiresAtMs <= now) this.#pending.delete(key);
    }
    for (const [key, binding] of this.#consumed) {
      if (binding.expiresAtMs <= now) this.#consumed.delete(key);
    }
  }
}

export class Ed25519AppOpsApprovalProofSigner
  implements AppOpsApprovalProofSigner
{
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly #privateKey: KeyObject;

  constructor(input: {
    readonly keyId: string;
    readonly privateKey: KeyObject;
    readonly publicKeyPem: string;
  }) {
    this.keyId = boundedIdentifier(input.keyId, "AppOps approval key ID");
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(this.keyId)) {
      throw new Error("AppOps approval key ID is invalid");
    }
    this.publicKeyPem = input.publicKeyPem;
    this.#privateKey = input.privateKey;
    if (this.#privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("AppOps approval proof requires an Ed25519 private key");
    }
  }

  issue(plan: AppOpsApprovalProofPlan, now = new Date()): string {
    validatePlan(plan);
    const issuedAtMs = now.getTime();
    const planExpiryMs = Date.parse(plan.expiresAt);
    const expiresAtMs = Math.min(
      planExpiryMs,
      issuedAtMs + MAX_PROOF_TTL_MS,
    );
    if (!Number.isFinite(issuedAtMs) || expiresAtMs <= issuedAtMs) {
      throw new Error("AppOps approval plan has already expired");
    }
    const header = {
      alg: "EdDSA",
      kid: this.keyId,
      typ: APPOPS_APPROVAL_PROOF_TYPE,
      v: APPOPS_APPROVAL_PROOF_VERSION,
    } as const;
    const payload: AppOpsApprovalProofPayload = {
      v: APPOPS_APPROVAL_PROOF_VERSION,
      iss: APPOPS_APPROVAL_PROOF_ISSUER,
      aud: APPOPS_APPROVAL_PROOF_AUDIENCE,
      operation_id: plan.operationId,
      plan_hash: plan.planHash,
      app_id: plan.appId,
      approval_scope: plan.approvalScope,
      execute_tool: plan.executeTool,
      issued_at: new Date(issuedAtMs).toISOString(),
      expires_at: new Date(expiresAtMs).toISOString(),
      nonce: randomUUID(),
    };
    const protectedHeader = base64urlJson(header);
    const encodedPayload = base64urlJson(payload);
    const signingInput = `${protectedHeader}.${encodedPayload}`;
    const signature = sign(null, Buffer.from(signingInput), this.#privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }
}

export function createEphemeralAppOpsApprovalProofSigner(): AppOpsApprovalProofSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return new Ed25519AppOpsApprovalProofSigner({
    keyId: randomUUID(),
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  });
}

function validatePlan(plan: AppOpsApprovalProofPlan): void {
  if (!UUID.test(plan.operationId) || !SHA256.test(plan.planHash)) {
    throw new Error("AppOps approval plan identity is invalid");
  }
  boundedIdentifier(plan.appId, "AppOps app ID");
  const expectedTool = {
    build_upload: "execute_approved_app_store_build_upload",
    version_setup: "execute_approved_app_store_version_setup",
    review_submission: "execute_approved_app_store_review_submission",
  }[plan.approvalScope];
  if (expectedTool === undefined || plan.executeTool !== expectedTool) {
    throw new Error("AppOps approval scope and execute tool do not match");
  }
  if (!Number.isFinite(Date.parse(plan.expiresAt))) {
    throw new Error("AppOps approval expiry is invalid");
  }
}

function validateBinding(binding: AppOpsApprovalProofBinding): void {
  boundedIdentifier(binding.agentId, "AppOps approval agent ID");
  boundedIdentifier(binding.sessionId, "AppOps approval session ID");
  boundedIdentifier(binding.turnId, "AppOps approval turn ID");
  validatePlan(binding.plan);
  if (
    binding.proof.length < 1 ||
    binding.proof.length > MAX_PROOF_LENGTH ||
    !/^[A-Za-z0-9._-]+$/u.test(binding.proof)
  ) {
    throw new Error("AppOps approval proof is invalid");
  }
}

function appOpsExecuteToolName(
  toolName: string,
): AppOpsApprovalProofPlan["executeTool"] | undefined {
  const match = /^mcp__(?:appops|app_ops|app-ops)__(.+)$/u.exec(toolName);
  const candidate = match?.[1];
  return candidate !== undefined &&
      Object.hasOwn(APPOPS_EXECUTE_TOOL_TO_SCOPE, candidate)
    ? candidate as AppOpsApprovalProofPlan["executeTool"]
    : undefined;
}

function proofBindingKey(
  agentId: string,
  sessionId: string,
  turnId: string,
  operationId: string,
): string {
  return `${agentId}\u0000${sessionId}\u0000${turnId}\u0000${operationId}`;
}

function proofInvocationKey(
  agentId: string,
  sessionId: string,
  turnId: string,
  operationId: string,
  toolUseId: string,
): string {
  return `${proofBindingKey(agentId, sessionId, turnId, operationId)}\u0000${toolUseId}`;
}

function deny(reason: string): AppOpsPreToolUseDecision {
  return { kind: "deny", reason };
}

function boundedIdentifier(value: string, name: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return trimmed;
}

function base64urlJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
