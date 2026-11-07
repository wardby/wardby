/** Each run's newest step, for get_run and cross-agent list_runs (the runs pane's one-line "now"). */
import { Prisma, type PrismaClient } from "#prisma";
import { logger } from "../logger.js";

const lastStepLog = logger.child({ module: "run-steps" });

export interface LastStep {
  seq: number;
  at: string;
  kind: string;
  tool: string | null;
  summary: string;
  status: string | null;
  /** "Bash: npm test (exit 1)", "said: Running the tests." */
  line: string;
}

interface LastStepRow {
  runId: string;
  seq: number;
  at: Date;
  kind: string;
  tool: string | null;
  summary: string;
  status: string | null;
}

export function stepLine(step: Pick<LastStep, "kind" | "tool" | "summary" | "status">): string {
  const head = step.kind === "tool" ? `${step.tool ?? "tool"}: ${step.summary}` : `said: ${step.summary}`;
  return step.status && step.status !== "ok" ? `${head} (${step.status})` : head;
}

/** One indexed DISTINCT ON query. Best effort: a failure lists the runs without it, never an error. */
export async function loadLastSteps(
  db: Pick<PrismaClient, "$queryRaw">,
  runIds: readonly string[],
): Promise<Map<string, LastStep>> {
  if (runIds.length === 0) return new Map();
  try {
    const rows = await db.$queryRaw<LastStepRow[]>`
      SELECT DISTINCT ON ("runId") "runId", "seq", "at", "kind", "tool", "summary", "status"
      FROM "RunStep" WHERE "runId" IN (${Prisma.join([...runIds])})
      ORDER BY "runId", "seq" DESC`;
    return new Map(
      rows.map((row) => [
        row.runId,
        {
          seq: row.seq,
          at: row.at.toISOString(),
          kind: row.kind,
          tool: row.tool,
          summary: row.summary,
          status: row.status,
          line: stepLine(row),
        },
      ]),
    );
  } catch (err) {
    lastStepLog.warn(
      { event: "run_steps_last_step_failed", errorName: err instanceof Error ? err.name : typeof err },
      "could not read runs' last steps; listing them without",
    );
    return new Map();
  }
}
