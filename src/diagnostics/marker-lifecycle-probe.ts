import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const MARKER_BASENAME = ".showtalk-marker-lifecycle-probe";
const MARKER_CONTENT = "showtalk-marker-lifecycle-probe\n";
const MAX_IDENTITY_LENGTH = 256;

export type MarkerLifecycleEvent =
  | "marker_created"
  | "marker_inspected"
  | "marker_removed"
  | "parent_removed";

export type MarkerLifecycleProbeFailureCode =
  | "disabled"
  | "filesystem_failure"
  | "invalid_binding"
  | "invalid_path"
  | "non_empty"
  | "receipt_binding_mismatch"
  | "receipt_missing"
  | "receipt_rejected"
  | "replay"
  | "symlink";

export interface MarkerLifecycleBinding {
  readonly workerId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly probeId: string;
}

export type MarkerLifecycleReceiptStatus =
  | "approved"
  | "binding_mismatch"
  | "missing"
  | "rejected"
  | "replay";

export interface MarkerLifecycleReceiptConsumer {
  consume(
    receiptId: string,
    binding: MarkerLifecycleBinding,
  ): Promise<MarkerLifecycleReceiptStatus>;
}

export interface MarkerLifecycleReceiptIssuer {
  recordDecision(
    binding: MarkerLifecycleBinding,
    decision: "approved" | "rejected",
  ): string;
}

export interface MarkerLifecycleProbeInput {
  readonly binding: MarkerLifecycleBinding;
  readonly receiptId?: string;
  readonly directoryPath: string;
}

interface MarkerLifecycleProbeSnapshot {
  readonly binding: MarkerLifecycleBinding;
  readonly receiptId: string | undefined;
  readonly directoryPath: string;
}

export interface MarkerLifecycleAuditRecord {
  readonly event: MarkerLifecycleEvent;
  readonly workerRef: string;
  readonly requestRef: string;
  readonly turnRef: string;
  readonly sessionRef: string;
  readonly probeRef: string;
}

export interface MarkerLifecycleFileInfo {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface MarkerLifecycleOpenMarker {
  inspect(): Promise<MarkerLifecycleFileInfo>;
  read(): Promise<string>;
  close(): Promise<void>;
}

/**
 * A directory capability. Every entry operation must be relative to the open
 * directory identity (for example openat/fstatat/unlinkat), never by resolving
 * a stored absolute path again. The identity argument on removals is a
 * mandatory conditional-delete guard: implementations must reject rather than
 * remove a different inode.
 */
export interface MarkerLifecycleOpenDirectory {
  inspect(): Promise<MarkerLifecycleFileInfo>;
  resolveRealPath(): Promise<string>;
  list(): Promise<readonly string[]>;
  openDirectory(name: string): Promise<MarkerLifecycleOpenDirectory>;
  inspectOptional(name: string): Promise<MarkerLifecycleFileInfo | undefined>;
  createMarker(
    name: string,
    content: string,
  ): Promise<MarkerLifecycleOpenMarker>;
  removeMarker(
    name: string,
    expected: MarkerLifecycleFileInfo,
  ): Promise<void>;
  removeDirectory(
    name: string,
    expected: MarkerLifecycleFileInfo,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface MarkerLifecycleFileSystem {
  /** Opens one no-follow directory capability for the exact path identity. */
  openDirectory(path: string): Promise<MarkerLifecycleOpenDirectory>;
}

export interface MarkerLifecycleProbeOptions {
  /** The probe is inert unless this diagnostic-only switch is explicitly true. */
  readonly enabled?: boolean;
  /** Canonical, non-symlink temporary root. Probe directories must be direct children. */
  readonly allowedTemporaryDirectory?: string;
  /** Approval-bound broker that atomically consumes one exact receipt. */
  readonly receiptConsumer?: MarkerLifecycleReceiptConsumer;
  /** Required secure openat-style provider; absence is fail-closed. */
  readonly fileSystem?: MarkerLifecycleFileSystem;
  /** Atomically persists the complete four-record lifecycle batch. */
  readonly audit?: (records: readonly MarkerLifecycleAuditRecord[]) => void;
}

interface ValidatedProbeDirectory {
  readonly name: string;
  readonly info: MarkerLifecycleFileInfo;
  readonly rootInfo: MarkerLifecycleFileInfo;
  readonly handle: MarkerLifecycleOpenDirectory;
  readonly rootHandle: MarkerLifecycleOpenDirectory;
}

const FAILURE_MESSAGES: Readonly<Record<MarkerLifecycleProbeFailureCode, string>> = {
  disabled: "Marker lifecycle probe is disabled",
  filesystem_failure: "Marker lifecycle probe filesystem verification failed",
  invalid_binding: "Marker lifecycle probe binding is invalid",
  invalid_path: "Marker lifecycle probe path is outside the allowed temporary directory",
  non_empty: "Marker lifecycle probe directory is not empty",
  receipt_binding_mismatch: "Marker lifecycle probe receipt does not match the active turn",
  receipt_missing: "Marker lifecycle probe approval receipt is missing",
  receipt_rejected: "Marker lifecycle probe approval was rejected",
  replay: "Marker lifecycle probe receipt was already consumed",
  symlink: "Marker lifecycle probe refuses symbolic links",
};

interface StoredMarkerLifecycleReceipt {
  readonly binding: MarkerLifecycleBinding;
  readonly decision: "approved" | "rejected";
}

/**
 * Process-local authority split for the diagnostic approval boundary. Give the
 * issuer only to the bound approval handler and the consumer to the probe.
 */
class MarkerLifecycleReceiptBroker {
  readonly #pending = new Map<string, StoredMarkerLifecycleReceipt>();
  readonly #consumed = new Set<string>();

  recordDecision(
    binding: MarkerLifecycleBinding,
    decision: "approved" | "rejected",
  ): string {
    validateBinding(binding);
    const receiptId = randomUUID();
    this.#pending.set(receiptId, {
      binding: Object.freeze({ ...binding }),
      decision,
    });
    return receiptId;
  }

