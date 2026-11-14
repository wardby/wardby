/**
 * The coding proxy's /substrate/ routes (experimental Substrate job launcher): the agent actor and the
 * tool actor of one run cannot reach each other, so the proxy relays their newline-delimited JSON-RPC
 * lines through a RelayStore and carries the run's files (input, tool setup, seed, result, transcript,
 * workspace) through the blob store.
 *
 * Callers: the agent actor authenticates with the run capability (`x-api-key`, injected by Substrate's
 * egress gateway); the tool actor with its Substrate actor JWT in `x-wardby-actor-jwt` (never
 * `Authorization`, which its package managers use for the registry-only token).
 *
 * Secrets: no header, body, line or token is ever logged or echoed. A log line carries the run token,
 * the route name, the status, byte counts and a duration (and, on a 500, an error kind); an error answer carries one fixed code.
 * The one exception is `POST diagnostics` (CLAUDE.md's operator-diagnostics exception): the agent
 * bridge's bounded stderr tail, redacted here (trusted code) by exact value against every secret
 * value delivered to the run's actors that the proxy can know (the capability the request
 * authenticated with and the registry-only token derived from it), logged at warn to the operator
 * log only, and refused unlogged if a token shape is still in it. A tool-side tail is refused: the
 * tool actor runs the model's commands, and the proxy holds no exact value to redact its tail with.
 *
 * Once the proxy has written a run's `done` marker its outcome is fixed: `workspace` and
 * `workspace-failed` are refused (409 substrate_run_collected), so a late or forged post cannot
 * change it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, Transform } from "node:stream";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../../mcp/transport/http-limits.js";
import { logger } from "../../../core/logger.js";
import { redactExactSecretValues, withEscapedForms } from "../../../core/secret-spans.js";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
import {
  BLOB,
  MAX_ROUND,
  parseRound,
  roundBlob,
  TOOL_ACTOR_JWT_HEADER,
  toolActorSubject,
} from "../../jobs/substrate/names.js";
import { workerDiagnosticOf, type WorkerDiagnostic } from "../../jobs/worker-diagnostic.js";
import { BlobStoreError, type BlobStore } from "../../storage/types.js";
import { capabilityHash } from "../capability-hash.js";
import type { ProxyLedger } from "../types.js";
import type { IdentityResult } from "./actor-identity.js";
import { RelayBackpressureError, RelayBusyError, type RelayStore, RelayUnknownError } from "./relay-store.js";

/** The longest relayed line, in bytes. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** A line post's JSON envelope may be larger than the line (escaping), within this bound. */
const MAX_LINE_BODY_BYTES = 2 * MAX_LINE_BYTES + 4096;
/** The longest exit report body (a code, a diagnostic and up to MAX_CODING_OUTPUT_ISSUES issues). */
const MAX_EXIT_BYTES = 8 * 1024;
/** The longest operator-diagnostics tail (the bridges' DIAGNOSTICS_TAIL.bytes; constants.test.ts keeps them equal). */
export const MAX_DIAGNOSTICS_BYTES = 8 * 1024;
const DEFAULT_POLL_WAIT_MS = 20_000;
/**
 * A run capability (`rrp_…`) or registry-only token (`rrg_…`) shape. A tail with either shape left in
 * it after exact-value redaction (a value the proxy could not know) is refused, not logged.
 */
const TOKEN_SHAPE = /rr[pg]_[A-Za-z0-9_-]/;
/** Runs (per side) whose diagnostics this replica already logged; oldest forgotten first past the cap. */
const DIAGNOSTICS_SEEN_MAX = 10_000;
/** The time an upload has to arrive once it is authenticated. */
export const SUBSTRATE_UPLOAD_MS = 10 * 60_000;

