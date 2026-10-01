import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MarkerLifecycleProbe,
  MarkerLifecycleProbeError,
  createMarkerLifecycleReceiptBroker,
  type MarkerLifecycleAuditRecord,
  type MarkerLifecycleFileInfo,
  type MarkerLifecycleFileSystem,
  type MarkerLifecycleOpenDirectory,
  type MarkerLifecycleOpenMarker,
  type MarkerLifecycleProbeInput,
} from "../../src/diagnostics/marker-lifecycle-probe.js";

const root = "/private/tmp";
const directory = "/private/tmp/showtalk-probe-synthetic";
const directoryName = "showtalk-probe-synthetic";
const alternateDirectory = "/private/tmp/showtalk-probe-alternate";
const alternateDirectoryName = "showtalk-probe-alternate";
const markerName = ".showtalk-marker-lifecycle-probe";
const binding = {
  workerId: "worker-synthetic",
  requestId: "request-synthetic",
  turnId: "turn-synthetic",
  sessionId: "session-synthetic",
  probeId: "probe-synthetic",
} as const;

function input(
  receiptId: string,
  changes: Partial<MarkerLifecycleProbeInput> = {},
): MarkerLifecycleProbeInput {
  return { binding, receiptId, directoryPath: directory, ...changes };
}

type NodeEntry = DirectoryEntry | FileEntry | SymlinkEntry;

interface DirectoryEntry {
  readonly kind: "directory";
  readonly dev: number;
  readonly ino: number;
  readonly path: string;
  readonly entries: Map<string, NodeEntry>;
  mode: number;
  nlink: number;
  uid?: number;
}

interface FileEntry {
  readonly kind: "file";
  readonly dev: number;
  readonly ino: number;
  content: string;
  mode: number;
  nlink: number;
  uid?: number;
}

interface SymlinkEntry {
  readonly kind: "symlink";
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly uid?: number;
}

function metadata(entry: NodeEntry): MarkerLifecycleFileInfo {
  return {
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    nlink: entry.nlink,
    size: entry.kind === "file" ? Buffer.byteLength(entry.content) : 0,
    uid: entry.uid ?? process.getuid?.() ?? 0,
    isDirectory: () => entry.kind === "directory",
    isFile: () => entry.kind === "file",
    isSymbolicLink: () => entry.kind === "symlink",
  };
}

function sameInode(entry: NodeEntry, expected: MarkerLifecycleFileInfo): boolean {
  return entry.dev === expected.dev && entry.ino === expected.ino;
}

class MemoryDirectoryHandle implements MarkerLifecycleOpenDirectory {
  constructor(
    private readonly fileSystem: MemoryFileSystem,
    readonly node: DirectoryEntry,
  ) {}

  async inspect(): Promise<MarkerLifecycleFileInfo> {
    this.fileSystem.calls.push("directory.inspect");
    return metadata(this.node);
  }

  async resolveRealPath(): Promise<string> {
    this.fileSystem.calls.push("directory.resolveRealPath");
    return this.node.path;
  }

  async list(): Promise<readonly string[]> {
    this.fileSystem.calls.push("directory.list");
    return [...this.node.entries.keys()];
  }

  async openDirectory(name: string): Promise<MarkerLifecycleOpenDirectory> {
    this.fileSystem.calls.push("directory.openDirectory");
    this.fileSystem.openedDirectoryNames.push(name);
    const entry = this.node.entries.get(name);
    if (entry?.kind !== "directory") throw new Error("synthetic not-directory");
    return new MemoryDirectoryHandle(this.fileSystem, entry);
  }

  async inspectOptional(name: string): Promise<MarkerLifecycleFileInfo | undefined> {
    this.fileSystem.calls.push("directory.inspectOptional");
    const entry = this.node.entries.get(name);
    const info = entry === undefined ? undefined : metadata(entry);
    if (
      this.node === this.fileSystem.rootNode &&
      name === this.fileSystem.parentName &&
      this.fileSystem.replacementParentBeforeOpen !== undefined
    ) {
      this.fileSystem.rootNode.entries.set(
        name,
        this.fileSystem.replacementParentBeforeOpen,
      );
      this.fileSystem.replacementParentBeforeOpen = undefined;
    }
    return info;
  }

