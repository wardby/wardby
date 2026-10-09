/**
 * Starting a sandbox-mode run against the HTTP gateway (native sandbox phase 3):
 * create its gateway session, launch a worker with the session's one-time
 * capability on its stdin, and return. Nothing waits on the worker — whichever
 * gateway replica serves its `finish` makes the terminal write. Phase 4's
 * executors launch the worker in a container or pod; `processWorkerLauncher`
 * runs it as a local child process.
 */

import { spawn } from "node:child_process";
import { createSandboxSession, type NativeRunProviders, type RunnerDb } from "../core/runner.js";
import type { Run } from "#prisma";
import { PrismaGatewayLedger } from "./ledger.js";
import type { WorkerInput } from "./protocol.js";
import type { WorkerProcessSpec } from "./stdio.js";

export interface WorkerHandle {
  /** Resolves with the worker's exit code (null when it was killed or never started). */
  exited: Promise<number | null>;
  kill(): void;
}

/** Starts a worker for an HTTP-gateway input and returns at once. */
export interface DetachedWorkerLauncher {
  launch(input: WorkerInput): Promise<WorkerHandle>;
  /**
   * False when the worker's network isolation only takes effect after it starts (a Kubernetes
   * NetworkPolicy): its session is then created not ready, and the launcher marks it ready once
   * proven. Absent or true: ready at creation (Docker's network exists before the container).
   */
  readonly networkReadyAtLaunch?: boolean;
}

/** The worker as a local child process with an empty environment (by default), its input on stdin. */
export function processWorkerLauncher(spec: WorkerProcessSpec): DetachedWorkerLauncher {
  return {
    async launch(input) {
      const child = spawn(spec.command, spec.args, {
        env: spec.env ?? {},
        cwd: spec.cwd,
        stdio: ["pipe", "ignore", "inherit"],
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on("error", () => resolve(null));
        child.on("exit", (code) => resolve(code));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(`${JSON.stringify(input)}\n`);
      return { exited, kill: () => child.kill("SIGKILL") };
    },
  };
}

export type StartSandboxRunOutcome =
  { kind: "launched"; sessionId: string; handle: WorkerHandle } | { kind: "ended"; run: Run };

export async function startSandboxRun(options: {
  runId: string;
  providers: NativeRunProviders;
  db: RunnerDb & ConstructorParameters<typeof PrismaGatewayLedger>[0];
  gatewayUrl: string;
  launcher: DetachedWorkerLauncher;
}): Promise<StartSandboxRunOutcome> {
  const session = await createSandboxSession({
    runId: options.runId,
    providers: options.providers,
    db: options.db,
    ledger: new PrismaGatewayLedger(options.db),
    gatewayUrl: options.gatewayUrl,
    networkReady: options.launcher.networkReadyAtLaunch !== false,
  });
  if (session.kind === "ended") return session;
  const handle = await options.launcher.launch(session.input);
  return { kind: "launched", sessionId: session.sessionId, handle };
}
