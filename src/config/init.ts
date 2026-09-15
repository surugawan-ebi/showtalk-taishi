import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function initializeConfig(
  targetPath: string,
  templateUrl = new URL("../../examples/config.example.yaml", import.meta.url),
): Promise<string> {
  const absoluteTarget = resolve(targetPath);
  const template = await readFile(templateUrl, "utf8");
  await mkdir(dirname(absoluteTarget), { recursive: true, mode: 0o700 });
  try {
    await writeFile(absoluteTarget, template, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Config already exists: ${absoluteTarget}`);
    }
    throw error;
  }
  return absoluteTarget;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
