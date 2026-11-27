/**
 * The join API that `wardby join -` calls (join-link.ts): POST, `Authorization: Bearer <join link
 * token>`, JSON. Mounted on both hosts, as the loopback sign-in routes are: the HTTP transport
 * (streamable-http.ts) and stdio's loopback link host (stdio-link-host.ts).
 *
 *   join    {}                                 joins the run (join_run)
 *   steps   { after }                          the run's steps after `after` (get_run_steps' shape)
 *   send    { message, interrupt? }            a message to the agent (send_to_run)
 *   leave   {}                                 leaves the run (leave_run)
 *   stop    {}                                 stops the run (stop_run): it ends cancelled
 *   status  {}                                 the run's status, cost and outcome
 *
 * Each answer carries `token`: a fresh token with the same payload, because the requestState codec's
 * own expiry is 10 minutes and a session lasts longer; the payload's `exp` still ends the session.
 * Every call checks access again with the actions the MCP tools use (join-actions.ts), and stop
 * goes through the same stopRun as stop_run.
 *
 * Secrets: the token is never logged or echoed (an answer's `token` is a new one, for the caller
 * that already holds the session); every refusal is a fixed code. Message text is stored only
 * through RunStepWriter.recordJoin (masked by exact value), and step text is what is stored.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { PrismaClient } from "#prisma";
import { publicCodingRunResult } from "../../coding/protocol.js";
import { MAX_JOIN_MESSAGE_CHARS } from "../../core/run-steps/join.js";
import type { RunStepSink } from "../../core/run-steps/types.js";
import { stopRun, type StopRunOptions } from "../../core/stop-run.js";
import { HTTP_LIMITS, HttpBoundaryError, parseBody, readBody } from "../transport/http-limits.js";
import type { StdioBearerRoute } from "../transport/stdio-link-host.js";
import {
  checkJoinableRun,
  JoinActionError,
  joinRunAs,
  leaveRunAs,
  sendToRunAs,
  type JoinActionDb,
} from "./join-actions.js";
import {
  JOIN_API_BODY_LIMIT,
  JOIN_API_PATHS,
  isJoinLinkPayload,
  type JoinApiAction,
  type JoinLinkPayload,
} from "./join-link.js";
import { JOIN_REFUSALS } from "./join-run.js";
import { canReadRun, canReadRunDetail, type RunReader } from "./run-access.js";
import { permissionsOf } from "../auth/resource-server.js";
import { resolveStanding, type StandingDb } from "../../core/teams/standing.js";
import type { RunTranscriptLinkAudience } from "./run-transcript-download.js";
import { loadRunStepsPage } from "./run-steps.js";

export interface JoinApiDeps {
  verify: (token: string) => Promise<unknown>;
  mint: (payload: JoinLinkPayload) => Promise<string>;
  /** The host serving this route: only links minted for it are accepted. */
  audience: RunTranscriptLinkAudience;
  db: JoinActionDb & StopRunOptions["db"] & Pick<PrismaClient, "runStep" | "authUser"> & StandingDb;
  recordJoin?: RunStepSink["recordJoin"];
  executor: StopRunOptions["executor"];
  now?: () => Date;
}

export interface JoinApiRequest {
  method: string | undefined;
  action: JoinApiAction;
  token: string | null;
  body: unknown;
}

const STEPS_PAGE = 200;
const StepsBody = z.object({ after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const SendBody = z
  .object({ message: z.string().trim().min(1).max(MAX_JOIN_MESSAGE_CHARS), interrupt: z.boolean().optional() })
  .strict();
const EmptyBody = z.object({}).strict();

function send(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    })
    .end(JSON.stringify(body));
}

function refusal(res: ServerResponse, err: JoinActionError): void {
  if (err.code === "not_found") return send(res, 404, { error: "not_found" });
  if (err.code === "insufficient_access") return send(res, 403, { error: "insufficient_access" });
  send(res, 409, { error: err.code, message: JOIN_REFUSALS[err.code] ?? err.code });
}

/**
 * Whether an owner-all link's principal still holds a role granting owner:all, read on every call.
 * Direct roles come live from the self-hosted AuthUser (which must still be enabled); a principal
 * without one (a delegating identity provider, whose role claim cannot be re-read without a token)
 * uses the roles recorded when the link was made. Team roles are always read live (resolveStanding).
 * The owner:all scope itself was checked when the link was made; the session ends with the run.
 */
async function ownerAllStill(db: JoinApiDeps["db"], payload: JoinLinkPayload): Promise<boolean> {
  const user = await db.authUser.findUnique({
    where: { principalId: payload.principalId },
    select: { roles: true, status: true },
  });
  if (user && user.status !== "enabled") return false;
  const standing = await resolveStanding(db, payload.principalId, user ? user.roles : (payload.roles ?? []));
  return permissionsOf([...standing.roles]).has("owner:all");
}

/** A visible run (canReadRun), for steps and status: they keep working after the run ends. */
async function readableRun(db: JoinApiDeps["db"], runId: string, reader: RunReader) {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { id: true, agentId: true, triggeredById: true, status: true, costUsd: true, error: true },
  });
  if (!run || !(await canReadRun(db, run, reader))) throw new JoinActionError("not_found");
  return run;
}

