import { createHash } from "node:crypto";

import type { WorkspaceGitDependabotMergeEvidence } from "../../core/index.js";

interface BoundPullRequest {
  readonly action: string;
  readonly branch: string;
  readonly expectedHead: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly headRepositoryOwner: string;
  readonly baseBranch: string;
  readonly basePolicy: string;
  readonly baseSha: string | undefined;
  readonly autoMergeEnabled: boolean;
  readonly expectedIsDraft: boolean;
  readonly hasParent: boolean;
}

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KEYS = ["version", "kind", "repository", "pull_request_number", "pull_request_url", "head_ref_name", "head_sha",
  "base_ref_name", "pr_read_base_sha", "current_base_tip_sha", "author_login", "author_id", "author_type", "ecosystem", "files", "source_fingerprint"];
const FILE_KEYS = ["path", "before_blob_sha", "after_blob_sha", "before_sha256", "after_sha256"];
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))) throw new Error("workspace-git Dependabot evidence has invalid fields");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, length: number): string {
  if (typeof value !== "string" || !value || value.length > length || /[\0\r\n]/u.test(value)) throw new Error("workspace-git Dependabot evidence has an invalid string");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

/** Validate public evidence consistency; backend alone re-reads GitHub/CI and verifies ancestry. */
export function validatedDependabotMergeEvidence(value: unknown, bound: BoundPullRequest): WorkspaceGitDependabotMergeEvidence {
  const evidence = exactRecord(value, KEYS);
  const repository = bounded(evidence.repository, 256);
  const url = bounded(evidence.pull_request_url, 512);
  const head = bounded(evidence.head_ref_name, 256);
  const match = /^dependabot\/(npm_and_yarn|github_actions)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.exec(head);
  if (evidence.version !== 1 || evidence.kind !== "dependabot_merge" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
    !Number.isSafeInteger(evidence.pull_request_number) || (evidence.pull_request_number as number) < 1 ||
    url !== `https://github.com/${repository}/pull/${evidence.pull_request_number}` || !match ||
    head.includes("..") || head.includes("//") || head.endsWith("/") || head.endsWith(".lock") ||
    evidence.ecosystem !== match[1] || evidence.author_login !== "dependabot[bot]" || evidence.author_type !== "Bot" ||
    !Number.isSafeInteger(evidence.author_id) || (evidence.author_id as number) <= 0 ||
    [evidence.head_sha, evidence.pr_read_base_sha, evidence.current_base_tip_sha].some(sha => typeof sha !== "string" || !SHA.test(sha)) ||
    typeof evidence.source_fingerprint !== "string" || !SHA256.test(evidence.source_fingerprint)) throw new Error("workspace-git Dependabot evidence identity is invalid");
  if (bound.action !== "merge" || bound.basePolicy !== "catalog_publication_branch" || bound.hasParent ||
    bound.autoMergeEnabled || bound.expectedIsDraft || bound.baseSha === undefined ||
    evidence.pull_request_number !== bound.pullRequestNumber || url !== bound.pullRequestUrl ||
    repository.split("/")[0] !== bound.headRepositoryOwner || head !== bound.branch || evidence.head_sha !== bound.expectedHead ||
    bounded(evidence.base_ref_name, 256) !== bound.baseBranch || evidence.pr_read_base_sha !== bound.baseSha) {
    throw new Error("workspace-git Dependabot evidence does not match its exact Pull Request plan");
  }
  if (!Array.isArray(evidence.files) || evidence.files.length < 1 || evidence.files.length > 100) throw new Error("workspace-git Dependabot evidence file set is invalid");
  const files = evidence.files.map(value => {
    const file = exactRecord(value, FILE_KEYS); const path = bounded(file.path, 1024);
    const allowed = evidence.ecosystem === "npm_and_yarn"
      ? path === "package.json" || path === "package-lock.json"
      : /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/u.test(path);
    if (!allowed || [file.before_blob_sha, file.after_blob_sha].some(sha => typeof sha !== "string" || !SHA.test(sha)) ||
      [file.before_sha256, file.after_sha256].some(sha => typeof sha !== "string" || !SHA256.test(sha)) ||
      file.before_blob_sha === file.after_blob_sha || file.before_sha256 === file.after_sha256) throw new Error("workspace-git Dependabot evidence file identity is invalid");
    return Object.freeze({ path, before_blob_sha: file.before_blob_sha as string, after_blob_sha: file.after_blob_sha as string,
      before_sha256: file.before_sha256 as string, after_sha256: file.after_sha256 as string });
  });
  if (new Set(files.map(file => file.path)).size !== files.length || files.some((file, index) => index > 0 && files[index - 1]!.path.localeCompare(file.path) >= 0)) throw new Error("workspace-git Dependabot evidence files must be unique and canonically ordered");
  const result = {
    version: 1 as const, kind: "dependabot_merge" as const, repository,
    pull_request_number: evidence.pull_request_number as number, pull_request_url: url, head_ref_name: head,
    head_sha: evidence.head_sha as string, base_ref_name: evidence.base_ref_name as string,
    pr_read_base_sha: evidence.pr_read_base_sha as string, current_base_tip_sha: evidence.current_base_tip_sha as string,
    author_login: "dependabot[bot]" as const, author_id: evidence.author_id as number, author_type: "Bot" as const,
    ecosystem: evidence.ecosystem as "npm_and_yarn" | "github_actions", files: Object.freeze(files),
  };
  const fingerprint = createHash("sha256").update(canonical(result)).digest("hex");
  if (fingerprint !== evidence.source_fingerprint) throw new Error("workspace-git Dependabot evidence fingerprint does not match its exact source fields");
  return Object.freeze({ ...result, source_fingerprint: fingerprint });
}
