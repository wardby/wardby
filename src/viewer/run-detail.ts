/** The run detail read model behind GET /admin/api/runs/:id (docs/viewer-api.md). */
import type { PrismaClient } from "#prisma";
import type { RunDetail } from "./api-schema.js";
import { loadGraphRuns, type IssueSites } from "./graph.js";
import { codeProviderOf, pullRequestWebUrl } from "../coding/code-host.js";
import { publicCodingRunResult } from "../coding/protocol.js";
import { requestForReader } from "../core/run-request.js";
import { RUN_TEXT_FIRST_PAGE_CHARS, textPiece } from "../mcp/tools/run-pages.js";

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

/** Reads an agent's secret values, to mask them in a run's request (the server's secret cipher). */
export type RequestSecrets = Parameters<typeof requestForReader>[1];

/**
 * The run's request as a reader may see it: masked first (so a secret across the cut is masked
 * whole), then cut to its first RUN_TEXT_FIRST_PAGE_CHARS. Null when there is none or it can't be checked.
 */
async function readableRequest(
  db: PrismaClient,
  secrets: RequestSecrets,
  run: { id: string; agentId: string },
  text: string | null,
): Promise<{ request: string | null; requestTruncated: boolean }> {
  if (!text) return { request: null, requestTruncated: false };
  const read = await requestForReader(db, secrets, run, text);
  if (!("request" in read)) return { request: null, requestTruncated: false };
  const piece = textPiece(read.request, 0, RUN_TEXT_FIRST_PAGE_CHARS);
  return { request: piece.text, requestTruncated: piece.next !== null };
}

export async function loadRunDetail(
  db: PrismaClient,
  runId: string,
  issueSites: IssueSites = {},
  secrets?: RequestSecrets,
): Promise<RunDetail | null> {
  const [graphRun] = await loadGraphRuns(db, [runId], issueSites);
  if (!graphRun) return null;
  const [row, children, newest, stepCount] = await Promise.all([
    db.run.findUniqueOrThrow({
      where: { id: runId },
      select: {
        agentId: true,
        error: true,
        finalText: true,
        stepsDropped: true,
        taskOverride: true,
        codingRun: {
          select: {
            request: true,
            provider: true,
            repository: true,
            baseRef: true,
            headRef: true,
            queuedAt: true,
            failureCategory: true,
            services: true,
            repositories: {
              orderBy: { position: "asc" },
              select: {
                name: true,
                access: true,
                repository: true,
                requestedRef: true,
                resolvedSha: true,
                pullRequestNumber: true,
                resultBranch: true,
                result: true,
              },
            },
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
  // A coding run's own request, else the task the run was started with (a native run's).
  const request = secrets
    ? await readableRequest(db, secrets, { id: runId, agentId: row.agentId }, coding?.request ?? row.taskOverride)
    : {};
  return {
    ...graphRun,
    error: row.error,
    finalText: row.finalText,
    childRunIds: children.map((c) => c.id),
    steps,
    stepsOmitted: Math.max(0, stepCount - newest.length),
    stepsDropped: row.stepsDropped,
    ...request,
    coding: coding
      ? {
          provider: coding.provider,
          repository: coding.repository,
          baseRef: coding.baseRef,
          headRef: coding.headRef,
          queuedAt: coding.queuedAt ? coding.queuedAt.toISOString() : null,
          failureCategory: coding.failureCategory,
          services: serviceDetails(coding.services),
          repositories: coding.repositories.map((r) => ({
            name: r.name,
            access: r.access === "write" ? ("write" as const) : ("read" as const),
            repository: r.repository,
            requestedRef: r.requestedRef ?? null,
            resolvedSha: r.resolvedSha ?? null,
            pullRequestNumber: r.pullRequestNumber ?? null,
            pullRequestUrl:
              r.pullRequestNumber != null
                ? pullRequestWebUrl(codeProviderOf(r.repository), r.repository, r.pullRequestNumber)
                : null,
            resultBranch: r.resultBranch ?? null,
            outcome: publicCodingRunResult(r.result)?.outcome ?? null,
          })),
        }
      : null,
  };
}
