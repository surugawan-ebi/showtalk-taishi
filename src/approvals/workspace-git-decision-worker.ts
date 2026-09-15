import { pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerConfiguration {
  readonly modulePath: string;
  readonly stateRoot: string;
}

interface ManualBroker {
  readonly contract_version: 1;
  recordHumanDecision(input: unknown): Promise<{
    readonly version: 1;
    readonly status: "approved" | "rejected";
    readonly disposition: "transitioned" | "already_recorded_same_delivery";
  }>;
}

interface ManualComposition {
  readonly contract_version: 1;
  readonly human_decision_broker_factory: {
    readonly contract_version: 1;
    create(): ManualBroker | Promise<ManualBroker>;
  };
  close(): Promise<void>;
}

interface ManualModule {
  createWorkspaceGitManualCompositionFromStateRoot(input: {
    readonly stateRoot: string;
  }):
    | ManualComposition
    | Promise<ManualComposition>;
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
if (port === null) throw new Error("Manual decision worker has no parent port");
const configuration = workerData as WorkerConfiguration;
const loaded = await import(pathToFileURL(configuration.modulePath).href) as
  Partial<ManualModule>;
if (typeof loaded.createWorkspaceGitManualCompositionFromStateRoot !== "function") {
  throw new Error("Manual workspace-git module has no supported composition factory");
}
const composition = await loaded.createWorkspaceGitManualCompositionFromStateRoot({
  stateRoot: configuration.stateRoot,
});
assertManualComposition(composition);
const broker = await composition.human_decision_broker_factory.create();
if (broker?.contract_version !== 1 || typeof broker.recordHumanDecision !== "function") {
  throw new Error("Manual workspace-git module returned an invalid broker");
}

port.postMessage({ type: "ready" });
port.on("message", (message: unknown) => {
  const record = asRecord(message);
  if (
    record?.type !== "manual_human_decision_v1" ||
    !Number.isSafeInteger(record.requestId)
  ) return;
  const requestId = record.requestId as number;
  void broker.recordHumanDecision(record.input).then(
    (result) => {
      port.postMessage({
        type: "result",
        requestId,
        ok: result.version === 1,
        status: result.status,
        disposition: result.disposition,
      });
    },
    (error: unknown) => {
      port.postMessage({
        type: "result",
        requestId,
        ok: false,
        errorCode: safeErrorCode(error),
      });
    },
  );
});

function assertManualComposition(value: unknown): asserts value is ManualComposition {
  const record = asRecord(value);
  const factory = asRecord(record?.human_decision_broker_factory);
  if (
    record?.contract_version !== 1 ||
    Object.keys(record).sort().join(",") !==
      "close,contract_version,human_decision_broker_factory" ||
    factory?.contract_version !== 1 ||
    typeof factory.create !== "function" ||
    typeof record.close !== "function"
  ) {
    throw new Error("Manual workspace-git composition is invalid");
  }
}

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
