import assert from "node:assert/strict";
import { verify } from "node:crypto";
import test from "node:test";

import {
  APPOPS_APPROVAL_PROOF_AUDIENCE,
  APPOPS_APPROVAL_PROOF_ISSUER,
  APPOPS_APPROVAL_PROOF_TYPE,
  AppOpsApprovalProofBroker,
  createEphemeralAppOpsApprovalProofSigner,
} from "../../src/approvals/appops-approval-proof.js";

function brokerBinding() {
  return {
    agentId: "implementer",
    sessionId: "thr_1",
    turnId: "turn_1",
    plan: {
      operationId: "11111111-1111-4111-8111-111111111111",
      planHash: "a".repeat(64),
      appId: "app07",
      approvalScope: "build_upload" as const,
      executeTool: "execute_approved_app_store_build_upload" as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    proof: "opaque-one-shot-proof",
  };
}

test("issues a short-lived Ed25519 AppOps proof bound to the exact plan", () => {
  const signer = createEphemeralAppOpsApprovalProofSigner();
  const now = new Date("2026-09-05T01:00:00.000Z");
  const proof = signer.issue({
    operationId: "11111111-1111-4111-8111-111111111111",
    planHash: "a".repeat(64),
    appId: "app07",
    approvalScope: "build_upload",
    executeTool: "execute_approved_app_store_build_upload",
    expiresAt: "2026-09-05T01:30:00.000Z",
  }, now);
  const [headerPart, payloadPart, signaturePart] = proof.split(".");
  assert.ok(headerPart && payloadPart && signaturePart);
  assert.equal(
    verify(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      signer.publicKeyPem,
      Buffer.from(signaturePart, "base64url"),
    ),
    true,
  );
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString());
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
  assert.deepEqual(header, {
    alg: "EdDSA",
    kid: signer.keyId,
    typ: APPOPS_APPROVAL_PROOF_TYPE,
    v: 1,
  });
  assert.equal(payload.iss, APPOPS_APPROVAL_PROOF_ISSUER);
  assert.equal(payload.aud, APPOPS_APPROVAL_PROOF_AUDIENCE);
  assert.equal(payload.operation_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.plan_hash, "a".repeat(64));
  assert.equal(payload.expires_at, "2026-09-05T01:02:00.000Z");
  assert.match(payload.nonce, /^[0-9a-f-]{36}$/u);
});

test("rejects mismatched scope/tool and an expired AppOps plan", () => {
  const signer = createEphemeralAppOpsApprovalProofSigner();
  assert.throws(() => signer.issue({
    operationId: "11111111-1111-4111-8111-111111111111",
    planHash: "a".repeat(64),
    appId: "app07",
    approvalScope: "build_upload",
    executeTool: "execute_approved_app_store_review_submission",
    expiresAt: "2026-09-05T01:30:00.000Z",
  }, new Date("2026-09-05T01:00:00.000Z")), /scope and execute tool/u);
  assert.throws(() => signer.issue({
    operationId: "11111111-1111-4111-8111-111111111111",
    planHash: "a".repeat(64),
    appId: "app07",
    approvalScope: "build_upload",
    executeTool: "execute_approved_app_store_build_upload",
    expiresAt: "2026-09-05T00:59:59.000Z",
  }, new Date("2026-09-05T01:00:00.000Z")), /expired/u);
});

test("makes duplicate hooks for one tool call idempotent and denies a replay", () => {
  const broker = new AppOpsApprovalProofBroker();
  const binding = brokerBinding();
  broker.register(binding);
  const input = {
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    toolName: "mcp__appops__execute_approved_app_store_build_upload",
    toolUseId: "tool-use-1",
    toolInput: {
      app_id: binding.plan.appId,
      operation_id: binding.plan.operationId,
    },
  };

  const first = broker.consume(binding.agentId, input);
  assert.equal(first.kind, "allow");
  if (first.kind === "allow") {
    assert.equal(first.updatedInput.approval_proof, binding.proof);
  }
  const duplicateHook = broker.consume(binding.agentId, input);
  assert.equal(duplicateHook.kind, "allow");
  const replay = broker.consume(binding.agentId, {
    ...input,
    toolUseId: "tool-use-2",
  });
  assert.equal(replay.kind, "deny");
  assert.throws(() => broker.register(binding), /already registered/u);
});

test("denies a duplicate hook ID when any execute argument changes", () => {
  const broker = new AppOpsApprovalProofBroker();
  const binding = brokerBinding();
  broker.register(binding);
  const input = {
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    toolName: "mcp__appops__execute_approved_app_store_build_upload",
    toolUseId: "tool-use-1",
    toolInput: {
      app_id: binding.plan.appId,
      operation_id: binding.plan.operationId,
    },
  };
  assert.equal(broker.consume(binding.agentId, input).kind, "allow");
  assert.equal(broker.consume(binding.agentId, {
    ...input,
    toolInput: {
      ...input.toolInput,
      unexpected: true,
    },
  }).kind, "deny");
});

test("keeps AppOps proofs bound to the exact Koe, turn, tool, and arguments", () => {
  const variants: Array<{
    agentId?: string;
    turnId?: string;
    toolName?: string;
    toolInput?: Readonly<Record<string, unknown>>;
  }> = [
    { agentId: "reviewer" },
    { turnId: "turn_2" },
    { toolName: "mcp__appops__execute_approved_app_store_review_submission" },
    { toolInput: { app_id: "app08", operation_id: brokerBinding().plan.operationId } },
    { toolInput: { app_id: "app07", operation_id: "22222222-2222-4222-8222-222222222222" } },
    {
      toolInput: {
        app_id: "app07",
        operation_id: brokerBinding().plan.operationId,
        approval_proof: "caller-supplied-proof",
      },
    },
  ];
  for (const variant of variants) {
    const broker = new AppOpsApprovalProofBroker();
    const binding = brokerBinding();
    broker.register(binding);
    const decision = broker.consume(variant.agentId ?? binding.agentId, {
      sessionId: binding.sessionId,
      turnId: variant.turnId ?? binding.turnId,
      toolName:
        variant.toolName ??
        "mcp__appops__execute_approved_app_store_build_upload",
      toolUseId: "tool-use-1",
      toolInput: variant.toolInput ?? {
        app_id: binding.plan.appId,
        operation_id: binding.plan.operationId,
      },
    });
    assert.equal(decision.kind, "deny");
  }
});

test("clears an unused AppOps proof when its session ends", () => {
  const broker = new AppOpsApprovalProofBroker();
  const binding = brokerBinding();
  broker.register(binding);
  broker.clearSession(binding.agentId, binding.sessionId);
  const decision = broker.consume(binding.agentId, {
    sessionId: binding.sessionId,
    turnId: binding.turnId,
    toolName: "mcp__appops__execute_approved_app_store_build_upload",
    toolUseId: "tool-use-1",
    toolInput: {
      app_id: binding.plan.appId,
      operation_id: binding.plan.operationId,
    },
  });
  assert.equal(decision.kind, "deny");
});
