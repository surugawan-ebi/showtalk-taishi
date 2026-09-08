import { createHash, verify } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from
  "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const publicKey = process.env.APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY;
if (publicKey === undefined) {
  throw new Error("Synthetic AppOps smoke environment is incomplete");
}
const approvalPublicKey = publicKey;

const operationId = "55555555-5555-4555-8555-555555555555";
const appId = "app07-smoke";
const executeTool = "execute_approved_app_store_version_setup";
const artifactSha256 = "b".repeat(64);
const plan = {
  operation: "version_setup",
  app_id: appId,
  apple_id: "1234567890",
  bundle_id: "com.example.appops-smoke",
  artifact: {
    source: { kind: "local", relative_path: "synthetic/release.ipa" },
    file_name: "release.ipa",
    size_bytes: 1234,
    sha256: artifactSha256,
    bundle_id: "com.example.appops-smoke",
    version: "1.2.3",
    build_number: "45",
  },
  localized_metadata_write: true,
  screenshots_write: false,
  release_type: "unchanged",
  primary_locale: "ja-JP",
  metadata: {
    description: "Synthetic description",
    keywords: "synthetic,smoke",
    support_url: "https://example.invalid/support",
    whats_new: "Synthetic release notes",
  },
};
const planHash = createHash("sha256")
  .update(JSON.stringify(plan))
  .digest("hex");
let executeCount = 0;

const server = new McpServer({ name: "fake-appops", version: "1.0.0" });
server.registerTool(
  "prepare_app_store_version_setup",
  {
    description:
      "Prepare the synthetic, local-only AppOps version_setup smoke operation. This never contacts a Store.",
    inputSchema: z.object({ app_id: z.literal(appId) }).strict(),
  },
  async () => {
    const expiresAt = new Date(Date.now() + 120_000).toISOString();
    const approvalPrompt = [
      `Target: AppOps app_id=${appId} bundle_id=${plan.bundle_id}`,
      `Scope: ${executeTool} operation_id=${operationId} plan_hash=${planHash} version=1.2.3 build=45 artifact_sha256=${artifactSha256}`,
      "Impact: App Store version_setup external write; primary_locale=ja-JP metadata=description,keywords,support_url,whats_new; screenshots/review unchanged; one execution only",
    ].join("\n");
    const output = {
      status: "awaiting_human_approval",
      external_write: false,
      approval_scope: "version_setup",
      approval_expires_at: expiresAt,
      operation_id: operationId,
      plan_hash: planHash,
      plan,
      approval_prompt: approvalPrompt,
      execute_tool: executeTool,
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

server.registerTool(
  executeTool,
  {
    description:
      "Execute the synthetic local-only AppOps version_setup smoke operation. approval_proof is required and must be supplied by the Codex PreToolUse hook.",
    inputSchema: z.object({
      app_id: z.literal(appId),
      operation_id: z.literal(operationId),
      approval_proof: z.string().min(1).optional(),
    }).strict(),
  },
  async ({ approval_proof: approvalProof }) => {
    const valid = typeof approvalProof === "string" && validateProof(approvalProof);
    if (valid) executeCount += 1;
    const output = valid
      ? {
          status: "completed",
          synthetic: true,
          valid_proof: true,
          execute_count: executeCount,
        }
      : {
          status: "blocked",
          synthetic: true,
          valid_proof: false,
          execute_count: executeCount,
        };
    return {
      ...(valid ? {} : { isError: true }),
      content: [{ type: "text" as const, text: JSON.stringify(output) }],
      structuredContent: output,
    };
  },
);

await server.connect(new StdioServerTransport());

function validateProof(proof: string): boolean {
  const [header, payload, signature] = proof.split(".");
  if (header === undefined || payload === undefined || signature === undefined) {
    return false;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    return claims.operation_id === operationId &&
      claims.plan_hash === planHash &&
      claims.app_id === appId &&
      claims.approval_scope === "version_setup" &&
      claims.execute_tool === executeTool &&
      Date.parse(String(claims.expires_at)) > Date.now() &&
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        approvalPublicKey,
        Buffer.from(signature, "base64url"),
      );
  } catch {
    return false;
  }
}
