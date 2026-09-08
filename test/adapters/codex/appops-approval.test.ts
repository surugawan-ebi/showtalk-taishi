import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { normalizeAppOpsPrepareCompletion } from "../../../src/adapters/codex/appops-approval.js";

test("captures a hash-checked AppOps prepare result and canonical approval prompt", () => {
  const fixture = appOpsPrepareFixture();
  const capture = normalizeAppOpsPrepareCompletion(fixture.completed, fixture.started.item);
  assert.equal(capture?.plan.appId, "app07");
  assert.equal(capture?.plan.approvalScope, "build_upload");
  assert.equal(capture?.plan.planHash, fixture.planHash);
  assert.match(capture?.approvalPrompt ?? "", /bundle_id=com\.example\.app07/u);
  assert.match(capture?.approvalPrompt ?? "", /version=1\.2\.3 build=45/u);
  assert.match(capture?.approvalPrompt ?? "", /artifact_sha256=/u);
});

test("captures a version_setup plan with its exact locale and metadata scope", () => {
  const fixture = appOpsPrepareFixture("version_setup");
  const capture = normalizeAppOpsPrepareCompletion(
    fixture.completed,
    fixture.started.item,
  );
  assert.equal(capture?.plan.approvalScope, "version_setup");
  assert.equal(
    capture?.plan.executeTool,
    "execute_approved_app_store_version_setup",
  );
  assert.match(capture?.approvalPrompt ?? "", /primary_locale=ja-JP/u);
  assert.match(
    capture?.approvalPrompt ?? "",
    /metadata=description,keywords,support_url,whats_new/u,
  );
});

test("rejects AppOps prepare output whose plan or prompt was altered", () => {
  const fixture = appOpsPrepareFixture();
  const item = (fixture.completed as any).item;
  item.result.structuredContent.plan.artifact.build_number = "46";
  assert.throws(
    () => normalizeAppOpsPrepareCompletion(fixture.completed, fixture.started.item),
    /invalid pending approval plan/u,
  );
});

test("rejects an AppOps prepare result that is already expired", () => {
  const fixture = appOpsPrepareFixture();
  const result = (fixture.completed as any).item.result.structuredContent;
  result.approval_expires_at = new Date(Date.now() - 1_000).toISOString();
  assert.throws(
    () => normalizeAppOpsPrepareCompletion(fixture.completed, fixture.started.item),
    /invalid pending approval plan/u,
  );
});

function appOpsPrepareFixture(
  scope: "build_upload" | "version_setup" = "build_upload",
) {
  const versionSetup = scope === "version_setup";
  const plan = {
    operation: scope,
    app_id: "app07",
    apple_id: "1234567890",
    bundle_id: "com.example.app07",
    artifact: {
      source: { kind: "local", relative_path: "app07/release.ipa" },
      file_name: "release.ipa",
      size_bytes: 1234,
      sha256: "b".repeat(64),
      bundle_id: "com.example.app07",
      version: "1.2.3",
      build_number: "45",
    },
    localized_metadata_write: versionSetup,
    screenshots_write: false,
    release_type: "unchanged",
    ...(versionSetup
      ? {
          primary_locale: "ja-JP",
          metadata: {
            description: "Synthetic description",
            keywords: "synthetic,smoke",
            support_url: "https://example.invalid/support",
            whats_new: "Synthetic release notes",
          },
        }
      : {}),
  };
  const planHash = createHash("sha256").update(JSON.stringify(plan)).digest("hex");
  const operationId = "11111111-1111-4111-8111-111111111111";
  const executeTool = versionSetup
    ? "execute_approved_app_store_version_setup"
    : "execute_approved_app_store_build_upload";
  const approvalPrompt = [
    "Target: AppOps app_id=app07 bundle_id=com.example.app07",
    `Scope: ${executeTool} operation_id=${operationId} plan_hash=${planHash} version=1.2.3 build=45 artifact_sha256=${"b".repeat(64)}`,
    versionSetup
      ? "Impact: App Store version_setup external write; primary_locale=ja-JP metadata=description,keywords,support_url,whats_new; screenshots/review unchanged; one execution only"
      : "Impact: App Store build_upload external write; metadata/screenshots unchanged; one execution only",
  ].join("\n");
  const started = {
    threadId: "thr_1",
    turnId: "turn_1",
    item: {
      id: "appops-prepare-1",
      type: "mcpToolCall",
      server: "appops",
      tool: versionSetup
        ? "prepare_app_store_version_setup"
        : "prepare_app_store_build_upload",
      status: "inProgress",
      arguments: { app_id: "app07", artifact_path: "app07/release.ipa" },
    },
  };
  return {
    planHash,
    started,
    completed: {
      ...started,
      item: {
        ...started.item,
        status: "completed",
        result: {
          structuredContent: {
            status: "awaiting_human_approval",
            external_write: false,
            approval_scope: scope,
            approval_expires_at: new Date(Date.now() + 60_000).toISOString(),
            operation_id: operationId,
            plan_hash: planHash,
            plan,
            approval_prompt: approvalPrompt,
            execute_tool: executeTool,
          },
        },
      },
    },
  };
}