export async function handleJoinApi(request: JoinApiRequest, res: ServerResponse, deps: JoinApiDeps): Promise<void> {
  if (request.method !== "POST") {
    res.writeHead(405, { allow: "POST", "cache-control": "no-store" }).end();
    return;
  }
  const now = (deps.now ?? (() => new Date()))();
  let payload: unknown;
  try {
    if (!request.token) throw new Error("missing");
    payload = await deps.verify(request.token);
  } catch {
    return send(res, 401, { error: "link_invalid" });
  }
  if (!isJoinLinkPayload(payload) || payload.aud !== deps.audience || payload.exp <= now.getTime()) {
    return send(res, 401, { error: "link_invalid" });
  }
  const reader: RunReader = {
    principalId: payload.principalId,
    operator: payload.operator === true || (payload.ownerAll === true && (await ownerAllStill(deps.db, payload))),
  };
  const actionDeps = { db: deps.db, ...(deps.recordJoin ? { recordJoin: deps.recordJoin } : {}) };
  const runId = payload.runId;
  const body = request.body ?? {};
  try {
    let answer: Record<string, unknown>;
    switch (request.action) {
      case "join": {
        if (!EmptyBody.safeParse(body).success) return send(res, 400, { error: "invalid_request" });
        const { already } = await joinRunAs(actionDeps, runId, reader);
        answer = { runId, joined: true, already };
        break;
      }
      case "steps": {
        const parsed = StepsBody.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: "invalid_request" });
        const run = await readableRun(deps.db, runId, reader);
        const showDetail = await canReadRunDetail(deps.db, run, reader);
        const { steps, next } = await loadRunStepsPage(deps.db, run.id, {
          after: parsed.data.after,
          take: STEPS_PAGE,
          showDetail,
        });
        answer = { runId, steps, next };
        break;
      }
      case "send": {
        const parsed = SendBody.safeParse(body);
        if (!parsed.success) return send(res, 400, { error: "invalid_request" });
        const { seq, kind } = await sendToRunAs(
          actionDeps,
          runId,
          reader,
          parsed.data.message,
          parsed.data.interrupt === true,
        );
        answer = { runId, seq, kind };
        break;
      }
      case "leave": {
        if (!EmptyBody.safeParse(body).success) return send(res, 400, { error: "invalid_request" });
        const { wasJoined } = await leaveRunAs(actionDeps, runId, reader);
        answer = { runId, joined: false, wasJoined };
        break;
      }
      case "stop": {
        if (!EmptyBody.safeParse(body).success) return send(res, 400, { error: "invalid_request" });
        // stop_run's access: visible and execute now (the join checks without joinability).
        await checkJoinableRun(actionDeps, runId, reader, { forLeave: true });
        const result = await stopRun({
          db: deps.db,
          executor: deps.executor,
          runId,
          stoppedBy: reader.principalId,
          reason: "stopped from wardby join",
        });
        answer = { runId, status: result.status, stopRequested: result.stopRequested };
        break;
      }
      case "status": {
        if (!EmptyBody.safeParse(body).success) return send(res, 400, { error: "invalid_request" });
        const run = await readableRun(deps.db, runId, reader);
        const coding = await deps.db.codingRun.findUnique({ where: { runId }, select: { result: true } });
        const result = publicCodingRunResult(coding?.result);
        answer = {
          runId,
          status: run.status,
          costUsd: run.costUsd.toString(),
          error: run.error,
          outcome: result?.outcome ?? null,
          summary: result?.summary ?? null,
          branch: result?.headRef ?? null,
          pullRequestUrl: result?.pullRequestUrl ?? null,
        };
        break;
      }
    }
    send(res, 200, { ...answer, token: await deps.mint(payload) });
  } catch (err) {
    if (err instanceof JoinActionError) return refusal(res, err);
    throw err;
  }
}

/** The action a join API path names, or undefined. */
export function joinApiAction(pathname: string): JoinApiAction | undefined {
  return (Object.keys(JOIN_API_PATHS) as JoinApiAction[]).find((action) => JOIN_API_PATHS[action] === pathname);
}

/** The join API as stdio loopback Bearer routes (the HTTP transport mounts handleJoinApi itself). */
export function joinApiStdioRoutes(deps: JoinApiDeps): Record<string, StdioBearerRoute> {
  const route =
    (action: JoinApiAction): StdioBearerRoute["bearer"] =>
    async (req: IncomingMessage, res: ServerResponse, token: string | null) => {
      let body: unknown;
      try {
        const raw = await readBody(req, JOIN_API_BODY_LIMIT, AbortSignal.timeout(HTTP_LIMITS.requestMs));
        body = raw === "" ? undefined : parseBody(raw, req.headers["content-type"]);
      } catch (err) {
        if (!(err instanceof HttpBoundaryError)) throw err;
        req.resume();
        send(res, err.status, { error: "invalid_request" });
        return;
      }
      await handleJoinApi({ method: req.method, action, token, body }, res, deps);
    };
  return Object.fromEntries(
    (Object.keys(JOIN_API_PATHS) as JoinApiAction[]).map((action) => [
      JOIN_API_PATHS[action],
      { bearer: route(action) },
    ]),
  );
}
