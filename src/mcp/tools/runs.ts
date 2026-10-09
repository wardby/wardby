import type { NativeExecutionMode } from "#prisma";
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { agentAccess, requireAgentAccess } from "../auth/access.js";
import { publicCodingRunResult } from "../../coding/protocol.js";
import { countPlanRefusals, summarizeRegistryFetches } from "../../coding/registry/report.js";
import { storedServiceLabels } from "../../coding/services/catalog.js";
import { textResult } from "./text-result.js";

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

export function registerRunTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_runs",
    scope: "agents:read",
    inputSchema: {
      type: "object",
      properties: { agentId: { type: "string" }, status: { type: "string" }, limit: { type: "number" } },
      required: ["agentId"],
    },
    handler: async (args: { agentId: string; status?: string; limit?: number }, ctx) => {
      const { access } = await requireAgentAccess(ctx, args.agentId, "read");
      const runs = await ctx.db.run.findMany({
        where: {
          agentId: args.agentId,
          ...(args.status ? { status: args.status as never } : {}),
          ...(access === "owner" ? {} : { triggeredById: ctx.principal.id }),
        },
        take: args.limit,
        orderBy: { startedAt: "desc" },
      });
      // Same rule as get_run: a pending coding run with queuedAt is waiting
      // for a concurrency slot (CODING_MAX_CONCURRENT), not stuck.
      const pendingIds = runs.filter((run) => run.status === "pending").map((run) => run.id);
      const queued =
        pendingIds.length > 0
          ? await ctx.db.codingRun.findMany({
              where: { runId: { in: pendingIds }, queuedAt: { not: null } },
              select: { runId: true, queuedAt: true },
            })
          : [];
      const queuedAtByRun = new Map(queued.map((row) => [row.runId, row.queuedAt?.toISOString()]));
      return textResult(
        runs.map((run) => {
          const codingQueuedAt = queuedAtByRun.get(run.id);
          return codingQueuedAt ? { ...withOperatorMode(run), codingQueuedAt } : withOperatorMode(run);
        }),
      );
    },
  });

  mcp.registerTool({
    name: "get_run",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    handler: async (args: { runId: string }, ctx) => {
      const run = await ctx.db.run.findUnique({ where: { id: args.runId } });
      const notFound = new McpError(404, `Run "${args.runId}" not found.`);
      if (!run) throw notFound;
      // Its triggerer keeps seeing it even after losing access to the agent;
      // otherwise only the agent's owner. read on the agent is not enough.
      if (run.triggeredById !== ctx.principal.id) {
        const agent = await ctx.db.agent.findUnique({ where: { id: run.agentId } });
        if (!agent || (await agentAccess(ctx, agent)) !== "owner") throw notFound;
      }
      const codingRun = await ctx.db.codingRun.findUnique({
        where: { runId: run.id },
        select: {
          result: true,
          queuedAt: true,
          failureCategory: true,
          diagnosticId: true,
          debugTrace: true,
          services: true,
          resultBranch: true,
          baseSha: true,
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
      // A failed coding run's error is only an opaque id; these two say which
      // stage failed and are the key an operator searches the control-plane
      // log for (the real reason is logged there, never persisted). Both are
      // designed to be safe to show the agent's owner (schema.prisma).
      const failureCategory = codingRun?.failureCategory ?? undefined;
      const diagnosticId = codingRun?.diagnosticId ?? undefined;
      // Which services the run started with ("postgres 16"); never their images or environments.
      const services = codingRun ? storedServiceLabels(codingRun.services) : [];
      return textResult({
        ...withOperatorMode(run),
        ...(codingResult ? { codingResult } : {}),
        ...(failureCategory ? { failureCategory } : {}),
        ...(diagnosticId ? { diagnosticId } : {}),
        ...(codingQueuedAt ? { codingQueuedAt } : {}),
        // An admin turned on the debug trace: the worker's full trace is in its pod log.
        ...(codingRun?.debugTrace ? { debugTrace: true } : {}),
        ...(services.length > 0 ? { services } : {}),
        ...(codingRun?.resultBranch ? { resultBranch: codingRun.resultBranch } : {}),
        ...(codingRun?.baseSha ? { baseSha: codingRun.baseSha } : {}),
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
      });
    },
  });
}