  async createMarker(
    name: string,
    content: string,
  ): Promise<MarkerLifecycleOpenMarker> {
    this.fileSystem.calls.push("directory.createMarker");
    if (this.fileSystem.injectedError !== undefined) {
      throw this.fileSystem.injectedError;
    }
    if (this.fileSystem.swapParentBeforeCreate) {
      this.fileSystem.swapParentBeforeCreate = false;
      this.fileSystem.rootNode.entries.set(this.fileSystem.parentName, {
        kind: "symlink",
        dev: 9,
        ino: 90,
        mode: 0o120777,
        nlink: 1,
      });
    }
    if (this.fileSystem.replacementParentBeforeCreate !== undefined) {
      this.fileSystem.rootNode.entries.set(
        this.fileSystem.parentName,
        this.fileSystem.replacementParentBeforeCreate,
      );
      this.fileSystem.replacementParentBeforeCreate = undefined;
    }
    if (this.node.entries.has(name)) throw new Error("synthetic duplicate");
    const marker: FileEntry = {
      kind: "file",
      dev: 2,
      ino: this.fileSystem.nextInode++,
      content,
      mode: 0o100600,
      nlink: 1,
    };
    this.node.entries.set(name, marker);
    this.fileSystem.markerWritePaths.push(this.node.path);
    if (this.node === this.fileSystem.outsideNode) {
      this.fileSystem.outsideMarkerWrites += 1;
    }
    return {
      inspect: async () => {
        this.fileSystem.calls.push("marker.inspect");
        return metadata(marker);
      },
      read: async () => {
        this.fileSystem.calls.push("marker.read");
        if (this.fileSystem.mutateModeAfterRead) marker.mode = 0o100644;
        return marker.content;
      },
      close: () => {
        this.fileSystem.calls.push("marker.close");
        if (this.fileSystem.markerCloseSyncError !== undefined) {
          throw this.fileSystem.markerCloseSyncError;
        }
        return Promise.resolve();
      },
    };
  }

  async removeMarker(
    name: string,
    expected: MarkerLifecycleFileInfo,
  ): Promise<void> {
    this.fileSystem.calls.push("directory.removeMarker");
    if (this.fileSystem.failMarkerRemoval) {
      throw new Error("synthetic cleanup marker removal failure");
    }
    const entry = this.node.entries.get(name);
    if (entry?.kind !== "file" || !sameInode(entry, expected)) {
      throw new Error("synthetic marker identity mismatch");
    }
    this.node.entries.delete(name);
    entry.nlink = 0;
  }

  async removeDirectory(
    name: string,
    expected: MarkerLifecycleFileInfo,
  ): Promise<void> {
    this.fileSystem.calls.push("directory.removeDirectory");
    if (this.fileSystem.failParentRemoval) {
      throw new Error("synthetic partial cleanup");
    }
    const entry = this.node.entries.get(name);
    if (
      entry?.kind !== "directory" ||
      !sameInode(entry, expected) ||
      entry.entries.size !== 0
    ) {
      throw new Error("synthetic directory identity mismatch");
    }
    this.node.entries.delete(name);
    entry.nlink = 0;
  }

  async close(): Promise<void> {
    this.fileSystem.calls.push("directory.close");
    this.fileSystem.closedDirectoryPaths.push(this.node.path);
  }
}

class MemoryFileSystem implements MarkerLifecycleFileSystem {
  readonly calls: string[] = [];
  readonly openedDirectoryNames: string[] = [];
  readonly markerWritePaths: string[] = [];
  readonly closedDirectoryPaths: string[] = [];
  readonly parentNode: DirectoryEntry;
  readonly rootNode: DirectoryEntry;
  readonly outsideNode: DirectoryEntry;
  nextInode = 100;
  injectedError: Error | undefined;
  swapParentBeforeCreate = false;
  replacementParentBeforeCreate: DirectoryEntry | undefined;
  replacementParentBeforeOpen: DirectoryEntry | undefined;
  markerCloseSyncError: Error | undefined;
  mutateModeAfterRead = false;
  failMarkerRemoval = false;
  failParentRemoval = false;
  outsideMarkerWrites = 0;

