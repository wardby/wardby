/**
 * The one actor of a Codex run's PID 1 (Substrate job launcher). A Codex run has no tool actor: the
 * unchanged Codex worker runs its tools itself, in /workspace. This bridge fetches the run's setup,
 * then its seed, then its input through the coding proxy (strictly in that order: the proxy deletes
 * the setup when the input is first downloaded), starts the worker in header mode, uploads its result
 * when it exits, ends the worker's whole process group, and uploads the workspace.
 *
 * The worker holds only the placeholder capability (the egress gateway injects the real one on the
 * wire) and the run's registry-only token, which the setup carries because it cannot be derived from a
 * placeholder. The token is a secret value: it is never logged, and the diagnostics tail and the
 * worker's output passed on to the actor's log are redacted against it and the placeholders. The
 * setup body is never logged.
 *
 * Extra repositories (the setup's `repositories`): each one's seed is extracted into /repos/<name>
 * after the /workspace seed and before the input, a read one made read-only (the boundary is the
 * proxy and the launcher, which never let a read repository's content out). Once the worker's group
 * is ended, each writable one is uploaded first, then /workspace as before (its upload writes `done`).
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * There are no warm rounds here.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DiagnosticsTail,
  mcpWorkerEnv,
  postCapped,
  requireProxyUrl,
  startReadyServer,
  stderrLogger,
  waitForRunToken,
  withoutMcpEnv,
  type Logger,
} from "./common.js";
import {
  CAPABILITY_HEADER_ENV,
  CODEX_WORKER_ENTRY,
  DEFAULT_METADATA_DIR,
  DEFAULT_READY_PORT,
  PLACEHOLDER_CAPABILITY,
  REGISTRY_TOKEN_ENV,
  REPOSITORY_MOUNT_ROOT,
  REGISTRY_TOKEN_SHAPE,
  WORKER_PLACEHOLDERS,
} from "./constants.js";
import { pipeRedacted, type LineSink } from "./diagnostics.js";
import { BridgeError, DEFAULT_POLICY, send, withRetry, type RetryPolicy } from "./http.js";
import { parseCollectExclusions, type CollectExclusions } from "./tar.js";
import { superviseWorker, type WorkerHandle } from "./worker-run.js";
import {
  collectRepositories,
  collectWorkspace,
  endGroup,
  extractRepositorySeeds,
  extractSeed,
  fetchSetup,
  parseSetupRepositories,
  signalGroup,
  type SetupRepository,
} from "./workspace.js";

const SETUP_DEADLINE_MS = 5 * 60_000;
const INPUT_DEADLINE_MS = 5 * 60_000;
/** How long the worker's process group gets after SIGTERM before SIGKILL. */
const GROUP_GRACE_MS = 2_000;

export interface CodexOptions {
  proxyUrl: string;
  env?: NodeJS.ProcessEnv;
  metadataDir?: string;
  workspace?: string;
  /** Where the extra repositories are extracted, one folder each (default /repos). */
  reposRoot?: string;
  /** Where the seed and the workspace tar are staged (outside the workspace). */
  tempRoot?: string;
  /** The tar executable (default `tar`, GNU tar in the images). */
  tarCommand?: string;
  /** 0 picks a free port (tests). */
  readyPort?: number;
  /** Called once the readiness server listens, before the actor's identity is known. */
  onReady?: (port: number) => void;
  /** How often the actor's name is re-read while it is not a run actor's name (default 200 ms). */
  identityPollMs?: number;
  /** Ends a wait for the actor's identity (substrate_bridge_stopped). */
  signal?: AbortSignal;
  inputPath?: string;
  resultPath?: string;
  /**
   * Starts the worker with this environment. The default spawns `node /opt/wardby/coding-worker/main.js`
   * in its own process group, its output redacted against `secrets` (the bridge's live list).
   */
  launchWorker?: (env: NodeJS.ProcessEnv, secrets: () => readonly string[]) => WorkerHandle;
  policy?: RetryPolicy;
  log?: Logger;
  /** Tests only: runs after the result bundle is opened and checked, before `.git` is checked again. */
  beforeResultBundleRecheck?: () => Promise<void> | void;
}

export interface CodexHandle {
  runToken: string;
  readyPort: number;
  /** Resolves with the worker's exit code. */
  workerExited: Promise<number>;
  /** Resolves once the workspace upload finished (or was given up on), after the result or exit report. */
  collected: Promise<"ok" | "rejected" | "failed">;
  close(): Promise<void>;
}

/** What the bridge reads from the setup file (providers/jobs/codex-worker-setup.ts CodexWorkerSetup). */
interface CodexSetup {
  registryToken: string;
  exclusions: CollectExclusions;
  collectResultBundle: boolean;
  /** The run's extra repositories ([] without them). */
  repositories: SetupRepository[];
}

