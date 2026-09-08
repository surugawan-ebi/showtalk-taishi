import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from
  "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from
  "@modelcontextprotocol/sdk/shared/transport.js";

import {
  APPOPS_APPROVAL_HOOK_MCP_URL_ENV,
  APPOPS_APPROVAL_HOOK_TOOL,
} from "../adapters/codex/mcp-config.js";

const MAX_STDIN_BYTES = 65_536;

await main().catch(() => {
  writeDecision(deny("AppOps approval proof binding failed closed"));
});

async function main(): Promise<void> {
  const url = requiredEnvironment(APPOPS_APPROVAL_HOOK_MCP_URL_ENV);
  const token = requiredEnvironment("SHOWTALK_TAISHI_MCP_TOKEN");
  const input = await readBoundedJsonInput();
  const client = new Client({
    name: "showtalk-appops-pre-tool-use-hook",
    version: "0.0.1",
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  try {
    // SDK 1.30's optional transport fields conflict under
    // exactOptionalPropertyTypes even though the class implements Transport.
    await client.connect(transport as unknown as Transport);
    const result = await client.callTool({
      name: APPOPS_APPROVAL_HOOK_TOOL,
      arguments: input,
    });
    const decision = asRecord(result.structuredContent);
    if (decision === undefined || !isHookDecision(decision)) {
      writeDecision(deny("AppOps approval proof broker returned no decision"));
      return;
    }
    writeDecision(decision);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function readBoundedJsonInput(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_STDIN_BYTES) throw new Error("Hook input is too large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  const record = asRecord(value);
  if (record === undefined) throw new Error("Hook input is invalid");
  return {
    session_id: record.session_id,
    turn_id: record.turn_id,
    tool_name: record.tool_name,
    tool_use_id: record.tool_use_id,
    tool_input: record.tool_input,
  };
}

function isHookDecision(value: Record<string, unknown>): boolean {
  const output = asRecord(value.hookSpecificOutput);
  return output?.hookEventName === "PreToolUse" &&
    (output.permissionDecision === "allow" ||
      output.permissionDecision === "deny");
}

function deny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function writeDecision(value: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(value));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
