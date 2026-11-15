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
 * The workspace holder (`tool-setup`, `seed`, `workspace`, `workspace-failed`) is the actor that holds
 * the run's workspace, by the run's actor shape (SubstrateRun.actorShape, looked up by the run token):
 * for a pair run (Claude Code: agent + tool) the tool actor, by its actor JWT only; for a single run
 * (Codex: one agent actor that runs the tools itself) that agent actor, by the run capability only.
 * A request with neither credential header is refused (401) before the shape is looked up. A single
 * run has no tool actor, so its relay routes (`channels*`, `events`) answer 404 before any auth or
 * relay call, `result` and `exit` queue no collect request, and its tool setup is deleted on
 * the first input download (there is no events poll to delete it).
 *
 * Secrets: no header, body, line or token is ever logged or echoed. A log line carries the run token,
 * the route name, the status, byte counts and a duration (and, on a 500, an error kind; on a single
 * run's input, whether it deleted the setup); an error answer carries one fixed code.
 * The one exception is `POST diagnostics` (CLAUDE.md's operator-diagnostics exception): the agent
 * bridge's bounded stderr tail, redacted here (trusted code) by exact value against every secret
 * value delivered to the run's actors that the proxy can know (the capability the request
 * authenticated with and the registry-only token derived from it), logged at warn to the operator
 * log only, and refused unlogged if a token shape is still in it. An MCP token shape (`rmt_`) left
 * in a tail is refused too; the actors hold only its placeholder. A tool-side tail is refused: the
 * tool actor runs the model's commands, and the proxy holds no exact value to redact its tail with.
 *
 * MCP tools: a 200 `input` answer carries MCP_TOOLS_INPUT_HEADER: "1" exactly when the session the
 * request authenticated with has at least one pinned MCP tool, so the agent bridge starts that round's
 * worker in MCP header mode. It is a fixed flag, never a token, pin or name; no other answer has it.
 *
 * Once the proxy has written a run's `done` marker its outcome is fixed: `workspace` and
 * `workspace-failed` are refused (409 substrate_run_collected), so a late or forged post cannot
 * change it.
 *
 * Extra repositories (multi-repository runs): `GET repos/<name>/seed` and `POST repos/<name>/workspace`
 * are holder-only, like `seed` and `workspace`. `<name>` must be a link name (isCodingRepositoryName;
 * anything else is unmatched) listed in the run's row (SubstrateRun.repositories, read with the shape
 * in one lookup): any listed repository's seed can be served, but only a `write` one can be uploaded,
 * so a read repository's content never leaves through the proxy; an unlisted name answers 404 before
 * any body is read. An extra's upload is capped at the workspace limit, refused after `done` (409)
 * and for another round (409), and never writes `done`, drops the relay or touches the setup state:
 * the default `workspace` upload, which the bridge sends last, still ends the run. Nothing of a body
 * is logged; the route line's `repository` field is the validated link name only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline, Transform } from "node:stream";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../../mcp/transport/http-limits.js";
import { logger } from "../../../core/logger.js";
import { redactExactSecretValues, withEscapedForms } from "../../../core/secret-spans.js";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
import { isCodingRepositoryName } from "../../../coding/protocol.js";
import {
  BLOB,
  MAX_ROUND,
  parseRound,
  REPO_BLOB,
  roundBlob,
  TOOL_ACTOR_JWT_HEADER,
  toolActorSubject,
} from "../../jobs/substrate/names.js";
import type { SubstrateRunLayout } from "../../jobs/substrate/run-store.js";
import { workerDiagnosticOf, type WorkerDiagnostic } from "../../jobs/worker-diagnostic.js";
import { BlobStoreError, type BlobStore } from "../../storage/types.js";
import { capabilityHash } from "../capability-hash.js";
import type { ProxyLedger, ProxySession } from "../types.js";
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
 * A run capability (`rrp_…`), registry-only token (`rrg_…`) or MCP token (`rmt_…`) shape. A tail with
 * any of them left in it after exact-value redaction (a value the proxy could not know, or the MCP
 * placeholder a bridge failed to redact) is refused, not logged.
 */
const TOKEN_SHAPE = /(?:rr[pg]|rmt)_[A-Za-z0-9_-]/;

