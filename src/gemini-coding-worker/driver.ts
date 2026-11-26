import { join } from "node:path";
import {
  DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS,
  DEFAULT_CLAUDE_MAX_TURNS,
  type CodingWorkerOutput,
} from "../coding/protocol.js";
import { INJECTED_CAPABILITY_PLACEHOLDER } from "../coding-worker/credentials.js";
import { describeError } from "../coding-worker/debug-trace.js";
import { assertMcpHeaderPlaceholder, type MCP_TOKEN_HEADER } from "../coding-worker/mcp-config.js";
import {
  boundedTaskPrompt,
  finishBudgetExhausted,
  finishWorkerRun,
  parseAgentOutput,
  prepareWorkerRun,
  WORKER_HOME,
  type PreparedWorkerRun,
  type RunFrameOptions,
} from "../coding-worker/run-frame.js";
import { workerSecurityInstructions } from "../coding-worker/security-instructions.js";
import { resetGeminiAgentState } from "./agent-state.js";
import { GEMINI_CONTEXT_FILE_NAMES, geminiCliModel, type GeminiBackend } from "./cli.js";
import { geminiCliEnvironment } from "./environment.js";
import { geminiRunEnd, jsonOutputResult, type GeminiRunEnd } from "./failure.js";
import { killLeftoverProcesses, type SweepResult } from "./leftovers.js";
import { assertGeminiContextFilesRegular } from "./context-files.js";
import { geminiOutputJsonSchema, geminiRepairPrompt, geminiTaskPrompt } from "./output.js";
import { spawnGeminiCli, type GeminiCliDone, type GeminiCliSpawner } from "./process.js";
import {
  geminiSubAgentsDisabledReason,
  geminiUserSettings,
  readRepoAgents,
  writeGeminiUserSettings,
  type GeminiRunSettings,
  type GeminiUserSettingsInput,
} from "./settings.js";
import { GeminiStreamReader } from "./stream.js";
import { checkGeminiCliVersion, verifyGeminiSystemSettings } from "./system-check.js";

export interface GeminiRunOptions extends RunFrameOptions {
  runSettings: GeminiRunSettings;
  /** The CLI's HOME (~/.gemini lives there); WORKER_HOME by default. */
  home?: string;
  /** The run's MCP token (WARDBY_MCP_TOKEN), set only when the run has MCP tools. */
  mcpToken?: string;
  mcpTokenHeader?: typeof MCP_TOKEN_HEADER;
  /** Substrate (phase 4): the capability is the gateway's placeholder. */
  capabilityHeader?: "x-api-key";
  /** Tests only. */
  spawnCli?: GeminiCliSpawner;
  /** Tests only: where the system settings are and who must own them. */
  systemCheck?: { root?: string; expectedUid?: number };
  /** Tests only: replaces killLeftoverProcesses (which signals every other process in the pid namespace). */
  sweepProcesses?: () => Promise<SweepResult>;
}

const VERSION_TIMEOUT_MS = 30_000;
/** Where the extra repositories are mounted when the options do not say (run-frame.ts's default). */
const DEFAULT_REPOS_ROOT = "/repos";
/**
 * The CLI is stopped this long before the run's deadline, so the worker still reports a fixed
 * code (coding_stream_timeout) before the launcher stops the container.
 */
export const GEMINI_DEADLINE_MARGIN_MS = 30_000;
/** setTimeout's longest delay; a deadline further away than this needs no timer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The fixed part of every CLI command line (spec §3): the run model, never `auto`; yolo; and
 * `--skip-trust`, which trusts the workspace for this session only (headless mode needs a trusted
 * folder) without writing it to trustedFolders.json. Trust does not relax the lock-down: the
 * system settings and policy still outrank anything in the workspace.
 */
export function geminiBaseArgs(googleModel: string): string[] {
  return ["-m", googleModel, "--approval-mode", "yolo", "--skip-trust"];
}

/** The run's cancel signal, ended early by its deadline (less the margin). */
function runSignal(signal: AbortSignal, deadlineAt: string | undefined): AbortSignal {
  const at = deadlineAt === undefined ? Number.NaN : Date.parse(deadlineAt);
  if (!Number.isFinite(at)) return signal;
  const ms = Math.max(0, at - GEMINI_DEADLINE_MARGIN_MS - Date.now());
  return ms > MAX_TIMER_MS ? signal : AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

/** `gemini --version`, with the run's guards and auth type but never a credential (the version prints offline). */
async function checkCliVersion(
  spawnCli: GeminiCliSpawner,
  options: GeminiRunOptions,
  home: string,
  backend: GeminiBackend,
): Promise<void> {
  const run = spawnCli(["--version"], {
    cwd: options.workspace,
    env: geminiCliEnvironment({
      agentEnvironment: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      proxyBaseUrl: options.proxyBaseUrl,
      capability: "",
      backend,
      home,
    }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(VERSION_TIMEOUT_MS)]),
  });
  const lines: string[] = [];
  for await (const line of run.lines) lines.push(line);
  const done = await run.done;
  if (done.code !== 0) throw new Error("worker_agent_cli_incompatible");
  checkGeminiCliVersion(lines.join("\n"));
}

