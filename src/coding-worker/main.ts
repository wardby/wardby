#!/usr/bin/env node
import { readCodingInput, writeCodingOutputAtomic } from "./artifact.js";
import { runCodingWorker } from "./driver.js";
import { safeOutputIssues, safeWorkerErrorCode } from "./errors.js";
import { createCodexSdkClient } from "./sdk.js";

const INPUT_PATH = "/run/wardby/input/input.json";
const OUTPUT_PATH = "/run/wardby/output/result.json";
const WORKSPACE_PATH = "/workspace";

function required(name: "WARDBY_PROXY_URL" | "WARDBY_RUN_CAPABILITY"): string {
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
  const output = await runCodingWorker({
    input,
    workspace: WORKSPACE_PATH,
    proxyBaseUrl: required("WARDBY_PROXY_URL"),
    capability: required("WARDBY_RUN_CAPABILITY"),
    signal: controller.signal,
    createClient: createCodexSdkClient,
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
  const issues = code === "coding_output_invalid" ? safeOutputIssues(error) : undefined;
  process.stderr.write(`${JSON.stringify({ error: code, ...(issues ? { issues } : {}) })}\n`);
  process.exitCode = controller.signal.aborted ? 143 : 1;
}