/**
 * The checked setup, or undefined. `onSecret` receives the registry token (any string there) before
 * anything else happens, so it is redacted from every later log line and tail.
 */
function parseSetup(body: Buffer, onSecret: (value: string) => void): CodexSetup | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const setup = value as Record<string, unknown>;
  if (typeof setup.registryToken === "string" && setup.registryToken !== "") onSecret(setup.registryToken);
  if (setup.schemaVersion !== 1) return undefined;
  if (typeof setup.registryToken !== "string" || !REGISTRY_TOKEN_SHAPE.test(setup.registryToken)) return undefined;
  const exclusions = parseCollectExclusions(setup.collectExclude);
  if (!exclusions) return undefined;
  if (setup.collectResultBundle !== undefined && setup.collectResultBundle !== true) return undefined;
  const repositories = parseSetupRepositories(setup.repositories);
  if (!repositories) return undefined;
  return {
    registryToken: setup.registryToken,
    exclusions,
    collectResultBundle: setup.collectResultBundle === true,
    repositories,
  };
}

/**
 * The worker in its own process group (so the bridge can end every process its tools started), with
 * its stdout and stderr piped through the bridge so it can read their last lines, and passed on to the
 * bridge's own (the actor's log) line by line, redacted by exact value against `secrets()` (read for
 * every line: the placeholder and the registry token).
 */
export const spawnCodexWorker = (
  env: NodeJS.ProcessEnv,
  secrets: () => readonly string[],
  entry: string = CODEX_WORKER_ENTRY,
  out: { stdout: LineSink; stderr: LineSink } = process,
): WorkerHandle => {
  const child = spawn(process.execPath, [entry], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  void pipeRedacted(child.stdout, out.stdout, secrets);
  void pipeRedacted(child.stderr, out.stderr, secrets);
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    child,
    exited: new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 1));
    }),
  };
};

