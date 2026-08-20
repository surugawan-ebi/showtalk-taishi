import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { initializeConfig } from "../../src/config/init.js";

test("initializes a private config from the safe example without overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "taishi-init-"));
  try {
    const template = join(directory, "template.yaml");
    const target = join(directory, "nested", "config.yaml");
    await writeFile(template, "version: 1\n", "utf8");
    assert.equal(
      await initializeConfig(target, pathToFileURL(template)),
      target,
    );
    assert.equal(await readFile(target, "utf8"), "version: 1\n");
    await assert.rejects(() => initializeConfig(target, pathToFileURL(template)), {
      message: `Config already exists: ${target}`,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
