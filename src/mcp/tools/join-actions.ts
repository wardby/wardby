/**
 * Join's actions, shared by the MCP tools (join_run, send_to_run, leave_run) and the join API that
 * `wardby join -` calls (join-api.ts), so both take exactly the same access checks and refusals.
 *
 * Access: the run must be visible to the reader (canReadRun: execute on the agent through the
 * owner or the reader's own grants, or the run's triggerer) and the reader must hold execute on the
 * agent now (a triggerer who lost it is refused). TEAMS (#639, team-aware access): when team access
 * lands, canReadRun and the execute check resolve through accessFor/actsFor, so a team member's
 * execute counts here with no change in this file.
 *
 * Secrets: a message is written only through RunStepWriter.recordJoin, which masks it by exact value
 * against the agent's secrets first; the answers carry the stored (masked) text, never the input.
 */
import type { PrismaClient } from "#prisma";
import { atLeast, effectiveAccess, type Access } from "../../core/grants.js";
import { joinRefusal, joinedPrincipals } from "../../core/run-steps/join.js";
import type { RunStepSink } from "../../core/run-steps/types.js";
import { canReadRun, type RunReader } from "./run-access.js";

/** A refusal: a fixed code (each has a help/errors article, or maps to not found / access). */
export type JoinActionCode =
  | "not_found"
  | "insufficient_access"
  | "run_not_running"
  | "join_not_supported"
  | "join_unavailable"
  | "run_not_joined";

export class JoinActionError extends Error {
  constructor(
    readonly code: JoinActionCode,
    /** For insufficient_access: the agent and the access the reader holds. */
    readonly detail?: { agentId: string; access: Access<"agent"> },
  ) {
    super(code);
    this.name = "JoinActionError";
  }
}

const CODES = new Set<string>(["run_not_running", "join_not_supported", "join_unavailable", "run_not_joined"]);

export type JoinActionDb = Pick<PrismaClient, "run" | "agent" | "resourceGrant" | "codingRun" | "runStep">;

export interface JoinActionDeps {
  db: JoinActionDb;
  /** The run-steps writer's recordJoin; absent where no writer runs (join is then unavailable). */
  recordJoin?: RunStepSink["recordJoin"];
}

export interface JoinableRun {
  id: string;
  agentId: string;
  triggeredById: string | null;
}

/**
 * The run, checked for the reader: visible (else not_found, exactly as a missing run), execute on its
 * agent now, a writer to record with, and (unless `forLeave`: leaving is always allowed, even once
 * the run has ended) joinable now.
 */
export async function checkJoinableRun(
  deps: JoinActionDeps,
  runId: string,
  reader: RunReader,
  opts: { forLeave?: boolean } = {},
): Promise<JoinableRun> {
  const run = await deps.db.run.findUnique({
    where: { id: runId },
    select: { id: true, agentId: true, triggeredById: true },
  });
  if (!run || !(await canReadRun(deps.db, run, reader))) throw new JoinActionError("not_found");
  const agent = await deps.db.agent.findUnique({ where: { id: run.agentId }, select: { id: true, ownerId: true } });
  if (!agent) throw new JoinActionError("not_found");
  const access = await effectiveAccess(deps.db, "agent", agent, reader.principalId, {
    operator: reader.operator === true,
  });
  if (!atLeast("agent", access, "execute")) {
    throw new JoinActionError("insufficient_access", { agentId: agent.id, access });
  }
  if (!deps.recordJoin) throw new JoinActionError("join_unavailable");
  if (!opts.forLeave) {
    const refusal = await joinRefusal(deps.db, run.id);
    if (refusal) throw new JoinActionError(refusal);
  }
  return run;
}

/** A writer failure as a fixed code where it is one; any other failure as it is. */
async function recorded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (CODES.has(code)) throw new JoinActionError(code as JoinActionCode);
    throw err;
  }
}

/** Joins the run. Joining twice records nothing new (`already`). */
export async function joinRunAs(
  deps: JoinActionDeps,
  runId: string,
  reader: RunReader,
): Promise<{ run: JoinableRun; already: boolean; seq?: number }> {
  const run = await checkJoinableRun(deps, runId, reader);
  if ((await joinedPrincipals(deps.db, run.id)).has(reader.principalId)) return { run, already: true };
  const { seq } = await recorded(deps.recordJoin!(run.id, { kind: "join", principalId: reader.principalId }));
  return { run, already: false, seq };
}

/** Sends a message (or an interrupt) to the agent of a run the reader joined. */
export async function sendToRunAs(
  deps: JoinActionDeps,
  runId: string,
  reader: RunReader,
  message: string,
  interrupt: boolean,
): Promise<{ run: JoinableRun; seq: number; kind: "message" | "interrupt" }> {
  const run = await checkJoinableRun(deps, runId, reader);
  if (!(await joinedPrincipals(deps.db, run.id)).has(reader.principalId)) {
    throw new JoinActionError("run_not_joined");
  }
  const kind = interrupt ? "interrupt" : "message";
  const { seq } = await recorded(deps.recordJoin!(run.id, { kind, principalId: reader.principalId, text: message }));
  return { run, seq, kind };
}

/** Leaves the run. Leaving when not joined records nothing (`wasJoined: false`). */
export async function leaveRunAs(
  deps: JoinActionDeps,
  runId: string,
  reader: RunReader,
): Promise<{ run: JoinableRun; wasJoined: boolean; seq?: number }> {
  const run = await checkJoinableRun(deps, runId, reader, { forLeave: true });
  if (!(await joinedPrincipals(deps.db, run.id)).has(reader.principalId)) return { run, wasJoined: false };
  const { seq } = await recorded(deps.recordJoin!(run.id, { kind: "leave", principalId: reader.principalId }));
  return { run, wasJoined: true, seq };
}
