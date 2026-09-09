import { once } from "node:events";

import { FileStateStore } from "../../src/state/file-state-store.js";

const path = process.argv[2];
if (path === undefined) throw new Error("State path is required");

const store = new FileStateStore(path);
await store.acquireLock();
process.stdout.write("acquired\n");
await once(process.stdin, "data");
await store.releaseLock();
