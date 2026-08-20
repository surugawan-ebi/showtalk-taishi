import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexMcpThreadConfig } from "../../../src/adapters/codex/mcp-config.js";

test("builds a required loopback MCP config that references, but never stores, the token", () => {
  const config = buildCodexMcpThreadConfig({
    url: "http://127.0.0.1:3210/mcp",
    bearerTokenEnvVar: "SHOWTALK_TAISHI_MCP_TOKEN",
  });
  assert.deepEqual(config, {
    mcp_servers: {
      showtalk_taishi: {
        url: "http://127.0.0.1:3210/mcp",
        bearer_token_env_var: "SHOWTALK_TAISHI_MCP_TOKEN",
        enabled: true,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 3600,
        default_tools_approval_mode: "auto",
      },
    },
  });
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