  constructor(
    readonly parentPath = directory,
    readonly parentName = directoryName,
  ) {
    this.parentNode = {
      kind: "directory",
      dev: 1,
      ino: 11,
      path: parentPath,
      entries: new Map(),
      mode: 0o040700,
      nlink: 1,
    };
    this.outsideNode = {
      kind: "directory",
      dev: 9,
      ino: 91,
      path: "/private/outside",
      entries: new Map(),
      mode: 0o040700,
      nlink: 1,
    };
    this.rootNode = {
      kind: "directory",
      dev: 1,
      ino: 10,
      path: root,
      entries: new Map([[parentName, this.parentNode]]),
      mode: 0o041777,
      nlink: 1,
    };
  }

  async openDirectory(path: string): Promise<MarkerLifecycleOpenDirectory> {
    this.calls.push("fileSystem.openDirectory");
    if (path !== root) throw new Error("synthetic unknown root");
    return new MemoryDirectoryHandle(this, this.rootNode);
  }
}

function expectCode(code: MarkerLifecycleProbeError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof MarkerLifecycleProbeError && error.code === code;
}

function opaqueRef(kind: string, value: string): string {
  return createHash("sha256")
    .update("showtalk-marker-lifecycle-probe-v1\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function assertBatchBinding(
  batch: readonly MarkerLifecycleAuditRecord[],
  expected: typeof binding,
): void {
  for (const record of batch) {
    assert.equal(record.workerRef, opaqueRef("worker", expected.workerId));
    assert.equal(record.requestRef, opaqueRef("request", expected.requestId));
    assert.equal(record.turnRef, opaqueRef("turn", expected.turnId));
    assert.equal(record.sessionRef, opaqueRef("session", expected.sessionId));
    assert.equal(record.probeRef, opaqueRef("probe", expected.probeId));
  }
}

function createProbe(
  fileSystem: MemoryFileSystem,
  records: MarkerLifecycleAuditRecord[][] = [],
) {
  const broker = createMarkerLifecycleReceiptBroker();
  return {
    broker,
    probe: new MarkerLifecycleProbe({
      enabled: true,
      allowedTemporaryDirectory: root,
      fileSystem,
      receiptConsumer: broker.consumer,
      audit: (batch) => records.push([...batch]),
    }),
  };
}

test("is disabled by default and requires an approved same-session same-turn receipt", async () => {
  const fileSystem = new MemoryFileSystem();
  const disabledBroker = createMarkerLifecycleReceiptBroker();
  await assert.rejects(
    new MarkerLifecycleProbe({ fileSystem }).run(input(
      disabledBroker.issuer.recordDecision(binding, "approved"),
    )),
    expectCode("disabled"),
  );
  assert.deepEqual(fileSystem.calls, []);

  const missingBroker = createMarkerLifecycleReceiptBroker();
  const rejectedBroker = createMarkerLifecycleReceiptBroker();
  const mismatchBroker = createMarkerLifecycleReceiptBroker();
  const mismatchedBinding = { ...binding, sessionId: "another-session" };
  for (const [candidate, broker, code] of [
    [{ binding, directoryPath: directory }, missingBroker.consumer, "receipt_missing"],
    [input(rejectedBroker.issuer.recordDecision(binding, "rejected")), rejectedBroker.consumer, "receipt_rejected"],
    [input(mismatchBroker.issuer.recordDecision(mismatchedBinding, "approved")), mismatchBroker.consumer, "receipt_binding_mismatch"],
  ] as const) {
    await assert.rejects(
      new MarkerLifecycleProbe({
        enabled: true,
        allowedTemporaryDirectory: root,
        fileSystem,
        receiptConsumer: broker,
      }).run(candidate),
      expectCode(code),
    );
  }
  assert.deepEqual(fileSystem.calls, []);
});

test("snapshots each binding ref before a synchronous consumer mutation", async (t) => {
  const fields = Object.keys(binding) as Array<keyof typeof binding>;
  for (const field of fields) {
    await t.test(field, async () => {
      const fileSystem = new MemoryFileSystem();
      const batches: MarkerLifecycleAuditRecord[][] = [];
      const broker = createMarkerLifecycleReceiptBroker();
      const sharedBinding: Record<keyof typeof binding, string> = { ...binding };
      const sharedInput = {
        binding: sharedBinding,
        receiptId: broker.issuer.recordDecision(binding, "approved"),
        directoryPath: directory,
      };
      let receivedFrozenSnapshot = false;
      const probe = new MarkerLifecycleProbe({
        enabled: true,
        allowedTemporaryDirectory: root,
        fileSystem,
        receiptConsumer: {
          consume: (receiptId, receivedBinding) => {
            sharedBinding[field] = `mutated-${field}`;
            receivedFrozenSnapshot = Object.isFrozen(receivedBinding);
            return broker.consumer.consume(receiptId, receivedBinding);
          },
        },
        audit: (batch) => batches.push([...batch]),
      });

      await probe.run(sharedInput);

      assert.equal(receivedFrozenSnapshot, true);
      assert.equal(Object.isFrozen(sharedBinding), false);
      assert.equal(Object.isFrozen(sharedInput), false);
      assertBatchBinding(batches[0] ?? [], binding);
    });
  }
});

test("keeps the complete binding snapshot when the caller replaces binding", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const broker = createMarkerLifecycleReceiptBroker();
  const sharedInput: {
    binding: Record<keyof typeof binding, string>;
    receiptId: string;
    directoryPath: string;
  } = {
    binding: { ...binding },
    receiptId: broker.issuer.recordDecision(binding, "approved"),
    directoryPath: directory,
  };
  const originalBinding = sharedInput.binding;
  const probe = new MarkerLifecycleProbe({
    enabled: true,
    allowedTemporaryDirectory: root,
    fileSystem,
    receiptConsumer: {
      consume: (receiptId, receivedBinding) => {
        sharedInput.binding = {
          workerId: "replacement-worker",
          requestId: "replacement-request",
          turnId: "replacement-turn",
          sessionId: "replacement-session",
          probeId: "replacement-probe",
        };
        return broker.consumer.consume(receiptId, receivedBinding);
      },
    },
    audit: (batch) => batches.push([...batch]),
  });

  await probe.run(sharedInput);

  assert.equal(Object.isFrozen(originalBinding), false);
  assert.equal(Object.isFrozen(sharedInput), false);
  assertBatchBinding(batches[0] ?? [], binding);
});

