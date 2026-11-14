/**
 * The agent actor's PID 1 (Substrate job launcher). The agent actor runs the unchanged
 * claude-coding-worker, which expects the tool runner's socket at /run/wardby/tool/runner.sock; the
 * tool actor is another actor it cannot reach. This bridge listens on that socket and relays the
 * worker's newline-delimited JSON-RPC lines through the coding proxy's /substrate/ routes, fetches
 * the run's input, and uploads the result and the session transcript when the worker exits.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts).
 */
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  postBestEffort,
  postCapped,
  readRunToken,
  requireProxyUrl,
  startReadyServer,
  stderrLogger,
  uploadFile,
  type Logger,
} from "./common.js";
import { DEFAULT_METADATA_DIR, DEFAULT_READY_PORT, DEFAULT_TOOL_SOCKET, PLACEHOLDER_CAPABILITY } from "./constants.js";
import { BridgeError, DEFAULT_POLICY, send, withRetry, type RetryPolicy } from "./http.js";
import { LineSplitter } from "./lines.js";

const MAX_LINE_CHARS = 4 * 1024 * 1024;
const POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const INPUT_DEADLINE_MS = 5 * 60_000;
const WORKER_ENTRY = "/opt/wardby/claude-coding-worker/main.js";

export interface WorkerHandle {
  exited: Promise<number>;
}

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
  /** Starts the worker with this environment. The default spawns `node /opt/wardby/claude-coding-worker/main.js`. */
  launchWorker?: (env: NodeJS.ProcessEnv) => WorkerHandle;
  log?: Logger;
  policy?: RetryPolicy;
  /** How long a line (either direction) may keep failing before its connection is dropped. */
  giveUpMs?: number;
}

export interface AgentHandle {
  runToken: string;
  readyPort: number;
  /** Resolves with the worker's exit code. */
  workerExited: Promise<number>;
  /** Resolves once the result and transcript uploads have finished (or been given up on). */
  uploaded: Promise<void>;
  close(): Promise<void>;
}

const spawnWorker = (env: NodeJS.ProcessEnv): WorkerHandle => {
  const child = spawn(process.execPath, [WORKER_ENTRY], { env, stdio: "inherit" });
  return {
    exited: new Promise<number>((resolve) => {
      child.once("error", () => resolve(1));
      child.once("exit", (code) => resolve(code ?? 1));
    }),
  };
};

export async function run(options: AgentOptions): Promise<AgentHandle> {
  const log = options.log ?? stderrLogger;
  const policy = options.policy ?? DEFAULT_POLICY;
  const giveUpMs = options.giveUpMs ?? 60_000;
  const env = options.env ?? process.env;
  const inputPath = options.inputPath ?? "/run/wardby/input/input.json";
  const resultPath = options.resultPath ?? "/run/wardby/output/result.json";
  const transcriptPath = options.transcriptPath ?? "/run/wardby/output/session.jsonl";
  const socketPath = options.socketPath ?? DEFAULT_TOOL_SOCKET;
  const token = await readRunToken(options.metadataDir ?? DEFAULT_METADATA_DIR, "agent");
  const base = `${options.proxyUrl}/substrate/runs/${token}`;
  const headers = { "x-api-key": PLACEHOLDER_CAPABILITY };
  const shutdown = new AbortController();
  const sockets = new Set<Socket>();

  const ready = await startReadyServer(options.readyPort ?? DEFAULT_READY_PORT);

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

  // 3. The worker.
  const worker = (options.launchWorker ?? spawnWorker)({
    ...env,
    WARDBY_PROXY_URL: options.proxyUrl,
    WARDBY_RUN_CAPABILITY: PLACEHOLDER_CAPABILITY,
  });
  log("substrate_bridge_worker_started", { runToken: token });

  // 4. Result and transcript, once the worker has exited.
  const uploaded = worker.exited.then(async (code) => {
    log("substrate_bridge_worker_exited", { runToken: token, code });
    const outcome = await uploadFile(`${base}/result`, headers, resultPath, policy, log, "result", shutdown.signal);
    // No usable result: tell the proxy the worker is gone (it also asks the tool for the workspace).
    if (outcome !== "ok") await postCapped(`${base}/exit`, headers, { code }, policy, log, "exit", shutdown.signal);
    await uploadFile(`${base}/transcript`, headers, transcriptPath, policy, log, "transcript", shutdown.signal);
  });

  return {
    runToken: token,
    readyPort: ready.port,
    workerExited: worker.exited,
    uploaded,
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
