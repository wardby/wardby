#!/usr/bin/env node
import { readCodingInput, writeCodingOutputAtomic } from "../coding-worker/artifact.js";
import { safeWorkerErrorCode } from "../coding-worker/errors.js";
import { runClaudeCodingWorker } from "./driver.js";
import { createClaudeSdkQuery } from "./sdk.js";

const INPUT_PATH = "/run/reevo/input/input.json";
const OUTPUT_PATH = "/run/reevo/output/result.json";

function required(name: "REEVO_PROXY_URL" | "REEVO_RUN_CAPABILITY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => controller.abort());

let stage: "input" | "execution" | "output" = "input";
try {
  const input = await readCodingInput(INPUT_PATH);
  stage = "execution";
  const output = await runClaudeCodingWorker({
    input,
    proxyBaseUrl: required("REEVO_PROXY_URL"),
    capability: required("REEVO_RUN_CAPABILITY"),
    signal: controller.signal,
    createQuery: createClaudeSdkQuery,
    onProgress: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  stage = "output";
  await writeCodingOutputAtomic(OUTPUT_PATH, output);
} catch (error) {
  const safeCode = safeWorkerErrorCode(error);
  const code = controller.signal.aborted
    ? "worker_cancelled"
    : safeCode === "worker_failed"
      ? `worker_${stage}_failed`
      : safeCode;
  process.stderr.write(`${JSON.stringify({ error: code })}\n`);
  process.exitCode = controller.signal.aborted ? 143 : 1;
}