test("rejects a B receipt after shared A binding mutates to B with zero filesystem operations", async () => {
  const fileSystem = new MemoryFileSystem();
  const broker = createMarkerLifecycleReceiptBroker();
  const bindingB = {
    workerId: "worker-b",
    requestId: "request-b",
    turnId: "turn-b",
    sessionId: "session-b",
    probeId: "probe-b",
  };
  const sharedBinding: Record<keyof typeof binding, string> = { ...binding };
  const sharedInput = {
    binding: sharedBinding,
    receiptId: broker.issuer.recordDecision(bindingB, "approved"),
    directoryPath: directory,
  };
  const probe = new MarkerLifecycleProbe({
    enabled: true,
    allowedTemporaryDirectory: root,
    fileSystem,
    receiptConsumer: {
      consume: (receiptId, receivedBinding) => {
        Object.assign(sharedBinding, bindingB);
        return broker.consumer.consume(receiptId, receivedBinding);
      },
    },
  });

  await assert.rejects(
    probe.run(sharedInput),
    expectCode("receipt_binding_mismatch"),
  );
  assert.deepEqual(fileSystem.calls, []);
});

test("uses directory A when the consumer synchronously replaces it with B", async () => {
  const fileSystem = new MemoryFileSystem();
  const alternateNode: DirectoryEntry = {
    kind: "directory",
    dev: 1,
    ino: 12,
    path: alternateDirectory,
    entries: new Map(),
    mode: 0o040700,
    nlink: 1,
  };
  fileSystem.rootNode.entries.set(alternateDirectoryName, alternateNode);
  const broker = createMarkerLifecycleReceiptBroker();
  const sharedInput = {
    binding: { ...binding },
    receiptId: broker.issuer.recordDecision(binding, "approved"),
    directoryPath: directory,
  };
  const probe = new MarkerLifecycleProbe({
    enabled: true,
    allowedTemporaryDirectory: root,
    fileSystem,
    receiptConsumer: {
      consume: (receiptId, receivedBinding) => {
        sharedInput.directoryPath = alternateDirectory;
        return broker.consumer.consume(receiptId, receivedBinding);
      },
    },
  });

  await probe.run(sharedInput);

  assert.deepEqual(fileSystem.markerWritePaths, [directory]);
  assert.equal(fileSystem.openedDirectoryNames.includes(alternateDirectoryName), false);
  assert.equal(fileSystem.rootNode.entries.has(directoryName), false);
  assert.equal(fileSystem.rootNode.entries.get(alternateDirectoryName), alternateNode);
  assert.equal(alternateNode.entries.size, 0);
});

