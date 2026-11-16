#!/usr/bin/env node
import { PLAN_FILES_ARTIFACT, PLAN_FOLDER_PATH, type CodingTaskInput } from "../coding/protocol.js";
import { readCodingInput, writeCodingOutputAtomic, writePlanFilesOutputAtomic } from "./artifact.js";
import { readWorkerCredentials } from "./credentials.js";
import { describeError, workerTracerFor, type DebugTracer } from "./debug-trace.js";
import { runCodingWorker } from "./driver.js";
import { safeOutputIssues, safeWorkerErrorCode } from "./errors.js";
import { readMcpConfig } from "./mcp-config.js";
import { collectPlanFolder } from "./plan-folder.mjs";
import { capturePlanFiles } from "./plan-output.js";
import { createCodexSdkClient } from "./sdk.js";

const INPUT_PATH = "/run/wardby/input/input.json";
const OUTPUT_PATH = "/run/wardby/output/result.json";
const WORKSPACE_PATH = "/workspace";
/** Where the extra repositories are mounted; a run with git history bundles each one there (#536). */
const REPOS_PATH = "/repos";

function required(name: "WARDBY_PROXY_URL"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => controller.abort());

let stage: "input" | "execution" | "output" = "input";
// Only for a run the operator asked to trace; see debug-trace.ts. Pod log only.
let trace: DebugTracer | undefined;
let input: CodingTaskInput | undefined;
try {
  input = await readCodingInput(INPUT_PATH);
  stage = "execution";
  const proxyBaseUrl = required("WARDBY_PROXY_URL");
  // WARDBY_RUN_CAPABILITY, plus on Substrate the header mode and the registry token (credentials.ts).
  const credentials = readWorkerCredentials(process.env);
  const { capability, capabilityHeader, registryToken } = credentials;
  // Set only when the run has MCP tools; the driver then adds the wardby_mcp server. On Substrate it
  // is the gateway's placeholder, in header mode (readMcpConfig refuses anything else).
  const mcp = readMcpConfig();
  trace = workerTracerFor(input, credentials, mcp?.token, (line) => process.stdout.write(line));
  const output = await runCodingWorker({
    input,
    workspace: WORKSPACE_PATH,
    reposRoot: REPOS_PATH,
    proxyBaseUrl,
    capability,
    ...(mcp ? { mcpToken: mcp.token } : {}),
    ...(mcp?.header ? { mcpTokenHeader: mcp.header } : {}),
    ...(registryToken ? { registryToken } : {}),
    ...(capabilityHeader ? { capabilityHeader } : {}),
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

// Plan files: after the result (or failure), so a capture problem never changes the run's outcome.
// Not on cancellation. Never logged: only a fixed warning code.
await capturePlanFiles({
  input,
  aborted: controller.signal.aborted,
  root: PLAN_FOLDER_PATH,
  collect: () => collectPlanFolder(PLAN_FOLDER_PATH),
  write: (plan) => writePlanFilesOutputAtomic(`/run/wardby/output/${PLAN_FILES_ARTIFACT}`, plan),
  warn: () => process.stderr.write(`${JSON.stringify({ warning: "plan_files_capture_failed" })}\n`),
});