  async consume(
    receiptId: string,
    binding: MarkerLifecycleBinding,
  ): Promise<MarkerLifecycleReceiptStatus> {
    validateIdentity(receiptId);
    validateBinding(binding);
    if (this.#consumed.has(receiptId)) return "replay";
    this.#consumed.add(receiptId);
    while (this.#consumed.size > 256) {
      const oldest = this.#consumed.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#consumed.delete(oldest);
    }
    const stored = this.#pending.get(receiptId);
    this.#pending.delete(receiptId);
    if (stored === undefined) return "missing";
    if (!sameBinding(stored.binding, binding)) return "binding_mismatch";
    return stored.decision;
  }
}

export function createMarkerLifecycleReceiptBroker(): {
  readonly issuer: MarkerLifecycleReceiptIssuer;
  readonly consumer: MarkerLifecycleReceiptConsumer;
} {
  const broker = new MarkerLifecycleReceiptBroker();
  return Object.freeze({
    issuer: Object.freeze({
      recordDecision: (
        binding: MarkerLifecycleBinding,
        decision: "approved" | "rejected",
      ) => broker.recordDecision(binding, decision),
    }),
    consumer: Object.freeze({
      consume: (receiptId: string, binding: MarkerLifecycleBinding) =>
        broker.consume(receiptId, binding),
    }),
  });
}

export class MarkerLifecycleProbeError extends Error {
  readonly code: MarkerLifecycleProbeFailureCode;

  constructor(code: MarkerLifecycleProbeFailureCode) {
    const normalizedCode = normalizeFailureCode(code);
    super(FAILURE_MESSAGES[normalizedCode]);
    this.name = "MarkerLifecycleProbeError";
    this.code = normalizedCode;
  }
}

/**
 * Executes the diagnostic marker lifecycle once for one already-approved
 * session/turn receipt. It is deliberately not wired into the normal runtime.
 */
export class MarkerLifecycleProbe {
  readonly #enabled: boolean;
  readonly #allowedTemporaryDirectory: string | undefined;
  readonly #fileSystem: MarkerLifecycleFileSystem | undefined;
  readonly #audit: (records: readonly MarkerLifecycleAuditRecord[]) => void;
  readonly #receiptConsumer: MarkerLifecycleReceiptConsumer | undefined;
  readonly #consumedReceiptRefs = new Set<string>();