export async function run(options: CodexOptions): Promise<CodexHandle> {
  // Every secret value this actor holds: the placeholders (capability and MCP token), and once the
  // setup is read the run's registry-only token. The diagnostics tail (the worker's stderr and this bridge's events) and the
  // worker's output passed on to the actor's log are redacted against them by exact value.
  const secrets: string[] = [...WORKER_PLACEHOLDERS];
  const diagnostics = new DiagnosticsTail(() => secrets);
  const log = diagnostics.logger(options.log ?? stderrLogger);
  const policy = options.policy ?? DEFAULT_POLICY;
  const env = options.env ?? process.env;
  const workspace = options.workspace ?? "/workspace";
  const reposRoot = options.reposRoot ?? REPOSITORY_MOUNT_ROOT;
  const tar = options.tarCommand ?? "tar";
  const inputPath = options.inputPath ?? "/run/wardby/input/input.json";
  const resultPath = options.resultPath ?? "/run/wardby/output/result.json";
  // 1. The readiness server first: Substrate's wake-up probe must answer for the golden actor too,
  // which never gets a run actor's name (see waitForRunToken). Nothing touches the network before it.
  const ready = await startReadyServer(options.readyPort ?? DEFAULT_READY_PORT);
  options.onReady?.(ready.port);
  const token = await waitForRunToken(options.metadataDir ?? DEFAULT_METADATA_DIR, "agent", {
    log,
    pollMs: options.identityPollMs,
    signal: options.signal,
  }).catch((error: unknown) => {
    ready.server.close();
    throw error;
  });
  // 2. The placeholder: the egress gateway replaces it with the run's capability.
  const base = `${options.proxyUrl}/substrate/runs/${token}`;
  const headers = { "x-api-key": PLACEHOLDER_CAPABILITY };
  const shutdown = new AbortController();
  const stage = await mkdtemp(join(options.tempRoot ?? tmpdir(), "wardby-bridge-"));

  const cleanup = async (): Promise<void> => {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  /**
   * Fails the run now instead of letting it time out: workspace-failed, then the exit report (this is
   * the only actor, so nobody else would). Best effort: postCapped gives up quietly when the proxy
   * cannot be reached.
   */
  const abortStart = async (code: string): Promise<never> => {
    log(code, { runToken: token });
    await postCapped(`${base}/workspace-failed`, headers, undefined, policy, log, "workspace-failed").catch(
      () => undefined,
    );
    await postCapped(`${base}/exit`, headers, { code: 1 }, policy, log, "exit").catch(() => undefined);
    ready.server.close();
    await cleanup();
    throw new BridgeError(code);
  };

  // 3. The setup (before the input, whose first download deletes it on the proxy).
  let setup: CodexSetup | undefined;
  try {
    const body = await fetchSetup(`${base}/tool-setup`, headers, policy, log, SETUP_DEADLINE_MS);
    setup = parseSetup(body, (value) => secrets.push(value));
  } catch (error) {
    if (error instanceof BridgeError && error.code === "substrate_bridge_setup_failed") return abortStart(error.code);
    throw error;
  }
  if (!setup) return abortStart("substrate_bridge_setup_invalid");
  const { registryToken, exclusions, collectResultBundle, repositories } = setup;
  log("substrate_bridge_setup_ready", { runToken: token });

  // 4. The seed, checked and extracted into the workspace; then each extra repository's, into its folder.
  try {
    await extractSeed({ url: `${base}/seed`, headers, workspace, stage, tar, policy, log });
    await extractRepositorySeeds({ base, headers, reposRoot, repositories, stage, tar, policy, log });
  } catch (error) {
    if (
      error instanceof BridgeError &&
      (error.code === "substrate_bridge_seed_failed" || error.code === "substrate_bridge_seed_unsafe")
    )
      return abortStart(error.code);
    throw error;
  }

  // 5. The input, and from its answer whether the worker gets MCP tools.
  let mcpEnv: Record<string, string>;
  try {
    await mkdir(dirname(inputPath), { recursive: true });
    const input = await withRetry(
      () => send(`${base}/input`, { method: "GET", headers, downloadTo: inputPath, timeoutMs: 5 * 60_000 }),
      { policy, deadlineMs: INPUT_DEADLINE_MS },
    );
    if (input.status !== 200) return await abortStart("substrate_bridge_input_failed");
    mcpEnv = mcpWorkerEnv(input.headers);
  } catch (error) {
    if (error instanceof BridgeError && error.code === "substrate_bridge_input_failed") throw error;
    if (error instanceof BridgeError && error.code === "substrate_bridge_stopped") throw error;
    return abortStart("substrate_bridge_input_failed");
  }
  log("substrate_bridge_input_ready", { runToken: token });

  // 6. The worker, in header mode.
  const launch = options.launchWorker ?? spawnCodexWorker;
  const worker = launch(
    {
      ...withoutMcpEnv(env),
      WARDBY_PROXY_URL: options.proxyUrl,
      WARDBY_RUN_CAPABILITY: PLACEHOLDER_CAPABILITY,
      [CAPABILITY_HEADER_ENV]: "x-api-key",
      [REGISTRY_TOKEN_ENV]: registryToken,
      ...mcpEnv,
    },
    () => secrets,
  );
  log("substrate_bridge_worker_started", { runToken: token });

  // 7. Its result once it exited (or the diagnostics tail and the exit report). No transcript: Codex
  // runs have no session resume.
  const supervised = superviseWorker(worker, {
    base,
    round: 1,
    token,
    headers,
    resultPath,
    tail: diagnostics,
    policy,
    log,
    signal: shutdown.signal,
  });

  // 8. Then the worker's whole process group is ended, so no process its tools started can change the
  // workspace or an extra while it is read; the writable extras are uploaded, then the workspace (whose
  // upload writes `done`, after which the proxy refuses an extra's).
  const collected = supervised.uploaded
    .then(async () => {
      if (worker.child) await endGroup(worker.child, GROUP_GRACE_MS, log);
      await collectRepositories({
        base,
        round: 1,
        token,
        headers,
        reposRoot,
        repositories,
        stage,
        tar,
        exclusions,
        beforeResultBundleRecheck: options.beforeResultBundleRecheck,
        policy,
        log,
        signal: shutdown.signal,
      });
      return collectWorkspace({
        base,
        round: 1,
        token,
        headers,
        workspace,
        stage,
        tar,
        exclusions,
        collectResultBundle,
        beforeResultBundleRecheck: options.beforeResultBundleRecheck,
        policy,
        log,
        signal: shutdown.signal,
      });
    })
    .catch((error: unknown): "failed" => {
      if (!shutdown.signal.aborted) {
        log("substrate_bridge_collect_failed", {
          code: error instanceof BridgeError ? error.code : "unexpected",
        });
      }
      return "failed";
    });

  // 9. Idle until closed: the readiness server keeps answering.
  return {
    runToken: token,
    readyPort: ready.port,
    workerExited: supervised.exited,
    collected,
    close: async () => {
      shutdown.abort();
      if (worker.child) signalGroup(worker.child, "SIGKILL", undefined, log);
      await new Promise<void>((resolve) => ready.server.close(() => resolve()));
      ready.server.closeAllConnections();
      await cleanup();
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let handle: CodexHandle;
  try {
    handle = await run({ proxyUrl: requireProxyUrl(env), env });
  } catch (error) {
    stderrLogger(error instanceof BridgeError ? error.code : "substrate_bridge_start_failed");
    process.exit(1);
  }
  await handle.collected;
  // Stay alive so the actor's probe keeps answering; the readiness server holds the event loop open.
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
