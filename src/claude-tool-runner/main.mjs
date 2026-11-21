#!/usr/bin/env node
import { createServer } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MAX_COMMAND_BYTES,
  MIN_COMMAND_TIMEOUT_MS,
  TOOL_SETUP_ENV,
  commandEnvironment,
  commandTimeoutLimits,
  parseToolSetup,
  prepareCommandWorkspace,
  runCommand,
} from "./command.mjs";

const SOCKET_PATH = "/run/wardby/tool/runner.sock";
const WORKSPACE_PATH = "/workspace";
/** Where the extra repositories are mounted (docker-isolation.ts, kubernetes-isolation.ts). */
const REPOS_ROOT = "/repos";
export const TOOL_RUNNER_READY_MESSAGE = "wardby_tool_runner_ready";
/**
 * The worker's one call on a dependency-cache run (claude-coding-worker/driver.ts), before the
 * agent starts. Never the agent's: the worker's SDK options disallow it (sdk.ts), and once any
 * command has run it only answers `already_started`.
 */
export const PREPARE_DEPENDENCIES_TOOL = "wardby_prepare_dependencies";
/**
 * The worker's call once the agent has finished a changes_ready run: points every uv.lock that names the proxy
 * back at real registry addresses (asked of the proxy) and puts the original Poetry files back (see pypiGate).
 * Answers `{ restored, warnings, unresolved }`; a non-empty `unresolved` fails the run. Never
 * the agent's either (sdk.ts disallows it).
 */
export const RESTORE_PYPI_LOCKFILES_TOOL = "wardby_restore_pypi_lockfiles";

/**
 * The worker's calls on a run with git history (#536, claude-coding-worker/driver.ts): a git check
 * before the agent starts, and a result bundle per history repository after it has finished. Never
 * the agent's: the worker's SDK options disallow both (sdk.ts). The agent's own commands have git
 * here anyway, so neither tool gives a command anything it lacks. Each answers small JSON; the
 * bundle is written into the repository's .git and never crosses the socket.
 */
export const GIT_CHECK_TOOL = "wardby_git_check";
export const RESULT_BUNDLE_TOOL = "wardby_result_bundle";
/**
 * The worker's plan-file calls (claude-coding-worker/plan-files.ts): place the run's input files
 * before any command, then list and read the folder after the agent has finished. Never the
 * agent's: the worker's SDK options disallow them (sdk.ts). The folder is the agent's own scratch,
 * so they give a command nothing it lacks. Answers are fixed codes, never file content in errors.
 */
export const PLAN_PLACE_TOOL = "wardby_plan_place";
export const PLAN_LIST_TOOL = "wardby_plan_list";
export const PLAN_READ_TOOL = "wardby_plan_read";
/** plan-folder.mjs PLAN_ROOT and protocol.ts PLAN_FOLDER_PATH; main.test.mjs keeps them equal. */
export const PLAN_ROOT = "/tmp/wardby-plan";
/** base64Length(PLAN_FILES_LIMITS.maxFileBytes); main.test.mjs keeps it equal to the shared limit. */
export const PLAN_PLACE_MAX_BASE64 = 1_398_104;
/** PLAN_FILES_LIMITS.maxFileBytes; main.test.mjs keeps it equal to the shared limit. */
export const PLAN_PLACE_MAX_BYTES = 1024 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The plan folder module (src/coding-worker/plan-folder.mjs), shipped to /opt/wardby/coding-worker/. */
const loadDefaultPlanFolder = () => import("../coding-worker/plan-folder.mjs");
const COMMIT = /^[0-9a-f]{40}$/;
const RESULT_BUNDLE_CODE = /^result_bundle_[a-z_]+$/;

/** The result bundle module (src/coding-worker/result-bundle.mjs), the same file the Codex driver
 *  ships: the image copies it to /opt/wardby/coding-worker/, as the dependency cache. */
const loadDefaultResultBundle = () => import("../coding-worker/result-bundle.mjs");