  constructor(options: MarkerLifecycleProbeOptions = {}) {
    this.#enabled = options.enabled === true;
    this.#allowedTemporaryDirectory = options.allowedTemporaryDirectory;
    this.#fileSystem = options.fileSystem;
    this.#audit = options.audit ?? (() => undefined);
    this.#receiptConsumer = options.receiptConsumer;
  }

  async run(input: MarkerLifecycleProbeInput): Promise<void> {
    // Capture every caller-owned value synchronously, before the first await or
    // consumer callback. Only this owned, deeply immutable snapshot may cross
    // the approval, filesystem, cleanup, and audit boundaries below.
    let snapshot: MarkerLifecycleProbeSnapshot;
    try {
      snapshot = snapshotProbeInput(input);
    } catch (error) {
      throw normalizeFailure(error);
    }
    if (!this.#enabled) fail("disabled");
    validateBinding(snapshot.binding);
    const receiptId = snapshot.receiptId;
    if (receiptId === undefined || this.#receiptConsumer === undefined) {
      fail("receipt_missing");
    }
    validateIdentity(receiptId);
    const receiptRef = opaqueRef("receipt", receiptId);
    if (this.#consumedReceiptRefs.has(receiptRef)) fail("replay");
    // Claim before the first await. Failures never restore a receipt.
    this.#consumedReceiptRefs.add(receiptRef);

    let receiptStatus: MarkerLifecycleReceiptStatus;
    try {
      receiptStatus = await this.#receiptConsumer.consume(
        receiptId,
        snapshot.binding,
      );
    } catch {
      fail("receipt_missing");
    }
    if (receiptStatus === "replay") fail("replay");
    if (receiptStatus === "binding_mismatch") fail("receipt_binding_mismatch");
    if (receiptStatus === "rejected") fail("receipt_rejected");
    if (receiptStatus !== "approved") fail("receipt_missing");

    const parent = await this.#validatedEmptyDirectory(snapshot.directoryPath);
    let markerHandle: MarkerLifecycleOpenMarker | undefined;
    let markerInfo: MarkerLifecycleFileInfo | undefined;
    let markerRemoved = false;
    let parentRemoved = false;
    let lifecycleFailure: MarkerLifecycleProbeError | undefined;
    try {
      // Revalidate the linked parent immediately before the first write. The
      // capability keeps later operations pinned even if the pathname changes.
      await this.#assertDirectoryIdentity(parent);
      markerHandle = await this.#fileOperation(() =>
        parent.handle.createMarker(MARKER_BASENAME, MARKER_CONTENT)
      );
      markerInfo = await this.#fileOperation(() => markerHandle!.inspect());
      validateLinkedMarker(markerInfo, markerInfo);
      await this.#assertDirectoryIdentity(parent);
      await this.#assertMarkerIdentity(parent, markerInfo);

      const content = await this.#fileOperation(() => markerHandle!.read());
      const inspectedInfo = await this.#fileOperation(() => markerHandle!.inspect());
      if (content !== MARKER_CONTENT) fail("filesystem_failure");
      validateLinkedMarker(markerInfo, inspectedInfo);
      await this.#assertDirectoryIdentity(parent);
      await this.#assertMarkerIdentity(parent, markerInfo);

      await this.#assertDirectoryIdentity(parent);
      const beforeRemoval = await this.#fileOperation(() => markerHandle!.inspect());
      validateLinkedMarker(markerInfo, beforeRemoval);
      await this.#assertMarkerIdentity(parent, markerInfo);
      await this.#fileOperation(() =>
        parent.handle.removeMarker(MARKER_BASENAME, markerInfo!)
      );
      if (
        await this.#fileOperation(() =>
          parent.handle.inspectOptional(MARKER_BASENAME)
        ) !== undefined
      ) {
        fail("filesystem_failure");
      }
      const unlinkedInfo = await this.#fileOperation(() => markerHandle!.inspect());
      validateUnlinkedMarker(markerInfo, unlinkedInfo);
      markerRemoved = true;
      await this.#assertDirectoryIdentity(parent);

