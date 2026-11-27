import { randomUUID } from "node:crypto";
import { dispatchRun } from "../../core/dispatch.js";
import { atLeast } from "../../core/grants.js";
import { MAX_REVIEW_NOTE_CHARS } from "../../core/documents/limits.js";
import { claimJob } from "../../core/review-routing/jobs.js";
import { rankRouters } from "../../core/review-routing/request.js";
import { agentAccessResolver } from "../auth/access.js";
import { McpError } from "../errors.js";
import type { McpRequestContext } from "../context.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";
import { requireTriggerable } from "./trigger.js";

const INVALID_ROUTER = "review_router_invalid: router must name a router agent you can run.";

/** The routers the caller can run, with their owners' names. A router the caller cannot run never appears. */
async function runnableRouters(ctx: McpRequestContext) {
  const [rows, accessOf] = await Promise.all([
    ctx.db.agent.findMany({
      where: { router: true, kind: "native" },
      select: {
        id: true,
        name: true,
        description: true,
        ownerId: true,
        owner: { select: { authUser: { select: { displayName: true } } } },
      },
    }),
    agentAccessResolver(ctx),
  ]);
  return rows
    .filter((r) => atLeast("agent", accessOf(r), "execute"))
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      ownerName: r.owner?.authUser?.displayName ?? null,
    }));
}

/**
 * request_work (#646, spec §5): a person asks for work without knowing which agent does it. Without `router`, it
 * ranks the routers the caller can run and starts nothing; with `router`, it starts that router with the request as
 * its task (router: true means its owner accepts requests from people who can run it), as trigger_agent starts a
 * run, and opens a review job so the documents the work produces route back to it.
 */
export function registerRequestWorkTool(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "request_work",
    scope: "runs:trigger",
    description:
      "Ask for work in plain words. Without router: returns up to 5 routers you can run that fit the request (none started). " +
      "If one router clearly fits, start it by calling again with router, and tell the person which one; ask the person only when several fit. " +
      "With router: starts it with your request.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        request: { type: "string", minLength: 1, maxLength: MAX_REVIEW_NOTE_CHARS },
        router: { type: "string" },
      },
      required: ["request"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = (rawArgs ?? {}) as { request?: unknown; router?: unknown };
      // The request is people-written: no message below repeats it.
      if (typeof args.request !== "string" || args.request.trim() === "") {
        throw new McpError(400, "Invalid request_work arguments: request: write what you need, in plain words.");
      }
      if (args.request.length > MAX_REVIEW_NOTE_CHARS) {
        throw new McpError(
          400,
          `Invalid request_work arguments: request: at most ${MAX_REVIEW_NOTE_CHARS} characters.`,
        );
      }
      if (args.router !== undefined && typeof args.router !== "string") {
        throw new McpError(400, "Invalid request_work arguments: router: must be an agent id.");
      }
      const request = args.request;

      if (args.router === undefined) {
        const routers = await runnableRouters(ctx);
        const ranked = rankRouters(request, routers);
        if (ranked.length > 0) return textResult({ routers: ranked });
        return textResult({ routers: [], yours: routers.map((r) => r.name).sort() });
      }

      const routerId = args.router;
      const row = await ctx.db.agent.findUnique({ where: { id: routerId }, include: { codingProfile: true } });
      // Same access answer as trigger_agent (404 below read, 403 below execute); no task override applies.
      const agent = await requireTriggerable(ctx, row, routerId, {});
      if (!agent.router || agent.kind !== "native") throw new McpError(400, INVALID_ROUTER);

      const job = await claimJob(ctx.db, {
        reviewEventId: `request:${randomUUID()}`,
        documentId: null,
        setId: null,
        routerAgentId: agent.id,
        startedById: ctx.principal.id,
        rootJobId: null,
      });
      if (!job) throw new Error("request_work: the request key was already claimed.");
      let dispatched;
      try {
        dispatched = await dispatchRun({
          db: ctx.db,
          executor: ctx.providers.executor,
          secretCipher: ctx.providers.secrets,
          selfDefects: { db: ctx.db, issueTrackers: ctx.providers.issueTrackers },
          agentId: agent.id,
          trigger: "manual",
          taskOverride: request,
          triggeredById: ctx.principal.id,
          afterPersist: async (tx, run) => {
            await tx.reviewJob.update({ where: { id: job.id }, data: { routerRunId: run.id, outcome: "started" } });
          },
          // Re-checked through the transaction: a concurrent revoke, make_owner or router: false conflicts.
          beforePersist: async (tx, current) => {
            const again = await requireTriggerable(ctx, current, agent.id, {}, tx);
            if (!(again as { router?: boolean }).router) throw new McpError(400, INVALID_ROUTER);
            return true;
          },
        });
        if (!dispatched) throw new Error("Run dispatch was not claimed.");
      } catch (err) {
        await ctx.db.reviewJob.deleteMany({ where: { id: job.id } }).catch(() => {});
        throw err;
      }
      const started = { router: { id: agent.id, name: agent.name } };
      if (dispatched.run.status === "refused" || dispatched.run.status === "failed") {
        return textResult({
          runId: dispatched.run.id,
          status: dispatched.run.status,
          error: dispatched.run.error,
          ...started,
        });
      }
      return textResult({ runId: dispatched.run.id, ...started });
    },
  });
}