/** The dependency cache module (src/coding-worker/dependency-cache.mjs): the image copies it to
 *  /opt/wardby/coding-worker/, the same path relative to this file as in the repository. */
const loadDefaultDependencyCache = () => import("../coding-worker/dependency-cache.mjs");

/** The uv.lock / poetry.lock session (src/coding/registry/pypi-lockfiles/session.ts, compiled): only the
 *  node-python image copies it to /opt/wardby/coding/registry/, so any other image fails to load it and skips. */
const loadDefaultPypiLockfiles = () => import("../coding/registry/pypi-lockfiles/session.js");

/**
 * The proxy's PyPI route and the run's registry token, read from the pip index the launcher already
 * put in the setup (pypi.ts workerConfig: `http://wardby:<token>@<proxy>/registry/pypi/simple/`).
 * Null without it: the run has no registry, so there is nothing to point a lockfile at.
 */
function pypiRegistry(setup) {
  const raw = setup.env.PIP_INDEX_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const token = decodeURIComponent(url.password);
    if (!token || !url.pathname.endsWith("/simple/")) return null;
    url.username = "";
    url.password = "";
    url.pathname = url.pathname.slice(0, -"simple/".length);
    return { registryUrl: url.toString(), token };
  } catch {
    return null;
  }
}

/**
 * One JSON line on stderr per warning, as for `tool_setup_invalid`: a prepare that left the lockfiles as
 * found (a failed `poetry lock`, say) is otherwise invisible to the person reading the run. The session's
 * warnings name files and reasons, never credentials.
 */
function logPypiWarnings(warnings) {
  for (const message of warnings) process.stderr.write(`${JSON.stringify({ warning: "pypi_lockfiles", message })}\n`);
}

/**
 * Process-wide, across every socket connection: the dependency cache runs at most once, only
 * before the first command, and the first command never starts while it is still running. Before
 * the first command the run's upload window is always sealed (memoized; the proxy's seal is
 * idempotent), whether or not prepare ran, failed or was skipped, so nothing a command (the
 * agent) does can be uploaded as a snapshot. The proxy's upload deadline is the backstop.
 * An adopted warm round (`setup.workspaceReused`) answers `reused_workspace` and never prepares:
 * its workspace already holds the previous round's tree, and the proxy refuses it the cache anyway.
 */