      const remaining = await this.#fileOperation(() => parent.handle.list());
      if (remaining.length !== 0) fail("non_empty");
      await this.#assertDirectoryIdentity(parent);
      await this.#fileOperation(() =>
        parent.rootHandle.removeDirectory(parent.name, parent.info)
      );
      if (
        await this.#fileOperation(() =>
          parent.rootHandle.inspectOptional(parent.name)
        ) !== undefined
      ) {
        fail("filesystem_failure");
      }
      parentRemoved = true;
      const detachedParent = await this.#fileOperation(() => parent.handle.inspect());
      if (!sameInode(parent.info, detachedParent) || detachedParent.nlink !== 0) {
        fail("filesystem_failure");
      }
      this.#recordLifecycle(snapshot.binding);
    } catch (error) {
      await this.#cleanupFailedLifecycle({
        parent,
        markerInfo,
        markerRemoved,
        parentRemoved,
      });
      lifecycleFailure = normalizeFailure(error);
    }

    const closeFailure = await closeProviders([
      markerHandle,
      parent.handle,
      parent.rootHandle,
    ]);
    if (lifecycleFailure !== undefined) throw lifecycleFailure;
    if (closeFailure) fail("filesystem_failure");
  }

  async #validatedEmptyDirectory(
    directoryPath: string,
  ): Promise<ValidatedProbeDirectory> {
    const allowed = this.#allowedTemporaryDirectory;
    if (
      allowed === undefined ||
      this.#fileSystem === undefined ||
      !isAbsolute(allowed) ||
      !isAbsolute(directoryPath)
    ) {
      fail("invalid_path");
    }
    const normalizedAllowed = resolve(allowed);
    const normalizedDirectory = resolve(directoryPath);
    if (
      normalizedAllowed !== allowed ||
      normalizedDirectory !== directoryPath ||
      dirname(normalizedDirectory) !== normalizedAllowed ||
      !isContained(normalizedAllowed, normalizedDirectory)
    ) {
      fail("invalid_path");
    }

    let rootHandle: MarkerLifecycleOpenDirectory | undefined;
    let directoryHandle: MarkerLifecycleOpenDirectory | undefined;
    try {
      rootHandle = await this.#fileOperation(() =>
        this.#fileSystem!.openDirectory(normalizedAllowed)
      );
      const allowedInfo = await this.#fileOperation(() => rootHandle!.inspect());
      validateRootInfo(allowedInfo);
      const realAllowed = await this.#fileOperation(() =>
        rootHandle!.resolveRealPath()
      );
      if (realAllowed !== normalizedAllowed) fail("invalid_path");

      const name = basename(normalizedDirectory);
      const entryBeforeOpen = await this.#fileOperation(() =>
        rootHandle!.inspectOptional(name)
      );
      if (entryBeforeOpen === undefined) fail("filesystem_failure");
      validateParentInfo(entryBeforeOpen);
      directoryHandle = await this.#fileOperation(() =>
        rootHandle!.openDirectory(name)
      );
      const directoryInfo = await this.#fileOperation(() =>
        directoryHandle!.inspect()
      );
      validateParentInfo(directoryInfo);
      assertSameDirectoryEntry(entryBeforeOpen, directoryInfo);
      const linkedInfo = await this.#fileOperation(() =>
        rootHandle!.inspectOptional(name)
      );
      if (linkedInfo === undefined) fail("filesystem_failure");
      assertSameDirectoryEntry(directoryInfo, linkedInfo);
      const realDirectory = await this.#fileOperation(() =>
        directoryHandle!.resolveRealPath()
      );
      if (
        realDirectory !== normalizedDirectory ||
        dirname(realDirectory) !== realAllowed ||
        !isContained(realAllowed, realDirectory)
      ) {
        fail("invalid_path");
      }
      const entries = await this.#fileOperation(() => directoryHandle!.list());
      if (entries.length !== 0) fail("non_empty");
      return {
        name,
        info: directoryInfo,
        rootInfo: allowedInfo,
        handle: directoryHandle,
        rootHandle,
      };
    } catch (error) {
      await closeProviders([directoryHandle, rootHandle]);
      throw normalizeFailure(error);
    }
  }

  async #assertDirectoryIdentity(
    expected: ValidatedProbeDirectory,
  ): Promise<void> {
    const root = await this.#fileOperation(() => expected.rootHandle.inspect());
    validateRootInfo(root);
    assertSameDirectoryEntry(expected.rootInfo, root);
    const current = await this.#fileOperation(() => expected.handle.inspect());
    validateParentInfo(current);
    assertSameDirectoryEntry(expected.info, current);
    const linked = await this.#fileOperation(() =>
      expected.rootHandle.inspectOptional(expected.name)
    );
    if (linked === undefined) fail("filesystem_failure");
    assertSameDirectoryEntry(expected.info, linked);
  }

  async #assertMarkerIdentity(
    parent: ValidatedProbeDirectory,
    expected: MarkerLifecycleFileInfo,
  ): Promise<void> {
    const current = await this.#fileOperation(() =>
      parent.handle.inspectOptional(MARKER_BASENAME)
    );
    if (current === undefined) fail("filesystem_failure");
    if (current.isSymbolicLink()) fail("symlink");
    validateLinkedMarker(expected, current);
  }

  async #cleanupFailedLifecycle(state: {
    readonly parent: ValidatedProbeDirectory;
    readonly markerInfo: MarkerLifecycleFileInfo | undefined;
    readonly markerRemoved: boolean;
    readonly parentRemoved: boolean;
  }): Promise<void> {
    try {
      if (!state.markerRemoved && state.markerInfo !== undefined) {
        const current = await state.parent.handle.inspectOptional(MARKER_BASENAME);
        if (
          current !== undefined &&
          !current.isSymbolicLink() &&
          sameInode(state.markerInfo, current)
        ) {
          validateLinkedMarker(state.markerInfo, current);
          await state.parent.handle.removeMarker(
            MARKER_BASENAME,
            state.markerInfo,
          );
        }
      }
      if (!state.parentRemoved) {
        const currentParent = await state.parent.rootHandle.inspectOptional(
          state.parent.name,
        );
        if (
          currentParent !== undefined &&
          !currentParent.isSymbolicLink() &&
          sameInode(currentParent, state.parent.info) &&
          (await state.parent.handle.list()).length === 0
        ) {
          await state.parent.rootHandle.removeDirectory(
            state.parent.name,
            state.parent.info,
          );
        }
      }
    } catch {
      // Never widen cleanup to another inode and never expose the raw failure.
    }
  }

  async #fileOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeFailure(error);
    }
  }

  #recordLifecycle(binding: MarkerLifecycleBinding): void {
    const records = Object.freeze([
      "marker_created",
      "marker_inspected",
      "marker_removed",
      "parent_removed",
    ].map((event) => Object.freeze({
      event: event as MarkerLifecycleEvent,
      workerRef: opaqueRef("worker", binding.workerId),
      requestRef: opaqueRef("request", binding.requestId),
      turnRef: opaqueRef("turn", binding.turnId),
      sessionRef: opaqueRef("session", binding.sessionId),
      probeRef: opaqueRef("probe", binding.probeId),
    })));
    try {
      this.#audit(records);
    } catch {
      fail("filesystem_failure");
    }
  }
}

