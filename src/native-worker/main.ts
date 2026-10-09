/**
 * Native sandbox worker process entry. Reads its WorkerInput as the first line
 * on stdin, runs the run's engine against the gateway on stdin/stdout
 * (stdio.ts), and exits 0 once it has sent its result. stdout carries only
 * protocol frames; diagnostics (and the shared logger) go to stderr.
 */

import { readFile, stat } from "node:fs/promises";
import { parseMessage, WorkerInputSchema } from "./protocol.js";
import { createHttpTransport } from "./http-transport.js";
import { createStdioTransport } from "./stdio.js";
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
  const input = parseMessage(await readInput(), WorkerInputSchema);
  // The gateway answers only after the worker asks, so choosing the transport after the input
  // line misses nothing.
  const transport = input.gateway
    ? createHttpTransport({ url: input.gateway.url, capability: input.gateway.capability })
    : createStdioTransport(process.stdin, process.stdout);
  await runNativeWorker(input, transport);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    if (err instanceof UnclaimedError) {
      process.stderr.write(`native sandbox worker: ${err.message}\n`);
      process.exit(WARM_WORKER_UNCLAIMED_EXIT);
    }
    process.stderr.write(`native sandbox worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
