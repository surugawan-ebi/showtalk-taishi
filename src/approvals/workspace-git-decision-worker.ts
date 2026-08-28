import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerConfiguration {
  readonly modulePath: string;
  readonly stateRoot: string;
}

interface PrivateBroker {
  recordDecision(input: unknown): Promise<{
    readonly status: string;
    readonly disposition: "transitioned" | "already_recorded_same_delivery";
  }>;
  inspectDecision(input: unknown): Promise<{
    readonly status: string;
    readonly disposition: "recorded" | "pending";
  }>;
}

interface PrivateBrokerModule {
  createPrivateWorkspaceGitApprovalBroker(options: {
    readonly stateRoot: string;
  }): Promise<PrivateBroker>;
}

const SAFE_ERROR_CODES = new Set([
  "invalid_decision",
  "operation_not_found",
  "plan_mismatch",
  "decision_replay",
  "status_conflict",
  "expired",
]);

const port = parentPort;
if (port === null) throw new Error("Private approval worker has no parent port");
const configuration = workerData as WorkerConfiguration;
const loaded = await import(pathToFileURL(configuration.modulePath).href) as
  Partial<PrivateBrokerModule>;
if (typeof loaded.createPrivateWorkspaceGitApprovalBroker !== "function") {
  throw new Error("Private approval module has no supported broker factory");
}
const broker = await loaded.createPrivateWorkspaceGitApprovalBroker({
  stateRoot: configuration.stateRoot,
});
if (
  broker === null ||
  typeof broker.recordDecision !== "function" ||
  typeof broker.inspectDecision !== "function"
) {
  throw new Error("Private approval module returned an invalid broker");
}
port.postMessage({ type: "ready" });
port.on("message", (message: unknown) => {
  const record = asRecord(message);
  if (
    (record?.type !== "decision" && record?.type !== "inspect") ||
    !Number.isSafeInteger(record.requestId)
  ) return;
  const requestId = record.requestId as number;
  const operation = record.type === "decision"
    ? broker.recordDecision(record.input)
    : broker.inspectDecision(record.input);
  void operation.then(
    (result) => {
      port.postMessage({
        type: "result",
        requestId,
        ok: true,
        status: result.status,
        disposition: result.disposition,
      });
    },
    (error: unknown) => {
      // Never copy local paths, operation IDs, or state details across the
      // worker boundary. Only a bounded, non-secret classification crosses.
      port.postMessage({
        type: "result",
        requestId,
        ok: false,
        errorCode: safeErrorCode(error),
      });
    },
  );
});

function safeErrorCode(error: unknown): string {
  const code = asRecord(error)?.code;
  return typeof code === "string" && SAFE_ERROR_CODES.has(code)
    ? code
    : "state_write_failed";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