function dependencyGate(initialSetup, workspacePath, loadDependencyCache, loadPypiLockfiles) {
  let setup = initialSetup;
  let preparing;
  let sealing;
  let pypi;
  let commandStarted = false;
  const env = () => commandEnvironment(setup, workspacePath);
  /**
   * Once, before the first command (or the dependency cache, whichever comes first): points the
   * workspace's uv.lock and poetry.lock files at the proxy, since the sandbox reaches nothing else, and
   * adds Poetry's source credentials to every later command. Best effort: any failure leaves the files as found.
   */
  const preparePypi = () =>
    (pypi ??= (async () => {
      const registry = pypiRegistry(initialSetup);
      if (!registry) return;
      try {
        await prepareCommandWorkspace(initialSetup, workspacePath);
        const module = await loadPypiLockfiles();
        const result = await module.prepareWorkspacePypiLockfiles({
          workspace: workspacePath,
          ...registry,
          env: commandEnvironment(initialSetup, workspacePath),
        });
        setup = { ...initialSetup, env: { ...initialSetup.env, ...result.env } };
        logPypiWarnings(result.warnings ?? []);
      } catch {
        // The files stay as the repository had them.
        logPypiWarnings(["preparing the workspace failed; files left as found"]);
      }
    })());
  const seal = () =>
    (sealing ??= (async () => {
      try {
        await prepareCommandWorkspace(setup, workspacePath);
        const module = await loadDependencyCache();
        await module.sealUploadWindow({ env: env() });
      } catch {
        // The proxy's upload deadline still closes the window.
      }
    })());
  return {
    started: () => commandStarted,
    /**
     * `deadlineAt`: the run's deadline (ISO), which the worker passes; the cache then takes at most
     * half the time left before it (dependencyCacheTimeLimit), the budget walk included. `signal`:
     * the call's own (aborted when the worker's connection closes): the work stops and settles.
     */
    prepare({ deadlineAt, signal } = {}) {
      if (preparing) return preparing;
      if (commandStarted) return Promise.resolve({ projects: [], reason: "already_started" });
      preparing = (async () => {
        await preparePypi();
        if (setup.workspaceReused) return { projects: [], reason: "reused_workspace" };
        if (deadlineAt !== undefined && !Number.isFinite(Date.parse(deadlineAt)))
          return { projects: [], reason: "invalid_deadline" };
        try {
          const started = Date.now();
          await prepareCommandWorkspace(setup, workspacePath);
          const module = await loadDependencyCache();
          const limitMs = module.dependencyCacheTimeLimit(deadlineAt, started);
          if (limitMs <= 0) return { projects: [], reason: "timeout" };
          // The run's volume (setup.diskMb) minus what the workspace already uses: statfs can't
          // see a Kubernetes emptyDir's sizeLimit. A size it can't measure skips the cache.
          const budget = await module.dependencyCacheBudget({
            workspace: workspacePath,
            diskMb: setup.diskMb,
            signal,
            timeoutMs: Math.min(module.BUDGET_MEASURE_TIMEOUT_MS, limitMs),
          });
          if (budget.reason !== undefined) return { projects: [], reason: budget.reason };
          const totalMs = limitMs - (Date.now() - started);
          if (totalMs <= 0) return { projects: [], reason: "timeout" };
          return await module.prepareDependencies({
            workspace: workspacePath,
            env: env(),
            budgetBytes: budget.budgetBytes,
            usedBytes: budget.usedBytes,
            signal,
            timeouts: { totalMs },
          });
        } catch {
          return { projects: [], reason: "worker_error" };
        }
      })();
      return preparing;
    },
    setup: () => setup,
    /**
     * After the agent: real registry addresses back in every uv.lock that names the proxy (asked of the proxy with
     * the run's token, so no snapshot is needed), and the original Poetry files. Never prepares.
     */
    async restorePypi() {
      const registry = pypiRegistry(initialSetup);
      if (!registry) return { restored: [], warnings: [], unresolved: [] };
      try {
        await pypi;
        const module = await loadPypiLockfiles();
        return await module.restoreWorkspacePypiLockfiles({
          workspace: workspacePath,
          registryUrl: registry.registryUrl,
          token: registry.token,
        });
      } catch {
        return {
          restored: [],
          warnings: ["pypi lockfiles: restoring the workspace failed; files left as found"],
          unresolved: [],
        };
      }
    },
    async beforeCommand() {
      commandStarted = true;
      await preparePypi();
      if (!setup.dependencyCache) return;
      if (preparing) await preparing;
      await seal();
    },
  };
}

/** run_command's description: the run's time limits, so the model can ask for more on a long command. */
export function runCommandDescription(limits) {
  const seconds = (ms) => `${Math.floor(ms / 1000)} s`;
  // Where commands run, by path: a workflow's sub-agents start in a folder of instruction files and
  // otherwise take it for the repository (#582).
  const base =
    "Run one bounded shell command in the isolated repository workspace: the repository is checked out at " +
    "/workspace, where every command starts (other repositories of the run are under /repos/<name>). " +
    "The session's own working folder holds only instruction files and is not visible here.";
  if (limits.maxMs <= limits.defaultMs) return `${base} A command is stopped after ${seconds(limits.defaultMs)}.`;
  return `${base} A command is stopped after ${seconds(limits.defaultMs)} unless timeout_ms asks for more, up to ${seconds(limits.maxMs)}.`;
}

