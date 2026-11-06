import type { NativeExecutionMode, Prisma, RunStatus } from "#prisma";
import type { WardbyMcpServer } from "../server.js";
import { agentAccessResolver, readableAgentsWhere, requireAgentAccess } from "../auth/access.js";
import { requireScope } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import { findReadableRun } from "./run-access.js";
import {
  publicCodingRunResult,
  redactTokenShapedValues,
  sanitizeDependencyCacheReport,
} from "../../coding/protocol.js";
import { countPlanRefusals, summarizeRegistryFetches } from "../../coding/registry/report.js";
import { summarizePackageAudit } from "../../coding/registry/audit-mode.js";
import { storedServiceLabels } from "../../coding/services/catalog.js";
import { textResult } from "./text-result.js";
import { loadBudgetEvents } from "../../core/budget-events.js";
import { loadAgentSecretValues, maskNamedSecrets } from "../../core/secret-guard.js";
import { logger } from "../../core/logger.js";
import type { McpRequestContext } from "../context.js";

const runsLog = logger.child({ module: "mcp-runs" });

/**
 * Run visibility (resource-sharing grants spec §3.5, A6): a run's output is
 * the triggerer's and the agent owner's, never every reader's. The owner
 * (and the stdio operator) sees every run; anyone else only runs with
 * Run.triggeredById equal to themselves.
 */
/** A run row with its execution mode in the operator spelling agent tools use; null for coding runs. */
function withOperatorMode<T extends { nativeExecutionMode?: NativeExecutionMode | null }>(
  run: T,
): Omit<T, "nativeExecutionMode"> & { nativeExecutionMode: "control-plane" | "sandbox" | null } {
  const mode = run.nativeExecutionMode;
  return { ...run, nativeExecutionMode: mode == null ? null : mode === "sandbox" ? "sandbox" : "control-plane" };
}

/**
 * A coding run's request as its readers may see it. It can be text a caller or an issue wrote, so
 * the agent's secret values and token-shaped values are masked here on every read. A secret that
 * can't be read means the text can't be checked, so it is withheld; the log carries the error name only.
 */
async function requestForReader(
  ctx: Pick<McpRequestContext, "db" | "providers">,
  run: { id: string; agentId: string },
  request: string,
): Promise<{ request: string } | { requestUnavailable: true }> {
  try {
    const named = await loadAgentSecretValues(ctx.db, ctx.providers.secrets, run.agentId);
    return { request: redactTokenShapedValues(maskNamedSecrets(request, named)) };
  } catch (err) {
    runsLog.warn(
      { runId: run.id, errorName: err instanceof Error ? err.name : typeof err },
      "could not read the agent's secrets to check a run's request; withholding it",
    );
    return { requestUnavailable: true };
  }
}

/** Statuses `active: true` keeps, and that `since` always keeps. */
const ACTIVE_STATUSES: RunStatus[] = ["pending", "running"];
/** Rows returned without an agentId: a default and a cap, since it spans every agent the caller can see. */
const ACROSS_AGENTS_DEFAULT_LIMIT = 50;
const ACROSS_AGENTS_MAX_LIMIT = 200;

/** The `active` and `since` filters, as clauses to AND onto the visibility rule. */
function runFilters(args: { active?: boolean; since?: string }): Prisma.RunWhereInput[] {
  const filters: Prisma.RunWhereInput[] = [];
  if (args.active === true) filters.push({ status: { in: ACTIVE_STATUSES } });
  if (args.since !== undefined) {
    const since = new Date(args.since);
    if (Number.isNaN(since.getTime())) throw new McpError(400, "since must be an ISO date or time");
    filters.push({
      OR: [{ startedAt: { gte: since } }, { finishedAt: { gte: since } }, { status: { in: ACTIVE_STATUSES } }],
    });
  }
  return filters;
}

/**
 * Runs across every agent the caller can read, under the same rule as one agent's listing: all runs of
 * agents they own, only the runs they triggered on the rest. With `all` (admin:view, checked by the
 * caller), every run in the deployment, as the admin viewer shows. Rows name their agent and leave
 * out finalText, which can be long and is one get_run away.
 */
