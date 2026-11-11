import type { NativeExecutionMode, Prisma, RunStatus } from "#prisma";
import type { WardbyMcpServer } from "../server.js";
import { agentAccessResolver, readableAgentsWhere, requireAgentAccess } from "../auth/access.js";
import { requireScope } from "../auth/resource-server.js";
import { McpError } from "../errors.js";
import { loadGraphRuns, type IssueSites } from "../../viewer/graph.js";
import { loadJiraConfig } from "../../config/providers.js";
import { findReadableRun } from "./run-access.js";
import { publicCodingRunResult, sanitizeDependencyCacheReport } from "../../coding/protocol.js";
import { countPlanRefusals, summarizeRegistryFetches } from "../../coding/registry/report.js";
import { summarizePackageAudit } from "../../coding/registry/audit-mode.js";
import { storedServiceLabels } from "../../coding/services/catalog.js";
import { textResult } from "./text-result.js";
import {
  clampInt,
  firstPageFields,
  listPage,
  RUN_PACKAGES_DEFAULT_LIMIT,
  RUN_PACKAGES_MAX_LIMIT,
  RUN_TEXT_DEFAULT_LIMIT,
  RUN_TEXT_FIELDS,
  RUN_TEXT_FIRST_PAGE_CHARS,
  RUN_TEXT_MAX_LIMIT,
  textPiece,
  type RunTextField,
} from "./run-pages.js";
import { loadBudgetEvents } from "../../core/budget-events.js";
import { requestForReader as readRequest } from "../../core/run-request.js";
import { loadLastSteps } from "../../core/run-steps/last-step.js";
import type { McpRequestContext } from "../context.js";

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

/** A coding run's request as get_run returns it: masked by the shared reader (core/run-request.ts). */
const requestForReader = (
  ctx: Pick<McpRequestContext, "db" | "providers">,
  run: { id: string; agentId: string },
  request: string,
) => readRequest(ctx.db, ctx.providers.secrets, run, request);

/** The issue-tracker sites issue links are built from (the admin viewer's own source); none when unset or invalid. */
function issueSites(): IssueSites {
  try {
    const jira = loadJiraConfig();
    return jira ? { jira: jira.siteUrl } : {};
  } catch {
    return {};
  }
}

/**
 * What started each run and what it produced, in the admin viewer API's shapes (docs/viewer-api.md):
 * `triggerInfo` (the pull request, issue, schedule or lead behind it), `outcomes` (pull requests opened,
 * comments, checks) and `serviceReadiness` (each coding-run service's state). Only ids and links:
 * repositories, numbers, issue keys, URLs, states and times, never free text. A service's failure
 * `reason` is left out, since it can quote what the service printed.
 */
async function runGraphFields(ctx: Pick<McpRequestContext, "db">, runIds: readonly string[]) {
  const graph = await loadGraphRuns(ctx.db, runIds, issueSites());
  return new Map(
    graph.map((run) => [
      run.id,
      {
        triggerInfo: run.trigger,
        outcomes: run.outcomes,
        serviceReadiness: run.services.map(({ name, state, attempts, readyAt, failedAt }) => ({
          name,
          state,
          attempts,
          readyAt,
          failedAt,
        })),
      },
    ]),
  );
}

/** Statuses `active: true` keeps, and that `since` always keeps. */
const ACTIVE_STATUSES: RunStatus[] = ["pending", "running"];
/** Rows a listing returns: a default and a cap, with or without an agentId. */
const ACROSS_AGENTS_DEFAULT_LIMIT = 50;
/**
 * The most of a run's taskOverride a listing row carries. A run started from GitHub or Jira holds the
 * whole issue or review text (often 5-10 KB), and a full listing of such rows can pass an MCP client's
 * result limit; a list needs the task's first lines only. get_run and get_run_text have the rest.
 */
export const ACROSS_AGENTS_TASK_CHARS = 600;
const ACROSS_AGENTS_MAX_LIMIT = 200;

/** A listing's page size: the default when the limit isn't a finite number, and never past the cap. */
function listingTake(limit: number | undefined): number {
  return clampInt(limit, ACROSS_AGENTS_DEFAULT_LIMIT, 1, ACROSS_AGENTS_MAX_LIMIT);
}

