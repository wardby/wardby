import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CODING_PROTOCOL_VERSION,
  PLAN_FOLDER_PATH,
  parseCodingAgentOutputJson,
  sanitizeDependencyCacheReport,
  type CodingAgentOutput,
  type CodingTaskInput,
  type CodingWorkerOutput,
  type DependencyCacheReport,
} from "../coding/protocol.js";
import { workerTaskNote } from "./task-note.js";
import { normalizeRegistryLockfiles } from "../coding/registry/lockfiles.js";
import {
  prepareWorkspacePypiLockfiles,
  restoreWorkspacePypiLockfiles,
} from "../coding/registry/pypi-lockfiles/session.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import { TUNNEL_CA_RELATIVE_PATH, tunnelProxyEnv, tunnelTrustEnv } from "../coding/tunnel-env.js";
import { deriveTunnelToken } from "../coding/tunnel-token.js";
import { registryUrlFor, registryWorkerSetup } from "../coding/registry/worker-config.js";
import { describeError } from "./debug-trace.js";
import { placePlanFiles } from "./plan-folder.mjs";
import { safeWorkerErrorCode } from "./errors.js";
import type { DependencyCacheModule, ResultBundleModule, WorkerRunOptions } from "./types.js";

/**
 * The provider-neutral frame around an in-container coding agent (Codex, Gemini CLI): the
 * workspace, registry, tunnel, plan files, pypi lockfiles and dependency cache before the agent
 * starts; its final answer parsed against wardby's own schema; lockfiles put back and commits
 * bundled after. Each driver keeps only its client and its stream loop.
 */

/** Everything a run gives the frame: the run options less the agent client and its credentials. */
export type RunFrameOptions = Omit<
  WorkerRunOptions,
  "createClient" | "mcpToken" | "capabilityHeader" | "mcpTokenHeader"
>;

/** The agent's home directory in every worker image. */
export const WORKER_HOME = "/home/wardby";

export function boundedTaskPrompt(task: string, runId: string, note?: string): string {
  return `Complete this software-engineering task in the current workspace.\n\nTask:\n${task}\n\n${note ? `${note}\n\n` : ""}The final JSON runId must be ${runId}.`;
}

/** Loaded only on a run that asks for it: the module ships next to this one in the driver image. */
async function loadDependencyCacheModule(): Promise<DependencyCacheModule> {
  return import("./dependency-cache.mjs");
}

/** Loaded only on a run with git history: the module ships next to this one in the driver image. */
async function loadResultBundleModule(): Promise<ResultBundleModule> {
  return import("./result-bundle.mjs");
}

const RESULT_BUNDLE_CODE = /^result_bundle_[a-z_]+$/;

/** The longest one bundle may take (the module's own bound for `git bundle create`). */
const RESULT_BUNDLE_MAX_MS = 10 * 60 * 1000;
/**
 * What the launcher still needs after the worker returns (collecting the files, sealing the result)
 * is kept out of the bundle step's time: a slow bundle must end in the files-only fallback, never in
 * the run's wall-clock timeout. The dependency cache has no such constant (it takes half the time
 * left), so this one is chosen here: two minutes.
 */
const RESULT_BUNDLE_DEADLINE_MARGIN_MS = 2 * 60 * 1000;

/** The time one bundle may take now: what is left before the deadline less the margin, at most the module's bound. 0 = skip. */
export function resultBundleTimeLimitMs(deadlineAt: string | undefined, now = Date.now()): number {
  const at = deadlineAt === undefined ? Number.NaN : Date.parse(deadlineAt);
  if (!Number.isFinite(at)) return RESULT_BUNDLE_MAX_MS;
  return Math.max(0, Math.min(RESULT_BUNDLE_MAX_MS, at - now - RESULT_BUNDLE_DEADLINE_MARGIN_MS));
}