async function listRunsAcrossAgents(
  ctx: McpRequestContext,
  filters: Prisma.RunWhereInput[],
  opts: { status?: string; limit?: number; all: boolean },
) {
  const [where, accessOf] = await Promise.all([
    opts.all ? Promise.resolve({}) : readableAgentsWhere(ctx),
    agentAccessResolver(ctx),
  ]);
  const agents = await ctx.db.agent.findMany({
    where,
    select: { id: true, ownerId: true, name: true, budgetUsd: true },
  });
  const owned = agents.filter((agent) => opts.all || accessOf(agent) === "owner").map((agent) => agent.id);
  const others = agents.filter((agent) => !opts.all && accessOf(agent) !== "owner").map((agent) => agent.id);
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const take = Math.min(Math.max(1, Math.floor(opts.limit ?? ACROSS_AGENTS_DEFAULT_LIMIT)), ACROSS_AGENTS_MAX_LIMIT);
  const status = opts.status;
  const runs = await ctx.db.run.findMany({
    where: {
      OR: [{ agentId: { in: owned } }, { agentId: { in: others }, triggeredById: ctx.principal.id }],
      ...(status ? { status: status as never } : {}),
      ...(filters.length > 0 ? { AND: filters } : {}),
    },
    omit: { finalText: true },
    take,
    orderBy: { startedAt: "desc" },
  });
  return runs.map((run) => {
    const agent = byId.get(run.agentId);
    return { ...run, agentName: agent?.name ?? null, agentBudgetUsd: agent ? Number(agent.budgetUsd) : null };
  });
}

/** Same rule as get_run: a pending coding run with queuedAt is waiting for a concurrency slot (CODING_MAX_CONCURRENT), not stuck. */
async function withQueuedAt<T extends { id: string; status: string; nativeExecutionMode?: NativeExecutionMode | null }>(
  ctx: McpRequestContext,
  runs: T[],
) {
  const pendingIds = runs.filter((run) => run.status === "pending").map((run) => run.id);
  const queued =
    pendingIds.length > 0
      ? await ctx.db.codingRun.findMany({
          where: { runId: { in: pendingIds }, queuedAt: { not: null } },
          select: { runId: true, queuedAt: true },
        })
      : [];
  const queuedAtByRun = new Map(queued.map((row) => [row.runId, row.queuedAt?.toISOString()]));
  return runs.map((run) => {
    const codingQueuedAt = queuedAtByRun.get(run.id);
    return codingQueuedAt ? { ...withOperatorMode(run), codingQueuedAt } : withOperatorMode(run);
  });
}

