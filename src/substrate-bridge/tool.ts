/**
 * The tool actor's PID 1 (Substrate job launcher). The tool actor runs the unchanged
 * claude-tool-runner, which listens on /run/wardby/tool/runner.sock; the agent actor is another actor
 * it cannot reach. This bridge fetches the run's tool setup and workspace seed through the coding
 * proxy, starts the tool runner, relays each channel the agent opens into the runner's socket, and
 * uploads the workspace when the proxy asks for it.
 *
 * Image self-check (image-check.ts): once the actor has a run actor's name, and before anything is
 * fetched, the bridge checks that its image has the tool runner, GNU tar, a writable /workspace and
 * /run/wardby/tool. It runs after the run token, so the golden actor never runs it. The first missing
 * one is posted as `image-incomplete` (an enum item, never free text), and the bridge then idles with
 * its probe answering; it posts neither workspace-failed nor anything else.
 *
 * Extra repositories (the setup's `repositories`): each one's seed is extracted into /repos/<name>
 * after the /workspace seed and before the runner starts, a read one made read-only (the boundary is
 * the proxy and the launcher, which never let a read repository's content out). At the collect, each
 * writable one is uploaded first, then /workspace as before (its upload writes `done`); when any of
 * them collects a result bundle, the runner's process group is ended first.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts); the tool setup is never logged and only
 * reaches the tool runner's environment. This bridge sends no operator-diagnostics tail: model-run
 * commands share this actor and its proxy credential, so only the agent side's tail is accepted
 * (the proxy refuses a tool-side one; see routes.ts). Its children's stderr goes to the actor's log.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  postBestEffort,
  postCapped,
  requireProxyUrl,
  startReadyServer,
  stderrLogger,
  waitForRound,
  waitForRunToken,
  withRound,
  withoutMcpEnv,
  proxyHeaders,
  type Logger,
} from "./common.js";
import {
  DEFAULT_METADATA_DIR,
  DEFAULT_READY_PORT,
  DEFAULT_TOOL_SOCKET,
  ACTOR_JWT_HEADER,
  GATEWAY_ACTOR_JWT_PLACEHOLDER,
  MAX_ROUND,
  NEXT_ROUND_POLL_MS,
  REPOSITORY_MOUNT_ROOT,
  WARM_ROUNDS_ENV,
} from "./constants.js";
import { waitAtMost } from "./diagnostics.js";
import { checkImage, ImageIncompleteError, type ImageCheck } from "./image-check.js";
import { BridgeError, DEFAULT_POLICY, send, withRetry, type RetryPolicy } from "./http.js";
import { LineSplitter } from "./lines.js";
import { parseCollectExclusions, type CollectExclusions } from "./tar.js";
import {
  collectRepositories,
  collectWorkspace,
  extractRepositorySeeds,
  type RepositoryFolders,
  extractSeed,
  fetchSetup,
  parseSetupRepositories,
  signalGroup,
  type SetupRepository,
} from "./workspace.js";

export { signalGroup as signalRunnerGroup, type GroupSignalTarget } from "./workspace.js";

const MAX_LINE_CHARS = 4 * 1024 * 1024;
const EVENTS_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SETUP_DEADLINE_MS = 5 * 60_000;
const RUNNER_ENTRY = "/opt/wardby/claude-tool-runner/main.mjs";
const READY_LINE = "wardby_tool_runner_ready";
/** Warm rounds: how long, after the bridge ends a round's runner, it waits for the runner to exit. */
const RUNNER_STOP_MS = 2_000;

export interface RunnerHandle {
  /** Resolves when the runner is listening; rejects if it exits first. */
  ready: Promise<void>;
  exited: Promise<number>;
  /** The runner's stderr, when the bridge can read it (passed on to the actor's log only). */
  stderr?: NodeJS.ReadableStream;
  /** Ends the runner (warm rounds: between rounds, before the next round's runner starts). */
  stop?: () => void;
  /**
   * Force-ends the runner and every process it started (its process group), whether or not the
   * runner itself already exited. Warm rounds call it after stop, so no process a round's tool started
   * keeps that round's environment into the next round.
   */
  kill?: () => void;
}

