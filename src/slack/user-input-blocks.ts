import type { KnownBlock } from "@slack/types";

import type {
  AgentGitApprovalInputResponse,
  WorkspaceGitApprovalPlan,
} from "../core/index.js";

export const USER_INPUT_ACTION_PREFIX = "taishi.git_plan.";
export const USER_INPUT_PATH_ACTION_PREFIX = `${USER_INPUT_ACTION_PREFIX}paths.`;
export const USER_INPUT_BODY_ACTION_PREFIX = `${USER_INPUT_ACTION_PREFIX}body.`;

const MAX_STORED_GIT_APPROVAL_DETAILS = 128;

export interface UserInputActionValue {
  readonly version: 1;
  readonly requestId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly messageTs: string;
}

export type UserInputPathVisibility = "show" | "hide";
export type UserInputBodyVisibility = "show" | "hide";

export interface WorkspaceGitApprovalBlockOptions {
  readonly pathsExpanded?: boolean;
  readonly allowPathToggle?: boolean;
  readonly bodyExpanded?: boolean;
  readonly allowBodyToggle?: boolean;
  readonly expiresAt?: string;
}

export interface WorkspaceGitApprovalDisplayState {
  readonly pathsExpanded: boolean;
  readonly bodyExpanded: boolean;
}

export interface WorkspaceGitApprovalDetails {
  readonly prompt: string;
  readonly plan: WorkspaceGitApprovalPlan;
  readonly routing: UserInputActionValue;
  readonly expiresAt: number;
  readonly fallbackText: string;
  readonly sourceUserMention?: string;
  readonly display: WorkspaceGitApprovalDisplayState;
}

/** Process-local display state for one exact, message-bound Git approval card. */
export class WorkspaceGitApprovalDetailsStore {
  readonly #entries = new Map<string, WorkspaceGitApprovalDetails>();
  readonly #actionTails = new Map<string, Promise<void>>();

  remember(details: WorkspaceGitApprovalDetails): void {
    const key = approvalDetailsKey(details.routing);
    this.#entries.delete(key);
    this.#entries.set(key, Object.freeze({
      ...details,
      plan: details.plan,
      routing: Object.freeze({ ...details.routing }),
      display: Object.freeze({ ...details.display }),
    }));
    while (this.#entries.size > MAX_STORED_GIT_APPROVAL_DETAILS) {
      const oldest = this.#entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.#entries.delete(oldest);
    }
  }

  get(routing: UserInputActionValue): WorkspaceGitApprovalDetails | undefined {
    return this.#entries.get(approvalDetailsKey(routing));
  }

  getForRequest(
    requestId: string,
    channelId: string,
    rootThreadTs: string,
  ): WorkspaceGitApprovalDetails | undefined {
    let match: WorkspaceGitApprovalDetails | undefined;
    for (const details of this.#entries.values()) {
      if (
        details.routing.requestId !== requestId ||
        details.routing.channelId !== channelId ||
        details.routing.rootThreadTs !== rootThreadTs
      ) {
        continue;
      }
      if (match !== undefined) return undefined;
      match = details;
    }
    return match;
  }

  updateDisplay(
    routing: UserInputActionValue,
    display: WorkspaceGitApprovalDisplayState,
  ): void {
    const key = approvalDetailsKey(routing);
    const current = this.#entries.get(key);
    if (current === undefined) return;
    this.#entries.set(key, Object.freeze({
      ...current,
      display: Object.freeze({ ...display }),
    }));
  }

  forget(routing: UserInputActionValue): void {
    this.#entries.delete(approvalDetailsKey(routing));
  }

  async serialize<T>(
    routing: UserInputActionValue,
    action: () => Promise<T>,
  ): Promise<T> {
    const key = approvalDetailsKey(routing);
    const previous = this.#actionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.#actionTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#actionTails.get(key) === tail) this.#actionTails.delete(key);
    }
  }
}

