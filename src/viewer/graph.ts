/** The graph snapshot read model behind GET /admin/api/graph (docs/viewer-api.md). */
import type { Prisma, PrismaClient } from "#prisma";
import { periodStart } from "../core/budget-groups.js";
import { publicCodingRunResult } from "../coding/protocol.js";
import type { GraphRun, GraphSnapshot, Outcome, RunTriggerInfo } from "./api-schema.js";

export const DEFAULT_GRAPH_LIMIT = 500;
export const MAX_GRAPH_LIMIT = 2000;

const DEFAULT_SINCE_MS = 60 * 60 * 1000;
const RELATIVE_SINCE_MS: Record<string, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** Accepts "15m" | "1h" | "6h" | "24h" | "7d" or an ISO-8601 timestamp; null defaults to 1h. Throws otherwise. */
export function parseSince(value: string | null, now: Date): Date {
  if (value === null) return new Date(now.getTime() - DEFAULT_SINCE_MS);
  if (Object.hasOwn(RELATIVE_SINCE_MS, value)) return new Date(now.getTime() - RELATIVE_SINCE_MS[value]);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`invalid since "${value}": use 15m, 1h, 6h, 24h, 7d or an ISO-8601 timestamp`);
}

const runInclude = {
  agent: true,
  codingRun: { select: { result: true, provider: true, model: true, services: true } },
  hostCheck: true,
  hostStatus: true,
  issueStatus: true,
  serviceStatuses: { orderBy: { createdAt: "asc" } },
  nativeWarmWorker: { select: { name: true } },
} satisfies Prisma.RunInclude;

type RunRow = Prisma.RunGetPayload<{ include: typeof runInclude }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Name and version of each service in a coding run's resolved services snapshot. */
function declaredServices(snapshot: unknown): GraphRun["declaredServices"] {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.filter(isRecord).map((s) => ({ name: String(s.name), version: String(s.version) }));
}
type PullRequestRow = Prisma.IssuePullRequestGetPayload<object>;

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/** Site origin per issue-tracker provider (e.g. `{ jira: "https://your-site.atlassian.net" }`), for links. */
export type IssueSites = Readonly<Record<string, string>>;

/** The tracker's page for an issue (and, with a comment id, that comment); null without a known site. */
export function issueUrl(
  sites: IssueSites,
  provider: string,
  issueKey: string,
  commentId?: string | null,
): string | null {
  const site = sites[provider];
  if (!site || provider !== "jira") return null;
  const page = `${site}/browse/${encodeURIComponent(issueKey)}`;
  return commentId ? `${page}?focusedCommentId=${encodeURIComponent(commentId)}` : page;
}

function triggerFor(row: RunRow, sites: IssueSites): RunTriggerInfo {
  switch (row.trigger) {
    case "scheduled":
      return { kind: "scheduled", schedule: row.agent.schedule };
    case "webhook":
      return { kind: "webhook" };
    case "subagent":
      return { kind: "subagent" };
    case "manual":
      return { kind: "manual" };
    case "host_event":
      if (row.issueStatus) {
        return {
          kind: "issue",
          provider: row.issueStatus.provider,
          issueKey: row.issueStatus.issueKey,
          url: issueUrl(sites, row.issueStatus.provider, row.issueStatus.issueKey),
        };
      }
      if (row.hostStatus) {
        return {
          kind: "code_host",
          provider: row.hostStatus.provider,
          repository: row.hostStatus.repository,
          number: row.hostStatus.number,
          event: "mention",
        };
      }
      if (row.hostCheck) {
        return {
          kind: "code_host",
          provider: row.hostCheck.provider,
          repository: row.hostCheck.repository,
          number: row.hostCheck.prNumber,
          event: "review",
        };
      }
      return { kind: "host_event" };
  }
}

function outcomesFor(row: RunRow, pullRequests: readonly PullRequestRow[], sites: IssueSites): Outcome[] {
  const outcomes: Outcome[] = pullRequests.map((pr) => ({
    kind: "pull_request",
    provider: pr.codeProvider,
    repository: pr.repository,
    number: pr.number,
    url: pr.url,
    state: pr.state,
    at: pr.createdAt.toISOString(),
  }));
  const result = publicCodingRunResult(row.codingRun?.result);
  if (
    result?.pullRequestUrl &&
    result.pullRequestNumber &&
    !pullRequests.some((pr) => pr.url === result.pullRequestUrl)
  ) {
    outcomes.push({
      kind: "pull_request",
      provider: "github",
      repository: result.repository,
      number: result.pullRequestNumber,
      url: result.pullRequestUrl,
      state: null,
      at: iso(row.finishedAt),
    });
  }
  if (row.hostStatus?.commentId) {
    outcomes.push({
      kind: "code_host_comment",
      provider: row.hostStatus.provider,
      repository: row.hostStatus.repository,
      number: row.hostStatus.number,
      at: (row.hostStatus.completedAt ?? row.hostStatus.createdAt).toISOString(),
    });
  }
  if (row.issueStatus?.commentId) {
    outcomes.push({
      kind: "issue_comment",
      provider: row.issueStatus.provider,
      issueKey: row.issueStatus.issueKey,
      url: issueUrl(sites, row.issueStatus.provider, row.issueStatus.issueKey, row.issueStatus.commentId),
      at: (row.issueStatus.completedAt ?? row.issueStatus.createdAt).toISOString(),
    });
  }
  if (row.hostCheck) {
    outcomes.push({
      kind: "check",
      provider: row.hostCheck.provider,
      repository: row.hostCheck.repository,
      number: row.hostCheck.prNumber,
      completed: row.hostCheck.completedAt !== null,
      at: iso(row.hostCheck.completedAt),
    });
  }
  return outcomes;
}

