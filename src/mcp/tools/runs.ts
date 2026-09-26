import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { requireReadableAgent } from "../auth/ownership.js";
import { publicCodingRunResult } from "../../coding/protocol.js";
import { textResult } from "./text-result.js";

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
      await requireReadableAgent(ctx.db, args.agentId, ctx.principal.id);
      const runs = await ctx.db.run.findMany({
        where: { agentId: args.agentId, ...(args.status ? { status: args.status as never } : {}) },
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
          return codingQueuedAt ? { ...run, codingQueuedAt } : run;
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
      if (!run) throw new McpError(404, `Run "${args.runId}" not found.`);
      await requireReadableAgent(ctx.db, run.agentId, ctx.principal.id);
      const codingRun = await ctx.db.codingRun.findUnique({
        where: { runId: run.id },
        select: { result: true, queuedAt: true },
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
      const packages = [
        ...new Map(
          registryFetches
            .filter((row) => row.outcome === "served" && row.version)
            .map(
              (row) =>
                [
                  `${row.ecosystem}\0${row.name}\0${row.version}`,
                  { ecosystem: row.ecosystem, name: row.name, version: row.version! },
                ] as const,
            ),
        ).values(),
      ];
      const packageRefusals = [
        ...new Map(
          registryFetches
            .filter((row) => row.outcome === "refused")
            .map((row) => {
              const reason = row.reason ?? "refused";
              return [
                `${row.ecosystem}\0${row.name}\0${reason}`,
                { ecosystem: row.ecosystem, name: row.name, reason },
              ] as const;
            }),
        ).values(),
      ];
      return textResult({
        ...run,
        ...(codingResult ? { codingResult } : {}),
        ...(codingQueuedAt ? { codingQueuedAt } : {}),
        ...(codingRun ? { packages, packageRefusals } : {}),
      });
    },
  });
}
