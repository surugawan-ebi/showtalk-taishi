import type { JsonValue } from "../../core/index.js";

export interface CodexMcpConnection {
  readonly url: string;
  readonly bearerTokenEnvVar: string;
}

/**
 * Builds a thread-local MCP override without embedding the bearer token in the
 * Codex rollout or Taishi state. The token value exists only in the isolated
 * Agent App Server process environment.
 */
export function buildCodexMcpThreadConfig(
  connection: CodexMcpConnection,
): Readonly<Record<string, JsonValue>> {
  const url = new URL(connection.url);
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) {
    throw new Error("ShowTalk Taishi MCP must use a loopback HTTP URL");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(connection.bearerTokenEnvVar)) {
    throw new Error("Invalid MCP bearer token environment variable name");
  }
  return {
    mcp_servers: {
      showtalk_taishi: {
        url: url.toString(),
        bearer_token_env_var: connection.bearerTokenEnvVar,
        enabled: true,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 3_600,
        default_tools_approval_mode: "auto",
      },
    },
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
