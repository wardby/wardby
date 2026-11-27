import { randomUUID } from "node:crypto";
import { atLeast } from "../../core/grants.js";
import { MAX_REVIEW_NOTE_CHARS } from "../../core/documents/limits.js";
import { claimJob } from "../../core/review-routing/jobs.js";
import { startRouterRun } from "../../core/review-routing/start.js";
import { rankRouters } from "../../core/review-routing/request.js";
import { agentAccessResolver } from "../auth/access.js";
import { McpError } from "../errors.js";
import type { McpRequestContext } from "../context.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";
import { requireTriggerable } from "./trigger.js";

/** The most router names a no-match answer lists. */
const MAX_YOURS = 20;
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
        return textResult({
          routers: [],
          yours: routers
            .map((r) => r.name)
            .sort()
            .slice(0, MAX_YOURS),
        });
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
      const selfDefects = { db: ctx.db, issueTrackers: ctx.providers.issueTrackers };
      // The shared router-start path: the job keeps its outcome (started, a refusal code, route_failed).
      const started = await startRouterRun(
        { db: ctx.db, executor: ctx.providers.executor, cipher: ctx.providers.secrets, selfDefects },
        {
          routerAgentId: agent.id,
          task: request,
          triggeredById: ctx.principal.id,
          jobId: job.id,
          documentIds: [],
          trigger: "manual",
          // Re-checked through the transaction: a concurrent revoke or make_owner conflicts.
          recheck: async (tx, current) => {
            await requireTriggerable(ctx, current, agent.id, {}, tx);
          },
        },
      );
      const router = { id: agent.id, name: agent.name };
      if ("runId" in started) return textResult({ runId: started.runId, router });
      if (started.refused === "review_router_invalid") throw new McpError(400, INVALID_ROUTER);
      return textResult({ status: started.refused, router });
    },
  });
}