/** Set to "1" on a 200 `input` answer exactly when the run's session has MCP tools (the bridges read it). */
export const MCP_TOOLS_INPUT_HEADER = "x-wardby-mcp-tools";
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
   * The run's actor shape and extra repositories, by its token (one SubstrateRun row read); undefined
   * when the token has no row (treated as a pair with no repositories, and asked again next time).
   * Absent: every run is a pair with no repositories.
   */
  runLayoutForToken?: (token: string) => Promise<SubstrateRunLayout | undefined>;
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

/** `holder`: the actor holding the workspace (the tool actor for a pair run, the agent actor for a single one). */
type Caller = "agent" | "tool" | "holder";
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
  | "diagnostics"
  | "repos.seed"
  | "repos.workspace";

interface Matched {
  name: RouteName;
  caller: Caller;
  channel?: string;
  /** repos.*: the extra repository, a validated link name. */
  repository?: string;
}

/** The routes between the agent and the tool actor: a single-shape run (no tool actor) has none. */
const RELAY_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  "channels.open",
  "channels.send",
  "channels.poll",
  "channels.from-tool",
  "events",
]);
/** Tokens whose layout is known (their row exists), oldest forgotten first past the cap. */
const KNOWN_LAYOUTS_MAX = 10_000;
/** A run's default layout: a pair with no extra repositories (no row, or no lookup). */
const DEFAULT_LAYOUT: SubstrateRunLayout = { shape: "pair" };

const RUN_PATH = /^\/substrate\/runs\/(wr-[0-9a-f]{20})\/(.+)$/;
const CHANNEL_PATH = /^channels\/(c[0-9]{1,9})\/(lines|from-tool)$/;
const REPO_PATH = /^repos\/([^/]+)\/(seed|workspace)$/;

