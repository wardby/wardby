/**
 * trigger_agent + the Tasks extension's tasks/get and tasks/cancel methods.
 * A separate module from agents.ts (Task 9's pure CRUD) — this is the one
 * place in Phase 4 that actually produces Tasks (kind:"run"; tool_authoring
 * is reserved/unused this phase), so registering tasks/get and tasks/cancel
 * here — rather than splitting them into yet another file with nothing
 * else to register — keeps the one task-producing concern together.
 *
 * Cancellation caveat: `Executor.start(runId)`/the engine expose no
 * interrupt hook at all today — `cancelTask`'s "cooperative stop" (per the
 * extension's own "cooperative and eventually consistent" language, a
 * best-effort contract, not a guarantee) has nothing to cooperate with yet.
 * The stop hook here marks the Task row cancelled (so tasks/get reflects
 * cancellation immediately) but cannot actually interrupt an in-flight
 * run — building real interruption is a new Executor/Engine capability out
 * of scope for this plan (no task in it adds one). Flagged in the ledger,
 * not silently glossed over.
 *
 * Ownership: a Task carries no owner of its own — it inherits the owning
 * Run's Agent's owner, resolved via requireOwnedTask below. tasks/get and
 * tasks/cancel both call it before touching the task manager, the same
 * shape every other cross-principal-sensitive read/mutate in this codebase
 * uses (requireOwnedAgent in agents.ts/runs.ts/etc.) — a caller who guesses
 * or is handed someone else's taskId gets 404, not another principal's
 * final text/cost.
 */
import type { PrismaClient } from "@prisma/client";
import { createRun } from "../../core/runner.js";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { createRunTask, getTask, cancelTask } from "../tasks/manager.js";

const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

async function requireOwnedTask(db: PrismaClient, taskId: string, principalId: string): Promise<void> {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task || !task.runId) throw new McpError(404, `Task "${taskId}" not found.`);
  const run = await db.run.findUnique({ where: { id: task.runId } });
  if (!run) throw new McpError(404, `Task "${taskId}" not found.`);
  const agent = await db.agent.findUnique({ where: { id: run.agentId } });
  // 404, not 403: confirming a taskId exists at all to a non-owner is
  // itself a (small) information leak — same reasoning as get_agent.
  if (!agent || agent.ownerId !== principalId) throw new McpError(404, `Task "${taskId}" not found.`);
}

export function registerTriggerTool(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "trigger_agent",
    scope: "runs:trigger",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      const agent = await ctx.db.agent.findUnique({ where: { id: args.agentId } });
      if (!agent) throw new McpError(404, `Agent "${args.agentId}" not found.`);
      if (agent.ownerId !== ctx.principal.id) throw new McpError(403, `Agent "${args.agentId}" is not owned by the caller.`);

      const run = await createRun(ctx.db, agent.name, "manual");

      // Detached on purpose: Executor.start() only resolves once the run
      // reaches a terminal state (see InProcessExecutor), which would block
      // this tool call for the run's entire duration — the whole point of
      // returning a Task/runId is NOT waiting for that here.
      void ctx.providers.executor.start(run.id).catch(() => {
        // executeRun already persists failures onto the Run row itself;
        // an executor-level throw beyond that has nowhere else to go.
      });

      if (ctx.clientSupportsTasks) {
        const task = await createRunTask(run.id, ctx.db, DEFAULT_TASK_TTL_MS);
        return textResult(task);
      }
      return textResult({ runId: run.id });
    },
  });

  // Neither handler sets `resultType` itself: it's wire-only protocol
  // machinery (`WireOnlyResultKey` in the SDK's own types) that the SDK
  // stamps on encode and strips on decode before application code — ours
  // AND the calling client's — ever sees it. Confirmed empirically: a
  // handler-returned `resultType` field never survives the round trip
  // through this SDK's own Client, while any other field does. A real
  // wire capture would show it; `client.request()`'s return value won't.
  mcp.registerRequestHandler("tasks/get", "agents:read", async (params, ctx) => {
    const { taskId } = params as { taskId: string };
    await requireOwnedTask(ctx.db, taskId, ctx.principal.id);
    return getTask(taskId, ctx.db) as unknown as Record<string, unknown>;
  });

  mcp.registerRequestHandler("tasks/cancel", "runs:trigger", async (params, ctx) => {
    const { taskId } = params as { taskId: string };
    await requireOwnedTask(ctx.db, taskId, ctx.principal.id);
    await cancelTask(taskId, ctx.db, async (runId) => {
      // See module-level caveat: no real interrupt hook exists yet.
      void runId;
    });
    return {};
  });
}
