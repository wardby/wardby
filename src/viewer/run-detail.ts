/** The run detail read model behind GET /admin/api/runs/:id (docs/viewer-api.md). */
import type { PrismaClient } from "#prisma";
import type { RunDetail } from "./api-schema.js";
import { loadGraphRuns, type IssueSites } from "./graph.js";

type CodingDetail = NonNullable<RunDetail["coding"]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the CodingRun.services snapshot. Env values are never copied: names only, and serviceEnv is never read. */
function serviceDetails(snapshot: unknown): CodingDetail["services"] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(isRecord).map((s) => ({
    name: String(s.name),
    version: String(s.version),
    image: String(s.image),
    envNames: isRecord(s.testEnv) ? Object.keys(s.testEnv).sort() : [],
  }));
}

/** The most steps a run detail carries: the newest, oldest first. */
export const RUN_DETAIL_STEPS = 200;

export async function loadRunDetail(
  db: PrismaClient,
  runId: string,
  issueSites: IssueSites = {},
): Promise<RunDetail | null> {
  const [graphRun] = await loadGraphRuns(db, [runId], issueSites);
  if (!graphRun) return null;
  const [row, children, newest, stepCount] = await Promise.all([
    db.run.findUniqueOrThrow({
      where: { id: runId },
      select: {
        error: true,
        finalText: true,
        stepsDropped: true,
        codingRun: {
          select: {
            provider: true,
            repository: true,
            baseRef: true,
            headRef: true,
            queuedAt: true,
            failureCategory: true,
            services: true,
          },
        },
      },
    }),
    db.run.findMany({
      where: { parentRunId: runId },
      select: { id: true },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
    }),
    // Stored already redacted; the call id and the detail text are never selected.
    db.runStep.findMany({
      where: { runId },
      orderBy: { seq: "desc" },
      take: RUN_DETAIL_STEPS,
      select: { seq: true, at: true, kind: true, tool: true, summary: true, status: true },
    }),
    db.runStep.count({ where: { runId } }),
  ]);
  const steps = newest
    .reverse()
    .filter((s): s is typeof s & { kind: "tool" | "said" } => s.kind === "tool" || s.kind === "said")
    .map((s) => ({
      seq: s.seq,
      at: s.at.toISOString(),
      kind: s.kind,
      tool: s.tool,
      summary: s.summary,
      status: s.status,
    }));
  const coding = row.codingRun;
  return {
    ...graphRun,
    error: row.error,
    finalText: row.finalText,
    childRunIds: children.map((c) => c.id),
    steps,
    stepsOmitted: Math.max(0, stepCount - newest.length),
    stepsDropped: row.stepsDropped,
    coding: coding
      ? {
          provider: coding.provider,
          repository: coding.repository,
          baseRef: coding.baseRef,
          headRef: coding.headRef,
          queuedAt: coding.queuedAt ? coding.queuedAt.toISOString() : null,
          failureCategory: coding.failureCategory,
          services: serviceDetails(coding.services),
        }
      : null,
  };
}