export interface SubstrateRouteOptions {
  atespace: string;
  relay: RelayStore;
  blobs: BlobStore;
  ledger: Pick<ProxyLedger, "findSessionByCapabilityHash">;
  /** Given the tool actor's `x-wardby-actor-jwt` value (`Bearer <jwt>`). */
  verifyActor: (actorJwt: string | undefined, expectedSubject: string) => Promise<IdentityResult>;
  /**
   * The run's token: substrateRunToken, or with warm rounds the token on the run's SubstrateRun row
   * (an adopting run holds the parked run's token).
   */
  tokenForRun: (runId: string) => string | Promise<string>;
  /**
   * Warm rounds (SUBSTRATE_WARM_ROUNDS, experimental): per-round files (`?round=n`, absent = 1) for the
   * round in the token's round record. Off: every request is round 1, exactly as before.
   */
  warmRounds?: boolean;
  limits: { resultBytes: number; transcriptBytes: number; workspaceBytes: number };
  /** Long-poll wait (default 20 s). */
  pollWaitMs?: number;
  /** Time an authenticated upload has to arrive (default 10 min). */
  uploadMs?: number;
  /** Route lines at info; operator diagnostics (and their refusals) at warn. */
  log?: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
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
  | "workspace-failed"
  | "diagnostics";

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
    case "POST diagnostics":
      return { name: "diagnostics", caller: "agent" };
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
  /** `<run token>/<side>` whose diagnostics were logged: a repeat is answered but not logged again. */
  const diagnosticsSeen = new Set<string>();

  async function agentAuth(request: IncomingMessage, token: string): Promise<boolean> {
    const key = request.headers["x-api-key"];
    if (typeof key !== "string" || key === "") return false;
    const session = await options.ledger.findSessionByCapabilityHash(capabilityHash(key));
    return (
      !!session &&
      session.status === "active" &&
      session.deadlineAt.getTime() > Date.now() &&
      (await options.tokenForRun(session.runId)) === token
    );
  }

  /** The round the token's actors are on (warm rounds: the launcher's round record; else 1). */
  async function currentRound(token: string): Promise<number> {
    if (!options.warmRounds) return 1;
    const key = roundBlob(token);
    const info = await options.blobs.head(key);
    if (!info || info.sizeBytes > 1024) return 1;
    try {
      return parseRound((await options.blobs.get(key)).toString("utf8")) ?? 1;
    } catch (error) {
      if (error instanceof BlobStoreError && error.code === "not_found") return 1;
      throw error;
    }
  }

  /**
   * The round a request is for (`?round=n`, absent = 1), which must be the token's current round:
   * a download for another round is not there yet (404, the bridge waits); an upload is refused (409).
   */
  async function roundFor(url: URL, token: string, kind: "download" | "upload"): Promise<number> {
    const raw = url.searchParams.get("round");
    if (raw !== null && !/^[1-9][0-9]{0,3}$/.test(raw)) throw new RouteError(400, "bad_request");
    const requested = raw === null ? 1 : Number(raw);
    if (requested > MAX_ROUND) throw new RouteError(400, "bad_request");
    if (requested !== (await currentRound(token))) {
      throw kind === "download" ? new RouteError(404, "not_found") : new RouteError(409, "round_mismatch");
    }
    return requested;
  }

  async function toolAuth(request: IncomingMessage, token: string): Promise<boolean> {
    const header = request.headers[TOOL_ACTOR_JWT_HEADER.toLowerCase()];
    const result = await options.verifyActor(
      typeof header === "string" ? header : undefined,
      toolActorSubject(options.atespace, token),
    );
    return result.ok;
  }

