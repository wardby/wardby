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
 * The worker's calls on a run with git history (#536, claude-coding-worker/driver.ts): a git check
 * before the agent starts, and a result bundle per history repository after it has finished. Never
 * the agent's: the worker's SDK options disallow both (sdk.ts). The agent's own commands have git
 * here anyway, so neither tool gives a command anything it lacks. Each answers small JSON; the
 * bundle is written into the repository's .git and never crosses the socket.
 */
export const GIT_CHECK_TOOL = "wardby_git_check";
export const RESULT_BUNDLE_TOOL = "wardby_result_bundle";
const COMMIT = /^[0-9a-f]{40}$/;
const RESULT_BUNDLE_CODE = /^result_bundle_[a-z_]+$/;

/** The result bundle module (src/coding-worker/result-bundle.mjs), the same file the Codex driver
 *  ships: the image copies it to /opt/wardby/coding-worker/, as the dependency cache. */
const loadDefaultResultBundle = () => import("../coding-worker/result-bundle.mjs");

/** The dependency cache module (src/coding-worker/dependency-cache.mjs): the image copies it to
 *  /opt/wardby/coding-worker/, the same path relative to this file as in the repository. */
const loadDefaultDependencyCache = () => import("../coding-worker/dependency-cache.mjs");

/**
 * Process-wide, across every socket connection: the dependency cache runs at most once, only
 * before the first command, and the first command never starts while it is still running. Before
 * the first command the run's upload window is always sealed (memoized; the proxy's seal is
 * idempotent), whether or not prepare ran, failed or was skipped, so nothing a command (the
 * agent) does can be uploaded as a snapshot. The proxy's upload deadline is the backstop.
 */
function dependencyGate(setup, workspacePath, loadDependencyCache) {
  let preparing;
  let sealing;
  let commandStarted = false;
  const env = () => commandEnvironment(setup, workspacePath);
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
    /**
     * `deadlineAt`: the run's deadline (ISO), which the worker passes; the cache then takes at most
     * half the time left before it (dependencyCacheTimeLimit), the budget walk included. `signal`:
     * the call's own (aborted when the worker's connection closes): the work stops and settles.
     */
    prepare({ deadlineAt, signal } = {}) {
      if (preparing) return preparing;
      if (commandStarted) return Promise.resolve({ projects: [], reason: "already_started" });
      preparing = (async () => {
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
    async beforeCommand() {
      commandStarted = true;
      if (!setup.dependencyCache) return;
      if (preparing) await preparing;
      await seal();
    },
  };
}

/** run_command's description: the run's time limits, so the model can ask for more on a long command. */
export function runCommandDescription(limits) {
  const seconds = (ms) => `${Math.floor(ms / 1000)} s`;
  const base = "Run one bounded shell command in the isolated repository workspace.";
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
    async bundle({ path, baseCommit, excludeCommits }) {
      try {
        const module = await loadResultBundle();
        const repoPath = module.resolveHistoryPath(path, { workspace: workspacePath, reposRoot });
        if (repoPath === null) return { ok: false, reason: "result_bundle_path_invalid" };
        const result = await module.createResultBundle({ repoPath, baseCommit, excludeCommits, gitBinary });
        return result.bundled ? { ok: true, bundled: true } : { ok: true, bundled: false, reason: result.reason };
      } catch (error) {
        const code =
          error instanceof Error && RESULT_BUNDLE_CODE.test(error.message) ? error.message : "result_bundle_failed";
        return { ok: false, reason: code };
      }
    },
  };
}

function toolServer(setup, gate, workspacePath, git) {
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
      const result = await runCommand(command, timeout_ms ?? limits.defaultMs, workspacePath, setup);
      return {
        content: [{ type: "text", text: `exit_code=${result.code}\n${result.output}` }],
        isError: result.code !== 0,
      };
    },
  );
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
      },
    },
    async ({ path, base_commit, exclude_commits }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await git.bundle({ path, baseCommit: base_commit, excludeCommits: exclude_commits })),
        },
      ],
    }),
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
    loadResultBundle = loadDefaultResultBundle,
  } = {},
) {
  if (!isAbsolute(socketPath)) throw new Error("tool_socket_path_invalid");
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const gate = dependencyGate(setup, workspacePath, loadDependencyCache);
  const git = gitTools({ workspacePath, reposRoot, gitBinary, loadResultBundle });
  const server = createServer((socket) => {
    const mcp = toolServer(setup, gate, workspacePath, git);
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