export interface ToolOptions {
  proxyUrl: string;
  env?: NodeJS.ProcessEnv;
  metadataDir?: string;
  workspace?: string;
  /** Where the extra repositories are extracted, one folder each (default /repos). */
  reposRoot?: string;
  socketPath?: string;
  /** 0 picks a free port (tests). */
  readyPort?: number;
  /** Called once the readiness server listens, before the actor's identity is known. */
  onReady?: (port: number) => void;
  /** How often the actor's name is re-read while it is not a run actor's name (default 200 ms). */
  identityPollMs?: number;
  /** Ends a wait for the actor's identity (substrate_bridge_stopped). */
  signal?: AbortSignal;
  /** Starts the tool runner with this tool setup. The default spawns `node <runnerEntry>`. */
  launchRunner?: (toolSetup: string, env: NodeJS.ProcessEnv) => RunnerHandle;
  /** The tool runner's entry point (default /opt/wardby/claude-tool-runner/main.mjs): the default launch and the image check use it. */
  runnerEntry?: string;
  /**
   * The image self-check, over the production values (the runner entry, the tar, the workspace and
   * the socket's directory). `false` skips it (tests only).
   */
  imageCheck?: Partial<ImageCheck> | false;
  log?: Logger;
  policy?: RetryPolicy;
  giveUpMs?: number;
  /** The tar executable (default `tar`, GNU tar in the images). */
  tarCommand?: string;
  /** Where the seed and the workspace tar are staged (outside the workspace). */
  tempRoot?: string;
  /** Warm rounds: how long to wait between asks for the next round's tool setup (default 1 s). */
  nextRoundPollMs?: number;
  /** Warm rounds: called once a round's workspace upload is done, with its outcome. */
  onRoundCollected?: (round: number, outcome: "ok" | "rejected" | "failed") => void;
  /** Warm rounds: called once a later round's tool runner is ready. */
  onRoundStarted?: (round: number) => void;
  /** Tests only: runs after the result bundle is opened and checked, before `.git` is checked again. */
  beforeResultBundleRecheck?: () => Promise<void> | void;
}

export interface ToolHandle {
  runToken: string;
  readyPort: number;
  /** Resolves once the agent asked for the workspace and the upload finished (or was given up on): round 1's. */
  collected: Promise<"ok" | "rejected" | "failed">;
  /** Whether the bridge stays for follow-up rounds (the template's WARDBY_SUBSTRATE_WARM_ROUNDS=1). */
  warmRounds: boolean;
  /** Resolves with the tool runner's exit code if it ever exits. */
  runnerExited: Promise<number>;
  close(): Promise<void>;
}

export const spawnRunner = (toolSetup: string, env: NodeJS.ProcessEnv, entry: string = RUNNER_ENTRY): RunnerHandle => {
  const child = spawn(process.execPath, [entry], {
    // Nothing MCP-related ever reaches the tool runner (only the agent's worker gets the MCP env).
    env: { ...withoutMcpEnv(env), WARDBY_TOOL_SETUP: toolSetup },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so stop and kill reach every process the runner's tools started.
    detached: true,
  });
  const signalChildGroup = (signal: NodeJS.Signals): void => {
    signalGroup(child, signal);
  };
  // Passed on unchanged to the actor's log.
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const ready = new Promise<void>((resolve, reject) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line === READY_LINE) resolve();
      else process.stdout.write(`${line}\n`);
    });
    void exited.then(() => reject(new BridgeError("substrate_bridge_runner_exited")));
  });
  return {
    ready,
    exited,
    stderr: child.stderr,
    stop: () => signalChildGroup("SIGTERM"),
    kill: () => signalChildGroup("SIGKILL"),
  };
};

/** The tool-setup file the proxy serves: the runner's setup plus what the bridge itself needs. */
interface SetupFile {
  toolSetup?: unknown;
  collectExclude?: unknown;
  /** Set (true) only on a git-history run. */
  collectResultBundle?: unknown;
  /** The run's extra repositories (names and access), only on a run that has them. */
  repositories?: unknown;
}

