/**
 * The agent actor's PID 1 (Substrate job launcher). The agent actor runs the unchanged
 * claude-coding-worker, which expects the tool runner's socket at /run/wardby/tool/runner.sock; the
 * tool actor is another actor it cannot reach. This bridge listens on that socket and relays the
 * worker's newline-delimited JSON-RPC lines through the coding proxy's /substrate/ routes, fetches
 * the run's input, and uploads the session transcript and then the result when the worker exits.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts).
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DiagnosticsTail,
  postBestEffort,
  requireProxyUrl,
  startReadyServer,
  stderrLogger,
  waitForRound,
  waitForRunToken,
  withRound,
  type Logger,
} from "./common.js";
import {
  DEFAULT_METADATA_DIR,
  DEFAULT_READY_PORT,
  DEFAULT_TOOL_SOCKET,
  MAX_ROUND,
  NEXT_ROUND_POLL_MS,
  PLACEHOLDER_CAPABILITY,
  WARM_ROUNDS_ENV,
  WORKER_CONTEXT_ROOT,
} from "./constants.js";
import { BridgeError, DEFAULT_POLICY, send, withRetry, type RetryPolicy } from "./http.js";
import { LineSplitter } from "./lines.js";
import { superviseWorker, TRANSCRIPT_DEADLINE_MS, type WorkerHandle } from "./worker-run.js";

export { TRANSCRIPT_DEADLINE_MS, type WorkerHandle } from "./worker-run.js";

const MAX_LINE_CHARS = 4 * 1024 * 1024;
const POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const INPUT_DEADLINE_MS = 5 * 60_000;
const WORKER_ENTRY = "/opt/wardby/claude-coding-worker/main.js";

export interface AgentOptions {
  proxyUrl: string;
  env?: NodeJS.ProcessEnv;
  metadataDir?: string;
  inputPath?: string;
  resultPath?: string;
  transcriptPath?: string;
  socketPath?: string;
  /** 0 picks a free port (tests). */
  readyPort?: number;
  /** Called once the readiness server listens, before the actor's identity is known. */
  onReady?: (port: number) => void;
  /** How often the actor's name is re-read while it is not a run actor's name (default 200 ms). */
  identityPollMs?: number;
  /** Ends a wait for the actor's identity (substrate_bridge_stopped). */
  signal?: AbortSignal;
  /** Starts the worker with this environment. The default spawns `node /opt/wardby/claude-coding-worker/main.js`. */
  launchWorker?: (env: NodeJS.ProcessEnv) => WorkerHandle;
  log?: Logger;
  policy?: RetryPolicy;
  /** How long a line (either direction) may keep failing before its connection is dropped. */
  giveUpMs?: number;
  /** How long the transcript upload may take before the bridge gives up on it and reports the result (default 2 min). */
  transcriptDeadlineMs?: number;
  /** Warm rounds: the worker's native-mode context directory, removed before each later round (tests). */
  contextRoot?: string;
  /** Warm rounds: how long to wait between asks for the next round's input (default 1 s). */
  nextRoundPollMs?: number;
  /** Warm rounds: called once a round's uploads are done (tests and the bridge's own log). */
  onRoundDone?: (round: number) => void;
  /** Warm rounds: called when a later round's worker starts, with the session it resumes (if any). */
  onRoundStarted?: (round: number, resumeSessionId: string | undefined) => void;
}

export interface AgentHandle {
  runToken: string;
  readyPort: number;
  /** Resolves with the worker's exit code. */
  workerExited: Promise<number>;
  /** Resolves once the transcript and result uploads have finished (or been given up on): round 1's. */
  uploaded: Promise<void>;
  /** Whether the bridge stays for follow-up rounds (the template's WARDBY_SUBSTRATE_WARM_ROUNDS=1). */
  warmRounds: boolean;
  close(): Promise<void>;
}

/**
 * The worker, with its stdout and stderr piped through the bridge (and passed on to the bridge's own,
 * so the actor's log is unchanged) so the bridge can read its last lines.
 */
