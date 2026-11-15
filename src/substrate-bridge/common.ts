/** Pieces both bridges share: identity, logging, the readiness server, uploads. */
import { access, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AGENT_SUFFIX, DIAGNOSTICS_TAIL, RUN_TOKEN_PATTERN, TOOL_SUFFIX } from "./constants.js";
import { LineTail, redactExact, type LineFeed } from "./diagnostics.js";
import { abortableSleep, BridgeError, send, withRetry, type HttpResult, type RetryPolicy } from "./http.js";

/**
 * A bridge log call. `event` is a fixed code; fields are numbers, the run token, channel ids and
 * fixed words. Never a line, body, header value, tool setup or environment.
 */
export type Logger = (event: string, fields?: Record<string, string | number>) => void;

export const stderrLogger: Logger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
};

/** Any run actor's name: the run token and a role suffix. */
const RUN_ACTOR_NAME = new RegExp(`^${RUN_TOKEN_PATTERN.source.slice(1, -1)}(${AGENT_SUFFIX}|${TOOL_SUFFIX})$`);
export const DEFAULT_IDENTITY_POLL_MS = 200;

export interface IdentityWaitOptions {
  log: Logger;
  /** How often `<dir>/name` is re-read while it is not a run actor's name. */
  pollMs?: number;
  /** Ends the wait with substrate_bridge_stopped. */
  signal?: AbortSignal;
}

/**
 * Waits until `<dir>/name` is a run actor's name and returns its run token.
 *
 * Substrate boots each template once as a golden actor and snapshots it; run actors resume from that
 * snapshot. The golden actor's name is not a run actor's name, so a name that is not one (or a file
 * not there yet) means "keep waiting", with no timeout: the snapshot is taken while this loop waits,
 * and after a restore the file holds the run actor's name. A run actor's name of the other role is
 * a misconfiguration: substrate_bridge_identity_invalid.
 */
export async function waitForRunToken(
  metadataDir: string,
  role: "agent" | "tool",
  options: IdentityWaitOptions,
): Promise<string> {
  const suffix = role === "agent" ? AGENT_SUFFIX : TOOL_SUFFIX;
  const pollMs = options.pollMs ?? DEFAULT_IDENTITY_POLL_MS;
  let logged = false;
  for (;;) {
    if (options.signal?.aborted) throw new BridgeError("substrate_bridge_stopped");
    const name = await readFile(`${metadataDir}/name`, "utf8").then(
      (text) => text.trim(),
      () => "",
    );
    const match = RUN_ACTOR_NAME.exec(name);
    if (match) {
      if (match[1] !== suffix) throw new BridgeError("substrate_bridge_identity_invalid");
      return name.slice(0, -suffix.length);
    }
    if (!logged) {
      options.log("substrate_bridge_waiting_for_identity");
      logged = true;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, pollMs);
      function done(): void {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", done);
        resolve();
      }
      options.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export function requireProxyUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.WARDBY_PROXY_URL;
  if (!raw) throw new BridgeError("substrate_bridge_env_missing");
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new BridgeError("substrate_bridge_env_missing");
  }
  return raw.replace(/\/+$/, "");
}

/** GET /readyz -> 200 (the template's wake-up probe). Pass port 0 for an ephemeral port. */
export function startReadyServer(port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/readyz") response.writeHead(200).end("ok");
    else response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

export const UPLOAD_ATTEMPTS = 10;
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type UploadOutcome = "ok" | "skipped" | "rejected" | "failed";

/** Uploads a file with its Content-Length. A missing file is skipped; every 4xx is terminal; transport failures stop after UPLOAD_ATTEMPTS. */
export async function uploadFile(
  url: string,
  headers: Record<string, string>,
  path: string,
  policy: RetryPolicy,
  log: Logger,
  what: string,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  try {
    await access(path);
  } catch {
    return "skipped";
  }
  try {
    const result = await withRetry(
      () => send(url, { method: "POST", headers, uploadFile: path, timeoutMs: UPLOAD_TIMEOUT_MS, signal }),
      { policy, maxAttempts: UPLOAD_ATTEMPTS, signal },
    );
    if (result.status === 200) {
      log("substrate_bridge_uploaded", { what });
      return "ok";
    }
    log("substrate_bridge_upload_rejected", { what, status: result.status });
    return "rejected";
  } catch {
    log("substrate_bridge_upload_failed", { what });
    return "failed";
  }
}

/** One attempt, no retry, no logging, any failure swallowed: for notices that only tidy up (closing an orphaned channel). */
export async function postBestEffort(url: string, headers: Record<string, string>, body?: unknown): Promise<void> {
  try {
    await send(url, {
      method: "POST",
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: 10_000,
    });
  } catch {
    // Nothing to do: the proxy drops idle channels with the run.
  }
}

/** A small POST with the standard retry rules, capped at UPLOAD_ATTEMPTS. True when the proxy answered 200. */
export async function postCapped(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  policy: RetryPolicy,
  log: Logger,
  what: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const result = await withRetry(
      () =>
        send(url, {
          method: "POST",
          headers: text === undefined ? headers : { ...headers, "content-type": "application/json" },
          ...(text === undefined ? {} : { body: text }),
          timeoutMs: 30_000,
          signal,
        }),
      { policy, maxAttempts: UPLOAD_ATTEMPTS, signal },
    );
    if (result.status === 200) {
      log("substrate_bridge_posted", { what });
      return true;
    }
    log("substrate_bridge_post_rejected", { what, status: result.status });
    return false;
  } catch {
    log("substrate_bridge_post_failed", { what });
    return false;
  }
}

