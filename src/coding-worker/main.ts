#!/usr/bin/env node
import { readCodingInput, writeCodingOutputAtomic } from "./artifact.js";
import { describeError, workerDebugTracer, type DebugTracer } from "./debug-trace.js";
import { runCodingWorker } from "./driver.js";
import { safeOutputIssues, safeWorkerErrorCode } from "./errors.js";
import { readMcpToken } from "./mcp-config.js";
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
// Only for a run the operator asked to trace; see debug-trace.ts. Pod log only.
let trace: DebugTracer | undefined;
try {
  const input = await readCodingInput(INPUT_PATH);
  stage = "execution";
  const proxyBaseUrl = required("WARDBY_PROXY_URL");
  const capability = required("WARDBY_RUN_CAPABILITY");
  // Set only when the run has MCP tools; the driver then adds the wardby_mcp server.
  const mcpToken = readMcpToken();
  trace = workerDebugTracer(input, capability, (line) => process.stdout.write(line), mcpToken ? [mcpToken] : []);
  const output = await runCodingWorker({
    input,
    workspace: WORKSPACE_PATH,
    proxyBaseUrl,
    capability,
    ...(mcpToken ? { mcpToken } : {}),
    signal: controller.signal,
    createClient: createCodexSdkClient,
    onProgress: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
    trace,
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
