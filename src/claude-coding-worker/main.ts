#!/usr/bin/env node
import { readCodingInput, writeCodingOutputAtomic, writePlanFilesOutputAtomic } from "../coding-worker/artifact.js";
import { describeError, workerDebugTracer, type DebugTracer } from "../coding-worker/debug-trace.js";
import { safeOutputIssues, safeWorkerErrorCode } from "../coding-worker/errors.js";
import { readMcpConfig } from "../coding-worker/mcp-config.js";
import { PLAN_FILES_ARTIFACT, type CodingTaskInput } from "../coding/protocol.js";
import { collectPlanOutput } from "../coding-worker/plan-output.js";
import { CLAUDE_CONFIG_DIR, runClaudeCodingWorker } from "./driver.js";
import { createClaudeSdkQuery } from "./sdk.js";
import { ProxyJoinChannel } from "./join.js";
import { collectPlanFilesViaToolRunner } from "./plan-files.js";
import {
  assertToolRunnerReachable,
  callGitCheck,
  callPlanPlace,
  callPrepareDependencies,
  callRestorePypiLockfiles,
  callResultBundle,
  openPlanSession,
} from "./tool-socket.js";
import { runTitle, TRANSCRIPT_OUTPUT_PATH, writeWorkerTranscript } from "./transcript.js";

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
  // Set only when the run has MCP tools; the driver then adds the wardby_mcp server. On Substrate it
  // is the gateway's placeholder, in header mode (readMcpConfig refuses anything else).
  const mcp = readMcpConfig();
  trace = workerDebugTracer(task, capability, (line) => process.stdout.write(line), mcp ? [mcp.token] : []);
  await assertToolRunnerReachable();
  const output = await runClaudeCodingWorker({
    input: task,
    proxyBaseUrl,
    capability,
    ...(mcp ? { mcpToken: mcp.token } : {}),
    ...(mcp?.header ? { mcpTokenHeader: mcp.header } : {}),
    signal: controller.signal,
    createQuery: createClaudeSdkQuery,
    // Join (phase 1): joined messages, long-polled from the proxy for the whole run.
    join: new ProxyJoinChannel({ proxyBaseUrl, capability, deadlineAt: task.deadlineAt }),
    prepareDependencies: () => callPrepareDependencies({ signal: controller.signal, deadlineAt: task.deadlineAt }),
    restorePypiLockfiles: () => callRestorePypiLockfiles({ signal: controller.signal }),
    // A run with git history (#536): the tool runner has the workspace and git; this container has neither.
    gitCheck: () => callGitCheck({ signal: controller.signal }),
    placePlanFile: (file) => callPlanPlace(file, { signal: controller.signal }),
    resultBundle: (repository, timeoutMs) => callResultBundle(repository, { signal: controller.signal, timeoutMs }),
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
    title: runTitle(input.runId, input.task),
  }).catch(() => {
    process.stderr.write(`${JSON.stringify({ warning: "transcript_capture_failed" })}\n`);
  });
}
// Plan files: after result.json (as the Codex worker), so a capture problem never changes the run's
// outcome. Not on cancellation. Only fixed codes are ever written.
if (input && !controller.signal.aborted) {
  const session = await openPlanSession().catch(() => undefined);
  try {
    let listError: string | undefined;
    const listed = session
      ? await session.list().catch((error: unknown) => {
          listError = error instanceof Error ? error.message : "plan_tool_failed";
          return undefined;
        })
      : undefined;
    const unavailable = listError === "plan_tool_unavailable";
    const hasEntries = (listed as { paths?: unknown[] } | undefined)?.paths?.length;
    if (input.planFiles || hasEntries || unavailable || (listed as { ok?: boolean } | undefined)?.ok === false) {
      const plan = await collectPlanOutput(input.runId, () =>
        session && !unavailable
          ? collectPlanFilesViaToolRunner({
              list: async () => {
                if (listError) throw new Error(listError);
                return listed;
              },
              read: (path) => session.read(path),
            })
          : Promise.resolve({ status: "error" as const, error: "plan_tool_unavailable" as const }),
      );
      await writePlanFilesOutputAtomic(`/run/wardby/output/${PLAN_FILES_ARTIFACT}`, plan).catch(() => {
        process.stderr.write(`${JSON.stringify({ warning: "plan_files_capture_failed" })}\n`);
      });
    }
  } finally {
    session?.close();
  }
}