/** The operator log line, by default: one JSON object on stderr, as main.ts writes its error. */
function stderrLog(event: Record<string, string>): void {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

/**
 * The result bundle of each history repository (#536), for changes_ready and budget_exhausted
 * output alike. Never fails the run: a failure is one operator log line with a fixed code (the
 * module throws only those; anything else becomes result_bundle_failed, so git's output or an
 * error's text never reaches the log), the module has removed that repository's bundle, and the
 * control plane takes the files only.
 */
async function bundleResults(options: RunFrameOptions, module: ResultBundleModule): Promise<void> {
  const log = options.operatorLog ?? stderrLog;
  for (const repository of options.input.gitHistory?.repositories ?? []) {
    // The run's deadline is shared by the repositories in turn: each gets what is left, less the margin.
    const timeoutMs = resultBundleTimeLimitMs(options.input.deadlineAt);
    if (timeoutMs <= 0) {
      log({ warning: "result_bundle_failed", code: "result_bundle_deadline" });
      continue;
    }
    const repoPath = module.resolveHistoryPath(repository.path, {
      workspace: options.workspace,
      reposRoot: options.reposRoot ?? "/repos",
    });
    if (repoPath === null) {
      log({ warning: "result_bundle_failed", code: "result_bundle_path_invalid" });
      continue;
    }
    try {
      await module.createResultBundle({
        repoPath,
        baseCommit: repository.baseCommit,
        excludeCommits: repository.excludeCommits,
        gitBinary: options.gitBinary ?? "git",
        timeoutMs,
      });
    } catch (error) {
      options.trace?.record("result_bundle_error", describeError(error));
      const code =
        error instanceof Error && RESULT_BUNDLE_CODE.test(error.message) ? error.message : "result_bundle_failed";
      log({ warning: "result_bundle_failed", path: repository.path, code });
    }
  }
}

/**
 * The run's registry-only token: the one the worker was handed (Substrate, where the capability is
 * the gateway's placeholder), else derived from the capability as on Docker/Kubernetes.
 */
function runRegistryToken(options: RunFrameOptions): string {
  return options.registryToken ?? deriveRegistryToken(options.capability);
}

/** How long the driver's own fallback seal may take (the module's is bounded the same way). */
const FALLBACK_SEAL_TIMEOUT_MS = 10_000;

/**
 * The seal when the module itself could not be loaded: the same idempotent POST /cache/npm/seal
 * with the registry-only token the npmrc carries (never the capability), so the agent never starts
 * with the upload window open. Bounded; never throws.
 */
async function fallbackSeal(options: RunFrameOptions): Promise<void> {
  try {
    await fetch(new URL("/cache/npm/seal", options.proxyBaseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${runRegistryToken(options)}` },
      signal: AbortSignal.timeout(FALLBACK_SEAL_TIMEOUT_MS),
    });
  } catch {
    // The proxy's upload deadline still closes the window.
  }
}

/**
 * The run's dependency cache (dependency-cache.mjs), before the agent starts. `env` is exactly
 * the agent's shell environment: the module runs npm (and, after the seal, `npm rebuild`) with
 * it, so it never sees the driver's own process environment (the run capability). The budget is
 * the run's volume (input.diskMb) minus what the workspace already uses, measured first; a size
 * it can't measure skips the cache. Never fails the run: anything unexpected becomes a stable
 * report, and every path that did not run the module to completion seals the upload window here.
 */
async function runDependencyCache(
  options: RunFrameOptions,
  env: Record<string, string>,
): Promise<DependencyCacheReport> {
  let module: DependencyCacheModule;
  try {
    module = await (options.loadDependencyCache ?? loadDependencyCacheModule)();
  } catch (error) {
    options.trace?.record("dependency_cache_error", describeError(error));
    await fallbackSeal(options);
    return { projects: [], reason: "worker_error" };
  }
  const seal = async () => {
    try {
      await module.sealUploadWindow({ env });
    } catch {
      await fallbackSeal(options);
    }
  };
  try {
    // At most half the run's remaining time (and the module's own bound), the budget walk included.
    const started = Date.now();
    const limitMs = module.dependencyCacheTimeLimit(options.input.deadlineAt, started);
    if (limitMs <= 0) {
      await seal();
      return { projects: [], reason: "timeout" };
    }
    const budget = await module.dependencyCacheBudget({
      workspace: options.workspace,
      diskMb: options.input.diskMb,
      signal: options.signal,
      timeoutMs: Math.min(module.BUDGET_MEASURE_TIMEOUT_MS, limitMs),
    });
    if (budget.reason !== undefined) {
      await seal();
      return { projects: [], reason: budget.reason };
    }
    const totalMs = limitMs - (Date.now() - started);
    if (totalMs <= 0) {
      await seal();
      return { projects: [], reason: "timeout" };
    }
    const result = await module.prepareDependencies({
      workspace: options.workspace,
      env,
      budgetBytes: budget.budgetBytes,
      usedBytes: budget.usedBytes,
      signal: options.signal,
      timeouts: { totalMs },
      log: (event, fields) => options.trace?.record("dependency_cache", { event, ...fields }),
    });
    return sanitizeDependencyCacheReport(result);
  } catch (error) {
    options.trace?.record("dependency_cache_error", describeError(error));
    await seal();
    return { projects: [], reason: "worker_error" };
  }
}

/** Where the driver image installs Wardby's own command shims (the npm
 *  shim that verifies a lockfile before an install: npm-shim.mjs), ahead of
 *  the real tools on the agent's PATH. */
export const WORKER_SHIM_DIRECTORY = "/opt/wardby/bin";

/**
 * The workspace-relative cache root: registryWorkerSetup writes package-manager
 * config under here, and the agent's temporary files (TMPDIR) now live here too
 * -- both stay out of the collected workspace via the ".cache" entry in
 * BUILTIN_COLLECT_EXCLUDE_NAMES (coding/collect-exclude.ts).
 */
function workspaceCacheRoot(workspace: string): string {
  return `${workspace}/.cache`;
}

/** Where the agent's shells get TMPDIR: workspace disk, not the tiny `/tmp` tmpfs
 *  (docker-isolation.ts's scratchMb caps it at 64 MiB, too small for a real
 *  `pip install` or `npm install` to unpack and build in). */
function workspaceTmpDir(workspace: string): string {
  return `${workspaceCacheRoot(workspace)}/tmp`;
}

function workerEnvironment(workspace: string): Record<string, string> {
  return {
    HOME: WORKER_HOME,
    LANG: "C.UTF-8",
    PATH: `${WORKER_SHIM_DIRECTORY}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: workspaceTmpDir(workspace),
  };
}

/**
 * The variables a run's services hand the agent's shells
 * (CodingTaskInput.services, docs/coding-services.md). Where two services set
 * the same variable, the first one listed wins. The worker's own variables are
 * spread after these, so they always win (the protocol reserves their names
 * anyway).
 */
export function serviceEnvironment(services: CodingTaskInput["services"]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const service of services ?? []) {
    for (const [name, value] of Object.entries(service.testEnv)) {
      if (!(name in env)) env[name] = value;
    }
  }
  return env;
}

/** The warnings name repository paths, so they reach only an operator's debug trace, never the control plane. */
function reportPypiLockfileWarnings(options: RunFrameOptions, step: "prepare" | "restore", warnings: string[]): void {
  for (const warning of warnings) options.trace?.record(`pypi_lockfiles_${step}_warning`, warning);
}

export interface PreparedWorkerRun {
  /** Exactly the agent's shell environment (the dependency cache's npm ran with it too). Never holds the capability. */
  agentEnvironment: Record<string, string>;
  dependencyCache?: DependencyCacheReport;
  /** Everything the worker adds to the prompt after the task (task-note.ts). */
  note: string;
  /** Set on a run with git history (#536). */
  resultBundle?: ResultBundleModule;
}

/** Everything before the agent starts, for every in-container coding agent (Codex, Gemini CLI). */
export async function prepareWorkerRun(options: RunFrameOptions): Promise<PreparedWorkerRun> {
  // A run with git history (#536) needs git for its result bundle: fail before anything else when
  // the image has none.
  let resultBundle: ResultBundleModule | undefined;
  if (options.input.gitHistory) {
    try {
      resultBundle = await (options.loadResultBundle ?? loadResultBundleModule)();
    } catch {
      throw new Error("worker_git_unavailable");
    }
    if (!(await resultBundle.gitAvailable(options.gitBinary ?? "git"))) throw new Error("worker_git_unavailable");
  }
  const registry = registryWorkerSetup({
    proxyBaseUrl: options.proxyBaseUrl,
    token: runRegistryToken(options),
    cacheRoot: workspaceCacheRoot(options.workspace),
  });
  for (const file of registry.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, { mode: file.mode });
  }
  // The tunnel's CA certificate, when the operator gave one: a public file under the cache root, trusted through the variables below.
  const tunnelCaCert = options.input.tunnel?.caCert;
  const tunnelCaFile = tunnelCaCert ? `${workspaceCacheRoot(options.workspace)}/${TUNNEL_CA_RELATIVE_PATH}` : undefined;
  if (tunnelCaFile && tunnelCaCert) {
    await mkdir(dirname(tunnelCaFile), { recursive: true });
    await writeFile(tunnelCaFile, tunnelCaCert, { mode: 0o644 });
  }
  await mkdir(workspaceTmpDir(options.workspace), { recursive: true, mode: 0o700 });
  // Plan files (a revision, a builder's approved design): in place before the agent exists. A
  // refused path or folder fails the run with a fixed code.
  if (options.input.planFiles) {
    try {
      await placePlanFiles(options.planRoot ?? PLAN_FOLDER_PATH, options.input.planFiles.files);
    } catch (error) {
      options.trace?.record("plan_files_error", describeError(error));
      throw new Error("worker_plan_files_failed", { cause: error });
    }
  }
  const baseEnvironment = {
    ...serviceEnvironment(options.input.services),
    ...workerEnvironment(options.workspace),
    ...registry.env,
    // Only when the tunnel is on: the proxy variables, carrying the tunnel-only token (never the capability).
    ...(options.input.tunnel
      ? tunnelProxyEnv({
          proxyHost: new URL(options.proxyBaseUrl).hostname,
          port: options.input.tunnel.port,
          token: deriveTunnelToken(options.capability),
        })
      : {}),
    ...(tunnelCaFile ? tunnelTrustEnv(tunnelCaFile) : {}),
  };
  // uv.lock and poetry.lock name their own index, which the sandbox cannot reach: point them at the proxy.
  const pypiLockfiles = await prepareWorkspacePypiLockfiles({
    workspace: options.workspace,
    registryUrl: registryUrlFor(options.proxyBaseUrl, "pypi"),
    token: deriveRegistryToken(options.capability),
    env: baseEnvironment,
  });
  reportPypiLockfileWarnings(options, "prepare", pypiLockfiles.warnings);
  // What every agent shell gets; the dependency cache's npm runs with exactly this too.
  const agentEnvironment = { ...baseEnvironment, ...pypiLockfiles.env };
  // After the repository and the registry files are in place, before the agent exists.
  const dependencyCache = options.input.dependencyCache
    ? await runDependencyCache(options, agentEnvironment)
    : undefined;
  const note = workerTaskNote(dependencyCache, options.input.repositories, options.input.gitHistory);
  return {
    agentEnvironment,
    note,
    ...(dependencyCache ? { dependencyCache } : {}),
    ...(resultBundle ? { resultBundle } : {}),
  };
}

function withCache<T extends CodingAgentOutput>(
  run: PreparedWorkerRun,
  output: T,
): T & Pick<CodingWorkerOutput, "dependencyCache"> {
  return run.dependencyCache ? { ...output, dependencyCache: run.dependencyCache } : output;
}

/** The agent's final JSON, validated with wardby's own schema; the run must be this one. */
export function parseAgentOutput(text: string, runId: string): CodingAgentOutput {
  let output: CodingAgentOutput;
  try {
    output = parseCodingAgentOutputJson(text);
  } catch (error) {
    if (safeWorkerErrorCode(error) !== "worker_failed") throw error;
    throw new Error("coding_output_invalid", { cause: error });
  }
  if (output.runId !== runId) throw new Error("coding_output_run_mismatch");
  return output;
}

/** After a valid answer: lockfiles put back (changes_ready), commits bundled, the completed event. */
export async function finishWorkerRun(
  options: RunFrameOptions,
  run: PreparedWorkerRun,
  output: CodingAgentOutput,
): Promise<CodingWorkerOutput> {
  // Only a changes_ready workspace is collected into a pull request; lockfiles written through the
  // registry proxy would otherwise commit sandbox-only download URLs.
  if (output.outcome === "changes_ready") {
    // The pypi lockfiles first: each proxy URL in a uv.lock (new or upgraded packages included) is
    // pointed back at the real address the proxy gives for it (a private index included), and one the
    // proxy cannot answer for is refused, which the generic pass below would otherwise rewrite to the
    // public index.
    const restored = await restoreWorkspacePypiLockfiles({
      workspace: options.workspace,
      registryUrl: registryUrlFor(options.proxyBaseUrl, "pypi"),
      token: deriveRegistryToken(options.capability),
    });
    reportPypiLockfileWarnings(options, "restore", restored.warnings);
    // A uv.lock the agent changed that still names the proxy cannot install outside the sandbox.
    if (restored.unresolved.length > 0) throw new Error("coding_pypi_lockfile_unresolved");
    await normalizeRegistryLockfiles({ workspace: options.workspace, proxyBaseUrl: options.proxyBaseUrl });
  }
  if (run.resultBundle && (output.outcome === "changes_ready" || output.outcome === "budget_exhausted")) {
    await bundleResults(options, run.resultBundle);
  }
  options.onProgress?.({ schemaVersion: 1, runId: options.input.runId, type: "completed", outcome: output.outcome });
  return withCache(run, output);
}

/** The proxy refused for budget before an answer: the shared summary; stopped work is kept and bundled. */
export async function finishBudgetExhausted(
  options: RunFrameOptions,
  run: PreparedWorkerRun,
): Promise<CodingWorkerOutput> {
  const exhausted: CodingAgentOutput = {
    schemaVersion: CODING_PROTOCOL_VERSION,
    runId: options.input.runId,
    outcome: "budget_exhausted",
    summary: "The coding budget was exhausted before the task could complete.",
    tests: [],
  };
  options.onProgress?.({
    schemaVersion: 1,
    runId: options.input.runId,
    type: "completed",
    outcome: exhausted.outcome,
  });
  // Stopped work is kept: its commits are bundled too.
  if (run.resultBundle) await bundleResults(options, run.resultBundle);
  return withCache(run, exhausted);
}
