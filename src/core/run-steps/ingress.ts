/**
 * The control plane's run-steps listener (WARDBY_RUN_STEPS_LISTEN, `wardby serve` only): the coding
 * proxy posts each coding run's steps here with the step text unmasked, and this process redacts
 * them by exact value (RunStepWriter, the same stepSummarizer path as native runs) before anything
 * is stored. A listener of its own, so the MCP endpoint's canonical-Host check and its public
 * exposure are untouched.
 *
 * Each request is authenticated by the run capability (`rrp_…`), found by its hash in the run's
 * proxy session, from the headers alone: the body is read only for a live session. The run's worker
 * and the proxy both hold this capability (it is also the worker's model API key), so it does not
 * tell the proxy from the worker: it limits a caller to its own run (a batch naming any other run
 * is refused, run_mismatch), and only the deployment's network policy keeps workers off this port.
 * The capability is handed to the writer as one more exact value to redact,
 * so a copy of it the model wrote, glued to other text or cut off at the end of a step, is masked
 * like the agent's own secrets. The run's MCP token (`rmt_…`) can't be passed the same way: only
 * its hash is stored, and the value leaves the control plane's memory once the job is launched; it
 * is masked by its token shape instead.
 *
 * Secrets: the request body, the step text and the Authorization value are never logged, echoed or
 * stored by this module. Log lines carry a fixed event, a status and an error's name only (never an
 * error's message: a database or writer error may quote the lookup or the text); every response
 * body is a fixed code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { capabilityHash } from "../../providers/coding-proxy/capability-hash.js";
import { HTTP_LIMITS, HttpBoundaryError, readBody } from "../../mcp/transport/http-limits.js";
import { parseListenAddress, type ListenAddress } from "../listen-address.js";
import { logger } from "../logger.js";
import { MAX_RUN_STEPS_POST_BYTES, RUN_STEPS_INGRESS_PATH, type RunStepSink } from "./types.js";
import { parseRunStepPost } from "./wire.js";

const ingressLog = logger.child({ module: "run-steps" });
/** `rrp_` + 32 random bytes, base64url (CodingProxy.createSession). */
const CAPABILITY = /^rrp_[A-Za-z0-9_-]{43}$/;
/** A reply that finished just before the session's deadline may still be in the forwarder's queue. */
const SESSION_GRACE_MS = 10 * 60_000;
/** Open connections at once; Node accepts and then closes any beyond this (they do not wait in the listen backlog). */
export const MAX_INGRESS_CONNECTIONS = 64;
/** How often Node checks requestTimeout and headersTimeout (its default, 30 s, would let a slow client stay). */
const CONNECTIONS_CHECK_MS = 2_000;
/** Fixed codes for the HTTP boundary's refusals; any other status is "bad_request". */
const BOUNDARY_CODES: Record<number, string> = { 413: "payload_too_large", 415: "unsupported_encoding" };

export interface RunStepIngressDeps {
  db: Pick<PrismaClient, "codingProxySession">;
  sink: RunStepSink;
  now?: () => Date;
  log?: { warn(fields: Record<string, unknown>, message: string): void };
  /** Tests only; HTTP_LIMITS.requestMs (15 s, under the forwarder's 20 s) otherwise. */
  requestTimeoutMs?: number;
}

export interface RunStepIngressResponse {
  status: number;
  body: { ok: true } | { error: string };
}

/** A live session's run and the capability that names it. */
interface Caller {
  runId: string;
  capability: string;
}

class RequestTimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** From the Authorization header alone: the caller's live session, or the refusal. */
async function authenticate(
  deps: RunStepIngressDeps,
  authorization: string | undefined,
): Promise<Caller | RunStepIngressResponse> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!token || !CAPABILITY.test(token)) return { status: 401, body: { error: "unauthorized" } };
  const session = await deps.db.codingProxySession.findUnique({
    where: { capabilityHash: capabilityHash(token) },
    select: { runId: true, deadlineAt: true },
  });
  if (!session) return { status: 401, body: { error: "unauthorized" } };
  // Only the deadline counts (a cancelled session's last steps still land): bounded by the grace.
  const now = (deps.now ?? (() => new Date()))();
  if (session.deadlineAt.getTime() + SESSION_GRACE_MS < now.getTime()) {
    return { status: 403, body: { error: "session_ended" } };
  }
  return { runId: session.runId, capability: token };
}

