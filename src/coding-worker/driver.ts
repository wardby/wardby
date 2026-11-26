import type { CodingWorkerOutput } from "../coding/protocol.js";
import { describeError } from "./debug-trace.js";
import { streamFailureCode } from "./errors.js";
import { codingOutputJsonSchema } from "./output-schema.js";
import {
  boundedTaskPrompt,
  finishBudgetExhausted,
  finishWorkerRun,
  parseAgentOutput,
  prepareWorkerRun,
} from "./run-frame.js";
import { disabledCodexSkills } from "./skills.js";
import { workerSecurityInstructions } from "./security-instructions.js";
import type { WorkerEvent, WorkerProgressEvent, WorkerRunOptions } from "./types.js";

export { CODING_OUTPUT_JSON_SCHEMA, codingOutputJsonSchema } from "./output-schema.js";
export { resultBundleTimeLimitMs, serviceEnvironment, WORKER_SHIM_DIRECTORY } from "./run-frame.js";

export const WORKER_SECURITY_INSTRUCTIONS = workerSecurityInstructions({
  shape: "in-container",
  instructionFiles: ["AGENTS.md"],
  mcp: false,
  gitHistory: false,
});

const SAFE_ACTIVITY_KINDS = new Set([
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error",
]);
const SAFE_ACTIVITY_STATUSES = new Set(["started", "updated", "completed", "in_progress", "failed"]);

function progress(input: WorkerRunOptions["input"], event: WorkerEvent): WorkerProgressEvent | null {
  if (event.type === "turn.started") return { schemaVersion: 1, runId: input.runId, type: "turn_started" };
  if (
    (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
    event.item
  ) {
    return {
      schemaVersion: 1,
      runId: input.runId,
      type: "activity",
      kind: SAFE_ACTIVITY_KINDS.has(event.item.type) ? event.item.type : "other",
      status: SAFE_ACTIVITY_STATUSES.has(event.item.status ?? "")
        ? (event.item.status as string)
        : event.type.slice("item.".length),
    };
  }
  return null;
}

export async function runCodingWorker(options: WorkerRunOptions): Promise<CodingWorkerOutput> {
  // Git check, registry, tunnel CA, plan files, pypi lockfiles and the dependency cache (run-frame.ts).
  const run = await prepareWorkerRun(options);
  const client = options.createClient({
    proxyBaseUrl: options.proxyBaseUrl,
    capability: options.capability,
    // A run with git history (#536) commits its work, so "never modify Git metadata" gives way to a narrower rule.
    developerInstructions: workerSecurityInstructions({
      shape: "in-container",
      instructionFiles: ["AGENTS.md"],
      mcp: Boolean(options.mcpToken),
      gitHistory: Boolean(options.input.gitHistory),
    }),
    environment: { ...run.agentEnvironment },
    disabledSkills: await disabledCodexSkills(options.workspace, options.input.repoSkills !== false),
    // Only on a run with MCP tools. sdk.ts puts it in the Codex process env, never the shells' env,
    // but a shell command can still read it from /proc (same uid): treat it as readable by the
    // repository's code.
    ...(options.mcpToken ? { mcpToken: options.mcpToken } : {}),
    ...(options.capabilityHeader ? { capabilityHeader: options.capabilityHeader } : {}),
    ...(options.mcpTokenHeader ? { mcpTokenHeader: options.mcpTokenHeader } : {}),
  });
  const thread = client.startThread({
    model: options.input.model,
    // Docker, not the nested Codex sandbox, is the enforcement boundary.
    sandboxMode: "danger-full-access",
    workingDirectory: options.workspace,
    // The trusted VCS layer intentionally removes .git before mounting the workspace.
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  const streamed = await thread.runStreamed(boundedTaskPrompt(options.input.task, options.input.runId, run.note), {
    outputSchema: codingOutputJsonSchema(Boolean(options.input.repositories)),
    signal: options.signal,
  });
  let finalJson: string | undefined;
  let failure: string | undefined;
  let streamFailure: string | undefined;
  try {
    for await (const event of streamed.events) {
      options.trace?.record("event", event);
      const safeProgress = progress(options.input, event);
      if (safeProgress) options.onProgress?.(safeProgress);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string") finalJson = event.item.text;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        failure = event.type === "turn.failed" ? event.error?.message : event.message;
        options.trace?.record(event.type === "turn.failed" ? "turn_failed" : "error_event", { message: failure });
      }
    }
  } catch (error) {
    options.trace?.record("stream_error", describeError(error));
    streamFailure = streamFailureCode(error);
  }
  if (!finalJson) {
    if (failure?.includes("wardby_budget_exhausted") || streamFailure === BUDGET_EXHAUSTED) {
      return finishBudgetExhausted(options, run);
    }
    if (streamFailure) throw new Error(streamFailure);
    throw new Error(failure ? "coding_turn_failed" : "coding_output_missing");
  }
  if (streamFailure) throw new Error(streamFailure === BUDGET_EXHAUSTED ? "coding_stream_failed" : streamFailure);
  return finishWorkerRun(options, run, parseAgentOutput(finalJson, options.input.runId));
}

const BUDGET_EXHAUSTED = "budget_exhausted";
