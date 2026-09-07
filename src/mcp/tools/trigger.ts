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
 * Cancellation calls the Executor's best-effort stop seam after the Task is
 * marked cancelled. Native execution remains cooperative until the Engine
 * accepts an AbortSignal; coding executors must stop the isolated job.
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
import { dispatchRun } from "../../core/dispatch.js";
import { CodingBaseRefSchema, CodingTaskOverrideSchema } from "../../coding/protocol.js";
import { z } from "zod";
import type { ReevoMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { createTaskResult, getTask, cancelTask } from "../tasks/manager.js";
import { canMutate, requireOwnedAgent, requireOwnedTask } from "../auth/ownership.js";
import { textResult } from "./text-result.js";

const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;

const TriggerAgentSchema = z
  .object({
    agentId: z.string().trim().min(1).max(128),
    task: CodingTaskOverrideSchema.optional(),
    baseRef: CodingBaseRefSchema.optional(),
  })
  .strict();

function parseTriggerArgs(args: unknown): z.infer<typeof TriggerAgentSchema> {
  const parsed = TriggerAgentSchema.safeParse(args);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  throw new McpError(400, `Invalid trigger_agent arguments: ${details}`);
}

export function registerTriggerTool(mcp: ReevoMcpServer): void {
  mcp.registerTool({
    name: "trigger_agent",
    scope: "runs:trigger",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { agentId: { type: "string" }, task: { type: "string" }, baseRef: { type: "string" } },
      required: ["agentId"],
    },
    handler: async (rawArgs: unknown, ctx) => {
      const args = parseTriggerArgs(rawArgs);
      const agent = await requireOwnedAgent(ctx.db, args.agentId, ctx.principal.id);
      if (agent.kind !== "coding" && (args.task !== undefined || args.baseRef !== undefined)) {
        throw new McpError(400, "Task and baseRef overrides are only valid for coding agents.");
      }

      const dispatched = await dispatchRun({
        db: ctx.db,
        executor: ctx.providers.executor,
        agentId: agent.id,
        trigger: "manual",
        codingTask: args.task,
        codingBaseRef: args.baseRef,
        task: ctx.clientSupportsTasks ? { principalId: ctx.principal.id, ttlMs: DEFAULT_TASK_TTL_MS } : undefined,
        beforePersist: async (_tx, current) => {
          if (!canMutate(current.ownerId, ctx.principal.id)) {
            throw new McpError(403, `Agent "${agent.id}" is not owned by the caller.`);
          }
          return true;
        },
      });
      if (!dispatched) throw new Error("Run dispatch was not claimed.");

      if (ctx.clientSupportsTasks) {
        if (!dispatched.task) throw new Error("Run task was not persisted.");
        return textResult(createTaskResult(dispatched.task, DEFAULT_TASK_TTL_MS));
      }
      return textResult({ runId: dispatched.run.id });
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
    return getTask(taskId, ctx.db);
  });

  mcp.registerRequestHandler("tasks/cancel", "runs:trigger", async (params, ctx) => {
    const { taskId } = params as { taskId: string };
    await requireOwnedTask(ctx.db, taskId, ctx.principal.id);
    await cancelTask(taskId, ctx.db, async (runId) => {
      await ctx.providers.executor.stop(runId, "cancelled by caller");
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