test("keeps all caller values fixed while the receipt consumer is delayed", async () => {
  const fileSystem = new MemoryFileSystem();
  const alternateNode: DirectoryEntry = {
    kind: "directory",
    dev: 1,
    ino: 12,
    path: alternateDirectory,
    entries: new Map(),
    mode: 0o040700,
    nlink: 1,
  };
  fileSystem.rootNode.entries.set(alternateDirectoryName, alternateNode);
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const broker = createMarkerLifecycleReceiptBroker();
  const receiptA = broker.issuer.recordDecision(binding, "approved");
  const sharedInput: {
    binding: Record<keyof typeof binding, string>;
    receiptId: string;
    directoryPath: string;
  } = {
    binding: { ...binding },
    receiptId: receiptA,
    directoryPath: directory,
  };
  let releaseConsumer: (() => void) | undefined;
  const consumerGate = new Promise<void>((resolve) => {
    releaseConsumer = resolve;
  });
  const probe = new MarkerLifecycleProbe({
    enabled: true,
    allowedTemporaryDirectory: root,
    fileSystem,
    receiptConsumer: {
      consume: async (receiptId, receivedBinding) => {
        await consumerGate;
        return broker.consumer.consume(receiptId, receivedBinding);
      },
    },
    audit: (batch) => batches.push([...batch]),
  });

  const pendingRun = probe.run(sharedInput);
  sharedInput.binding = {
    workerId: "delayed-worker",
    requestId: "delayed-request",
    turnId: "delayed-turn",
    sessionId: "delayed-session",
    probeId: "delayed-probe",
  };
  sharedInput.receiptId = "delayed-replacement-receipt";
  sharedInput.directoryPath = alternateDirectory;
  releaseConsumer?.();
  await pendingRun;

  assert.deepEqual(fileSystem.markerWritePaths, [directory]);
  assert.equal(alternateNode.entries.size, 0);
  assertBatchBinding(batches[0] ?? [], binding);
});

test("records one complete four-event batch only after marker and parent are absent", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const { broker, probe } = createProbe(fileSystem, batches);
  const receiptId = broker.issuer.recordDecision(binding, "approved");

  await probe.run(input(receiptId));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.map(({ event }) => event), [
    "marker_created",
    "marker_inspected",
    "marker_removed",
    "parent_removed",
  ]);
  assert.equal(fileSystem.parentNode.entries.has(markerName), false);
  assert.equal(fileSystem.rootNode.entries.has(directoryName), false);
  for (const record of batches[0] ?? []) {
    assert.deepEqual(Object.keys(record).sort(), [
      "event", "probeRef", "requestRef", "sessionRef", "turnRef", "workerRef",
    ]);
    for (const value of Object.values(record).slice(1)) {
      assert.match(value, /^[0-9a-f]{16}$/u);
    }
  }

  const callCount = fileSystem.calls.length;
  await assert.rejects(probe.run(input(receiptId)), expectCode("replay"));
  assert.equal(fileSystem.calls.length, callCount);
});