/** An authenticated caller's body: parsed, bound to its run, then written. */
async function accept(deps: RunStepIngressDeps, caller: Caller, body: string): Promise<RunStepIngressResponse> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const post = parseRunStepPost(value);
  if (!post) return { status: 400, body: { error: "invalid_batch" } };
  // A capability names one run: a batch for any other run is refused, never written there.
  if (post.runId !== caller.runId) return { status: 403, body: { error: "run_mismatch" } };
  await deps.sink.record(caller.runId, post.batch, [caller.capability, deriveRegistryToken(caller.capability)]);
  return { status: 202, body: { ok: true } };
}

export async function handleRunStepPost(
  deps: RunStepIngressDeps,
  authorization: string | undefined,
  body: string,
): Promise<RunStepIngressResponse> {
  const caller = await authenticate(deps, authorization);
  return "status" in caller ? caller : accept(deps, caller, body);
}

/** WARDBY_RUN_STEPS_LISTEN: `host:port` or `:port`; unset or blank = no listener. */
export function parseRunStepsListen(value: string | undefined): ListenAddress | undefined {
  return parseListenAddress("WARDBY_RUN_STEPS_LISTEN", value);
}

/**
 * Writes a fixed answer. A refusal also closes the connection once the answer is out: its body
 * may be unread, and is never drained.
 */
function send(res: ServerResponse, status: number, body: RunStepIngressResponse["body"]): void {
  const refusal = status >= 300;
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...(refusal ? { connection: "close" } : {}),
  });
  if (refusal) res.once("finish", () => res.socket?.destroy());
  res.end(JSON.stringify(body));
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

export function startRunStepIngress(listen: ListenAddress, deps: RunStepIngressDeps): Promise<Server> {
  const log = deps.log ?? ingressLog;
  const limitMs = deps.requestTimeoutMs ?? HTTP_LIMITS.requestMs;
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== RUN_STEPS_INGRESS_PATH) return send(res, 404, { error: "not_found" });
    // One limit for the whole request (lookup, body, write), so the forwarder always gets an answer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limitMs);
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new RequestTimeoutError()), { once: true }),
    );
    const work = (async () => {
      const caller = await authenticate(deps, req.headers.authorization);
      if ("status" in caller) return caller;
      const body = await readBody(req, MAX_RUN_STEPS_POST_BYTES, controller.signal);
      return accept(deps, caller, body);
    })();
    // After a timeout answer, a failure that lands later is logged by name only (the body read's
    // own abort is not a failure).
    work.catch((err: unknown) => {
      if (controller.signal.aborted && !(err instanceof HttpBoundaryError)) {
        log.warn(
          { event: "run_steps_ingress_late_failure", errorName: errorName(err) },
          "run steps request failed late",
        );
      }
    });
    try {
      const result = await Promise.race([work, timedOut]);
      send(res, result.status, result.body);
    } catch (err) {
      const timeout = err instanceof RequestTimeoutError;
      const status = timeout ? 503 : err instanceof HttpBoundaryError ? err.status : 500;
      const code = timeout ? "timeout" : status === 500 ? "internal" : (BOUNDARY_CODES[status] ?? "bad_request");
      log.warn({ event: "run_steps_ingress_failed", status, errorName: errorName(err) }, "run steps request failed");
      if (!res.headersSent) send(res, status, { error: code });
    } finally {
      clearTimeout(timer);
    }
  };
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: limitMs,
      headersTimeout: Math.min(HTTP_LIMITS.headersMs, limitMs),
      connectionsCheckingInterval: Math.min(CONNECTIONS_CHECK_MS, limitMs),
    },
    (req, res) => void serve(req, res),
  );
  server.maxConnections = MAX_INGRESS_CONNECTIONS;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
