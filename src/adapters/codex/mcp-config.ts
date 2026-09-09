import type { JsonValue } from "../../core/index.js";
import { APPOPS_EXECUTE_PRE_TOOL_USE_MATCHER } from
  "../../approvals/appops-approval-proof.js";

export interface CodexMcpConnection {
  readonly url: string;
  readonly bearerTokenEnvVar: string;
}

export interface CodexAppOpsApprovalVerifierConfig {
  readonly publicKeyPem: string;
  readonly keyId: string;
}

/**
 * Keep workspace-git calls visible as first-class App Server MCP items. Git
 * prepare/execute results cross an approval boundary and must never be hidden
 * inside a model-controlled code-mode result.
 */
export const WORKSPACE_GIT_DIRECT_ONLY_NAMESPACE = "mcp__workspace_git";

/**
 * ShowTalk requires approval-bearing tools to stay visible as direct App
 * Server requests. Namespace filtering proved insufficient across every
 * persistent Koe, so code mode is disabled instead of relying on the model to
 * avoid nesting request_user_input inside functions.exec.
 */
export const SHOWTALK_CODE_MODE_ENABLED = false;
export const APPOPS_APPROVAL_HOOK_TOOL =
  "internal.appops-pre-tool-use" as const;
export const APPOPS_APPROVAL_HOOK_PATH_ENV =
  "SHOWTALK_TAISHI_APPOPS_HOOK_PATH" as const;
export const APPOPS_APPROVAL_HOOK_MCP_URL_ENV =
  "SHOWTALK_TAISHI_APPOPS_HOOK_MCP_URL" as const;

/**
 * Legacy fail-closed compatibility shape for installations that previously
 * configured the retired AppOps hook. The standard runtime does not install or
 * activate it; thread/start config must not inject an untrusted hook.
 */
export function buildAppOpsApprovalHookConfig(): Readonly<Record<string, JsonValue>> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: APPOPS_EXECUTE_PRE_TOOL_USE_MATCHER,
          hooks: [
            {
              type: "command",
              command: `node "$${APPOPS_APPROVAL_HOOK_PATH_ENV}"`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Builds a thread-local MCP override without embedding the bearer token in the
 * Codex rollout or Taishi state. The token value exists only in the isolated
 * Agent App Server process environment.
 */
export function buildCodexMcpThreadConfig(
  connection: CodexMcpConnection,
  appOpsApprovalVerifier?: CodexAppOpsApprovalVerifierConfig,
): Readonly<Record<string, JsonValue>> {
  const url = new URL(connection.url);
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) {
    throw new Error("ShowTalk Taishi MCP must use a loopback HTTP URL");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(connection.bearerTokenEnvVar)) {
    throw new Error("Invalid MCP bearer token environment variable name");
  }
  const appOpsMcpConfig = appOpsApprovalVerifier === undefined
    ? undefined
    : {
        env: {
          APP_OPS_SHOWTALK_APPROVAL_PUBLIC_KEY:
            appOpsApprovalVerifier.publicKeyPem,
          APP_OPS_SHOWTALK_APPROVAL_KEY_ID: appOpsApprovalVerifier.keyId,
        },
      };
  return {
    features: {
      code_mode: {
        enabled: SHOWTALK_CODE_MODE_ENABLED,
        direct_only_tool_namespaces: [
          WORKSPACE_GIT_DIRECT_ONLY_NAMESPACE,
        ],
      },
    },
    mcp_servers: {
      ...(appOpsMcpConfig === undefined ? {} : { appops: appOpsMcpConfig }),
      showtalk_taishi: {
        url: url.toString(),
        bearer_token_env_var: connection.bearerTokenEnvVar,
        enabled: true,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 3_600,
        default_tools_approval_mode: "auto",
        disabled_tools: [APPOPS_APPROVAL_HOOK_TOOL],
      },
    },
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
