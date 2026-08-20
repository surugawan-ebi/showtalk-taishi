import type { KnownBlock } from "@slack/types";

import type {
  AgentUserInputResponse,
  WorkspaceGitApprovalPlan,
} from "../core/index.js";

export const USER_INPUT_ACTION_PREFIX = "taishi.git_plan.";

export interface UserInputActionValue {
  readonly version: 1;
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
}

export function buildWorkspaceGitApprovalBlocks(
  prompt: string,
  plan: WorkspaceGitApprovalPlan,
  value: UserInputActionValue,
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Git操作の承認待ち*\n${escapeSlack(prompt)}`,
      },
    },
    {
      type: "section",
      fields: planFields(plan),
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Operation ID*\n\`${plan.operationId}\`\n` +
          `*Plan hash*\n\`${plan.planHash}\`\n` +
          `*期限*\n${escapeSlack(plan.expiresAt)}`,
      },
    },
  ];
  const pathChunks = exactPathChunks(plan.paths);
  blocks.push(...pathChunks.map((text): KnownBlock => ({
    type: "section",
    text: { type: "plain_text", text, emoji: false },
  })));
  for (const [label, value] of exactPlanTexts(plan)) {
    blocks.push(...exactTextChunks(label, value).map((text): KnownBlock => ({
      type: "section",
      text: { type: "plain_text", text, emoji: false },
    })));
  }
  if (blocks.length > 48) {
    throw new Error("The exact Git plan is too large for Slack Block Kit");
  }
  const encoded = JSON.stringify(value);
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "承認して実行", emoji: true },
        style: "primary",
        action_id: `${USER_INPUT_ACTION_PREFIX}approve`,
        value: encoded,
        confirm: {
          title: { type: "plain_text", text: "このGit操作を承認しますか？" },
          text: {
            type: "mrkdwn",
            text:
              "表示されたexact planを承認し、同じCodex turnで実行前の再検証へ進みます。",
          },
          confirm: { type: "plain_text", text: "承認して実行" },
          deny: { type: "plain_text", text: "戻る" },
        },
      },
      {
        type: "button",
        text: { type: "plain_text", text: "拒否・保留", emoji: true },
        action_id: `${USER_INPUT_ACTION_PREFIX}reject`,
        value: encoded,
      },
    ],
  });
  return blocks;
}

export function parseUserInputDecision(
  actionId: string,
): AgentUserInputResponse["optionId"] | undefined {
  if (!actionId.startsWith(USER_INPUT_ACTION_PREFIX)) return undefined;
  const decision = actionId.slice(USER_INPUT_ACTION_PREFIX.length);
  return decision === "approve" || decision === "reject"
    ? decision
    : undefined;
}

export function parseUserInputActionValue(value: string): UserInputActionValue {
  if (value.length < 1 || value.length > 1_000) {
    throw new Error("Invalid Git approval action payload");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid Git approval action payload");
  }
  const record = asRecord(parsed);
  if (
    record === undefined ||
    record.version !== 1 ||
    typeof record.requestId !== "string" ||
    !/^codex-input:[0-9a-f-]{36}$/iu.test(record.requestId) ||
    typeof record.channelId !== "string" ||
    !/^C[A-Z0-9]{1,127}$/u.test(record.channelId) ||
    typeof record.rootThreadTs !== "string" ||
    !/^\d{1,20}\.\d{1,20}$/u.test(record.rootThreadTs) ||
    typeof record.messageTs !== "string" ||
    !/^\d{1,20}\.\d{1,20}$/u.test(record.messageTs) ||
    Object.keys(record).length !== 5 ||
    countLiteralKey(value, "version") !== 1 ||
    countLiteralKey(value, "requestId") !== 1 ||
    countLiteralKey(value, "channelId") !== 1 ||
    countLiteralKey(value, "rootThreadTs") !== 1 ||
    countLiteralKey(value, "messageTs") !== 1
  ) {
    throw new Error("Invalid Git approval action payload");
  }
  return {
    version: 1,
    requestId: record.requestId,
    channelId: record.channelId,
    rootThreadTs: record.rootThreadTs,
    messageTs: record.messageTs,
  };
}

