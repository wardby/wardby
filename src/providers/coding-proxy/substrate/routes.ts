/**
 * The coding proxy's /substrate/ routes (experimental Substrate job launcher): the agent actor and the
 * tool actor of one run cannot reach each other, so the proxy relays their newline-delimited JSON-RPC
 * lines through a RelayStore and carries the run's files (input, tool setup, seed, result, transcript,
 * workspace) through the blob store.
 *
 * Callers: the agent actor authenticates with the run capability (`x-api-key`, injected by Substrate's
 * egress gateway); the tool actor with its Substrate actor JWT.
 *
 * Secrets: no header, body, line or token is ever logged or echoed. A log line carries the run token,
 * the route name, the status, byte counts and a duration (and, on a 500, an error kind); an error answer carries one fixed code.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, Transform } from "node:stream";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../../mcp/transport/http-limits.js";
import { logger } from "../../../core/logger.js";
import { BLOB, toolActorSubject } from "../../jobs/substrate/names.js";
import { BlobStoreError, type BlobStore } from "../../storage/types.js";
import { capabilityHash } from "../capability-hash.js";
import type { ProxyLedger } from "../types.js";
import type { IdentityResult } from "./actor-identity.js";
import { RelayBackpressureError, RelayBusyError, type RelayStore, RelayUnknownError } from "./relay-store.js";

/** The longest relayed line, in bytes. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** A line post's JSON envelope may be larger than the line (escaping), within this bound. */
const MAX_LINE_BODY_BYTES = 2 * MAX_LINE_BYTES + 4096;
/** The longest exit report body. */
const MAX_EXIT_BYTES = 1024;
const DEFAULT_POLL_WAIT_MS = 20_000;
/** The time an upload has to arrive once it is authenticated. */
export const SUBSTRATE_UPLOAD_MS = 10 * 60_000;

export interface SubstrateRouteOptions {
  atespace: string;
  relay: RelayStore;
  blobs: BlobStore;
  ledger: Pick<ProxyLedger, "findSessionByCapabilityHash">;
  verifyActor: (authorization: string | undefined, expectedSubject: string) => Promise<IdentityResult>;
  /** substrateRunToken */
  tokenForRun: (runId: string) => string;
  limits: { resultBytes: number; transcriptBytes: number; workspaceBytes: number };
  /** Long-poll wait (default 20 s). */
  pollWaitMs?: number;
  /** Time an authenticated upload has to arrive (default 10 min). */
  uploadMs?: number;
  log?: { info(fields: Record<string, unknown>, message: string): void };
}

type Caller = "agent" | "tool";
type RouteName =
  | "input"
  | "channels.open"
  | "channels.send"
  | "channels.poll"
  | "result"
  | "transcript"
  | "tool-setup"
  | "seed"
  | "events"
  | "channels.from-tool"
  | "workspace"
  | "exit"
  | "workspace-failed";

interface Matched {
  name: RouteName;
  caller: Caller;
  channel?: string;
}

const RUN_PATH = /^\/substrate\/runs\/(wr-[0-9a-f]{20})\/(.+)$/;
const CHANNEL_PATH = /^channels\/(c[0-9]{1,9})\/(lines|from-tool)$/;

function match(method: string, rest: string): Matched | undefined {
  const channel = CHANNEL_PATH.exec(rest);
  if (channel) {
    if (channel[2] === "lines" && method === "POST")
      return { name: "channels.send", caller: "agent", channel: channel[1] };
    if (channel[2] === "lines" && method === "GET")
      return { name: "channels.poll", caller: "agent", channel: channel[1] };
    if (channel[2] === "from-tool" && method === "POST")
      return { name: "channels.from-tool", caller: "tool", channel: channel[1] };
    return undefined;
  }
  const key = `${method} ${rest}`;
  switch (key) {
    case "GET input":
      return { name: "input", caller: "agent" };
    case "POST channels":
      return { name: "channels.open", caller: "agent" };
    case "POST result":
      return { name: "result", caller: "agent" };
    case "POST transcript":
      return { name: "transcript", caller: "agent" };
    case "GET tool-setup":
      return { name: "tool-setup", caller: "tool" };
    case "GET seed":
      return { name: "seed", caller: "tool" };
    case "GET events":
      return { name: "events", caller: "tool" };
    case "POST workspace":
      return { name: "workspace", caller: "tool" };
    case "POST exit":
      return { name: "exit", caller: "agent" };
    case "POST workspace-failed":
      return { name: "workspace-failed", caller: "tool" };
    default:
      return undefined;
  }
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { ...JSON_HEADERS, ...headers }).end(JSON.stringify(body));
}

function sendError(request: IncomingMessage, response: ServerResponse, error: RouteError): void {
  // A request body that was not read: close the connection rather than keep reading it.
  if (!request.complete) response.setHeader("connection", "close");
  sendJson(response, error.status, { error: { type: error.code } }, error.headers);
}