/** Verification failures are already the fixed code; the cause (which check) goes to the debug trace only. */
async function verifySystem(options: GeminiRunOptions): Promise<void> {
  try {
    await verifyGeminiSystemSettings(options.systemCheck);
  } catch (error) {
    options.trace?.record("gemini_cli_incompatible", describeError(error));
    throw error;
  }
}

/**
 * One coding task with the pinned Gemini CLI (spec §3): verify the baked lock-down and the CLI
 * version, prepare the shared run frame, reset the agent-writable CLI state and write the run's
 * user settings, run the CLI once with stream-json, parse the final answer (one --resume repair
 * if needed, after the same reset), finish through the frame.
 */
export async function runGeminiCodingWorker(options: GeminiRunOptions): Promise<CodingWorkerOutput> {
  const spawnCli = options.spawnCli ?? spawnGeminiCli();
  const sweepProcesses = options.sweepProcesses ?? (() => killLeftoverProcesses());
  const home = options.home ?? WORKER_HOME;
  const log = options.operatorLog ?? ((event) => process.stderr.write(`${JSON.stringify(event)}\n`));
  // Header mode puts the capability in a variable every shell can read: only the gateway's placeholder may go there.
  if (options.capabilityHeader && options.capability !== INJECTED_CAPABILITY_PLACEHOLDER) {
    throw new Error("worker_capability_header_needs_placeholder");
  }
  assertMcpHeaderPlaceholder(options.mcpToken, options.mcpTokenHeader);
  const model = geminiCliModel(options.input.model);
  await verifySystem(options);
  try {
    await checkCliVersion(spawnCli, options, home, model.backend);
  } catch (error) {
    options.trace?.record("gemini_cli_incompatible", describeError(error));
    throw error;
  }
  const signal = runSignal(options.signal, options.input.deadlineAt);
  const run = await prepareWorkerRun(options);
  const schema = geminiOutputJsonSchema(Boolean(options.input.repositories));
  // The extra repositories, where they are mounted: the CLI's trusted roots besides the workspace.
  const includeDirectories = (options.input.repositories ?? []).map((repository) =>
    join(options.reposRoot ?? DEFAULT_REPOS_ROOT, repository.name),
  );
  const settingsInput: Omit<GeminiUserSettingsInput, "repoAgentNames" | "repoAgentsUnpinnable"> = {
    backend: model.backend,
    googleModel: model.googleModel,
    maxOutputTokens: options.input.maxOutputTokens ?? DEFAULT_CLAUDE_MAX_OUTPUT_TOKENS,
    maxSessionTurns: options.input.maxTurns ?? DEFAULT_CLAUDE_MAX_TURNS,
    commandTimeoutMs: options.runSettings.commandTimeoutMs,
    subAgents: options.runSettings.subAgents,
    webTools: options.runSettings.webTools,
    repoSkills: options.input.repoSkills !== false,
    outputSchema: schema,
    includeDirectories,
    ...(options.mcpToken
      ? { mcp: { proxyBaseUrl: options.proxyBaseUrl, headerMode: Boolean(options.mcpTokenHeader) } }
      : {}),
  };
  let warnedSubAgents = false;
  let warnedSweep = false;
  /** Leftover processes stopped; outside the worker image's own pid namespace the sweep is skipped, and said once. */
  const sweep = async (): Promise<void> => {
    if ((await sweepProcesses()) === "skipped" && !warnedSweep) {
      warnedSweep = true;
      log({ warning: "gemini_process_sweep_skipped" });
    }
  };
  /**
   * Before each CLI start: nothing the agent left running, nothing it wrote for the CLI to load
   * (user policies outrank the per-run exclusions), the run's settings rewritten whole from the
   * repository as it is now, and the system lock-down checked again. The repair turn gets exactly
   * the first turn's settings and guards; nothing is re-enabled.
   */
  const prepareTurn = async (): Promise<void> => {
    await sweep();
    await resetGeminiAgentState(home);
    // The CLI follows a symlinked GEMINI.md/AGENTS.md/CLAUDE.md under any root it trusts (context-files.ts): refuse the run first.
    await assertGeminiContextFilesRegular([options.workspace, ...includeDirectories]);
    const agents = options.runSettings.subAgents
      ? await readRepoAgents(options.workspace)
      : { names: [], unpinnable: false };
    const input: GeminiUserSettingsInput = {
      ...settingsInput,
      repoAgentNames: agents.names,
      repoAgentsUnpinnable: agents.unpinnable,
    };
    const reason = geminiSubAgentsDisabledReason(input);
    if (reason && !warnedSubAgents) {
      warnedSubAgents = true;
      options.trace?.record("gemini_sub_agents_disabled", { reason });
      log({ warning: "gemini_sub_agents_disabled", reason });
    }
    await writeGeminiUserSettings(home, geminiUserSettings(input));
    await verifySystem(options);
  };
  const env = geminiCliEnvironment({
    agentEnvironment: run.agentEnvironment,
    proxyBaseUrl: options.proxyBaseUrl,
    capability: options.capability,
    backend: model.backend,
    home,
    ...(options.mcpToken ? { mcpToken: options.mcpToken, mcpHeaderMode: Boolean(options.mcpTokenHeader) } : {}),
  });
  /** One CLI run: every line to `onLine`; afterwards, leftover processes stopped whatever happened. */
  const cli = async (args: string[], onLine: (line: string) => void): Promise<GeminiCliDone> => {
    const started = spawnCli(args, { cwd: options.workspace, env, signal });
    let done: GeminiCliDone | undefined;
    let failure: unknown;
    try {
      for await (const line of started.lines) onLine(line);
      done = await started.done;
    } catch (error) {
      failure = error;
    }
    // Leftovers stopped whatever happened; a sweep failure outranks the run's own.
    try {
      await sweep();
    } catch (error) {
      failure = error;
    }
    // The tail goes only to the operator-asked debug trace (redacted by exact value), never elsewhere.
    if (done) options.trace?.record("cli_stderr", done.stderrTail);
    // Cancellation and the deadline come from the signal itself, before any other failure: without
    // the relaunch the CLI handles SIGTERM and may exit with any code, 0 included.
    if (signal.aborted) {
      if (failure !== undefined) options.trace?.record("cli_after_abort_error", describeError(failure));
      throw new Error(options.signal.aborted ? "worker_cancelled" : "coding_stream_timeout");
    }
    if (failure !== undefined || !done) throw failure;
    // A dropped event could have been the answer or the failure: never read the rest as success.
    if (done.oversizedLines > 0) {
      options.trace?.record("cli_stdout_oversized", { lines: done.oversizedLines });
      throw new Error("coding_stream_failed");
    }
    return done;
  };
  const prompt = geminiTaskPrompt({
    instructions: workerSecurityInstructions({
      shape: "in-container",
      instructionFiles: GEMINI_CONTEXT_FILE_NAMES,
      mcp: Boolean(options.mcpToken),
      gitHistory: Boolean(options.input.gitHistory),
    }),
    task: boundedTaskPrompt(options.input.task, options.input.runId, run.note),
    schema,
  });

  // The agent's turn.
  await prepareTurn();
  const reader = new GeminiStreamReader(options.input.runId, options.onProgress, options.trace);
  const firstDone = await cli(
    [...geminiBaseArgs(model.googleModel), "-p", prompt, "--output-format", "stream-json"],
    (line) => reader.line(line),
  );
  const settled = await settle(options, run, geminiRunEnd(firstDone, reader.result, firstDone.stderrTail));
  if (settled) return settled;
  const answer = tryParse(reader.finalText(), options.input.runId);
  if (answer.ok) return finishWorkerRun(options, run, answer.output);
  options.trace?.record("final_answer_invalid", describeError(answer.error));

  // One repair turn on the same session, after the same reset.
  await prepareTurn();
  const stdout: string[] = [];
  const repairDone = await cli(
    [
      ...geminiBaseArgs(model.googleModel),
      "--resume",
      "latest",
      "-p",
      geminiRepairPrompt(options.input.runId),
      "--output-format",
      "json",
    ],
    (line) => stdout.push(line),
  );
  const parsed = jsonOutputResult(stdout.join("\n"));
  options.trace?.record("repair_output", { response: parsed.response ?? null });
  const repairSettled = await settle(options, run, geminiRunEnd(repairDone, parsed.result, repairDone.stderrTail));
  if (repairSettled) return repairSettled;
  const repaired = tryParse(parsed.response ?? "", options.input.runId);
  if (repaired.ok) return finishWorkerRun(options, run, repaired.output);
  throw repaired.error;
}

/** A budget stop finishes the run; any other failure throws its fixed code; ok returns undefined. */
async function settle(
  options: GeminiRunOptions,
  run: PreparedWorkerRun,
  end: GeminiRunEnd,
): Promise<CodingWorkerOutput | undefined> {
  if (end.kind === "budget_exhausted") return finishBudgetExhausted(options, run);
  if (end.kind === "failed") throw new Error(end.code);
  return undefined;
}

function tryParse(
  text: string,
  runId: string,
): { ok: true; output: ReturnType<typeof parseAgentOutput> } | { ok: false; error: Error } {
  if (!text) return { ok: false, error: new Error("coding_output_missing") };
  try {
    return { ok: true, output: parseAgentOutput(text, runId) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error("coding_output_invalid") };
  }
}