function snapshotProbeInput(
  input: MarkerLifecycleProbeInput,
): MarkerLifecycleProbeSnapshot {
  const binding = input.binding;
  const snapshotBinding = Object.freeze({
    workerId: binding.workerId,
    requestId: binding.requestId,
    turnId: binding.turnId,
    sessionId: binding.sessionId,
    probeId: binding.probeId,
  });
  return Object.freeze({
    binding: snapshotBinding,
    receiptId: input.receiptId,
    directoryPath: input.directoryPath,
  });
}

function validateBinding(binding: MarkerLifecycleBinding): void {
  validateIdentity(binding.workerId);
  validateIdentity(binding.requestId);
  validateIdentity(binding.turnId);
  validateIdentity(binding.sessionId);
  validateIdentity(binding.probeId);
}

function sameBinding(
  left: MarkerLifecycleBinding,
  right: MarkerLifecycleBinding,
): boolean {
  return left.workerId === right.workerId &&
    left.requestId === right.requestId &&
    left.turnId === right.turnId &&
    left.sessionId === right.sessionId &&
    left.probeId === right.probeId;
}

function validateRootInfo(info: MarkerLifecycleFileInfo): void {
  const processUid = process.getuid?.();
  if (info.isSymbolicLink()) fail("symlink");
  if (
    !info.isDirectory() ||
    ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) ||
    (processUid !== undefined && info.uid !== 0 && info.uid !== processUid)
  ) {
    fail("invalid_path");
  }
}

