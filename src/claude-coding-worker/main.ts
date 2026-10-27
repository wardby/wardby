#!/usr/bin/env node
import { readCodingInput, writeCodingOutputAtomic } from "../coding-worker/artifact.js";
import { describeError, workerDebugTracer, type DebugTracer } from "../coding-worker/debug-trace.js";
import { safeOutputIssues, safeWorkerErrorCode } from "../coding-worker/errors.js";
import type { CodingTaskInput } from "../coding/protocol.js";
import { CLAUDE_CONFIG_DIR, runClaudeCodingWorker } from "./driver.js";
import { createClaudeSdkQuery } from "./sdk.js";
import { assertToolRunnerReachable, callPrepareDependencies } from "./tool-socket.js";
import { TRANSCRIPT_OUTPUT_PATH, writeWorkerTranscript } from "./transcript.js";

const INPUT_PATH = "/run/wardby/input/input.json";
const OUTPUT_PATH = "/run/wardby/output/result.json";

function required(name: "WARDBY_PROXY_URL" | "WARDBY_RUN_CAPABILITY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => controller.abort());

let stage: "input" | "execution" | "output" = "input";
// Only for a run the operator asked to trace; see coding-worker/debug-trace.ts. Pod log only.
let trace: DebugTracer | undefined;
let input: CodingTaskInput | undefined;
let sessionId: string | undefined;
try {
  const task = await readCodingInput(INPUT_PATH);
  input = task;
  stage = "execution";
  const proxyBaseUrl = required("WARDBY_PROXY_URL");
  const capability = required("WARDBY_RUN_CAPABILITY");
  trace = workerDebugTracer(task, capability, (line) => process.stdout.write(line));
  await assertToolRunnerReachable();
  const output = await runClaudeCodingWorker({
    input: task,
    proxyBaseUrl,
    capability,
    signal: controller.signal,
    createQuery: createClaudeSdkQuery,
    prepareDependencies: () => callPrepareDependencies({ signal: controller.signal, deadlineAt: task.deadlineAt }),
    onProgress: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    trace,
    onSessionId: (id) => {
      sessionId ??= id;
    },
  });
  stage = "output";
  await writeCodingOutputAtomic(OUTPUT_PATH, output);
} catch (error) {
  trace?.record("worker_error", { stage, error: describeError(error) });
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
// Session resume: after the result (or failure) is written, so a capture problem never changes the
// run's outcome or exit code. Not on cancellation: the pod is being stopped.
if (input?.sessionResume && sessionId && !controller.signal.aborted) {
  await writeWorkerTranscript({
    configDir: CLAUDE_CONFIG_DIR,
    sessionId,
    outputPath: TRANSCRIPT_OUTPUT_PATH,
  }).catch(() => {
    process.stderr.write(`${JSON.stringify({ warning: "transcript_capture_failed" })}\n`);
  });
}