/** The git tools' handlers; any failure is a fixed code, never git's output or an error's text. */
function gitTools({ workspacePath, reposRoot, gitBinary, loadResultBundle }) {
  return {
    async check() {
      try {
        const module = await loadResultBundle();
        return (await module.gitAvailable(gitBinary)) ? { ok: true } : { ok: false, reason: "git_unavailable" };
      } catch {
        return { ok: false, reason: "git_unavailable" };
      }
    },
    async bundle({ path, baseCommit, excludeCommits, timeoutMs }) {
      try {
        const module = await loadResultBundle();
        const repoPath = module.resolveHistoryPath(path, { workspace: workspacePath, reposRoot });
        if (repoPath === null) return { ok: false, reason: "result_bundle_path_invalid" };
        const result = await module.createResultBundle({
          repoPath,
          baseCommit,
          excludeCommits,
          gitBinary,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        return result.bundled ? { ok: true, bundled: true } : { ok: true, bundled: false, reason: result.reason };
      } catch (error) {
        const code =
          error instanceof Error && RESULT_BUNDLE_CODE.test(error.message) ? error.message : "result_bundle_failed";
        return { ok: false, reason: code };
      }
    },
  };
}

function toolServer(setup, gate, workspacePath, git, plan) {
  const server = new McpServer({ name: "wardby_tools", version: "1.0.0" });
  const limits = commandTimeoutLimits(setup);
  server.registerTool(
    "run_command",
    {
      description: runCommandDescription(limits),
      inputSchema: {
        command: z.string().min(1).max(MAX_COMMAND_BYTES),
        timeout_ms: z.number().int().min(MIN_COMMAND_TIMEOUT_MS).max(limits.maxMs).optional(),
      },
    },
    async ({ command, timeout_ms }) => {
      await gate.beforeCommand();
      const result = await runCommand(command, timeout_ms ?? limits.defaultMs, workspacePath, gate.setup());
      return {
        content: [{ type: "text", text: `exit_code=${result.code}\n${result.output}` }],
        isError: result.code !== 0,
      };
    },
  );
  // Only a run with a PyPI registry has lockfiles to put back.
  if (pypiRegistry(setup)) {
    server.registerTool(
      RESTORE_PYPI_LOCKFILES_TOOL,
      {
        description: "Wardby internal: put the original index URLs back in uv and poetry lockfiles.",
        inputSchema: {},
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify(await gate.restorePypi()) }] }),
    );
  }
  if (setup.dependencyCache) {
    server.registerTool(
      PREPARE_DEPENDENCIES_TOOL,
      {
        description: "Wardby internal: restore the run's dependencies before the agent starts.",
        inputSchema: { deadline_at: z.string().max(64).optional() },
      },
      async ({ deadline_at }, extra) => ({
        content: [
          { type: "text", text: JSON.stringify(await gate.prepare({ deadlineAt: deadline_at, signal: extra.signal })) },
        ],
      }),
    );
  }
  server.registerTool(
    GIT_CHECK_TOOL,
    { description: "Wardby internal: check that git is available for the run's history.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: JSON.stringify(await git.check()) }] }),
  );
  server.registerTool(
    RESULT_BUNDLE_TOOL,
    {
      description: "Wardby internal: bundle a history repository's new commits after the agent has finished.",
      inputSchema: {
        path: z.string().min(1).max(256),
        base_commit: z.string().regex(COMMIT),
        exclude_commits: z.array(z.string().regex(COMMIT)).max(17),
        timeout_ms: z.number().int().min(1).max(600_000).optional(),
      },
    },
    async ({ path, base_commit, exclude_commits, timeout_ms }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await git.bundle({
              path,
              baseCommit: base_commit,
              excludeCommits: exclude_commits,
              timeoutMs: timeout_ms,
            }),
          ),
        },
      ],
    }),
  );
  const listed = { files: undefined };
  server.registerTool(
    PLAN_PLACE_TOOL,
    {
      description: "Wardby internal: place one plan file before the agent starts.",
      inputSchema: { path: z.string().min(1).max(512), content_base64: z.string().max(PLAN_PLACE_MAX_BASE64) },
    },
    async ({ path, content_base64 }) => {
      const answer = async () => {
        if (gate.started()) return { ok: false, reason: "already_started" };
        try {
          const module = await plan.load();
          if (!module.isSafePlanPath(path)) return { ok: false, reason: "plan_path_invalid" };
          // No fixed code names a malformed encoding, so it is the folder's own: plan_folder_invalid.
          if (!BASE64.test(content_base64)) return { ok: false, reason: "plan_folder_invalid" };
          if (Buffer.from(content_base64, "base64").length > PLAN_PLACE_MAX_BYTES) {
            return { ok: false, reason: "plan_too_large" };
          }
          await module.placePlanFiles(plan.root, [{ path, contentBase64: content_base64 }]);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            reason:
              error instanceof Error && error.message === "plan_path_invalid"
                ? "plan_path_invalid"
                : "plan_folder_invalid",
          };
        }
      };
      return { content: [{ type: "text", text: JSON.stringify(await answer()) }] };
    },
  );
  server.registerTool(
    PLAN_LIST_TOOL,
    { description: "Wardby internal: list the plan folder after the agent has finished.", inputSchema: {} },
    async () => {
      const answer = async () => {
        try {
          const module = await plan.load();
          const result = await module.collectPlanFolder(plan.root);
          if (result.status !== "ok") {
            listed.files = undefined;
            return { ok: false, reason: result.error === "plan_too_large" ? "plan_too_large" : "plan_folder_invalid" };
          }
          listed.files = new Map(result.files.map((file) => [file.path, file.contentBase64]));
          return {
            ok: true,
            paths: result.files.map((file) => file.path),
            skipped: result.skipped,
            skippedUnnamed: result.skippedUnnamed,
          };
        } catch {
          listed.files = undefined;
          return { ok: false, reason: "plan_folder_invalid" };
        }
      };
      return { content: [{ type: "text", text: JSON.stringify(await answer()) }] };
    },
  );
  server.registerTool(
    PLAN_READ_TOOL,
    {
      description: "Wardby internal: one plan file from the last list.",
      inputSchema: { path: z.string().min(1).max(512) },
    },
    async ({ path }) => {
      const content = listed.files?.get(path);
      const text =
        content === undefined ? { ok: false, reason: "plan_path_invalid" } : { ok: true, content_base64: content };
      return { content: [{ type: "text", text: JSON.stringify(text) }] };
    },
  );
  return server;
}

