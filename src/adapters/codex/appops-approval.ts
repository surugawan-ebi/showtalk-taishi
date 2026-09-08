import { createHash } from "node:crypto";

import type { AppOpsApprovalProofPlan } from "../../approvals/appops-approval-proof.js";

const APPOPS_SERVERS = new Set(["appops", "app_ops", "app-ops"]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;

const PREPARE_TO_SCOPE = {
  prepare_app_store_build_upload: "build_upload",
  prepare_app_store_version_setup: "version_setup",
  prepare_app_store_review_submission: "review_submission",
} as const;

const SCOPE_TO_EXECUTE = {
  build_upload: "execute_approved_app_store_build_upload",
  version_setup: "execute_approved_app_store_version_setup",
  review_submission: "execute_approved_app_store_review_submission",
} as const;

export interface AppOpsApprovalPlanCapture {
  readonly turnId: string;
  readonly plan: AppOpsApprovalProofPlan;
  readonly approvalPrompt: string;
}

/**
 * Captures only the public result of a Codex-owned AppOps prepare call.
 * ShowTalk never reads or mutates AppOps approval state.
 */
export function normalizeAppOpsPrepareCompletion(
  notification: unknown,
  startedItem?: Readonly<Record<string, unknown>>,
): AppOpsApprovalPlanCapture | undefined {
  const outer = asRecord(notification);
  const item = asRecord(outer?.item);
  if (
    item?.type !== "mcpToolCall" ||
    typeof item.server !== "string" ||
    !APPOPS_SERVERS.has(item.server) ||
    typeof item.tool !== "string" ||
    !Object.hasOwn(PREPARE_TO_SCOPE, item.tool)
  ) {
    return undefined;
  }
  if (item.status !== "completed") return undefined;
  if (
    startedItem !== undefined &&
    (startedItem.id !== item.id ||
      startedItem.server !== item.server ||
      startedItem.tool !== item.tool)
  ) {
    throw new Error("AppOps started and completed tool identities do not match");
  }
  const turnId = boundedString(outer?.turnId, 256, "turn ID");
  const output = asRecord(asRecord(item.result)?.structuredContent);
  if (output?.status !== "awaiting_human_approval") return undefined;
  if (output.external_write !== false) {
    throw new Error("AppOps prepare result crossed the external-write boundary");
  }
  const scope = PREPARE_TO_SCOPE[
    item.tool as keyof typeof PREPARE_TO_SCOPE
  ];
  const executeTool = SCOPE_TO_EXECUTE[scope];
  if (
    output.approval_scope !== scope ||
    output.execute_tool !== executeTool
  ) {
    throw new Error("AppOps approval scope and execute tool do not match");
  }
  const operationId = boundedString(output.operation_id, 64, "operation ID");
  const planHash = boundedString(output.plan_hash, 64, "plan hash");
  const expiresAt = boundedString(
    output.approval_expires_at,
    64,
    "approval expiry",
  );
  const argumentsRecord = requiredRecord(
    startedItem?.arguments ?? item.arguments,
    "AppOps prepare arguments",
  );
  const appId = boundedString(argumentsRecord.app_id, 128, "app ID");
  const publicPlan = requiredRecord(output.plan, "AppOps public plan");
  const approvalPrompt = boundedApprovalPrompt(
    output.approval_prompt,
  );
  const expiresAtMs = Date.parse(expiresAt);
  if (
    !UUID.test(operationId) ||
    !SHA256.test(planHash) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    publicPlan.app_id !== appId ||
    publicPlan.operation !== scope ||
    createHash("sha256")
      .update(JSON.stringify(publicPlan))
      .digest("hex") !== planHash ||
    approvalPrompt !== renderAppOpsApprovalPrompt(
      {
        operationId,
        planHash,
        appId,
        approvalScope: scope,
        executeTool,
        expiresAt,
      },
      publicPlan,
    )
  ) {
    throw new Error("AppOps returned an invalid pending approval plan");
  }
  return {
    turnId,
    plan: {
      operationId,
      planHash,
      appId,
      approvalScope: scope,
      executeTool,
      expiresAt,
    },
    approvalPrompt,
  };
}

export function renderAppOpsApprovalPrompt(
  plan: AppOpsApprovalProofPlan,
  publicPlan: Record<string, unknown>,
): string {
  const artifact = requiredRecord(publicPlan.artifact, "AppOps public artifact");
  const bundleId = boundedString(publicPlan.bundle_id, 256, "bundle ID");
  const version = boundedString(artifact.version, 128, "version");
  const buildNumber = boundedString(artifact.build_number, 128, "build number");
  const artifactSha256 = boundedString(
    artifact.sha256,
    64,
    "artifact SHA-256",
  );
  if (!SHA256.test(artifactSha256)) {
    throw new Error("AppOps artifact SHA-256 is invalid");
  }
  const impact = plan.approvalScope === "review_submission"
    ? "App Store review_submission external write; releaseType MANUAL; one execution only"
    : plan.approvalScope === "version_setup"
      ? `App Store version_setup external write; primary_locale=${boundedString(publicPlan.primary_locale, 20, "primary locale")} metadata=${validatedMetadataKeys(publicPlan.metadata).join(",")}; screenshots/review unchanged; one execution only`
      : "App Store build_upload external write; metadata/screenshots unchanged; one execution only";
  return [
    `Target: AppOps app_id=${plan.appId} bundle_id=${bundleId}`,
    `Scope: ${plan.executeTool} operation_id=${plan.operationId} plan_hash=${plan.planHash} version=${version} build=${buildNumber} artifact_sha256=${artifactSha256}`,
    `Impact: ${impact}`,
  ].join("\n");
}

function validatedMetadataKeys(value: unknown): string[] {
  const metadata = requiredRecord(value, "AppOps version metadata");
  const keys = Object.keys(metadata).sort();
  const allowed = new Set([
    "description",
    "keywords",
    "marketing_url",
    "promotional_text",
    "support_url",
    "whats_new",
  ]);
  if (
    !["description", "keywords", "support_url", "whats_new"].every((key) =>
      Object.hasOwn(metadata, key)
    ) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new Error("AppOps version metadata fields are invalid");
  }
  return keys;
}

function requiredRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new Error(`${name} is invalid`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, max: number, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function boundedApprovalPrompt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_000 ||
    /[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("AppOps approval prompt is invalid");
  }
  return value;
}