/** Newest first; id breaks startedAt ties, so `before` pages neither repeat nor skip runs that started together. */
const LISTING_ORDER: Prisma.RunOrderByWithRelationInput[] = [{ startedAt: "desc" }, { id: "desc" }];

/**
 * The clause that keeps a listing to the runs after `before`, or null for an empty page. The cursor must be
 * a run this listing could show (its access rule only: a run that has since stopped matching `active` or
 * `status` still marks its place). A run the caller can't read, or that doesn't exist, gives an empty page,
 * so the reply never tells the two apart.
 */
async function beforeClause(
  ctx: McpRequestContext,
  readable: Prisma.RunWhereInput,
  before: string,
): Promise<Prisma.RunWhereInput | null> {
  const cursor = await ctx.db.run.findFirst({
    where: { AND: [readable, { id: before }] },
    select: { id: true, startedAt: true },
  });
  if (!cursor) return null;
  return { OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }] };
}

/** A listing row's task: its first ACROSS_AGENTS_TASK_CHARS characters, marked when there is more. */
function withListingTask<T extends { taskOverride: string | null }>(run: T): T & { taskOverrideTruncated?: true } {
  if (typeof run.taskOverride !== "string" || run.taskOverride.length <= ACROSS_AGENTS_TASK_CHARS) return run;
  return {
    ...run,
    taskOverride: textPiece(run.taskOverride, 0, ACROSS_AGENTS_TASK_CHARS).text,
    taskOverrideTruncated: true,
  };
}

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
  opts: { status?: string; limit?: number; all: boolean; before?: string },
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
  const take = listingTake(opts.limit);
  const status = opts.status;
  const readable: Prisma.RunWhereInput = {
    OR: [{ agentId: { in: owned } }, { agentId: { in: others }, triggeredById: ctx.principal.id }],
  };
  const clauses = [...filters];
  if (opts.before !== undefined) {
    const after = await beforeClause(ctx, readable, opts.before);
    if (!after) return [];
    clauses.push(after);
  }
  const runs = await ctx.db.run.findMany({
    where: {
      ...readable,
      ...(status ? { status: status as never } : {}),
      ...(clauses.length > 0 ? { AND: clauses } : {}),
    },
    omit: { finalText: true, pricingSnapshot: true },
    take,
    orderBy: LISTING_ORDER,
  });
  const graph = await runGraphFields(
    ctx,
    runs.map((run) => run.id),
  );
  // The newest step of each run (the runs pane's one line), when it has any.
  const lastSteps = await loadLastSteps(
    ctx.db,
    runs.map((run) => run.id),
  );
  return runs.map((run) => {
    const agent = byId.get(run.agentId);
    return {
      ...withListingTask(run),
      agentName: agent?.name ?? null,
      agentBudgetUsd: agent ? Number(agent.budgetUsd) : null,
      ...(graph.get(run.id) ?? { triggerInfo: null, outcomes: [], serviceReadiness: [] }),
      ...(lastSteps.has(run.id) ? { lastStep: lastSteps.get(run.id) } : {}),
    };
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

/** A coding run's registry fetches in a stable order (id breaks createdAt ties), as get_run and get_run_packages read them. */
function registryFetchesOf(ctx: Pick<McpRequestContext, "db">, runId: string) {
  return ctx.db.registryFetch.findMany({ where: { runId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

/**
 * One of a run's long text fields as get_run returns it (the request masked as get_run masks it), or
 * null when the run has none. Only the RUN_TEXT_FIELDS allowlist reaches here.
 */
async function runTextField(
  ctx: McpRequestContext,
  run: { id: string; agentId: string; taskOverride: string | null; finalText: string | null; error: string | null },
  field: RunTextField,
): Promise<{ text: string | null } | { requestUnavailable: true }> {
  if (field !== "request") return { text: run[field] };
  const codingRun = await ctx.db.codingRun.findUnique({ where: { runId: run.id }, select: { request: true } });
  if (!codingRun?.request) return { text: null };
  const read = await requestForReader(ctx, run, codingRun.request);
  return "request" in read ? { text: read.request } : read;
}

export function registerRunTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_runs",
    scope: "agents:read",
    description:
      "Lists runs, newest first. With agentId, that agent's runs; without it, runs across every agent you can see " +
      "(those rows add agentName, agentBudgetUsd, triggerInfo, outcomes, serviceReadiness and lastStep, the run's newest " +
      "step as one line when it has steps). Every row leaves out finalText and pricingSnapshot (get_run has them), and " +
      `carries taskOverride's first ${ACROSS_AGENTS_TASK_CHARS} characters: a longer one has taskOverrideTruncated: true, ` +
      'and get_run_text (field "taskOverride", offset ' +
      `${ACROSS_AGENTS_TASK_CHARS}) has the rest. Default limit ${ACROSS_AGENTS_DEFAULT_LIMIT}, at most ${ACROSS_AGENTS_MAX_LIMIT}. ` +
      "You see all runs of agents you own and only the runs you triggered on others. " +
      "active: true keeps pending and running runs; since (ISO time) keeps runs that started or finished then or later, " +
      "plus any still pending or running. all: true (no agentId) lists every run in the deployment (admins only, admin:view). " +
      "Pages are newest first (startedAt, then id): for the next page, pass before: the last row's id, with or without " +
      "agentId; the reply holds only runs after that one, and is empty when before names no run this listing could show. " +
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
        before: {
          type: "string",
          description: "A run id from the previous page: list only the runs after it",
        },
      },
    },
    handler: async (
      args: {
        agentId?: string;
        status?: string;
        active?: boolean;
        since?: string;
        all?: boolean;
        limit?: number;
        before?: string;
      },
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
          before: args.before,
        });
        return textResult(await withQueuedAt(ctx, runs));
      }
      const { access } = await requireAgentAccess(ctx, args.agentId, "read");
      const readable: Prisma.RunWhereInput = {
        agentId: args.agentId,
        ...(access === "owner" ? {} : { triggeredById: ctx.principal.id }),
      };
      const clauses = [...filters];
      if (args.before !== undefined) {
        const after = await beforeClause(ctx, readable, args.before);
        if (!after) return textResult([]);
        clauses.push(after);
      }
      const runs = await ctx.db.run.findMany({
        where: {
          ...readable,
          ...(args.status ? { status: args.status as never } : {}),
          ...(clauses.length > 0 ? { AND: clauses } : {}),
        },
        omit: { finalText: true, pricingSnapshot: true },
        take: listingTake(args.limit),
        orderBy: LISTING_ORDER,
      });
      return textResult(await withQueuedAt(ctx, runs.map(withListingTask)));
    },
  });

  mcp.registerTool({
    name: "get_run",
    scope: "agents:read",
    description:
      "One run in full: status, cost, request, result, errors and budget events, plus triggerInfo (what started it: " +
      "a pull request review or mention, an issue, a schedule or a lead run), outcomes (pull requests opened, comments, " +
      "checks) and serviceReadiness. A run's pull-request outcome matching another run's triggerInfo links the two. " +
      "lastStep is the newest step; get_run_steps lists them all. A coding run has packageCount (packages the registry " +
      "served it), packagePlan and packageRefusals; use get_run_packages for the packages themselves. request, " +
      `taskOverride, finalText and error come whole up to ${RUN_TEXT_FIRST_PAGE_CHARS} characters. A longer one comes ` +
      `as its first ${RUN_TEXT_FIRST_PAGE_CHARS} characters, a first page, not a cut: <field>More ({ next, total }) ` +
      "says so, and get_run_text with that field and offset next returns the rest.",
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
      const registryFetches = codingRun ? await registryFetchesOf(ctx, run.id) : [];
      // The packages themselves page through get_run_packages: a run can install more than a reply holds.
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
      // What started the run and what it produced, as the admin viewer shows them.
      const graph = (await runGraphFields(ctx, [run.id])).get(run.id);
      // The newest step (get_run_steps has them all).
      const lastStep = (await loadLastSteps(ctx.db, [run.id])).get(run.id);
      // What the run was asked to do: the trigger's or lead's task, without the agent's standing instructions.
      const request: { request?: string; requestUnavailable?: true } = codingRun?.request
        ? await requestForReader(ctx, run, codingRun.request)
        : {};
      return textResult({
        ...withOperatorMode(run),
        // Long free text comes as a first page with <field>More; get_run_text has the rest.
        ...firstPageFields("taskOverride", run.taskOverride),
        ...firstPageFields("finalText", run.finalText),
        ...firstPageFields("error", run.error),
        ...(request.request !== undefined ? firstPageFields("request", request.request) : request),
        ...(graph ?? {}),
        ...(lastStep ? { lastStep } : {}),
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
        ...(codingRun ? { packageCount: packages.length, packageRefusals, packagePlan } : {}),
        ...(packageAuditMode ? { packageAuditMode, packageAudit } : {}),
      });
    },
  });

  mcp.registerTool({
    name: "get_run_packages",
    scope: "agents:read",
    description:
      "The packages the package registry served a coding run (each ecosystem, name, version, size and any accepted " +
      "advisories), in a stable order: the order the run first fetched them. get_run gives only packageCount. " +
      "To read the next page, call again with after set to the next you were given. " +
      `next is the after for the next page, or null. limit defaults to ${RUN_PACKAGES_DEFAULT_LIMIT}, at most ` +
      `${RUN_PACKAGES_MAX_LIMIT}. total counts every package. Same access as get_run.`,
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        after: { type: "number", description: "Packages already read: the next from the previous page" },
        limit: {
          type: "number",
          description: `Packages to return (default ${RUN_PACKAGES_DEFAULT_LIMIT}, at most ${RUN_PACKAGES_MAX_LIMIT})`,
        },
      },
      required: ["runId"],
    },
    handler: async (args: { runId: string; after?: number; limit?: number }, ctx) => {
      const run = await findReadableRun(ctx, args.runId);
      const codingRun = await ctx.db.codingRun.findUnique({ where: { runId: run.id }, select: { runId: true } });
      const { packages } = summarizeRegistryFetches(codingRun ? await registryFetchesOf(ctx, run.id) : []);
      const after = clampInt(args.after, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(args.limit, RUN_PACKAGES_DEFAULT_LIMIT, 1, RUN_PACKAGES_MAX_LIMIT);
      const { page, next } = listPage(packages, after, limit);
      return textResult({ runId: run.id, packages: page, next, total: packages.length });
    },
  });

  mcp.registerTool({
    name: "get_run_text",
    scope: "agents:read",
    description:
      "A piece of one of a run's long text fields: request, taskOverride, finalText or error, exactly as get_run " +
      "returns them. get_run returns a long field's first page with <field>More ({ next, total }); call this with " +
      "offset next for the rest, and again with each next until next is null. The pieces joined in order are the " +
      "whole text. Offsets count UTF-16 code units; a piece never ends inside a surrogate pair (it stops one unit " +
      "early instead), so next can be one less than offset plus limit. " +
      `limit defaults to ${RUN_TEXT_DEFAULT_LIMIT} characters, at most ${RUN_TEXT_MAX_LIMIT}. total is the field's ` +
      "full length; text is null when the run has no such field. Same access as get_run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        field: { type: "string", enum: [...RUN_TEXT_FIELDS] },
        offset: { type: "number", description: "Where the piece starts: 0, or the next from the previous piece" },
        limit: {
          type: "number",
          description: `Characters to return (default ${RUN_TEXT_DEFAULT_LIMIT}, at most ${RUN_TEXT_MAX_LIMIT})`,
        },
      },
      required: ["runId", "field"],
    },
    handler: async (args: { runId: string; field: string; offset?: number; limit?: number }, ctx) => {
      if (!(RUN_TEXT_FIELDS as readonly string[]).includes(args.field)) {
        throw new McpError(400, `field must be one of ${RUN_TEXT_FIELDS.join(", ")}`);
      }
      const field = args.field as RunTextField;
      const run = await findReadableRun(ctx, args.runId);
      const value = await runTextField(ctx, run, field);
      if (!("text" in value)) return textResult({ runId: run.id, field, requestUnavailable: true });
      if (value.text === null) return textResult({ runId: run.id, field, offset: 0, text: null, next: null, total: 0 });
      const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInt(args.limit, RUN_TEXT_DEFAULT_LIMIT, 1, RUN_TEXT_MAX_LIMIT);
      return textResult({ runId: run.id, field, ...textPiece(value.text, offset, limit) });
    },
  });
}