/** The fixed answer for a failure inside a route. Nothing of the failure's own text is used. */
function classify(error: unknown): RouteError {
  if (error instanceof RouteError) return error;
  if (error instanceof RelayUnknownError) return new RouteError(404, "relay_unknown");
  if (error instanceof RelayBackpressureError) return new RouteError(429, "relay_backpressure", { "retry-after": "1" });
  if (error instanceof RelayBusyError) return new RouteError(503, "relay_busy", { "retry-after": "1" });
  if (error instanceof BlobStoreError) {
    if (error.code === "not_found") return new RouteError(404, "not_found");
    if (error.code === "blob_too_large") return new RouteError(413, "too_large");
  }
  if (error instanceof HttpBoundaryError) {
    if (error.status === 413) return new RouteError(413, "too_large");
    if (error.status === 408) return new RouteError(408, "request_timeout");
    return new RouteError(400, "bad_request");
  }
  return new RouteError(500, "internal_error");
}

/** What kind of failure a 500 was: the Prisma error code when present, else the constructor name. Never the message. */
function errorKindOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
  const name = (error as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : "unknown";
}

function afterParam(url: URL): number {
  const raw = url.searchParams.get("after");
  if (raw === null) return 0;
  if (!/^\d{1,12}$/.test(raw)) throw new RouteError(400, "bad_request");
  return Number(raw);
}

type LinePost = { close: true } | { close?: false; seq: number; line: string };

function parseLinePost(raw: string): LinePost {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RouteError(400, "bad_request");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RouteError(400, "bad_request");
  const body = value as { close?: unknown; seq?: unknown; line?: unknown };
  if (body.close === true) return { close: true };
  if (typeof body.seq !== "number" || !Number.isSafeInteger(body.seq) || body.seq < 1 || typeof body.line !== "string")
    throw new RouteError(400, "bad_request");
  if (Buffer.byteLength(body.line) > MAX_LINE_BYTES) throw new RouteError(413, "too_large");
  return { seq: body.seq, line: body.line };
}

function countBytes(): { stream: Transform; bytes(): number } {
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, bytes: () => bytes };
}