  async function sendBlob(
    response: ServerResponse,
    key: string,
    contentType: string,
    counter: { bytes: number },
    /** Runs once the blob is known to exist, before anything is sent (a failure answers 500, so the caller retries). */
    beforeSend?: () => Promise<void>,
  ): Promise<void> {
    const source = await options.blobs.getStream(key);
    if (beforeSend) {
      try {
        await beforeSend();
      } catch (error) {
        (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        throw error;
      }
    }
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

  /**
   * The agent bridge's exit report: `{"code": <int>}`, plus the worker's own diagnostic when it printed
   * one (`diagnostic`, optional `diagnosticIssues`), each checked with the shared worker-diagnostic rule.
   * Content-Length required, at most MAX_EXIT_BYTES; any other key or an unsafe value refuses the whole body.
   */
  async function readExitReport(request: IncomingMessage): Promise<{ code: number } & Partial<WorkerDiagnostic>> {
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
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RouteError(400, "bad_request");
    const body = value as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "code" && key !== "diagnostic" && key !== "diagnosticIssues"))
      throw new RouteError(400, "bad_request");
    const code = body.code;
    if (typeof code !== "number" || !Number.isSafeInteger(code) || code < -1_000_000 || code > 1_000_000)
      throw new RouteError(400, "bad_request");
    if (body.diagnostic === undefined) {
      if (body.diagnosticIssues !== undefined) throw new RouteError(400, "bad_request");
      return { code };
    }
    const diagnostic = workerDiagnosticOf(body.diagnostic, body.diagnosticIssues);
    // The shared rule drops an unsafe issues list; here that refuses the report instead.
    if (!diagnostic || (body.diagnosticIssues !== undefined && !diagnostic.diagnosticIssues))
      throw new RouteError(400, "bad_request");
    return { code, ...diagnostic };
  }

  /** A diagnostics tail: Content-Length required, at most MAX_DIAGNOSTICS_BYTES, read as UTF-8 text. */
  async function readDiagnostics(request: IncomingMessage): Promise<string> {
    const length = request.headers["content-length"];
    if (length === undefined) throw new RouteError(411, "length_required");
    if (!/^\d+$/.test(length) || Number(length) > MAX_DIAGNOSTICS_BYTES) throw new RouteError(413, "too_large");
    return readBody(request, MAX_DIAGNOSTICS_BYTES, AbortSignal.timeout(HTTP_LIMITS.requestMs));
  }

  /**
   * The secret values delivered to an agent-authenticated request's run that the proxy can know: the
   * capability it authenticated with (the gateway injects the real one) and the registry-only token
   * derived from it.
   */
  function agentSecretValues(request: IncomingMessage): string[] {
    const key = request.headers["x-api-key"];
    return typeof key === "string" && key !== "" ? [key, deriveRegistryToken(key)] : [];
  }

  /** The run's outcome is fixed once `done` exists: a later workspace report is refused. */
  async function refuseOnceCollected(token: string, round = 1): Promise<void> {
    if (await options.blobs.head(BLOB.done(token, round))) throw new RouteError(409, "substrate_run_collected");
  }

