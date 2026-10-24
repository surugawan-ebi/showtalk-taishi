import { spawn, type ChildProcess } from "node:child_process";

export const GATEWAY_WORKER_ENV_VAR = "SHOWTALK_TAISHI_GATEWAY_WORKER";
export const GATEWAY_RESTART_EXIT_CODE = 75;

export interface GatewaySupervisorOptions {
  readonly spawnWorker?: () => ChildProcess;
  readonly processRef?: Pick<
    NodeJS.Process,
    "on" | "off" | "execPath" | "execArgv" | "argv" | "env"
  >;
  readonly onRestart?: () => void;
  /** Fixture seam; production holds the failed stop without allowing launchd to respawn it. */
  readonly holdAfterStopFailure?: (error: Error) => Promise<never>;
}

interface WorkerExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Keeps a small parent process alive while Gateway workers come and go.
 * A worker exit code of 75 is the only path that starts a replacement; normal
 * and unexpected exits never become an unbounded crash loop.
 */
export async function superviseGatewayWorker(
  options: GatewaySupervisorOptions = {},
): Promise<void> {
  const processRef = options.processRef ?? process;
  const spawnWorker = options.spawnWorker ?? (() => spawnCurrentWorker(processRef));
  let child: ChildProcess | undefined;
  let stopping = false;
  let stopSignalFailure: Error | undefined;

  const requestStop = () => {
    if (stopping) return;
    stopping = true;
    try {
      if (child !== undefined && !child.kill("SIGTERM")) {
        stopSignalFailure = new Error("Gateway worker did not accept the graceful stop signal");
      }
    } catch (error) {
      stopSignalFailure = new Error("Gateway worker graceful stop signal failed", { cause: error });
    }
    if (stopSignalFailure !== undefined) console.error(stopSignalFailure.message);
  };
  processRef.on("SIGINT", requestStop);
  processRef.on("SIGTERM", requestStop);

  try {
    while (!stopping) {
      child = spawnWorker();
      let exited: WorkerExit;
      try {
        exited = await waitForWorkerExit(child);
      } catch (error) {
        if (!stopping) throw error;
        return await (options.holdAfterStopFailure ?? holdFailedStop)(
          new Error("Gateway stop could not confirm worker termination", { cause: error }),
        );
      }
      child = undefined;
      if (stopping) {
        if (stopSignalFailure !== undefined) {
          return await (options.holdAfterStopFailure ?? holdFailedStop)(stopSignalFailure);
        }
        if (exited.signal === null &&
            (exited.code === 0 || exited.code === GATEWAY_RESTART_EXIT_CODE)) return;
        return await (options.holdAfterStopFailure ?? holdFailedStop)(
          new Error(`Gateway stop failed: worker exit=${String(exited.code)}, signal=${String(exited.signal)}`),
        );
      }
      if (exited.signal !== null) {
        throw new Error(`Gateway worker stopped by ${exited.signal}`);
      }
      if (exited.code === GATEWAY_RESTART_EXIT_CODE) {
        options.onRestart?.();
        continue;
      }
      if (exited.code === 0) return;
      throw new Error(
        `Gateway worker exited unexpectedly with code ${String(exited.code)}`,
      );
    }
  } finally {
    processRef.off("SIGINT", requestStop);
    processRef.off("SIGTERM", requestStop);
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

async function holdFailedStop(error: Error): Promise<never> {
  const report = () => console.error(
    `${error.message}; Supervisor remains stopped from replacement; maintenance stop is NOT confirmed.`,
  );
  report();
  // Keep the registered Supervisor alive: a nonzero exit would let launchd's
  // SuccessfulExit=false policy start a new worker. No retry or force follows.
  return new Promise<never>(() => { setInterval(report, 30_000); });
}

export function isGatewayWorker(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[GATEWAY_WORKER_ENV_VAR] === "1";
}

function spawnCurrentWorker(
  processRef: Pick<NodeJS.Process, "execPath" | "execArgv" | "argv" | "env">,
): ChildProcess {
  const entrypoint = processRef.argv[1];
  if (entrypoint === undefined) {
    throw new Error("Cannot determine the ShowTalk Taishi CLI entrypoint");
  }
  return spawn(
    processRef.execPath,
    [...processRef.execArgv, entrypoint, ...processRef.argv.slice(2)],
    {
      env: { ...processRef.env, [GATEWAY_WORKER_ENV_VAR]: "1" },
      stdio: "inherit",
    },
  );
}

function waitForWorkerExit(child: ChildProcess): Promise<WorkerExit> {
  return new Promise<WorkerExit>((resolve, reject) => {
    const onError = (error: Error) => {
      child.off("exit", onExit);
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      child.off("error", onError);
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
