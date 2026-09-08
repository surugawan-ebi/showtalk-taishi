import { randomUUID } from "node:crypto";

import type { KnownBlock } from "@slack/types";

import type { WorkspaceGitAutonomyProfileCandidate } from "../approvals/workspace-git-autonomy-control.js";

export const WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX = "workspace_git_autonomy.";

export type WorkspaceGitAutonomyCardOperation = "enable" | "disable";

export interface WorkspaceGitAutonomyCardRoute {
  readonly token: string;
  readonly operation: WorkspaceGitAutonomyCardOperation;
  readonly koeId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
  readonly candidate: WorkspaceGitAutonomyProfileCandidate;
  readonly koeBindingRevision: number;
  readonly principalPolicyRevision: number;
  readonly requestedExpiresAt: string;
  readonly activationHandle?: string;
}

export class WorkspaceGitAutonomyCardStore {
  readonly #routes = new Map<string, WorkspaceGitAutonomyCardRoute>();

  createToken(): string {
    return randomUUID();
  }

  remember(route: WorkspaceGitAutonomyCardRoute): void {
    if (this.#routes.size >= 256) {
      const oldest = this.#routes.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#routes.delete(oldest);
    }
    this.#routes.set(route.token, Object.freeze({ ...route }));
  }

  get(token: string): WorkspaceGitAutonomyCardRoute | undefined {
    return this.#routes.get(token);
  }

  forget(token: string): void {
    this.#routes.delete(token);
  }
}

export function buildWorkspaceGitAutonomyBlocks(
  route: WorkspaceGitAutonomyCardRoute,
): KnownBlock[] {
  const profile = route.candidate.label?.trim() || route.candidate.profileId;
  const actionLabel = route.operation === "enable"
    ? "自動運転を有効化"
    : "自動運転を無効化";
  const description = route.operation === "enable"
    ? [
        `*${escapeMrkdwn(route.koeId)}* のGit自動運転を有効化します。`,
        `Profile: \`${escapeMrkdwn(profile)}\` revision ${route.candidate.profileRevision}`,
        `期限上限: ${route.candidate.requestedTtlMinutes}分`,
        "対象はdevelopmentのcommit / push / Draft PRのみです。main、Ready、merge、release、deploy、productionは引き続き手動承認です。",
        "現在すでに承認待ちのGit計画には適用せず、次のfresh planから有効になります。",
      ].join("\n")
    : [
        `*${escapeMrkdwn(route.koeId)}* のGit自動運転を通常OFFにします。`,
        "OFF後の新しいGit計画は従来の手動承認へ戻ります。実行中の操作や緊急security revokeを上書きしません。",
      ].join("\n");
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "Workspace Git 自動運転", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: description },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: `${WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX}${route.operation}`,
          text: { type: "plain_text", text: actionLabel, emoji: true },
          style: route.operation === "enable" ? "primary" : "danger",
          value: route.token,
        },
        {
          type: "button",
          action_id: `${WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX}hold`,
          text: { type: "plain_text", text: "保留", emoji: true },
          value: route.token,
        },
      ],
    },
  ];
}

export function parseWorkspaceGitAutonomyAction(
  actionId: string,
): WorkspaceGitAutonomyCardOperation | "hold" | undefined {
  if (!actionId.startsWith(WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX)) return undefined;
  const action = actionId.slice(WORKSPACE_GIT_AUTONOMY_ACTION_PREFIX.length);
  return action === "enable" || action === "disable" || action === "hold"
    ? action
    : undefined;
}

export function parseWorkspaceGitAutonomyToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new Error("Workspace Git autonomy action token is invalid");
  }
  return value;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
