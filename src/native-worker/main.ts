/**
 * Native sandbox worker process entry. Reads its WorkerInput as the first line
 * on stdin, runs the run's engine against the gateway on stdin/stdout
 * (stdio.ts), and exits 0 once it has sent its result. stdout carries only
 * protocol frames; diagnostics (and the shared logger) go to stderr.
 */

import { readFile } from "node:fs/promises";
import { parseMessage, WorkerInputSchema } from "./protocol.js";
import { createHttpTransport } from "./http-transport.js";
import { createStdioTransport } from "./stdio.js";
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

/**
 * The input's source: a mounted file when NATIVE_WORKER_INPUT_FILE names one (a Kubernetes pod
 * mounts it read-only from the run's Secret), otherwise the first line on stdin (Docker, local).
 */
async function readInput(): Promise<string> {
  const file = process.env.NATIVE_WORKER_INPUT_FILE;
  return file ? (await readFile(file, "utf8")).trim() : firstLine();
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
    process.stderr.write(`native sandbox worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