test("rejects a concurrent receipt replay before either invocation reaches marker I/O", async () => {
  const broker = createMarkerLifecycleReceiptBroker();
  const receiptId = broker.issuer.recordDecision(binding, "approved");
  const firstFileSystem = new MemoryFileSystem();
  const secondFileSystem = new MemoryFileSystem();
  const options = (fileSystem: MemoryFileSystem) => ({
    enabled: true,
    allowedTemporaryDirectory: root,
    fileSystem,
    receiptConsumer: broker.consumer,
  });
  const results = await Promise.allSettled([
    new MarkerLifecycleProbe(options(firstFileSystem)).run(input(receiptId)),
    new MarkerLifecycleProbe(options(secondFileSystem)).run(input(receiptId)),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.equal(rejected?.status, "rejected");
  if (rejected?.status === "rejected") assert.ok(expectCode("replay")(rejected.reason));
  const rejectedIndex = results.findIndex(({ status }) => status === "rejected");
  const rejectedFileSystem = [firstFileSystem, secondFileSystem][rejectedIndex];
  assert.deepEqual(rejectedFileSystem?.calls, []);
});

test("keeps a receipt consumed after a failed lifecycle and rejects replay before filesystem access", async () => {
  const fileSystem = new MemoryFileSystem();
  const { broker, probe } = createProbe(fileSystem);
  const receiptId = broker.issuer.recordDecision(binding, "approved");
  fileSystem.injectedError = new Error("synthetic first-run failure");

  await assert.rejects(probe.run(input(receiptId)), expectCode("filesystem_failure"));
  const callsAfterFailure = [...fileSystem.calls];
  fileSystem.injectedError = undefined;

  await assert.rejects(probe.run(input(receiptId)), expectCode("replay"));
  assert.deepEqual(fileSystem.calls, callsAfterFailure);
});

test("fails closed for path escape, symlinks, and non-empty directories", async () => {
  const escaped = new MemoryFileSystem();
  const escapedProbe = createProbe(escaped);
  await assert.rejects(
    escapedProbe.probe.run(input(
      escapedProbe.broker.issuer.recordDecision(binding, "approved"),
      { directoryPath: "/private/outside" },
    )),
    expectCode("invalid_path"),
  );
  assert.deepEqual(escaped.calls, []);

  const symlink = new MemoryFileSystem();
  symlink.rootNode.entries.set(directoryName, {
    kind: "symlink", dev: 9, ino: 90, mode: 0o120777, nlink: 1,
  });
  const symlinkProbe = createProbe(symlink);
  await assert.rejects(
    symlinkProbe.probe.run(input(
      symlinkProbe.broker.issuer.recordDecision(binding, "approved"),
    )),
    expectCode("symlink"),
  );
  assert.equal(symlink.calls.includes("directory.createMarker"), false);

  const nonEmpty = new MemoryFileSystem();
  nonEmpty.parentNode.entries.set("unrelated", {
    kind: "file", dev: 2, ino: 20, content: "leave", mode: 0o100600, nlink: 1,
  });
  const nonEmptyProbe = createProbe(nonEmpty);
  await assert.rejects(
    nonEmptyProbe.probe.run(input(
      nonEmptyProbe.broker.issuer.recordDecision(binding, "approved"),
    )),
    expectCode("non_empty"),
  );
  assert.equal(nonEmpty.calls.includes("directory.createMarker"), false);
});

test("pins marker I/O to the opened parent when its name is replaced by a symlink", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  fileSystem.swapParentBeforeCreate = true;
  const { broker, probe } = createProbe(fileSystem, batches);

  await assert.rejects(
    probe.run(input(broker.issuer.recordDecision(binding, "approved"))),
    expectCode("symlink"),
  );
  assert.equal(fileSystem.outsideMarkerWrites, 0);
  assert.equal(fileSystem.outsideNode.entries.size, 0);
  assert.equal(fileSystem.parentNode.entries.has(markerName), false);
  assert.equal(fileSystem.rootNode.entries.get(directoryName)?.kind, "symlink");
  assert.deepEqual(batches, []);
});

test("rejects a directory replaced after the pre-open identity check without touching B", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const replacementNode: DirectoryEntry = {
    kind: "directory",
    dev: 9,
    ino: 90,
    path: directory,
    entries: new Map(),
    mode: 0o040700,
    nlink: 1,
  };
  fileSystem.replacementParentBeforeOpen = replacementNode;
  const { broker, probe } = createProbe(fileSystem, batches);

  await assert.rejects(
    probe.run(input(broker.issuer.recordDecision(binding, "approved"))),
    expectCode("filesystem_failure"),
  );

  assert.equal(fileSystem.rootNode.entries.get(directoryName), replacementNode);
  assert.equal(fileSystem.parentNode.entries.size, 0);
  assert.equal(replacementNode.entries.size, 0);
  assert.deepEqual(fileSystem.markerWritePaths, []);
  assert.equal(fileSystem.calls.includes("directory.list"), false);
  assert.equal(fileSystem.calls.includes("directory.createMarker"), false);
  assert.equal(fileSystem.calls.includes("directory.removeMarker"), false);
  assert.equal(fileSystem.calls.includes("directory.removeDirectory"), false);
  assert.deepEqual(batches, []);
});