/** How many times a diagnostics tail is tried: it is a courtesy to the operator, never worth a long wait. */
export const DIAGNOSTICS_ATTEMPTS = 3;

/**
 * A bridge's operator-diagnostics tail (CLAUDE.md's operator-diagnostics exception): its child
 * processes' stderr plus its own log events, the last DIAGNOSTICS_TAIL lines, each line redacted by
 * exact value against `secrets()` (every secret value delivered to those processes) once complete.
 * Posted at most once, and only after a failure.
 */
export class DiagnosticsTail {
  readonly tail: LineTail;
  private readonly own: LineFeed;
  private sent = false;

  constructor(secrets: () => readonly string[]) {
    this.tail = new LineTail(DIAGNOSTICS_TAIL.lines, DIAGNOSTICS_TAIL.bytes, (line) => redactExact(line, secrets()));
    this.own = this.tail.feed();
  }

  /** Wraps a logger so the bridge's own events (fixed codes and numbers) are part of the tail. */
  logger(log: Logger): Logger {
    return (event, fields = {}) => {
      log(event, fields);
      this.own.push(`${JSON.stringify({ event, ...fields })}\n`);
    };
  }

  /** Posts the tail once (text/plain, Content-Length), with a few quick retries; failures are only logged. */
  async post(
    url: string,
    headers: Record<string, string>,
    policy: RetryPolicy,
    log: Logger,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.sent) return;
    this.sent = true;
    const body = this.tail.text();
    if (body === "") return;
    try {
      const result = await withRetry(
        () =>
          send(url, {
            method: "POST",
            headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
            body,
            timeoutMs: 10_000,
            signal,
          }),
        { policy, maxAttempts: DIAGNOSTICS_ATTEMPTS, signal },
      );
      if (result.status === 200) log("substrate_bridge_posted", { what: "diagnostics" });
      else log("substrate_bridge_post_rejected", { what: "diagnostics", status: result.status });
    } catch {
      log("substrate_bridge_post_failed", { what: "diagnostics" });
    }
  }
}

/** Appends a round to a URL that may already carry a query. */
export function withRound(url: string, round: number): string {
  if (round <= 1) return url;
  return `${url}${url.includes("?") ? "&" : "?"}round=${round}`;
}

/**
 * Warm rounds: asks for a later round's file until it is there (200), however long that takes. Every
 * other answer (404 while the round is not staged, 401 while the actor still runs on a finished
 * run's capability, 5xx, a network error, a request cut by a suspend) means wait and ask again.
 * Resolves with the 200 answer; rejects only when `signal` aborts.
 */
export async function waitForRound(
  ask: () => Promise<HttpResult>,
  options: { pollMs: number; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): Promise<HttpResult> {
  const sleep = options.sleep ?? abortableSleep;
  for (;;) {
    if (options.signal?.aborted) throw new BridgeError("substrate_bridge_stopped");
    try {
      const result = await ask();
      if (result.status === 200) return result;
    } catch {
      // A transient failure: ask again.
    }
    try {
      await sleep(options.pollMs, options.signal);
    } catch {
      throw new BridgeError("substrate_bridge_stopped");
    }
  }
}
