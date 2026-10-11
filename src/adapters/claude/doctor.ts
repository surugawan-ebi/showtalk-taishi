import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ClaudeAdapterConfig, TaishiConfig } from "../../config/schema.js";

const execFileAsync = promisify(execFile);

/**
 * Offline readiness checks for a Claude Code adapter. Verifies that the Agent
 * SDK loads, that an explicit `claude` executable runs, and that any operator
 * configured Claude session exists on this host.
 */
export async function doctorClaudeAdapter(
  config: TaishiConfig,
  name: string,
  adapter: ClaudeAdapterConfig,
  dependencies: {
    readonly loadSdk?: () => Promise<{
      getSessionInfo(
        sessionId: string,
        options?: { dir?: string },
      ): Promise<unknown>;
    }>;
    readonly runVersion?: (command: string) => Promise<string>;
  } = {},
): Promise<string[]> {
  const checks: string[] = [];
  const loadSdk = dependencies.loadSdk ??
    (() => import("@anthropic-ai/claude-agent-sdk"));
  let sdk: Awaited<ReturnType<typeof loadSdk>>;
  try {
    sdk = await loadSdk();
  } catch (error) {
    throw new Error(
      `Claude Agent SDK is unavailable for adapter ${name}; run npm ci`,
      { cause: error },
    );
  }
  checks.push(`adapter:${name}:claude-agent-sdk`);
  if (adapter.command !== undefined) {
    const runVersion = dependencies.runVersion ?? (async (command: string) =>
      (await execFileAsync(command, ["--version"], { timeout: 10_000 })).stdout);
    try {
      await runVersion(adapter.command);
    } catch (error) {
      throw new Error(`Claude Code executable is unavailable for adapter ${name}`, {
        cause: error,
      });
    }
    checks.push(`adapter:${name}:claude-executable`);
  }
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (agent.adapter !== name || agent.adapter_session_id === undefined) continue;
    const info =
      (await sdk.getSessionInfo(agent.adapter_session_id, {
        dir: agent.workspace.path,
      })) ?? (await sdk.getSessionInfo(agent.adapter_session_id));
    if (info === undefined) {
      throw new Error(
        `Configured session validation failed for adapter ${name}: Koe ${agentId} Claude session was not found`,
      );
    }
    checks.push(`agent:${agentId}:configured-session`);
  }
  return checks;
}