function validateParentInfo(info: MarkerLifecycleFileInfo): void {
  const processUid = process.getuid?.();
  if (info.isSymbolicLink()) fail("symlink");
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (processUid !== undefined && info.uid !== processUid)
  ) {
    fail("invalid_path");
  }
}

function assertSameDirectoryEntry(
  expected: MarkerLifecycleFileInfo,
  current: MarkerLifecycleFileInfo,
): void {
  if (current.isSymbolicLink()) fail("symlink");
  if (!current.isDirectory() || !sameDirectoryIdentity(expected, current)) {
    fail("filesystem_failure");
  }
}

function sameDirectoryIdentity(
  left: MarkerLifecycleFileInfo,
  right: MarkerLifecycleFileInfo,
): boolean {
  return sameInode(left, right) &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.isDirectory() === right.isDirectory() &&
    left.isFile() === right.isFile() &&
    left.isSymbolicLink() === right.isSymbolicLink();
}

async function closeProviders(
  providers: readonly (
    | MarkerLifecycleOpenDirectory
    | MarkerLifecycleOpenMarker
    | undefined
  )[],
): Promise<boolean> {
  let failed = false;
  for (const provider of providers) {
    if (provider === undefined) continue;
    try {
      await provider.close();
    } catch {
      failed = true;
    }
  }
  return failed;
}

function validateMarkerShape(
  info: MarkerLifecycleFileInfo,
  expectedLinkCount: 0 | 1,
): void {
  const processUid = process.getuid?.();
  if (info.isSymbolicLink()) fail("symlink");
  if (
    !info.isFile() ||
    info.size !== Buffer.byteLength(MARKER_CONTENT) ||
    (info.mode & 0o777) !== 0o600 ||
    (processUid !== undefined && info.uid !== processUid) ||
    info.nlink !== expectedLinkCount
  ) {
    fail("filesystem_failure");
  }
}

function validateLinkedMarker(
  expected: MarkerLifecycleFileInfo,
  current: MarkerLifecycleFileInfo,
): void {
  validateMarkerShape(current, 1);
  if (!sameMarkerIdentity(expected, current)) fail("filesystem_failure");
}

function validateUnlinkedMarker(
  expected: MarkerLifecycleFileInfo,
  current: MarkerLifecycleFileInfo,
): void {
  validateMarkerShape(current, 0);
  if (!sameMarkerIdentity(expected, current)) fail("filesystem_failure");
}

function sameInode(
  left: MarkerLifecycleFileInfo,
  right: MarkerLifecycleFileInfo,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMarkerIdentity(
  left: MarkerLifecycleFileInfo,
  right: MarkerLifecycleFileInfo,
): boolean {
  return sameInode(left, right) &&
    left.size === right.size &&
    left.uid === right.uid;
}

function validateIdentity(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_IDENTITY_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("invalid_binding");
  }
}

function isContained(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
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

function fail(code: MarkerLifecycleProbeFailureCode): never {
  throw new MarkerLifecycleProbeError(code);
}

function normalizeFailure(error: unknown): MarkerLifecycleProbeError {
  const code = error instanceof MarkerLifecycleProbeError
    ? normalizeFailureCode(error.code)
    : "filesystem_failure";
  return new MarkerLifecycleProbeError(code);
}

function normalizeFailureCode(
  code: unknown,
): MarkerLifecycleProbeFailureCode {
  return typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, code)
    ? code as MarkerLifecycleProbeFailureCode
    : "filesystem_failure";
}