const spawnWorker = (env: NodeJS.ProcessEnv): WorkerHandle => {
  const child = spawn(process.execPath, [WORKER_ENTRY], { env, stdio: ["inherit", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 1));
    }),
  };
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The transcript header is one short JSON line; anything longer is not read. */
const MAX_HEADER_BYTES = 64 * 1024;

/** The session id in the worker's transcript header (its first line), if it wrote one. */
async function transcriptSessionId(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path)).subarray(0, MAX_HEADER_BYTES).toString("utf8");
    const newline = text.indexOf("\n");
    const header = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as { sessionId?: unknown } | null;
    const id = header?.sessionId;
    return typeof id === "string" && SESSION_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Warm rounds: the input the worker reads, with `sessionResume` on (the session file must be kept for
 * the next round to resume it) and, from round 2, `resumeSessionId`. An input that is not a JSON
 * object is written unchanged: the worker refuses it as it would today.
 */
async function writeRoundInput(path: string, body: Buffer, resumeSessionId: string | undefined): Promise<void> {
  let text = body.toString("utf8");
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      text = JSON.stringify({ ...value, sessionResume: true, ...(resumeSessionId ? { resumeSessionId } : {}) });
    }
  } catch {
    // Unchanged.
  }
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

export async function run(options: AgentOptions): Promise<AgentHandle> {
  // The operator-diagnostics tail: the worker's stderr and this bridge's events. The worker holds no
  // real secret (the gateway injects the capability on the wire), only the placeholder. Warm rounds:
  // each round gets a fresh tail, so a round's post carries only that round's worker and events.
  const newTail = (): DiagnosticsTail => new DiagnosticsTail(() => [PLACEHOLDER_CAPABILITY]);
  const baseLog = options.log ?? stderrLogger;
  let diagnostics = newTail();
  let roundLog = diagnostics.logger(baseLog);
  const log: Logger = (event, fields) => roundLog(event, fields);
  const policy = options.policy ?? DEFAULT_POLICY;
  const giveUpMs = options.giveUpMs ?? 60_000;
  const env = options.env ?? process.env;
  const warmRounds = env[WARM_ROUNDS_ENV] === "1";
  const inputPath = options.inputPath ?? "/run/wardby/input/input.json";
  const resultPath = options.resultPath ?? "/run/wardby/output/result.json";
  const transcriptPath = options.transcriptPath ?? "/run/wardby/output/session.jsonl";
  const socketPath = options.socketPath ?? DEFAULT_TOOL_SOCKET;
  // The readiness server first: Substrate's wake-up probe must answer for the golden actor too, which
  // never gets a run actor's name (see waitForRunToken). Nothing touches the network before the name.
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
  const base = `${options.proxyUrl}/substrate/runs/${token}`;
  const headers = { "x-api-key": PLACEHOLDER_CAPABILITY };
  const shutdown = new AbortController();
  const sockets = new Set<Socket>();

  // 1. The input.
  await mkdir(dirname(inputPath), { recursive: true });
  try {
    const input = await withRetry(
      () => send(`${base}/input`, { method: "GET", headers, downloadTo: inputPath, timeoutMs: 5 * 60_000 }),
      { policy, deadlineMs: INPUT_DEADLINE_MS, signal: shutdown.signal },
    );
    if (input.status !== 200) throw new BridgeError("substrate_bridge_input_failed");
  } catch (error) {
    ready.server.close();
    throw error instanceof BridgeError && error.code === "substrate_bridge_input_failed"
      ? error
      : new BridgeError("substrate_bridge_input_failed");
  }
  if (warmRounds) await writeRoundInput(inputPath, await readFile(inputPath), undefined);
  log("substrate_bridge_input_ready", { runToken: token });

  // 2. The tool socket.
  const handleConnection = (socket: Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.pause();
    void relayConnection(socket);
  };

  async function relayConnection(socket: Socket): Promise<void> {
    const splitter = new LineSplitter(MAX_LINE_CHARS);
    const pollAbort = new AbortController();
    const queue: ({ line: string } | { close: true })[] = [];
    let channel: string | undefined;
    let seq = 0;
    let sending = false;
    let failed = false;
    let closedByRelay = false;

    const fail = (code: string, fields: Record<string, string | number> = {}): void => {
      if (failed) return;
      failed = true;
      log(code, { runToken: token, ...(channel ? { channel } : {}), ...fields });
      pollAbort.abort();
      socket.destroy();
      // Tell the relay once, without retrying, so the tool does not keep serving an orphaned channel.
      if (channel !== undefined && !closedByRelay) void closeOnce(channel);
    };
    const closeOnce = (id: string): Promise<void> =>
      postBestEffort(`${base}/channels/${id}/lines`, headers, { close: true });

    const pump = async (): Promise<void> => {
      if (sending || channel === undefined) return;
      sending = true;
      try {
        while (queue.length > 0 && !failed) {
          const item = queue.shift()!;
          const body = "close" in item ? { close: true } : { seq: ++seq, line: item.line };
          const text = JSON.stringify(body);
          const sentSeq = "close" in item ? 0 : seq;
          try {
            const result = await withRetry(
              () =>
                send(`${base}/channels/${channel}/lines`, {
                  method: "POST",
                  headers: { ...headers, "content-type": "application/json" },
                  body: text,
                  timeoutMs: REQUEST_TIMEOUT_MS,
                }),
              { policy, deadlineMs: giveUpMs },
            );
            if (result.status !== 200) fail("substrate_bridge_send_rejected", { status: result.status, seq: sentSeq });
          } catch {
            fail("substrate_bridge_send_failed", { seq: sentSeq });
          }
        }
      } finally {
        sending = false;
      }
    };

    // Writes to the worker's socket are not paused on backpressure: events arrive one poll at a
    // time and a worker that does not read stalls only its own connection.
    socket.on("data", (chunk: string) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        fail("substrate_bridge_line_too_long");
        return;
      }
      for (const line of lines) queue.push({ line });
      void pump();
    });
    socket.on("error", () => undefined);
    socket.once("close", () => {
      pollAbort.abort();
      if (failed || closedByRelay || channel === undefined) return;
      queue.push({ close: true });
      void pump();
    });

    // Open the channel before the worker's first line is read.
    try {
      const opened = await withRetry(
        () => send(`${base}/channels`, { method: "POST", headers, timeoutMs: REQUEST_TIMEOUT_MS }),
        { policy, deadlineMs: giveUpMs },
      );
      const parsed = opened.status === 200 ? (JSON.parse(opened.body.toString("utf8")) as { channel?: unknown }) : {};
      if (typeof parsed.channel !== "string") return fail("substrate_bridge_open_rejected", { status: opened.status });
      channel = parsed.channel;
    } catch {
      return fail("substrate_bridge_open_failed");
    }
    if (socket.destroyed) {
      // The worker went away while the open was in flight: close what was just opened.
      if (!failed) void closeOnce(channel);
      return;
    }
    log("substrate_bridge_channel_open", { runToken: token, channel });
    socket.resume();
    void pump();

    // Lines from the tool.
    let cursor = 0;
    let failingSince: number | undefined;
    while (!pollAbort.signal.aborted) {
      let events: { seq: number; type: string; line?: string }[] | undefined;
      let status = 0;
      try {
        const result = await send(`${base}/channels/${channel}/lines?after=${cursor}`, {
          method: "GET",
          headers,
          timeoutMs: POLL_TIMEOUT_MS,
          signal: pollAbort.signal,
        });
        status = result.status;
        if (status === 200) events = (JSON.parse(result.body.toString("utf8")) as { events: typeof events }).events;
      } catch {
        if (pollAbort.signal.aborted) return;
      }
      if (events) {
        failingSince = undefined;
        for (const event of events) {
          if (typeof event.seq !== "number") continue;
          cursor = event.seq;
          if (event.type === "line" && typeof event.line === "string" && !socket.destroyed) {
            socket.write(`${event.line}\n`);
          } else if (event.type === "close") {
            closedByRelay = true;
            socket.end();
            return;
          }
        }
        continue;
      }
      if (status !== 0 && status < 500 && status !== 429) return fail("substrate_bridge_poll_rejected", { status });
      failingSince ??= Date.now();
      if (Date.now() - failingSince > giveUpMs) return fail("substrate_bridge_poll_failed");
      try {
        await policy.sleep(policy.baseMs, pollAbort.signal);
      } catch {
        return;
      }
    }
  }

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const listener: Server = createServer(handleConnection);
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socketPath, () => resolve());
  });

  // 3. The worker, and 4. its transcript and result once it has exited (per round).
  const transcriptDeadlineMs = options.transcriptDeadlineMs ?? TRANSCRIPT_DEADLINE_MS;
  const startRound = (round: number): { exited: Promise<number>; uploaded: Promise<void> } => {
    const tail = diagnostics;
    const worker = (options.launchWorker ?? spawnWorker)({
      ...env,
      WARDBY_PROXY_URL: options.proxyUrl,
      WARDBY_RUN_CAPABILITY: PLACEHOLDER_CAPABILITY,
    });
    log("substrate_bridge_worker_started", { runToken: token, ...(round > 1 ? { round } : {}) });
    return superviseWorker(worker, {
      base,
      round,
      token,
      headers,
      resultPath,
      transcriptPath,
      transcriptDeadlineMs,
      tail,
      policy,
      log,
      signal: shutdown.signal,
    });
  };
  const first = startRound(1);

  /**
   * Warm rounds: after a round's uploads, wait (across the launcher's suspend and resume) for the next
   * round's input, then run the worker again on the same socket, resuming the previous round's
   * Claude Code session. The previous round's output files and the worker's context directory go
   * first, so nothing of it is mistaken for the new round's.
   */
  const followRounds = async (): Promise<void> => {
    let round = 1;
    let uploaded = first.uploaded;
    while (round < MAX_ROUND && !shutdown.signal.aborted) {
      await uploaded;
      options.onRoundDone?.(round);
      const sessionId = await transcriptSessionId(transcriptPath);
      round += 1;
      log("substrate_bridge_waiting_for_round", { runToken: token, round });
      const answer = await waitForRound(
        () =>
          send(withRound(`${base}/input`, round), {
            method: "GET",
            headers,
            timeoutMs: 5 * 60_000,
            signal: shutdown.signal,
          }),
        { pollMs: options.nextRoundPollMs ?? NEXT_ROUND_POLL_MS, signal: shutdown.signal },
      );
      diagnostics = newTail();
      roundLog = diagnostics.logger(baseLog);
      await Promise.all([resultPath, transcriptPath].map((path) => rm(path, { force: true })));
      await rm(options.contextRoot ?? WORKER_CONTEXT_ROOT, { recursive: true, force: true });
      await writeRoundInput(inputPath, answer.body, sessionId);
      log("substrate_bridge_input_ready", { runToken: token, round, resumed: sessionId ? 1 : 0 });
      options.onRoundStarted?.(round, sessionId);
      uploaded = startRound(round).uploaded;
    }
  };
  if (warmRounds) {
    void followRounds().catch((error: unknown) => {
      if (!shutdown.signal.aborted) {
        log("substrate_bridge_round_failed", {
          runToken: token,
          code: error instanceof BridgeError ? error.code : "unexpected",
        });
      }
    });
  }

  return {
    runToken: token,
    readyPort: ready.port,
    workerExited: first.exited,
    uploaded: first.uploaded,
    warmRounds,
    close: async () => {
      shutdown.abort();
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => listener.close(() => resolve())),
        new Promise<void>((resolve) => ready.server.close(() => resolve())),
      ]);
      ready.server.closeAllConnections();
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let handle: AgentHandle;
  try {
    handle = await run({ proxyUrl: requireProxyUrl(env), env });
  } catch (error) {
    stderrLogger(error instanceof BridgeError ? error.code : "substrate_bridge_start_failed");
    process.exit(1);
  }
  await handle.uploaded;
  // Stay alive so the actor's probe keeps answering; the servers hold the event loop open.
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