test("does not touch a replacement directory during a parent path race", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const replacementNode: DirectoryEntry = {
    kind: "directory",
    dev: 9,
    ino: 90,
    path: directory,
    entries: new Map(),
    mode: 0o040700,
    nlink: 1,
  };
  fileSystem.replacementParentBeforeCreate = replacementNode;
  const { broker, probe } = createProbe(fileSystem, batches);

  await assert.rejects(
    probe.run(input(broker.issuer.recordDecision(binding, "approved"))),
    expectCode("filesystem_failure"),
  );

  assert.equal(replacementNode.entries.size, 0);
  assert.equal(fileSystem.markerWritePaths.length, 1);
  assert.equal(fileSystem.parentNode.entries.has(markerName), false);
  assert.equal(fileSystem.rootNode.entries.get(directoryName), replacementNode);
  assert.deepEqual(batches, []);
});

test("emits no partial events when marker cleanup succeeds but parent cleanup fails", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  fileSystem.failParentRemoval = true;
  const { broker, probe } = createProbe(fileSystem, batches);

  await assert.rejects(
    probe.run(input(broker.issuer.recordDecision(binding, "approved"))),
    expectCode("filesystem_failure"),
  );
  assert.equal(fileSystem.parentNode.entries.has(markerName), false);
  assert.equal(fileSystem.rootNode.entries.get(directoryName), fileSystem.parentNode);
  assert.deepEqual(batches, []);
});

test("fails closed when marker removal also fails partway through cleanup", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  fileSystem.failMarkerRemoval = true;
  const { broker, probe } = createProbe(fileSystem, batches);

  await assert.rejects(
    probe.run(input(broker.issuer.recordDecision(binding, "approved"))),
    expectCode("filesystem_failure"),
  );

  assert.equal(
    fileSystem.calls.filter((call) => call === "directory.removeMarker").length,
    2,
  );
  assert.equal(fileSystem.parentNode.entries.has(markerName), true);
  assert.equal(fileSystem.rootNode.entries.get(directoryName), fileSystem.parentNode);
  assert.deepEqual(batches, []);
});

test("rejects a marker changed from mode 0600 to 0644 after inspection", async () => {
  const fileSystem = new MemoryFileSystem();
  const batches: MarkerLifecycleAuditRecord[][] = [];
  fileSystem.mutateModeAfterRead = true;
  const { broker, probe } = createProbe(fileSystem, batches);

  await assert.rejects(
    probe.run(input(broker.issuer.recordDecision(binding, "approved"))),
    expectCode("filesystem_failure"),
  );
  assert.equal(fileSystem.calls.includes("directory.removeMarker"), false);
  assert.equal(fileSystem.parentNode.entries.has(markerName), true);
  assert.deepEqual(batches, []);
});

