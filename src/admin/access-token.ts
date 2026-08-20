import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export async function loadOrCreateAdminAccessToken(
  stateFilePath: string,
): Promise<{ readonly token: string; readonly path: string }> {
  const directory = dirname(resolve(stateFilePath));
  const path = join(directory, "admin-ui.token");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${generated}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") throw error;
  }

  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("The admin UI token path must be a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("The admin UI token file must be owner-only (mode 0600)");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("The admin UI token file must be owned by the Gateway user");
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("The admin UI token file is invalid");
  }
  return { token, path };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
