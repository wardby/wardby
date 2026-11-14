/**
 * HTTP to the coding proxy, with the retry rules the proxy's routes expect: network errors, 429
 * relay_backpressure, 503 relay_busy and other 5xx are retried with backoff (Retry-After honoured);
 * any other status is returned to the caller. Nothing here logs: a URL, header or body never reaches a log.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";

export class BridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  /** The longest Retry-After wait honoured. */
  retryAfterCapMs: number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BridgeError("substrate_bridge_aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BridgeError("substrate_bridge_aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const DEFAULT_POLICY: RetryPolicy = { baseMs: 250, maxMs: 5000, retryAfterCapMs: 10_000, sleep: abortableSleep };

export interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  method: "GET" | "POST";
  headers: Record<string, string>;
  /** A small request body. */
  body?: string;
  /** A file uploaded with its Content-Length. */
  uploadFile?: string;
  /** A 200 response body is written to this file instead of memory. */
  downloadTo?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

const MAX_ERROR_BODY = 1024 * 1024;

export async function send(url: string, options: RequestOptions): Promise<HttpResult> {
  const parsed = new URL(url);
  const make = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const signals = [AbortSignal.timeout(options.timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);
  const headers: Record<string, string> = { ...options.headers };
  let uploadSize: number | undefined;
  if (options.uploadFile !== undefined) {
    uploadSize = (await stat(options.uploadFile)).size;
    headers["content-length"] = String(uploadSize);
  } else if (options.body !== undefined) {
    headers["content-length"] = String(Buffer.byteLength(options.body));
  }
  return new Promise<HttpResult>((resolve, reject) => {
    const req = make(parsed, { method: options.method, headers, signal }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const done = (body: Buffer): void => resolve({ status, headers: response.headers, body });
      if (options.downloadTo !== undefined && status === 200) {
        pipeline(response, createWriteStream(options.downloadTo, { mode: 0o600 })).then(
          () => done(Buffer.alloc(0)),
          reject,
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= MAX_ERROR_BODY) chunks.push(chunk);
      });
      response.once("end", () => done(Buffer.concat(chunks)));
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("aborted")));
    });
    req.once("error", reject);
    if (options.uploadFile !== undefined) {
      pipeline(createReadStream(options.uploadFile), req).catch(reject);
    } else {
      req.end(options.body);
    }
  });
}

export interface RetryOptions {
  policy: RetryPolicy;
  /** Give up after this many attempts. */
  maxAttempts?: number;
  /** Give up once this long has passed since the first attempt. */
  deadlineMs?: number;
  signal?: AbortSignal;
}

const retriable = (status: number): boolean => status === 429 || status >= 500;

function retryAfterMs(result: HttpResult, policy: RetryPolicy): number | undefined {
  const raw = result.headers["retry-after"];
  if (typeof raw !== "string" || !/^\d{1,4}$/.test(raw)) return undefined;
  return Math.min(Number(raw) * 1000, policy.retryAfterCapMs);
}

/** Runs `attempt` until it returns a non-retriable status. Throws substrate_bridge_retry_exhausted when it gives up. */
export async function withRetry(attempt: () => Promise<HttpResult>, options: RetryOptions): Promise<HttpResult> {
  const startedAt = Date.now();
  let delay = options.policy.baseMs;
  for (let n = 1; ; n++) {
    let result: HttpResult | undefined;
    try {
      result = await attempt();
    } catch (error) {
      if (options.signal?.aborted) throw new BridgeError("substrate_bridge_aborted");
      if (error instanceof BridgeError) throw error;
    }
    if (result && !retriable(result.status)) return result;
    if (options.maxAttempts !== undefined && n >= options.maxAttempts)
      throw new BridgeError("substrate_bridge_retry_exhausted");
    const wait = (result ? retryAfterMs(result, options.policy) : undefined) ?? delay;
    if (options.deadlineMs !== undefined && Date.now() - startedAt + wait > options.deadlineMs)
      throw new BridgeError("substrate_bridge_retry_exhausted");
    await options.policy.sleep(wait, options.signal);
    delay = Math.min(delay * 2, options.policy.maxMs);
  }
}