  /** Writes the round's `done` unless it exists (then the post is refused: the first report stands). */
  async function writeDoneOnce(token: string, round: number, workspace: "ok" | "failed"): Promise<void> {
    await refuseOnceCollected(token, round);
    await options.blobs.put(BLOB.done(token, round), Buffer.from(JSON.stringify({ workspace })), {
      contentType: "application/json",
    });
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
      // Diagnostics are agent-side only: a post with the tool's credential header is refused unread.
      if (matched.name === "diagnostics" && request.headers[TOOL_ACTOR_JWT_HEADER.toLowerCase()] !== undefined) {
        throw new RouteError(403, "diagnostics_agent_only");
      }
      const side = matched.caller;
      const allowed = side === "agent" ? await agentAuth(request, token) : await toolAuth(request, token);
      if (!allowed) throw new RouteError(401, "unauthorized");
      const { relay, blobs, limits } = options;
      const channel = matched.channel ?? "";
      switch (matched.name) {
        case "input": {
          // The agent reached the proxy: record it (if not yet recorded) before the input is sent, so
          // a failed write answers 500 and the agent asks again, and the launcher's startup timeout
          // (no `started` record) never fires on a run that did start.
          const round = await roundFor(url, token, "download");
          await sendBlob(response, BLOB.input(token, round), "application/json", counters, async () => {
            if (!(await blobs.head(BLOB.started(token, round)))) {
              await blobs.put(BLOB.started(token, round), Buffer.from("{}"), { contentType: "application/json" });
            }
          });
          return;
        }
        case "tool-setup":
          // Not deleted here: a lost response would strand the run. The first events poll deletes it.
          await roundFor(url, token, "download");
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
          // Per round: a later round stages a new tool setup under the same key.
          const setupKey = `${token}/${await currentRound(token)}`;
          if (!setupDeleted.has(setupKey)) {
            await blobs.delete(BLOB.toolSetup(token)).catch((error: unknown) => {
              if (!(error instanceof BlobStoreError && error.code === "not_found")) throw error;
            });
            setupDeleted.add(setupKey);
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
          const round = await roundFor(url, token, "upload");
          counters.bytes = await receiveBlob(request, BLOB.result(token, round), limits.resultBytes, clearBodyTimer);
          await relay.requestCollect(token);
          sendJson(response, 200, {});
          return;
        }
        case "transcript": {
          const round = await roundFor(url, token, "upload");
          counters.bytes = await receiveBlob(
            request,
            BLOB.transcript(token, round),
            limits.transcriptBytes,
            clearBodyTimer,
          );
          sendJson(response, 200, {});
          return;
        }
        case "workspace": {
          const round = await roundFor(url, token, "upload");
          await refuseOnceCollected(token, round);
          counters.bytes = await receiveBlob(
            request,
            BLOB.workspace(token, round),
            limits.workspaceBytes,
            clearBodyTimer,
          );
          await writeDoneOnce(token, round, "ok");
          await relay.dropRelay(token);
          setupDeleted.delete(`${token}/${round}`);
          sendJson(response, 200, {});
          return;
        }
        case "exit": {
          // The worker exited without a usable result: record its code (and its own safe diagnostic,
          // if it printed one) and still collect the workspace.
          const round = await roundFor(url, token, "upload");
          const report = await readExitReport(request);
          if (!(await blobs.head(BLOB.exit(token, round)))) {
            try {
              await relay.requestCollect(token);
            } catch (error) {
              // The relay was already dropped: the run was collected, so there is nothing left to queue.
              if (!(error instanceof RelayUnknownError)) throw error;
            }
            await blobs.put(BLOB.exit(token, round), Buffer.from(JSON.stringify(report)), {
              contentType: "application/json",
            });
          }
          sendJson(response, 200, {});
          return;
        }
        case "diagnostics": {
          // Operator diagnostics (CLAUDE.md's exception): the agent bridge's bounded stderr tail after
          // a failure, redacted here by exact value whatever the bridge did. It goes to the operator
          // log only: never a blob, the database, an answer, MCP, the viewer or a run record.
          const raw = await readDiagnostics(request);
          counters.bytes = Buffer.byteLength(raw);
          const tail = redactExactSecretValues(raw, withEscapedForms(agentSecretValues(request)));
          if (TOKEN_SHAPE.test(tail)) {
            log.warn(
              { event: "substrate.diagnostics_rejected", runToken: token, side },
              "substrate actor diagnostics rejected",
            );
            throw new RouteError(400, "bad_request");
          }
          const seenKey = `${token}/${side}`;
          if (!diagnosticsSeen.has(seenKey)) {
            diagnosticsSeen.add(seenKey);
            if (diagnosticsSeen.size > DIAGNOSTICS_SEEN_MAX) {
              const oldest = diagnosticsSeen.values().next().value;
              if (oldest !== undefined) diagnosticsSeen.delete(oldest);
            }
            log.warn({ event: "substrate.diagnostics", runToken: token, side, tail }, "substrate actor diagnostics");
          }
          sendJson(response, 200, {});
          return;
        }
        case "workspace-failed": {
          // The tool bridge could not produce the workspace tar: say so and end the relay.
          const round = await roundFor(url, token, "upload");
          await refuseOnceCollected(token, round);
          await writeDoneOnce(token, round, "failed");
          await relay.dropRelay(token);
          setupDeleted.delete(`${token}/${round}`);
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