/** The events of a 200 answer; undefined (a transient error to the caller) unless every event is an object with an integer seq. */
function parseEvents(body: Buffer): { seq: number; type: string; channel?: string; line?: string }[] | undefined {
  try {
    const parsed = (JSON.parse(body.toString("utf8")) as { events?: unknown } | null)?.events;
    if (!Array.isArray(parsed)) return undefined;
    for (const event of parsed as unknown[]) {
      if (event === null || typeof event !== "object" || !Number.isSafeInteger((event as { seq?: unknown }).seq))
        return undefined;
    }
    return parsed as { seq: number; type: string; channel?: string; line?: string }[];
  } catch {
    return undefined;
  }
}

export async function run(options: ToolOptions): Promise<ToolHandle> {
  const log = options.log ?? stderrLogger;
  const policy = options.policy ?? DEFAULT_POLICY;
  const giveUpMs = options.giveUpMs ?? 60_000;
  const env = options.env ?? process.env;
  const warmRounds = env[WARM_ROUNDS_ENV] === "1";
  const workspace = options.workspace ?? "/workspace";
  const reposRoot = options.reposRoot ?? REPOSITORY_MOUNT_ROOT;
  const tar = options.tarCommand ?? "tar";
  const socketPath = options.socketPath ?? DEFAULT_TOOL_SOCKET;
  // The readiness server first: Substrate's wake-up probe must answer for the golden actor too, which
  // never gets a run actor's name (see waitForRunToken). Nothing touches the network before the name.
  const ready = await startReadyServer(options.readyPort ?? DEFAULT_READY_PORT);
  options.onReady?.(ready.port);
  const token = await waitForRunToken(options.metadataDir ?? DEFAULT_METADATA_DIR, "tool", {
    log,
    pollMs: options.identityPollMs,
    signal: options.signal,
  }).catch((error: unknown) => {
    ready.server.close();
    throw error;
  });
  const base = `${options.proxyUrl}/substrate/runs/${token}`;
  const headers = proxyHeaders({ [ACTOR_JWT_HEADER]: GATEWAY_ACTOR_JWT_PLACEHOLDER });
  const shutdown = new AbortController();
  const stage = await mkdtemp(join(options.tempRoot ?? tmpdir(), "wardby-bridge-"));
  const connections = new Map<string, { socket: Socket; relayClosed(): void }>();
  let stopped = false;

  const cleanup = async (): Promise<void> => {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  const abortStart = async (code: string): Promise<never> => {
    log(code, { runToken: token });
    // Tell the run once so the launcher fails it now instead of the agent timing out on a tool runner
    // that never starts (best effort: postCapped gives up quietly when the proxy cannot be reached).
    await postCapped(
      `${base}/workspace-failed`,
      headers,
      undefined,
      policy,
      log,
      "workspace-failed",
      shutdown.signal,
    ).catch(() => undefined);
    ready.server.close();
    await cleanup();
    throw new BridgeError(code);
  };

  // 0. The image self-check: after the run token (the golden actor never runs it), before any fetch.
  const runnerEntry = options.runnerEntry ?? RUNNER_ENTRY;
  const imageCheck = options.imageCheck ?? {};
  const missing =
    imageCheck === false
      ? undefined
      : await checkImage({ runnerEntry, tar, workspace, runDirs: [dirname(socketPath)], ...imageCheck });
  if (missing) {
    log("substrate_bridge_image_incomplete", { runToken: token, item: missing });
    await postCapped(
      `${base}/image-incomplete`,
      headers,
      { item: missing },
      policy,
      log,
      "image-incomplete",
      shutdown.signal,
    ).catch(() => undefined);
    await cleanup();
    // The readiness server stays open: the actor keeps answering its probe and idles.
    throw new ImageIncompleteError(missing, async () => {
      await new Promise<void>((resolve) => ready.server.close(() => resolve()));
      ready.server.closeAllConnections();
    });
  }

  // 1. The tool setup (before the first events poll, which deletes it on the proxy). It carries the
  // run's registry-only token; once the runner has started, the runner is its only holder (`current`).
  let toolSetup: string;
  let exclusions: CollectExclusions;
  // A git-history run (#536): the upload carries only the root .git's result bundle (see collect).
  let collectResultBundle = false;
  // The run's extra repositories (round 1 only: a run with them never has a later round).
  let repositories: SetupRepository[] = [];
  try {
    const body = await fetchSetup(`${base}/tool-setup`, headers, policy, log, SETUP_DEADLINE_MS);
    const parsed = JSON.parse(body.toString("utf8")) as SetupFile;
    if (typeof parsed.toolSetup !== "string") return await abortStart("substrate_bridge_setup_invalid");
    const parsedExclusions = parseCollectExclusions(parsed.collectExclude);
    if (!parsedExclusions) return await abortStart("substrate_bridge_exclude_invalid");
    const parsedRepositories = parseSetupRepositories(parsed.repositories);
    if (!parsedRepositories) return await abortStart("substrate_bridge_setup_invalid");
    toolSetup = parsed.toolSetup;
    exclusions = parsedExclusions;
    collectResultBundle = parsed.collectResultBundle === true;
    repositories = parsedRepositories;
  } catch (error) {
    if (
      error instanceof BridgeError &&
      error.code !== "substrate_bridge_retry_exhausted" &&
      error.code !== "substrate_bridge_setup_failed"
    )
      throw error;
    return abortStart("substrate_bridge_setup_failed");
  }
  log("substrate_bridge_setup_ready", { runToken: token });

  /** Each extra's folder as seeded, re-checked before it is collected. */
  let repositoryFolders: RepositoryFolders = new Map();
  // 2. The seed, checked and extracted into the workspace; then each extra repository's, into its folder.
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

  // 3. The tool runner (warm rounds: one per round, each with its round's tool setup).
  let resolveRunnerExited!: (code: number) => void;
  const runnerExited = new Promise<number>((resolve) => (resolveRunnerExited = resolve));
  /**
   * The current round's runner, and whether the bridge itself is ending it (between rounds). It is
   * the only holder of the round's tool setup (and so of its registry-only token) once started.
   */
  let current: { runner: RunnerHandle; retiring: boolean } | undefined;
  const startRunner = async (setup: string): Promise<boolean> => {
    const runner = options.launchRunner ? options.launchRunner(setup, env) : spawnRunner(setup, env, runnerEntry);
    const entry = { runner, retiring: false };
    current = entry;
    try {
      await runner.ready;
    } catch {
      return false;
    }
    // A runner that exits mid-run is a failure; its stderr is in the actor's log. Without warm rounds,
    // every exit resolves runnerExited (main() then ends the actor), as before rounds existed, except
    // a runner the bridge itself ended (between rounds, or before a git-history run's collect).
    void runner.exited.then((code) => {
      if (entry.retiring || (warmRounds && stopped)) return;
      if (!stopped) log("substrate_bridge_runner_exited", { runToken: token, code });
      resolveRunnerExited(code);
    });
    return true;
  };
  if (!(await startRunner(toolSetup))) return abortStart("substrate_bridge_runner_failed");
  log("substrate_bridge_runner_ready", { runToken: token });

  // 4. Channels.
  const openChannel = (channel: string): void => {
    const socket = connect(socketPath);
    socket.setEncoding("utf8");
    const splitter = new LineSplitter(MAX_LINE_CHARS);
    const queue: ({ line: string } | { close: true })[] = [];
    let seq = 0;
    let sending = false;
    let dropped = false;
    let closedByRelay = false;
    const drop = (code: string, fields: Record<string, string | number> = {}): void => {
      if (dropped) return;
      dropped = true;
      log(code, { runToken: token, channel, ...fields });
      socket.destroy();
      // Tell the relay once, without retrying, so the agent does not keep serving an orphaned channel.
      if (!closedByRelay) void postBestEffort(`${base}/channels/${channel}/from-tool`, headers, { close: true });
    };
    const pump = async (): Promise<void> => {
      if (sending) return;
      sending = true;
      try {
        while (queue.length > 0 && !dropped) {
          const item = queue.shift()!;
          const body = "close" in item ? { close: true } : { seq: ++seq, line: item.line };
          const text = JSON.stringify(body);
          try {
            const result = await withRetry(
              () =>
                send(`${base}/channels/${channel}/from-tool`, {
                  method: "POST",
                  headers: { ...headers, "content-type": "application/json" },
                  body: text,
                  timeoutMs: REQUEST_TIMEOUT_MS,
                }),
              { policy, deadlineMs: giveUpMs },
            );
            if (result.status !== 200) drop("substrate_bridge_send_rejected", { status: result.status });
          } catch {
            drop("substrate_bridge_send_failed");
          }
        }
      } finally {
        sending = false;
      }
    };
    // Writes to the runner's socket are not paused on backpressure: events arrive one poll at a
    // time and a runner that does not read stalls only its own connection.
    socket.on("data", (chunk: string) => {
      try {
        for (const line of splitter.push(chunk)) queue.push({ line });
      } catch {
        drop("substrate_bridge_line_too_long");
        return;
      }
      void pump();
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      if (connections.get(channel)?.socket === socket) connections.delete(channel);
      if (dropped || closedByRelay) return;
      queue.push({ close: true });
      void pump();
    });
    connections.set(channel, {
      socket,
      relayClosed: () => {
        closedByRelay = true;
      },
    });
  };

  let resolveCollected!: (outcome: "ok" | "rejected" | "failed") => void;
  const collected = new Promise<"ok" | "rejected" | "failed">((resolve) => (resolveCollected = resolve));

  let round = 1;
  const collect = async (): Promise<"ok" | "rejected" | "failed"> => {
    // A history run (of the workspace or of any extra) first ends the runner's whole process group, so
    // no tool process is left to change a folder while it is read (only its result bundle is added back).
    if (collectResultBundle || repositories.some((r) => r.collectResultBundle)) await retireRunner();
    // The writable extras first: the /workspace upload writes `done`, after which the proxy refuses them.
    await collectRepositories({
      base,
      round,
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
      round,
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
  };

  /** One round's relay: polls events from 0 (the relay starts afresh each round) until the collect. */
  const eventsLoop = async (): Promise<"ok" | "rejected" | "failed" | undefined> => {
    let cursor = 0;
    while (!stopped) {
      type ToolEvent = { seq: number; type: string; channel?: string; line?: string };
      let events: ToolEvent[] | undefined;
      let rejected = false;
      const before = cursor;
      try {
        const result = await send(`${base}/events?after=${cursor}`, {
          method: "GET",
          headers,
          timeoutMs: EVENTS_TIMEOUT_MS,
          signal: shutdown.signal,
        });
        if (result.status === 200) events = parseEvents(result.body);
        else rejected = result.status < 500 && result.status !== 429;
      } catch {
        if (stopped) return undefined;
      }
      if (!events) {
        // Retry forever; a refused poll (the run is over) backs off harder than a network blip.
        try {
          await policy.sleep(rejected ? policy.maxMs : policy.baseMs, shutdown.signal);
        } catch {
          return undefined;
        }
        continue;
      }
      for (const event of events) {
        cursor = event.seq;
        const channel = typeof event.channel === "string" ? event.channel : "";
        if (event.type === "open" && channel) openChannel(channel);
        else if (event.type === "line" && typeof event.line === "string") {
          const socket = connections.get(channel)?.socket;
          if (socket && !socket.destroyed) socket.write(`${event.line}\n`);
        } else if (event.type === "close") {
          const connection = connections.get(channel);
          connection?.relayClosed();
          connection?.socket.end();
        } else if (event.type === "collect") {
          // The relay is dropped once the workspace is uploaded: stop polling (and idle, or with
          // warm rounds wait for the next round).
          if (!warmRounds) stopped = true;
          return collect();
        }
      }
      // A non-empty answer that did not move the cursor would be polled again at once: wait first.
      if (events.length > 0 && cursor === before) {
        try {
          await policy.sleep(policy.baseMs, shutdown.signal);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };

  /**
   * Ends the round's runner and drops it. The round's registry-only token belongs to a finished run,
   * and the runner is its only holder: once this returns, nothing of the bridge refers to it, so a
   * suspended actor holds no copy. (Its own function, so no frame that waits for the next round keeps
   * the runner alive.)
   */
  const retireRunner = async (): Promise<void> => {
    const retired = current;
    current = undefined;
    if (!retired) return;
    retired.retiring = true;
    if (retired.runner.stop) {
      retired.runner.stop();
      await waitAtMost(retired.runner.exited, RUNNER_STOP_MS);
    }
    // Whatever is left of the runner's process group after the grace period (the runner itself if it
    // ignored SIGTERM, or a process one of its tools started) holds round n's environment: end it.
    if (retired.runner.kill) {
      retired.runner.kill();
      await waitAtMost(retired.runner.exited, RUNNER_STOP_MS);
    }
  };

  /**
   * Warm rounds: after a round's workspace is stored, end its tool runner (its registry token belongs
   * to a finished run) and wait, across the launcher's suspend and resume, for the next round's tool
   * setup. /workspace stays as it is (repository, virtualenvs, installs): it is not seeded again.
   */
  const nextRound = async (): Promise<boolean> => {
    await retireRunner();
    for (const { socket } of connections.values()) socket.destroy();
    connections.clear();
    round += 1;
    log("substrate_bridge_waiting_for_round", { runToken: token, round });
    const answer = await waitForRound(
      () =>
        send(withRound(`${base}/tool-setup`, round), {
          method: "GET",
          headers,
          timeoutMs: REQUEST_TIMEOUT_MS,
          signal: shutdown.signal,
        }),
      { pollMs: options.nextRoundPollMs ?? NEXT_ROUND_POLL_MS, signal: shutdown.signal },
    );
    let setup: string;
    try {
      const parsed = JSON.parse(answer.body.toString("utf8")) as SetupFile;
      const parsedExclusions = parseCollectExclusions(parsed.collectExclude);
      if (typeof parsed.toolSetup !== "string" || !parsedExclusions) throw new Error("invalid");
      // A run with extra repositories always starts cold and never has a later round (W1).
      if (parsed.repositories !== undefined) throw new Error("invalid");
      setup = parsed.toolSetup;
      exclusions = parsedExclusions;
      collectResultBundle = parsed.collectResultBundle === true;
    } catch {
      log("substrate_bridge_setup_invalid", { runToken: token, round });
      return false;
    }
    if (!(await startRunner(setup))) {
      log("substrate_bridge_runner_failed", { runToken: token, round });
      await postCapped(
        withRound(`${base}/workspace-failed`, round),
        headers,
        undefined,
        policy,
        log,
        "workspace-failed",
        shutdown.signal,
      ).catch(() => undefined);
      return false;
    }
    log("substrate_bridge_runner_ready", { runToken: token, round });
    options.onRoundStarted?.(round);
    return true;
  };

  const rounds = async (): Promise<void> => {
    for (;;) {
      const outcome = await eventsLoop();
      if (outcome === undefined) return;
      if (round === 1) resolveCollected(outcome);
      options.onRoundCollected?.(round, outcome);
      // Without warm rounds (or after a failed collect, which the launcher never parks): idle.
      if (!warmRounds || outcome !== "ok" || round >= MAX_ROUND) {
        stopped = true;
        return;
      }
      if (!(await nextRound())) {
        stopped = true;
        return;
      }
    }
  };
  void rounds().catch((error: unknown) => {
    if (!shutdown.signal.aborted) {
      log("substrate_bridge_round_failed", {
        runToken: token,
        code: error instanceof BridgeError ? error.code : "unexpected",
      });
    }
  });

  return {
    runToken: token,
    readyPort: ready.port,
    collected,
    runnerExited,
    warmRounds,
    close: async () => {
      stopped = true;
      shutdown.abort();
      for (const { socket } of connections.values()) socket.destroy();
      await new Promise<void>((resolve) => ready.server.close(() => resolve()));
      ready.server.closeAllConnections();
      await cleanup();
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    const handle = await run({ proxyUrl: requireProxyUrl(env), env });
    void handle.runnerExited.then(() => process.exit(1));
  } catch (error) {
    if (error instanceof ImageIncompleteError) {
      // Reported to the proxy; idle with the probe answering (the readiness server holds the event loop open).
      stderrLogger(error.code);
      return;
    }
    stderrLogger(error instanceof BridgeError ? error.code : "substrate_bridge_start_failed");
    process.exit(1);
  }
  // Stay alive: the readiness server and the runner hold the event loop open; the runner's exit ends the process.
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