test("normalizes a synchronous marker close canary and still closes every provider", async () => {
  const syntheticCanary = "synchronous-close-canary-never-expose";
  const fileSystem = new MemoryFileSystem();
  fileSystem.markerCloseSyncError = new Error(syntheticCanary);
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const { broker, probe } = createProbe(fileSystem, batches);

  let failure: unknown;
  try {
    await probe.run(input(broker.issuer.recordDecision(binding, "approved")));
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof MarkerLifecycleProbeError);
  assert.equal(failure.code, "filesystem_failure");
  assert.equal(
    failure.message,
    "Marker lifecycle probe filesystem verification failed",
  );
  assert.doesNotMatch(failure.message, /synchronous-close-canary-never-expose/u);
  assert.equal(
    fileSystem.calls.filter((call) => call === "marker.close").length,
    1,
  );
  assert.deepEqual(fileSystem.closedDirectoryPaths, [directory, root]);
  assert.equal(fileSystem.parentNode.entries.has(markerName), false);
  assert.equal(fileSystem.rootNode.entries.has(directoryName), false);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.map(({ event }) => event), [
    "marker_created",
    "marker_inspected",
    "marker_removed",
    "parent_removed",
  ]);
  assert.doesNotMatch(
    JSON.stringify({ failure: failure.message, batches }),
    /synchronous-close-canary-never-expose/u,
  );
});

test("normalizes failures and never exposes a synthetic canary", async () => {
  const syntheticCanary = "synthetic-canary-never-record";
  const canaryDirectory = `${root}/${syntheticCanary}-directory`;
  const fileSystem = new MemoryFileSystem(
    canaryDirectory,
    `${syntheticCanary}-directory`,
  );
  const injectedFailure = new MarkerLifecycleProbeError("filesystem_failure");
  injectedFailure.message = `raw exception ${syntheticCanary}`;
  fileSystem.injectedError = injectedFailure;
  const batches: MarkerLifecycleAuditRecord[][] = [];
  const secretBinding = {
    workerId: `${syntheticCanary}-worker`,
    requestId: `${syntheticCanary}-request`,
    turnId: `${syntheticCanary}-turn`,
    sessionId: `${syntheticCanary}-session`,
    probeId: `${syntheticCanary}-probe`,
  };
  const probe = new MarkerLifecycleProbe({
    enabled: true,
    allowedTemporaryDirectory: root,
    fileSystem,
    receiptConsumer: { consume: async () => "approved" },
    audit: (batch) => batches.push([...batch]),
  });

  let failure: unknown;
  try {
    await probe.run({
      binding: secretBinding,
      receiptId: `${syntheticCanary}-receipt`,
      directoryPath: canaryDirectory,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof MarkerLifecycleProbeError);
  assert.equal(failure.code, "filesystem_failure");
  assert.equal(
    failure.message,
    "Marker lifecycle probe filesystem verification failed",
  );
  const serialized = JSON.stringify({
    batches,
    error: { name: failure.name, code: failure.code, message: failure.message },
  });
  assert.doesNotMatch(serialized, /synthetic-canary-never-record/u);
  assert.doesNotMatch(serialized, /\.showtalk-marker-lifecycle-probe/u);
  assert.deepEqual(batches, []);

  const unknownCode = new MarkerLifecycleProbeError(
    `${syntheticCanary}-code` as MarkerLifecycleProbeError["code"],
  );
  assert.equal(unknownCode.code, "filesystem_failure");
  assert.doesNotMatch(unknownCode.message, /synthetic-canary-never-record/u);

  const poisonedFailure = new MarkerLifecycleProbeError("invalid_binding");
  poisonedFailure.message = `poisoned getter ${syntheticCanary}`;
  const poisonedInput = Object.defineProperty({
    receiptId: `${syntheticCanary}-unused-receipt`,
    directoryPath: canaryDirectory,
  }, "binding", {
    get: () => {
      throw poisonedFailure;
    },
  }) as MarkerLifecycleProbeInput;
  await assert.rejects(
    new MarkerLifecycleProbe({ enabled: true }).run(poisonedInput),
    (error: unknown) => {
      assert.ok(error instanceof MarkerLifecycleProbeError);
      assert.equal(error.code, "invalid_binding");
      assert.equal(error.message, "Marker lifecycle probe binding is invalid");
      assert.doesNotMatch(error.message, /synthetic-canary-never-record/u);
      return true;
    },
  );
});