/** The one row -> GraphRun mapping (also used by run detail). `pullRequests` are the IssuePullRequest rows this run opened. */
export function toGraphRun(row: RunRow, pullRequests: readonly PullRequestRow[], sites: IssueSites = {}): GraphRun {
  return {
    id: row.id,
    parentRunId: row.parentRunId,
    agentId: row.agentId,
    agentName: row.agent.name,
    agentKind: row.agent.kind,
    model: row.codingRun?.model ?? row.agent.model,
    codingProvider: row.codingRun?.provider ?? null,
    nativeExecutionMode:
      row.nativeExecutionMode === "sandbox"
        ? "sandbox"
        : row.nativeExecutionMode === "control_plane"
          ? "control-plane"
          : null,
    warmWorkerName: row.nativeWarmWorker?.name ?? null,
    status: row.status,
    trigger: triggerFor(row, sites),
    turns: row.turns,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: Number(row.costUsd),
    budgetUsd: Number(row.agent.budgetUsd),
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    heartbeatAt: iso(row.heartbeatAt),
    outcomes: outcomesFor(row, pullRequests, sites),
    declaredServices: declaredServices(row.codingRun?.services),
    services: row.serviceStatuses.map((s) => ({
      name: s.name,
      state: s.state,
      attempts: s.attempts,
      reason: s.reason,
      readyAt: iso(s.readyAt),
      failedAt: iso(s.failedAt),
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

async function mapRows(db: PrismaClient, rows: readonly RunRow[], sites: IssueSites): Promise<GraphRun[]> {
  if (rows.length === 0) return [];
  const pullRequests = await db.issuePullRequest.findMany({
    where: { openedByRunId: { in: rows.map((r) => r.id) } },
    orderBy: { createdAt: "asc" },
  });
  const byRun = new Map<string, PullRequestRow[]>();
  for (const pr of pullRequests) byRun.set(pr.openedByRunId, [...(byRun.get(pr.openedByRunId) ?? []), pr]);
  return rows.map((row) => toGraphRun(row, byRun.get(row.id) ?? [], sites));
}

/** Loads the given runs as GraphRuns (shared with run detail); unknown ids are skipped. */
export async function loadGraphRuns(
  db: PrismaClient,
  runIds: readonly string[],
  sites: IssueSites = {},
): Promise<GraphRun[]> {
  if (runIds.length === 0) return [];
  const rows = await db.run.findMany({ where: { id: { in: [...runIds] } }, include: runInclude });
  return mapRows(db, rows, sites);
}

export async function loadGraph(
  db: PrismaClient,
  options: { since: Date; limit: number; now?: Date; issueSites?: IssueSites },
): Promise<GraphSnapshot> {
  const now = options.now ?? new Date();
  // Window rule: started inside the window, or still in flight (a long run started earlier stays visible).
  const windowed = await db.run.findMany({
    where: { OR: [{ startedAt: { gte: options.since } }, { status: { in: ["pending", "running"] } }] },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    include: runInclude,
  });
  const truncated = windowed.length > options.limit;
  const rows: RunRow[] = windowed.slice(0, options.limit);

  // Ancestor rule: every ancestor of a windowed run is included, one batch per level, never capped.
  const known = new Set(rows.map((r) => r.id));
  let frontier = rows;
  for (;;) {
    const missing = [
      ...new Set(frontier.map((r) => r.parentRunId).filter((p): p is string => p !== null && !known.has(p))),
    ];
    if (missing.length === 0) break;
    frontier = await db.run.findMany({ where: { id: { in: missing } }, include: runInclude });
    for (const r of frontier) {
      known.add(r.id);
      rows.push(r);
    }
  }

  const dayStart = periodStart("day", now);
  const [runs, today, groups] = await Promise.all([
    mapRows(db, rows, options.issueSites ?? {}),
    db.run.aggregate({ where: { startedAt: { gte: dayStart } }, _sum: { costUsd: true } }),
    db.budgetGroup.findMany({
      where: { dailyBudgetUsd: { not: null } },
      select: { id: true, name: true, dailyBudgetUsd: true, agents: { select: { id: true } } },
      orderBy: { name: "asc" },
    }),
  ]);

  const memberAgents = groups.flatMap((g) => g.agents.map((a) => a.id));
  const spendByAgent = memberAgents.length
    ? await db.run.groupBy({
        by: ["agentId"],
        where: { agentId: { in: memberAgents }, startedAt: { gte: dayStart } },
        _sum: { costUsd: true },
      })
    : [];
  const spent = new Map(spendByAgent.map((s) => [s.agentId, Number(s._sum.costUsd ?? 0)]));

  return {
    generatedAt: now.toISOString(),
    since: options.since.toISOString(),
    limit: options.limit,
    truncated,
    runs,
    spend: {
      todayUsd: Number(today._sum.costUsd ?? 0),
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        dailyBudgetUsd: g.dailyBudgetUsd === null ? null : Number(g.dailyBudgetUsd),
        spentTodayUsd: g.agents.reduce((sum, a) => sum + (spent.get(a.id) ?? 0), 0),
      })),
    },
  };
}
