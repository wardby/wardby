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
 * Services (the setup's `services`, coding-run services; services.ts): after the seeds and before the
 * input (whose first download deletes the setup and starts the run's clock on the proxy), the bridge
 * writes each service's start script into its script volume and waits for every service to be ready,
 * reporting each change to the proxy. The input is fetched and the worker started only after that
 * gate, and every start.sh is removed once it opens. Nothing of a script (it carries the entry's
 * serviceEnv) or of a state file is logged, and the worker's environment never gets the serviceEnv.
 * When a service fails, exits, never starts or is not ready in time, the bridge fetches no input,
 * posts neither workspace-failed nor exit, and idles with its probe answering (the launcher reads the
 * report and removes the actor).
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * There are no warm rounds here.
 *
 * Image self-check (image-check.ts): once the actor has a run actor's name, and before anything is
 * fetched, the bridge checks that it does not run as root and that its image has the worker entry, GNU
 * tar, a writable /workspace and /run/wardby/input and /run/wardby/output. It runs after the run
 * token, so the golden actor never runs it. The first missing one is posted as `image-incomplete` (an
 * enum item, never free text), and the bridge then idles with its probe answering; it posts neither
 * workspace-failed nor exit. If that post fails after its retries, main exits non-zero instead.
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
  proxyHeaders,
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
  SERVICES_ROOT,
  WORKER_PLACEHOLDERS,
} from "./constants.js";
import { pipeRedacted, type LineSink } from "./diagnostics.js";
import { checkImage, ImageIncompleteError, type ImageCheck } from "./image-check.js";
import { BridgeError, DEFAULT_POLICY, send, withRetry, type RetryPolicy } from "./http.js";
import {
  parseServicesWaitMs,
  parseSetupServices,
  ServicesUnreadyError,
  startServices,
  type SetupService,
} from "./services.js";
import { parseCollectExclusions, type CollectExclusions } from "./tar.js";
import { superviseWorker, type WorkerHandle } from "./worker-run.js";
import {
  collectRepositories,
  collectWorkspace,
  endGroup,
  extractRepositorySeeds,
  type RepositoryFolders,
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
  /** Where the services' script volumes are mounted, `<root>/<i>` each (default /run/wardby-services). */
  servicesRoot?: string;
  /** How often the services' state files are read while the bridge waits for them (default 250 ms). */
  servicesPollMs?: number;
  /** The clock the services wait is measured with (tests only; default Date.now). */
  servicesNow?: () => number;
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
  /** The worker's entry point (default CODEX_WORKER_ENTRY): the default launch and the image check use it. */
  workerEntry?: string;
  /**
   * The image self-check, over the production values (the worker entry, the tar, the workspace and the
   * input and result directories). `false` skips it (tests only).
   */
  imageCheck?: Partial<ImageCheck> | false;
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
  /** The run's services' start scripts, in name order ([] without them). */
  services: SetupService[];
  /** How long the bridge waits for all of them: set exactly when `services` is non-empty. */
  servicesWaitMs?: number;
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
  const services = parseSetupServices(setup.services);
  if (!services) return undefined;
  const servicesWaitMs = parseServicesWaitMs(setup.servicesWaitMs);
  if (services.length > 0 && servicesWaitMs === undefined) return undefined;
  return {
    registryToken: setup.registryToken,
    exclusions,
    collectResultBundle: setup.collectResultBundle === true,
    repositories,
    services,
    ...(services.length > 0 ? { servicesWaitMs } : {}),
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
  const headers = proxyHeaders({ "x-api-key": PLACEHOLDER_CAPABILITY });
  const shutdown = new AbortController();
  // The image self-check: after the run token (the golden actor never runs it), before any fetch
  // and before the temp directory, so a missing prerequisite is reported even on an image whose
  // temp directory cannot be made (that one fails the start, it is not an image item).
  const workerEntry = options.workerEntry ?? CODEX_WORKER_ENTRY;
  const imageCheck = options.imageCheck ?? {};
  const missing =
    imageCheck === false
      ? undefined
      : await checkImage({
          runnerEntry: workerEntry,
          tar,
          workspace,
          runDirs: [dirname(inputPath), dirname(resultPath)],
          ...imageCheck,
        });
  if (missing) {
    log("substrate_bridge_image_incomplete", { runToken: token, item: missing });
    // postCapped retries with the bridge's normal policy; false once it gave up or was refused.
    const reported = await postCapped(
      `${base}/image-incomplete`,
      headers,
      { item: missing },
      policy,
      log,
      "image-incomplete",
      shutdown.signal,
    ).catch(() => false);
    // The readiness server stays open: once reported, the actor keeps answering its probe and idles.
    throw new ImageIncompleteError(
      missing,
      async () => {
        await new Promise<void>((resolve) => ready.server.close(() => resolve()));
        ready.server.closeAllConnections();
      },
      reported,
    );
  }

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

  /** Each extra's folder as seeded, re-checked before it is collected. */
  let repositoryFolders: RepositoryFolders = new Map();
  // 4. The seed, checked and extracted into the workspace; then each extra repository's, into its folder.
  try {
    await extractSeed({ url: `${base}/seed`, headers, workspace, stage, tar, policy, log });
    repositoryFolders = await extractRepositorySeeds({
      base,
      headers,
      reposRoot,
      repositories,
      stage,
      tar,
      policy,
      log,
    });
  } catch (error) {
    if (
      error instanceof BridgeError &&
      (error.code === "substrate_bridge_seed_failed" || error.code === "substrate_bridge_seed_unsafe")
    )
      return abortStart(error.code);
    throw error;
  }

  // The services gate: the input (and so the run's clock on the proxy) and the worker wait for it.
  if (setup.services.length > 0) {
    const gate = await startServices({
      base,
      token,
      headers,
      root: options.servicesRoot ?? SERVICES_ROOT,
      services: setup.services,
      waitMs: setup.servicesWaitMs ?? 0,
      pollMs: options.servicesPollMs,
      policy,
      log,
      signal: shutdown.signal,
      ...(options.servicesNow ? { now: options.servicesNow } : {}),
    });
    // The scripts are no longer needed (and on success no longer on disk): drop this bridge's copies.
    setup.services = [];
    if (!gate.ok) {
      log("substrate_bridge_service_unready", { runToken: token, service: gate.service, reason: gate.reason });
      await cleanup();
      // No input, no workspace-failed and no exit: the launcher reads the report. The probe stays up.
      throw new ServicesUnreadyError(gate.service, gate.reason, async () => {
        shutdown.abort();
        await new Promise<void>((resolve) => ready.server.close(() => resolve()));
        ready.server.closeAllConnections();
      });
    }
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
  const launch =
    options.launchWorker ??
    ((workerEnv: NodeJS.ProcessEnv, workerSecrets: () => readonly string[]) =>
      spawnCodexWorker(workerEnv, workerSecrets, workerEntry));
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
        folders: repositoryFolders,
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
    if (error instanceof ImageIncompleteError && error.reported) {
      // Reported to the proxy; idle with the probe answering (the readiness server holds the event loop open).
      stderrLogger(error.code);
      return;
    }
    if (error instanceof ServicesUnreadyError) {
      // Reported to the proxy as the services' states; idle with the probe answering.
      stderrLogger(error.code);
      return;
    }
    // An unreported image report falls through: exit non-zero so the actor ends and the run fails now.
    stderrLogger(error instanceof BridgeError ? error.code : "substrate_bridge_start_failed");
    process.exit(1);
  }
  await handle.collected;
  // Stay alive so the actor's probe keeps answering; the readiness server holds the event loop open.
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