function match(method: string, rest: string): Matched | undefined {
  const repo = REPO_PATH.exec(rest);
  if (repo) {
    const repository = repo[1];
    if (!isCodingRepositoryName(repository)) return undefined;
    if (repo[2] === "seed" && method === "GET") return { name: "repos.seed", caller: "holder", repository };
    if (repo[2] === "workspace" && method === "POST") return { name: "repos.workspace", caller: "holder", repository };
    return undefined;
  }
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
      return { name: "tool-setup", caller: "holder" };
    case "GET seed":
      return { name: "seed", caller: "holder" };
    case "GET events":
      return { name: "events", caller: "tool" };
    case "POST workspace":
      return { name: "workspace", caller: "holder" };
    case "POST exit":
      return { name: "exit", caller: "agent" };
    case "POST workspace-failed":
      return { name: "workspace-failed", caller: "holder" };
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
  /** The setupDeleted key: the run token, and with warm rounds its round. */
  const setupKeyFor = (token: string, round: number): string => (options.warmRounds ? `${token}/${round}` : token);
  /** `<run token>/<round>/<side>` whose diagnostics were logged: a repeat is answered but not logged again. */
  const diagnosticsSeen = new Set<string>();
  /**
   * The layout of every token whose row was found: a token's row, its shape and its repositories are
   * set when the row is created and never change. A token with no row is not remembered, so a row not
   * yet visible is never pinned.
   */
  const knownLayouts = new Map<string, SubstrateRunLayout>();

  async function layoutFor(token: string): Promise<SubstrateRunLayout> {
    if (!options.runLayoutForToken) return DEFAULT_LAYOUT;
    const known = knownLayouts.get(token);
    if (known) return known;
    const found = await options.runLayoutForToken(token);
    if (found === undefined) return DEFAULT_LAYOUT;
    const layout: SubstrateRunLayout = {
      shape: found.shape === "single" ? "single" : "pair",
      ...(found.repositories ? { repositories: found.repositories } : {}),
    };
    knownLayouts.set(token, layout);
    if (knownLayouts.size > KNOWN_LAYOUTS_MAX) {
      const oldest = knownLayouts.keys().next().value;
      if (oldest !== undefined) knownLayouts.delete(oldest);
    }
    return layout;
  }

  /** Whether the run's row lists the extra repository (`write`: as writable). */
  function listed(layout: SubstrateRunLayout, name: string, write: boolean): boolean {
    return (layout.repositories ?? []).some((entry) => entry.name === name && (!write || entry.access === "write"));
  }

  /** Whether the request carries either credential header (a request with neither is refused unread). */
  const hasCredential = (request: IncomingMessage): boolean => {
    const key = request.headers["x-api-key"];
    const jwt = request.headers[TOOL_ACTOR_JWT_HEADER.toLowerCase()];
    return (typeof key === "string" && key !== "") || (typeof jwt === "string" && jwt !== "");
  };

  /**
   * No live credential at rest: a capability works only while its session is active and in time, and
   * only for the token its run holds now. The executor cancels a run's session as the run ends, before
   * its actors may be parked (warm rounds), so a finished round's capability is refused here (401) on
   * every route, the next round's input included; its registry-only token stops working the same way
   * (the registry looks it up through the same session).
   *
   * One place accepts the capability after cancel: the control plane's run-steps ingress
   * (src/core/run-steps/ingress.ts) checks only the deadline, and accepts until the deadline plus its
   * grace, so a cancelled session's last steps still land. That is safe for a parked round: only the
   * coding proxy's run-steps relay reaches the ingress (in-cluster or on the run's isolated network,
   * reachable from the proxy alone), and the proxy relays steps only from requests it accepted, which
   * need an active session.
   */
  async function agentSession(request: IncomingMessage, token: string): Promise<ProxySession | undefined> {
    const key = request.headers["x-api-key"];
    if (typeof key !== "string" || key === "") return undefined;
    const session = await options.ledger.findSessionByCapabilityHash(capabilityHash(key));
    if (!session || session.status !== "active" || session.deadlineAt.getTime() <= Date.now()) return undefined;
    return (await options.tokenForRun(session.runId)) === token ? session : undefined;
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
   * Without warm rounds every request is round 1 (as before rounds existed), and a request for a round
   * above 1 is refused the same way (a control plane with warm rounds behind a proxy without them must
   * stall a follow-up round, never re-serve round 1's input).
   */
  async function roundFor(url: URL, token: string, kind: "download" | "upload"): Promise<number> {
    const raw = url.searchParams.get("round");
    if (raw !== null && !/^[1-9][0-9]{0,3}$/.test(raw)) throw new RouteError(400, "bad_request");
    const requested = raw === null ? 1 : Number(raw);
    if (requested > MAX_ROUND) throw new RouteError(400, "bad_request");
    if (!options.warmRounds) {
      if (requested === 1) return 1;
      throw kind === "download" ? new RouteError(404, "not_found") : new RouteError(409, "round_mismatch");
    }
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
    /** Fixed headers for the 200 answer only (never a value from a request or a secret). */
    extraHeaders: Record<string, string> = {},
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
    response.writeHead(200, { ...extraHeaders, "content-type": contentType, "cache-control": "no-store" });
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
    /** A single-shape input: whether this request deleted the run's setup (fixed true/false). */
    let inputDeletedSetup: boolean | undefined;
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
          ...(inputDeletedSetup !== undefined ? { setupDeleted: inputDeletedSetup } : {}),
          ...(matched?.repository ? { repository: matched.repository } : {}),
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
      // No credential at all: refused before the layout lookup (no database read for it).
      if (!hasCredential(request)) throw new RouteError(401, "unauthorized");
      const layout = await layoutFor(token);
      const shape = layout.shape;
      if (shape === "single" && RELAY_ROUTES.has(matched.name)) throw new RouteError(404, "not_found");
      const side = matched.caller === "holder" ? (shape === "single" ? "agent" : "tool") : matched.caller;
      // The agent side's session (the input answer's MCP flag reads it); the tool side has none.
      let session: ProxySession | undefined;
      if (side === "agent") session = await agentSession(request, token);
      const allowed = side === "agent" ? session !== undefined : await toolAuth(request, token);
      if (!allowed) throw new RouteError(401, "unauthorized");
      const { relay, blobs, limits } = options;
      const channel = matched.channel ?? "";
      switch (matched.name) {
        case "input": {
          // The agent reached the proxy: record it (if not yet recorded) before the input is sent, so
          // a failed write answers 500 and the agent asks again, and the launcher's startup timeout
          // (no `started` record) never fires on a run that did start. A single-shape run has no events
          // poll, so its tool setup (read by the same actor before its input) is deleted here, best effort:
          // the launcher's startup timeout also waits for that deletion.
          // The MCP flag follows this round's own session (warm rounds: each round has its own).
          const round = await roundFor(url, token, "download");
          const mcpFlag: Record<string, string> =
            (session?.mcpTools?.length ?? 0) > 0 ? { [MCP_TOOLS_INPUT_HEADER]: "1" } : {};
          await sendBlob(
            response,
            BLOB.input(token, round),
            "application/json",
            counters,
            async () => {
              if (!(await blobs.head(BLOB.started(token, round)))) {
                await blobs.put(BLOB.started(token, round), Buffer.from("{}"), { contentType: "application/json" });
              }
              if (shape === "single") {
                inputDeletedSetup = await blobs.delete(BLOB.toolSetup(token)).then(
                  () => true,
                  () => false,
                );
              }
            },
            mcpFlag,
          );
          return;
        }
        case "tool-setup":
          // Not deleted here: a lost response would strand the run. The first events poll (a single-shape
          // run: the first input download) deletes it.
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
          // Warm rounds: per round (a later round stages a new tool setup under the same key), and a
          // tool setup already gone is fine. Without them, exactly as before: one key per run, and a
          // failed delete answers its error.
          const setupKey = setupKeyFor(token, await currentRound(token));
          if (!setupDeleted.has(setupKey)) {
            const deleted = blobs.delete(BLOB.toolSetup(token));
            await (options.warmRounds
              ? deleted.catch((error: unknown) => {
                  if (!(error instanceof BlobStoreError && error.code === "not_found")) throw error;
                })
              : deleted);
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
          // A single-shape run has no tool actor to collect: the agent actor uploads its workspace itself.
          if (shape !== "single") await relay.requestCollect(token);
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
          setupDeleted.delete(setupKeyFor(token, round));
          sendJson(response, 200, {});
          return;
        }
        case "exit": {
          // The worker exited without a usable result: record its code (and its own safe diagnostic,
          // if it printed one) and still collect the workspace.
          const round = await roundFor(url, token, "upload");
          const report = await readExitReport(request);
          if (!(await blobs.head(BLOB.exit(token, round)))) {
            if (shape !== "single") {
              try {
                await relay.requestCollect(token);
              } catch (error) {
                // The relay was already dropped: the run was collected, so there is nothing left to queue.
                if (!(error instanceof RelayUnknownError)) throw error;
              }
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
          // Per round (warm rounds): each round's tail is its own; another round's post is refused (409).
          const round = await roundFor(url, token, "upload");
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
          const seenKey = `${token}/${round}/${side}`;
          if (!diagnosticsSeen.has(seenKey)) {
            diagnosticsSeen.add(seenKey);
            if (diagnosticsSeen.size > DIAGNOSTICS_SEEN_MAX) {
              const oldest = diagnosticsSeen.values().next().value;
              if (oldest !== undefined) diagnosticsSeen.delete(oldest);
            }
            log.warn(
              { event: "substrate.diagnostics", runToken: token, side, ...(round > 1 ? { round } : {}), tail },
              "substrate actor diagnostics",
            );
          }
          sendJson(response, 200, {});
          return;
        }
        case "repos.seed": {
          const name = matched.repository ?? "";
          if (!listed(layout, name, false)) throw new RouteError(404, "not_found");
          await sendBlob(response, REPO_BLOB.seed(token, name), "application/x-tar", counters);
          return;
        }
        case "repos.workspace": {
          // Before the body is read: an unlisted or read-only repository is refused (404, connection closed).
          // Never writes `done`, drops the relay or touches setupDeleted: the default `workspace` upload,
          // sent last, ends the run.
          const name = matched.repository ?? "";
          if (!listed(layout, name, true)) throw new RouteError(404, "not_found");
          const round = await roundFor(url, token, "upload");
          await refuseOnceCollected(token, round);
          counters.bytes = await receiveBlob(
            request,
            REPO_BLOB.workspace(token, name, round),
            limits.workspaceBytes,
            clearBodyTimer,
          );
          sendJson(response, 200, {});
          return;
        }
        case "workspace-failed": {
          // The tool bridge could not produce the workspace tar: say so and end the relay.
          const round = await roundFor(url, token, "upload");
          await refuseOnceCollected(token, round);
          await writeDoneOnce(token, round, "failed");
          await relay.dropRelay(token);
          setupDeleted.delete(setupKeyFor(token, round));
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