export function buildWorkspaceGitApprovalBlocks(
  prompt: string,
  plan: WorkspaceGitApprovalPlan,
  value: UserInputActionValue,
  options: WorkspaceGitApprovalBlockOptions = {},
): KnownBlock[] {
  const pathsExpanded = options.pathsExpanded ?? true;
  const allowPathToggle = options.allowPathToggle ?? false;
  const bodyExpanded = options.bodyExpanded ?? true;
  const allowBodyToggle = options.allowBodyToggle ?? false;
  const expiresAt = options.expiresAt ?? plan.expiresAt;
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
          `*期限*\n${escapeSlack(expiresAt)}`,
      },
    },
  ];
  blocks.push(pathSummaryBlock(plan.paths.length, value, {
    pathsExpanded,
    allowPathToggle,
  }));
  if (pathsExpanded) {
    const pathChunks = exactPathChunks(plan.paths);
    blocks.push(...pathChunks.map((text): KnownBlock => ({
      type: "section",
      text: { type: "plain_text", text, emoji: false },
    })));
  }
  for (const [label, value] of exactPlanTexts(plan)) {
    blocks.push(...exactTextChunks(label, value).map((text): KnownBlock => ({
      type: "section",
      text: { type: "plain_text", text, emoji: false },
    })));
  }
  if (plan.pullRequestBody !== undefined) {
    blocks.push(bodySummaryBlock(plan.pullRequestBody, value, {
      bodyExpanded,
      allowBodyToggle,
    }));
    if (bodyExpanded) {
      blocks.push(...exactTextChunks("Draft PR body", plan.pullRequestBody).map(
        (text): KnownBlock => ({
          type: "section",
          text: { type: "plain_text", text, emoji: false },
        }),
      ));
    }
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

export function buildExpiredWorkspaceGitApprovalBlocks(
  plan: WorkspaceGitApprovalPlan,
  expiresAt: string,
): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*:warning: Git操作の承認期限が切れました*\n" +
          "この計画は実行できません。必要な場合は、同じ依頼をもう一度送って承認画面を再作成してください。",
      },
    },
    {
      type: "section",
      fields: [
        field("操作", operationLabel(plan.operation)),
        field("Repository", plan.repoId),
        field("Branch", plan.branch),
        field("Mode", plan.mode),
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `期限: ${escapeSlack(expiresAt)} ・ 状態: 期限切れ（実行不可）`,
        },
      ],
    },
  ];
}

export function buildUnavailableWorkspaceGitApprovalBlocks(): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*:warning: このGit承認は利用できません*\n" +
          "期限切れ、処理済み、またはGateway再起動前の承認画面です。" +
          "このボタンからは実行できません。必要な場合は承認画面を再作成してください。",
      },
    },
  ];
}

export function parseUserInputDecision(
  actionId: string,
): AgentGitApprovalInputResponse["optionId"] | undefined {
  if (!actionId.startsWith(USER_INPUT_ACTION_PREFIX)) return undefined;
  const decision = actionId.slice(USER_INPUT_ACTION_PREFIX.length);
  return decision === "approve" || decision === "reject"
    ? decision
    : undefined;
}

export function parseUserInputPathVisibility(
  actionId: string,
): UserInputPathVisibility | undefined {
  if (!actionId.startsWith(USER_INPUT_PATH_ACTION_PREFIX)) return undefined;
  const visibility = actionId.slice(USER_INPUT_PATH_ACTION_PREFIX.length);
  return visibility === "show" || visibility === "hide"
    ? visibility
    : undefined;
}

export function parseUserInputBodyVisibility(
  actionId: string,
): UserInputBodyVisibility | undefined {
  if (!actionId.startsWith(USER_INPUT_BODY_ACTION_PREFIX)) return undefined;
  const visibility = actionId.slice(USER_INPUT_BODY_ACTION_PREFIX.length);
  return visibility === "show" || visibility === "hide"
    ? visibility
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

function pathSummaryBlock(
  pathCount: number,
  routing: UserInputActionValue,
  options: {
    readonly pathsExpanded: boolean;
    readonly allowPathToggle: boolean;
  },
): KnownBlock {
  const summary = pathCount === 0
    ? "*変更ファイル*\nなし"
    : `*変更ファイル*\n${pathCount}件`;
  if (!options.allowPathToggle || pathCount === 0) {
    return {
      type: "section",
      text: { type: "mrkdwn", text: summary },
    };
  }
  const visibility: UserInputPathVisibility = options.pathsExpanded
    ? "hide"
    : "show";
  return {
    type: "section",
    text: { type: "mrkdwn", text: summary },
    accessory: {
      type: "button",
      text: {
        type: "plain_text",
        text: options.pathsExpanded ? "一覧を閉じる" : "変更ファイルを表示",
        emoji: true,
      },
      action_id: `${USER_INPUT_PATH_ACTION_PREFIX}${visibility}`,
      value: JSON.stringify(routing),
    },
  };
}

function bodySummaryBlock(
  body: string,
  routing: UserInputActionValue,
  options: {
    readonly bodyExpanded: boolean;
    readonly allowBodyToggle: boolean;
  },
): KnownBlock {
  const summary = `*Draft PR body*\n${[...body].length}文字`;
  if (!options.allowBodyToggle) {
    return {
      type: "section",
      text: { type: "mrkdwn", text: summary },
    };
  }
  const visibility: UserInputBodyVisibility = options.bodyExpanded
    ? "hide"
    : "show";
  return {
    type: "section",
    text: { type: "mrkdwn", text: summary },
    accessory: {
      type: "button",
      text: {
        type: "plain_text",
        text: options.bodyExpanded ? "PR本文を閉じる" : "PR本文を表示",
        emoji: true,
      },
      action_id: `${USER_INPUT_BODY_ACTION_PREFIX}${visibility}`,
      value: JSON.stringify(routing),
    },
  };
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

function approvalDetailsKey(value: UserInputActionValue): string {
  return [
    value.requestId,
    value.channelId,
    value.rootThreadTs,
    value.messageTs,
  ].join("\u0000");
}
