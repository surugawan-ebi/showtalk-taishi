import assert from "node:assert/strict";
import test from "node:test";

test("removes admin UI credentials and non-routing URL data from logs", async () => {
  const originalArgv = process.argv;
  const originalLog = console.log;
  process.argv = [process.execPath, "src/cli.ts", "help"];
  console.log = () => undefined;

  try {
    const { adminUiUrlForLog } = await import("../src/cli.js");
    const credential = "secret-admin-credential";
    const loggedUrl = adminUiUrlForLog(
      `http://127.0.0.1:43123/admin?source=start#credential=${credential}`,
    );

    assert.equal(loggedUrl, "http://127.0.0.1:43123/admin");
    assert.equal(loggedUrl.includes(credential), false);
    assert.equal(loggedUrl.includes("source=start"), false);
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
  }
});
