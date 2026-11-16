/**
 * Native sandbox worker process entry. The run's WorkerInput comes from one of three sources: the
 * first line on stdin (Docker, local), a file named by NATIVE_WORKER_INPUT_FILE (a Kubernetes pod,
 * or a warm worker that waits for it), or, in substrate mode (WARDBY_NATIVE_SUBSTRATE=1,
 * substrate-mode.ts), the gateway's input route once the actor's name appears. It runs the run's
 * engine against the gateway (on stdin/stdout, stdio.ts, or over HTTP) and exits 0 once it has sent
 * its result; in substrate mode it idles instead, with /readyz still answering. stdout carries only
 * protocol frames; diagnostics (and the shared logger) go to stderr, without any secret value the
 * worker received (stderr-redaction.ts).
 */

import { readFile, stat } from "node:fs/promises";
import { parseMessage, WorkerInputSchema } from "./protocol.js";
import { createHttpTransport } from "./http-transport.js";
import { createStdioTransport } from "./stdio.js";
import { flushStderrRedaction, installStderrRedaction, rememberSecretValue } from "./stderr-redaction.js";
import { NATIVE_SUBSTRATE_ENV, runSubstrateMode } from "./substrate-mode.js";
import { WARM_WORKER_UNCLAIMED_EXIT } from "./warm-delivery.js";
import { runNativeWorker } from "./worker.js";

function firstLine(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        process.stdin.off("data", onData);
        resolve(buffer.slice(0, newline));
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => reject(new Error("stdin closed before the worker input arrived")));
  });
}

class UnclaimedError extends Error {}

/**
 * A warm pool worker (NATIVE_WORKER_INPUT_WAIT_MS set) starts before any run exists: it waits for
 * its input file, delivered after a run claims it (warm-delivery.ts), and gives up after the wait.
 */
async function waitForFile(file: string, waitMs: number): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (
      await stat(file).then(
        () => true,
        () => false,
      )
    )
      return;
    if (Date.now() >= until) throw new UnclaimedError("no run claimed this warm worker in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The input's source: a file when NATIVE_WORKER_INPUT_FILE names one (a Kubernetes pod mounts it
 * read-only from the run's Secret; a warm worker waits for it), otherwise the first line on stdin
 * (Docker, local).
 */
async function readInput(): Promise<string> {
  const file = process.env.NATIVE_WORKER_INPUT_FILE;
  if (!file) return firstLine();
  const waitMs = Number(process.env.NATIVE_WORKER_INPUT_WAIT_MS ?? "");
  if (Number.isFinite(waitMs) && waitMs > 0) await waitForFile(file, waitMs);
  return (await readFile(file, "utf8")).trim();
}

async function main(): Promise<void> {
  if (process.env[NATIVE_SUBSTRATE_ENV] === "1") {
    await runSubstrateMode({ env: process.env });
    // After its result the actor stays up until the launcher deletes it: idle, /readyz still answering.
    await new Promise<never>(() => {});
  }
  const input = parseMessage(await readInput(), WorkerInputSchema);
  if (input.gateway) rememberSecretValue(input.gateway.capability);
  // The gateway answers only after the worker asks, so choosing the transport after the input
  // line misses nothing.
  const transport = input.gateway
    ? createHttpTransport({ url: input.gateway.url, capability: input.gateway.capability })
    : createStdioTransport(process.stdin, process.stdout);
  await runNativeWorker(input, transport);
}

const fail = (err: unknown): never => {
  // Anything still buffered for its line's end goes out first, so the failure line stands alone.
  flushStderrRedaction();
  if (err instanceof UnclaimedError) {
    process.stderr.write(`native sandbox worker: ${err.message}\n`);
    process.exit(WARM_WORKER_UNCLAIMED_EXIT);
  }
  process.stderr.write(`native sandbox worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
};

installStderrRedaction();
// Node's own report of an uncaught error would bypass the redaction: fail the same way instead.
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
main().then(() => process.exit(0), fail);