export async function startToolRunner(
  socketPath = SOCKET_PATH,
  setup = parseToolSetup(undefined),
  {
    workspacePath = WORKSPACE_PATH,
    reposRoot = REPOS_ROOT,
    gitBinary = "git",
    loadDependencyCache = loadDefaultDependencyCache,
    loadPypiLockfiles = loadDefaultPypiLockfiles,
    loadResultBundle = loadDefaultResultBundle,
    planRoot = PLAN_ROOT,
    loadPlanFolder = loadDefaultPlanFolder,
  } = {},
) {
  if (!isAbsolute(socketPath)) throw new Error("tool_socket_path_invalid");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const gate = dependencyGate(setup, workspacePath, loadDependencyCache, loadPypiLockfiles);
  const git = gitTools({ workspacePath, reposRoot, gitBinary, loadResultBundle });
  const plan = { root: planRoot, load: loadPlanFolder };
  const server = createServer((socket) => {
    const mcp = toolServer(setup, gate, workspacePath, git, plan);
    // A closed connection ends the server, which aborts its in-flight calls' signals (a prepare stops).
    socket.once("close", () => void mcp.close().catch(() => undefined));
    void mcp.connect(new StdioServerTransport(socket, socket)).catch(() => socket.destroy());
  });
  await new Promise((resolve, reject) => server.listen(socketPath, () => resolve()).once("error", reject));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let setup;
  try {
    setup = parseToolSetup(process.env[TOOL_SETUP_ENV]);
  } catch {
    process.stderr.write(`${JSON.stringify({ error: "tool_setup_invalid" })}\n`);
    process.exit(1);
  }
  await startToolRunner(SOCKET_PATH, setup);
  process.stdout.write(`${TOOL_RUNNER_READY_MESSAGE}\n`);
}