function planFields(
  plan: WorkspaceGitApprovalPlan,
): Array<{ type: "mrkdwn"; text: string }> {
  const operation = operationLabel(plan.operation);
  const fields = [
    field("操作", operation),
    field("Repository", plan.repoId),
    field("Branch", plan.branch),
    field("Mode", plan.mode),
    field("HEAD", plan.expectedHead ?? "unborn"),
    field("Worktree", plan.worktreeId ?? "該当なし（PR操作）"),
    ...(plan.expectedSnapshotId === undefined
      ? []
      : [field("Snapshot", plan.expectedSnapshotId)]),
    ...(plan.pushTarget === undefined
      ? []
      : [field("Push target", plan.pushTarget)]),
    ...(plan.pullRequestBaseBranch === undefined
      ? []
      : [field("Draft PR base", plan.pullRequestBaseBranch)]),
    ...(plan.pullRequestNumber === undefined
      ? []
      : [field("Pull Request", `#${plan.pullRequestNumber}`)]),
    ...(plan.baseBranch === undefined
      ? []
      : [field("Base", plan.baseBranch)]),
    ...(plan.mergeMethod === undefined
      ? []
      : [field("Merge method", plan.mergeMethod)]),
  ];
  if (fields.length > 10) {
    throw new Error("The Git plan has too many summary fields for Slack Block Kit");
  }
  return fields;
}

function field(label: string, value: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text: `*${label}*\n${escapeSlack(value)}` };
}

function exactPathChunks(paths: readonly string[]): string[] {
  if (paths.length === 0) return ["*Paths*\nなし"];
  const lines = paths.map((path) => `• ${visibleJsonString(path)}`);
  const chunks: string[] = [];
  let current = "Paths";
  for (const line of lines) {
    if (line.length > 2_850) {
      throw new Error("A Git plan path is too large for Slack Block Kit");
    }
    if (current.length + line.length + 1 > 2_900) {
      chunks.push(current);
      current = "Paths（続き）";
    }
    current += `\n${line}`;
  }
  chunks.push(current);
  return chunks;
}

function exactPlanTexts(
  plan: WorkspaceGitApprovalPlan,
): ReadonlyArray<readonly [string, string]> {
  return [
    ...(plan.commitMessage === undefined
      ? []
      : [["Commit message", plan.commitMessage] as const]),
    ...(plan.pullRequestTitle === undefined
      ? []
      : [["Draft PR title", plan.pullRequestTitle] as const]),
    ...(plan.pullRequestBody === undefined
      ? []
      : [["Draft PR body", plan.pullRequestBody] as const]),
    ...(plan.pullRequestBaseBranch === undefined
      ? []
      : [["Draft PR base", plan.pullRequestBaseBranch] as const]),
  ];
}

function exactTextChunks(label: string, value: string): string[] {
  const encoded = visibleJsonString(value);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < encoded.length) {
    const heading = chunks.length === 0 ? label : `${label}（続き）`;
    const budget = 2_900 - heading.length - 1;
    let end = Math.min(offset + budget, encoded.length);
    if (
      end < encoded.length &&
      end > offset &&
      isHighSurrogate(encoded.charCodeAt(end - 1))
    ) {
      end -= 1;
    }
    const body = encoded.slice(offset, end);
    chunks.push(`${heading}\n${body}`);
    offset += body.length;
  }
  return chunks.length === 0 ? [`${label}\n""`] : chunks;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function visibleJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
}

function operationLabel(operation: WorkspaceGitApprovalPlan["operation"]): string {
  switch (operation) {
    case "git_publication":
      return "Git公開 / Draft PR";
    case "pull_request_ready":
      return "Pull RequestをReady化";
    case "pull_request_merge":
      return "Pull Requestをmerge";
  }
}

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function countLiteralKey(value: string, key: string): number {
  return [...value.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length;
}
