import assert from "node:assert/strict";
import test from "node:test";

import {
  APPOPS_APPROVAL_HOOK_TOOL,
  buildAppOpsApprovalHookConfig,
  buildCodexMcpThreadConfig,
  SHOWTALK_CODE_MODE_ENABLED,
  WORKSPACE_GIT_DIRECT_ONLY_NAMESPACE,
} from "../../../src/adapters/codex/mcp-config.js";

test("builds a required loopback MCP config that references, but never stores, the token", () => {
  const config = buildCodexMcpThreadConfig({
    url: "http://127.0.0.1:3210/mcp",
    bearerTokenEnvVar: "SHOWTALK_TAISHI_MCP_TOKEN",
  });
  assert.deepEqual(config, {
    features: {
      code_mode: {
        enabled: false,
        direct_only_tool_namespaces: ["mcp__workspace_git"],
      },
    },
    mcp_servers: {
      showtalk_taishi: {
        url: "http://127.0.0.1:3210/mcp",
        bearer_token_env_var: "SHOWTALK_TAISHI_MCP_TOKEN",
        enabled: true,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 3600,
        default_tools_approval_mode: "auto",
        disabled_tools: ["internal.appops-pre-tool-use"],
      },
    },
  });
  assert.deepEqual(buildAppOpsApprovalHookConfig(), {
    hooks: {
      PreToolUse: [{
        matcher:
          "^mcp__(?:appops|app_ops|app-ops)__(?:execute_approved_app_store_build_upload|execute_approved_app_store_version_setup|execute_approved_app_store_review_submission)$",
        hooks: [{
          type: "command",
          command: "node \"$SHOWTALK_TAISHI_APPOPS_HOOK_PATH\"",
          timeout: 10,
        }],
      }],
    },
  });
  assert.equal(WORKSPACE_GIT_DIRECT_ONLY_NAMESPACE, "mcp__workspace_git");
  assert.equal(SHOWTALK_CODE_MODE_ENABLED, false);
  assert.equal(APPOPS_APPROVAL_HOOK_TOOL, "internal.appops-pre-tool-use");
  assert.doesNotMatch(JSON.stringify(config), /secret-token/);
});

test("rejects non-loopback endpoints and unsafe environment names", () => {
  assert.throws(() =>
    buildCodexMcpThreadConfig({
      url: "https://example.com/mcp",
      bearerTokenEnvVar: "TOKEN",
    }),
  );
  assert.throws(() =>
    buildCodexMcpThreadConfig({
      url: "http://127.0.0.1:1234/mcp",
      bearerTokenEnvVar: "BAD-NAME",
    }),
  );
});

test("passes only AppOps public verifier material to the AppOps MCP", () => {
  const config = buildCodexMcpThreadConfig(
    { url: "http://127.0.0.1:4123/mcp", bearerTokenEnvVar: "TOKEN" },
    { publicKeyPem: "public-key-pem", keyId: "key-id" },
  );
  assert.deepEqual((config.mcp_servers as Record<string, unknown>).appops, {
    env: {
      APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY: "public-key-pem",
      APP_OPS_SHOWTALK_APPROVAL_KEY_ID: "key-id",
    },
  });
  assert.equal(JSON.stringify(config).includes("private-key"), false);
});
