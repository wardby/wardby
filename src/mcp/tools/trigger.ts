/**
 * trigger_agent + the Tasks extension's tasks/get, tasks/cancel, and
 * tasks/update methods. A separate module from agents.ts (Task 9's pure
 * CRUD) — this is the one place in Phase 4 that actually produces Tasks
 * (kind:"run"; tool_authoring is reserved/unused this phase), so
 * registering all three here — rather than splitting them into yet
 * another file with nothing else to register — keeps the one
 * task-producing concern together.
 *
 * tasks/update is registered but always rejects: a run-backed task never
 * enters "input_required" (runs need no mid-flight input, and guided tool
 * authoring — the one flow that would — is deferred per Amendment A), so
 * there is never legitimately pending input to submit. Registering it
 * anyway (rather than leaving it unregistered, -32601) gives a client that
 * calls it a clear, on-protocol "this task isn't awaiting input" instead
 * of a generic method-not-found.
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
 * Ownership: a Task is stamped with the triggering principal's id at
 * creation (Task.principalId) — a direct column, not resolved transitively
 * through Run -> Agent -> ownerId, so it works uniformly even for a future
 * tool_authoring task with no Run/Agent chain. requireOwnedTask (in
 * ../auth/ownership.js, the one seam every ownership check in this codebase
 * routes through) checks it before tasks/get and tasks/cancel touch the
 * task manager — a caller who guesses or is handed someone else's taskId
 * gets 404, not another principal's final text/cost.
 */
import { createRun } from "../../core/runner.js";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { createRunTask, getTask, cancelTask } from "../tasks/manager.js";
import { requireOwnedAgent, requireOwnedTask } from "../auth/ownership.js";

const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerTriggerTool(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "trigger_agent",
    scope: "runs:trigger",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    handler: async (args: { agentId: string }, ctx) => {
      const agent = await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);

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
        const task = await createRunTask(run.id, ctx.principal.id, ctx.db, DEFAULT_TASK_TTL_MS);
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

  mcp.registerRequestHandler("tasks/update", "runs:trigger", async (params, ctx) => {
    const { taskId } = params as { taskId: string };
    await requireOwnedTask(ctx.db, taskId, ctx.principal.id);
    const result = await getTask(taskId, ctx.db);
    throw new McpError(400, `Task "${taskId}" is not awaiting input (status: ${result.status}).`);
  });
}