export function registerRunTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_runs",
    scope: "agents:read",
    description:
      "Lists runs, newest first. With agentId, that agent's runs; without it, runs across every agent you can see " +
      `(each row adds agentName and agentBudgetUsd and leaves out finalText; default limit ${ACROSS_AGENTS_DEFAULT_LIMIT}, ` +
      `at most ${ACROSS_AGENTS_MAX_LIMIT}). You see all runs of agents you own and only the runs you triggered on others. ` +
      "active: true keeps pending and running runs; since (ISO time) keeps runs that started or finished then or later, " +
      "plus any still pending or running. all: true (no agentId) lists every run in the deployment (admins only, admin:view). " +
      "Use get_run for one run's detail.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        status: { type: "string" },
        active: { type: "boolean" },
        since: { type: "string", description: "ISO date or time" },
        all: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    handler: async (
      args: { agentId?: string; status?: string; active?: boolean; since?: string; all?: boolean; limit?: number },
      ctx,
    ) => {
      const filters = runFilters(args);
      if (args.all === true) {
        if (args.agentId !== undefined) throw new McpError(400, "all lists every agent's runs; leave out agentId");
        if (!ctx.operator) requireScope(ctx, ctx.canonicalUri, "admin:view");
      }
      if (args.agentId === undefined) {
        const runs = await listRunsAcrossAgents(ctx, filters, {
          status: args.status,
          limit: args.limit,
          all: args.all === true,
        });
        return textResult(await withQueuedAt(ctx, runs));
      }
      const { access } = await requireAgentAccess(ctx, args.agentId, "read");
      const runs = await ctx.db.run.findMany({
        where: {
          agentId: args.agentId,
          ...(args.status ? { status: args.status as never } : {}),
          ...(access === "owner" ? {} : { triggeredById: ctx.principal.id }),
          ...(filters.length > 0 ? { AND: filters } : {}),
        },
        take: args.limit,
        orderBy: { startedAt: "desc" },
      });
      return textResult(await withQueuedAt(ctx, runs));
    },
  });

  mcp.registerTool({
    name: "get_run",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    handler: async (args: { runId: string }, ctx) => {
      // Its triggerer keeps seeing it even after losing access to the agent;
      // otherwise only the agent's owner. read on the agent is not enough.
      const run = await findReadableRun(ctx, args.runId);
      const codingRun = await ctx.db.codingRun.findUnique({
        where: { runId: run.id },
        select: {
          result: true,
          request: true,
          queuedAt: true,
          failureCategory: true,
          diagnosticId: true,
          debugTrace: true,
          debugTraceMaxMb: true,
          services: true,
          resultBranch: true,
          baseSha: true,
          dependencyCacheResult: true,
          prDescriptionOutcome: true,
          packageAuditMode: true,
          budgetBaseUsd: true,
          budgetReservedUsd: true,
          budgetLimitUsd: true,
        },
      });
      const localPr = await ctx.db.localPullRequest.findUnique({
        where: { runId: run.id },
        include: { reviews: { orderBy: { createdAt: "asc" } } },
      });
      const codingResult = publicCodingRunResult(codingRun?.result);
      // A pending coding run with queuedAt is waiting for a concurrency slot
      // (CODING_MAX_CONCURRENT), not stuck.
      const codingQueuedAt =
        run.status === "pending" && codingRun?.queuedAt ? codingRun.queuedAt.toISOString() : undefined;
      // Packages served/refused only exist for coding runs; a non-coding run
      // has no RegistryFetch rows at all, so skip the query entirely.
      const registryFetches = codingRun
        ? await ctx.db.registryFetch.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } })
        : [];
      const { packages, packageRefusals } = summarizeRegistryFetches(registryFetches);
      // Lockfile verification (POST /registry/<ecosystem>/-/plan): exact
      // versions approved for the run, and distinct entries it refused.
      const packagePlan = codingRun
        ? {
            approved: await ctx.db.registryApprovedVersion.count({ where: { runId: run.id } }),
            refused: countPlanRefusals(registryFetches),
          }
        : undefined;
      // Package audit mode, fixed at dispatch: what the registry served only
      // because of it (empty when nothing was), read only for a run that had it.
      const packageAuditMode = codingRun?.packageAuditMode ?? null;
      const packageAudit = packageAuditMode
        ? summarizePackageAudit(
            await ctx.db.registryAuditRecord.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } }),
          ).entries
        : undefined;
      // A failed coding run's error is only an opaque id; these two say which
      // stage failed and are the key an operator searches the control-plane
      // log for (the real reason is logged there, never persisted). Both are
      // designed to be safe to show the agent's owner (schema.prisma).
      const failureCategory = codingRun?.failureCategory ?? undefined;
      const diagnosticId = codingRun?.diagnosticId ?? undefined;
      // Which services the run started with ("postgres 16"); never their images or environments.
      const services = codingRun ? storedServiceLabels(codingRun.services) : [];
      // The worker's dependency cache report (stable codes, folder names and numbers only), re-bounded on read.
      const dependencyCache =
        codingRun?.dependencyCacheResult !== null && codingRun?.dependencyCacheResult !== undefined
          ? sanitizeDependencyCacheReport(codingRun.dependencyCacheResult)
          : undefined;
      // Well-formed refusals only, with group, lead and agent budget filled as the run error's are.
      const budgetEvents = await loadBudgetEvents(ctx.db, run.id);
      // What the run was asked to do: the trigger's or lead's task, without the agent's standing instructions.
      const request = codingRun?.request ? await requestForReader(ctx, run, codingRun.request) : {};
      return textResult({
        ...withOperatorMode(run),
        ...request,
        ...(budgetEvents.length > 0 ? { budgetEvents } : {}),
        ...(codingRun?.budgetReservedUsd != null ? { budgetReservedUsd: Number(codingRun.budgetReservedUsd) } : {}),
        ...(codingRun?.budgetBaseUsd != null ? { budgetBaseUsd: Number(codingRun.budgetBaseUsd) } : {}),
        // The most overrun top-ups may raise budgetReservedUsd to; absent = the reservation is the limit.
        ...(codingRun?.budgetLimitUsd != null ? { budgetLimitUsd: Number(codingRun.budgetLimitUsd) } : {}),
        ...(codingResult ? { codingResult } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        ...(diagnosticId ? { diagnosticId } : {}),
        ...(codingQueuedAt ? { codingQueuedAt } : {}),
        // An admin turned on the debug trace: the worker's full trace is in its pod log.
        ...(codingRun?.debugTrace ? { debugTrace: true } : {}),
        ...(codingRun?.debugTrace && codingRun.debugTraceMaxMb ? { debugTraceMaxMb: codingRun.debugTraceMaxMb } : {}),
        ...(services.length > 0 ? { services } : {}),
        ...(codingRun?.resultBranch ? { resultBranch: codingRun.resultBranch } : {}),
        ...(codingRun?.baseSha ? { baseSha: codingRun.baseSha } : {}),
        ...(dependencyCache ? { dependencyCache } : {}),
        ...(codingRun?.prDescriptionOutcome ? { prDescriptionOutcome: codingRun.prDescriptionOutcome } : {}),
        ...(localPr
          ? {
              review: {
                number: localPr.number,
                branch: localPr.branch,
                base: localPr.base,
                reviews: localPr.reviews.map((r) => ({
                  verdict: r.verdict,
                  summary: r.summary,
                  body: r.body,
                  comments: r.comments,
                })),
              },
            }
          : {}),
        ...(codingRun ? { packages, packageRefusals, packagePlan } : {}),
        ...(packageAuditMode ? { packageAuditMode, packageAudit } : {}),
      });
    },
  });
}
