import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 5_000;

function sanitizedGitEnvironment(templateDirectory: string): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: templateDirectory,
  };
}

async function isIgnored(
  repository: string,
  path: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      [
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        "--no-index",
        "--quiet",
        path,
      ],
      {
        cwd: repository,
        env: environment,
        timeout: GIT_COMMAND_TIMEOUT_MS,
      },
    );
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 1
    ) {
      return false;
    }
    throw error;
  }
}

test("ignores machine-local workbench files without hiding public files", async () => {
  const repository = await mkdtemp(join(tmpdir(), "showtalk-hygiene-"));
  try {
    const templateDirectory = join(repository, "empty-git-template");
    await mkdir(templateDirectory);
    const gitEnvironment = sanitizedGitEnvironment(templateDirectory);
    await execFileAsync("git", ["init", "--quiet"], {
      cwd: repository,
      env: gitEnvironment,
      timeout: GIT_COMMAND_TIMEOUT_MS,
    });
    await copyFile(new URL("../.gitignore", import.meta.url), join(repository, ".gitignore"));

    for (const path of [
      "admin-config-overrides.v1.json",
      "admin-config-overrides.v1.json.lock",
      ".admin-config-overrides.1234.tmp",
      "private/state/admin-config-overrides.v1.json",
      "private/state/admin-config-overrides.v1.json.lock",
      "private/state/.admin-config-overrides.1234.tmp",
      "tmp/local-mcp-workspace/private-state.json",
    ]) {
      assert.equal(
        await isIgnored(repository, path, gitEnvironment),
        true,
        `${path} must be ignored`,
      );
    }

    for (const path of [
      "README.md",
      "examples/config.example.yaml",
      "src/config/schema.ts",
      "src/tmp/example.ts",
      "test/fixtures/admin-config-overrides.v1.example.json",
    ]) {
      assert.equal(
        await isIgnored(repository, path, gitEnvironment),
        false,
        `${path} must stay public`,
      );
    }
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