export function createSubstrateRoutes(
  options: SubstrateRouteOptions,
): (request: IncomingMessage, response: ServerResponse, clearBodyTimer?: () => void) => Promise<void> {
  const log = options.log ?? logger.child({ module: "coding-proxy-substrate" });
  const pollWaitMs = options.pollWaitMs ?? DEFAULT_POLL_WAIT_MS;
  const uploadMs = options.uploadMs ?? SUBSTRATE_UPLOAD_MS;
  /** Runs whose tool setup this replica already deleted (saves a blob call on every later poll). */
  const setupDeleted = new Set<string>();
  const SETUP_DELETED_MAX = 10_000;

  async function agentAuth(request: IncomingMessage, token: string): Promise<boolean> {
    const key = request.headers["x-api-key"];
    if (typeof key !== "string" || key === "") return false;
    const session = await options.ledger.findSessionByCapabilityHash(capabilityHash(key));
    return (
      !!session &&
      session.status === "active" &&
      session.deadlineAt.getTime() > Date.now() &&
      options.tokenForRun(session.runId) === token
    );
  }

  async function toolAuth(request: IncomingMessage, token: string): Promise<boolean> {
    const result = await options.verifyActor(request.headers.authorization, toolActorSubject(options.atespace, token));
    return result.ok;
  }

  async function sendBlob(
    response: ServerResponse,
    key: string,
    contentType: string,
    counter: { bytes: number },
  ): Promise<void> {
    const source = await options.blobs.getStream(key);
    const meter = countBytes();
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
    await new Promise<void>((resolve) => {
      pipeline(source, meter.stream, response, () => {
        counter.bytes = meter.bytes();
        if (!response.destroyed && !response.writableEnded) response.destroy();
        resolve();
      });
    });
  }

  /** Streams the request body into a blob within `maxBytes`; returns its size. */
  async function receiveBlob(
    request: IncomingMessage,
    key: string,
    maxBytes: number,
    clearBodyTimer: (() => void) | undefined,
  ): Promise<number> {
    const length = request.headers["content-length"];
    if (length === undefined) throw new RouteError(411, "length_required");
    if (!/^\d+$/.test(length) || Number(length) > maxBytes) throw new RouteError(413, "too_large");
    clearBodyTimer?.();
    const timer = setTimeout(() => request.destroy(), uploadMs);
    timer.unref();
    try {
      const stored = await options.blobs.putStream(key, request, { maxBytes });
      return stored.sizeBytes;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(request: IncomingMessage): Promise<string> {
    return readBody(request, MAX_LINE_BODY_BYTES, AbortSignal.timeout(HTTP_LIMITS.requestMs));
  }

  /** The agent bridge's `{"code": <int>}` (Content-Length required, at most MAX_EXIT_BYTES). */
  async function readExitCode(request: IncomingMessage): Promise<number> {
    const length = request.headers["content-length"];
    if (length === undefined) throw new RouteError(411, "length_required");
    if (!/^\d+$/.test(length) || Number(length) > MAX_EXIT_BYTES) throw new RouteError(413, "too_large");
    const raw = await readBody(request, MAX_EXIT_BYTES, AbortSignal.timeout(HTTP_LIMITS.requestMs));
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new RouteError(400, "bad_request");
    }
    const code = (value as { code?: unknown } | null)?.code;
    if (typeof code !== "number" || !Number.isSafeInteger(code) || code < -1_000_000 || code > 1_000_000)
      throw new RouteError(400, "bad_request");
    return code;
  }

  return async (request, response, clearBodyTimer) => {
    const startedAt = performance.now();
    const url = new URL(request.url ?? "/", "http://substrate.invalid");
    const found = RUN_PATH.exec(url.pathname);
    const matched = found ? match(request.method ?? "", found[2]) : undefined;
    const token = found?.[1] ?? "unknown";
    const route = matched?.name ?? "unmatched";
    const counters = { bytes: 0 };
    let errorKind: string | undefined;
    response.once("close", () => {
      log.info(
        {
          event: "substrate.route",
          runToken: token,
          route,
          status: response.statusCode,
          bytes: counters.bytes,
          durationMs: Math.round(performance.now() - startedAt),
          ...(errorKind ? { errorKind } : {}),
        },
        "coding proxy substrate route",
      );
    });
    try {
      if (!found || !matched) throw new RouteError(404, "not_found");
      const allowed = matched.caller === "agent" ? await agentAuth(request, token) : await toolAuth(request, token);
      if (!allowed) throw new RouteError(401, "unauthorized");
      const { relay, blobs, limits } = options;
      const channel = matched.channel ?? "";
      switch (matched.name) {
        case "input":
          await sendBlob(response, BLOB.input(token), "application/json", counters);
          return;
        case "tool-setup":
          // Not deleted here: a lost response would strand the run. The first events poll deletes it.
          await sendBlob(response, BLOB.toolSetup(token), "application/json", counters);
          return;
        case "seed":
          await sendBlob(response, BLOB.seed(token), "application/x-tar", counters);
          return;
        case "channels.open":
          sendJson(response, 200, { channel: await relay.openChannel(token) });
          return;
        case "channels.send": {
          const post = parseLinePost(await readJson(request));
          if (post.close) await relay.closeFromAgent(token, channel);
          else await relay.fromAgent(token, channel, post.seq, post.line);
          counters.bytes = post.close ? 0 : Buffer.byteLength(post.line);
          sendJson(response, 200, {});
          return;
        }
        case "channels.from-tool": {
          const post = parseLinePost(await readJson(request));
          if (post.close) await relay.closeFromTool(token, channel);
          else await relay.fromTool(token, channel, post.seq, post.line);
          counters.bytes = post.close ? 0 : Buffer.byteLength(post.line);
          sendJson(response, 200, {});
          return;
        }
        case "channels.poll": {
          const controller = new AbortController();
          response.once("close", () => controller.abort());
          const events = await relay.pollAgent(token, channel, afterParam(url), pollWaitMs, controller.signal);
          sendJson(response, 200, { events });
          return;
        }
        case "events": {
          if (!setupDeleted.has(token)) {
            await blobs.delete(BLOB.toolSetup(token));
            setupDeleted.add(token);
            if (setupDeleted.size > SETUP_DELETED_MAX) {
              const oldest = setupDeleted.values().next().value;
              if (oldest !== undefined) setupDeleted.delete(oldest);
            }
          }
          const controller = new AbortController();
          response.once("close", () => controller.abort());
          const events = await relay.pollTool(token, afterParam(url), pollWaitMs, controller.signal);
          sendJson(response, 200, { events });
          return;
        }
        case "result": {
          counters.bytes = await receiveBlob(request, BLOB.result(token), limits.resultBytes, clearBodyTimer);
          await relay.requestCollect(token);
          sendJson(response, 200, {});
          return;
        }
        case "transcript":
          counters.bytes = await receiveBlob(request, BLOB.transcript(token), limits.transcriptBytes, clearBodyTimer);
          sendJson(response, 200, {});
          return;
        case "workspace": {
          counters.bytes = await receiveBlob(request, BLOB.workspace(token), limits.workspaceBytes, clearBodyTimer);
          await blobs.put(BLOB.done(token), Buffer.from(JSON.stringify({ workspace: "ok" })), {
            contentType: "application/json",
          });
          await relay.dropRelay(token);
          setupDeleted.delete(token);
          sendJson(response, 200, {});
          return;
        }
        case "exit": {
          // The worker exited without a usable result: record its code and still collect the workspace.
          const code = await readExitCode(request);
          await blobs.put(BLOB.exit(token), Buffer.from(JSON.stringify({ code })), {
            contentType: "application/json",
          });
          await relay.requestCollect(token);
          sendJson(response, 200, {});
          return;
        }
        case "workspace-failed": {
          // The tool bridge could not produce the workspace tar: say so and end the relay.
          await blobs.put(BLOB.done(token), Buffer.from(JSON.stringify({ workspace: "failed" })), {
            contentType: "application/json",
          });
          await relay.dropRelay(token);
          setupDeleted.delete(token);
          sendJson(response, 200, {});
          return;
        }
      }
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      const answer = classify(error);
      if (answer.status === 500) errorKind = errorKindOf(error);
      sendError(request, response, answer);
    }
  };
}
