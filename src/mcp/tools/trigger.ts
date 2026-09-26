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
import type { WardbyMcpServer } from "../server.js";
import { McpError } from "../errors.js";
import { createTaskResult, getTask, cancelTask } from "../tasks/manager.js";
import { requireOwnedTask } from "../auth/ownership.js";
import { assertAgentAccess } from "../auth/access.js";
import type { McpRequestContext } from "../context.js";
import type { PrismaClient } from "#prisma";
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

/**
 * A non-owner's coding task or baseRef would steer what the owner's
 * repository authority does, so it is allowed only when the owner opted in
 * to non-owner task text (codingProfile.allowWebhookTaskOverride, the same
 * opt-in webhooks use). Otherwise a non-owner run uses the owner's
 * defaultTask. Resource-sharing grants spec §3.4.5.
 */
function assertOverrideAllowed(
  principalId: string,
  agent: { id: string; ownerId: string | null; codingProfile: { allowWebhookTaskOverride: boolean } | null },
  args: { task?: string; baseRef?: string },
): void {
  // Strictly the owner: the stdio operator's owner-level access doesn't make
  // it the owner whose repository authority the task steers (review M8).
  const isOwner = agent.ownerId !== null && agent.ownerId === principalId;
  if (isOwner || (args.task === undefined && args.baseRef === undefined)) return;
  if (!agent.codingProfile?.allowWebhookTaskOverride) {
    throw new McpError(
      403,
      `Agent "${agent.id}": only its owner can pass a task or baseRef, unless the owner allows it (codingProfile.allowWebhookTaskOverride).`,
    );
  }
}

type TriggerableAgent = {
  id: string;
  ownerId: string | null;
  codingProfile: { allowWebhookTaskOverride: boolean } | null;
};

/** execute on the agent, plus the override rule; `db` is the transaction when re-checking. */
async function requireTriggerable<A extends TriggerableAgent>(
  ctx: McpRequestContext,
  row: A | null,
  id: string,
  args: { task?: string; baseRef?: string },
  db: Pick<PrismaClient, "resourceGrant"> = ctx.db,
): Promise<A> {
  const { agent } = await assertAgentAccess(ctx, row, id, "execute", db);
  assertOverrideAllowed(ctx.principal.id, agent, args);
  return agent;
}

export function registerTriggerTool(mcp: WardbyMcpServer): void {
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
      const agent = await requireTriggerable(
        ctx,
        await ctx.db.agent.findUnique({ where: { id: args.agentId }, include: { codingProfile: true } }),
        args.agentId,
        args,
      );
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
        triggeredById: ctx.principal.id,
        // Re-checked through the transaction: a concurrent revoke or
        // make_owner conflicts instead of racing the run in.
        beforePersist: async (tx, current) => {
          await requireTriggerable(ctx, current, agent.id, args, tx);
          return true;
        },
      });
      if (!dispatched) throw new Error("Run dispatch was not claimed.");

      if (ctx.clientSupportsTasks) {
        if (!dispatched.task) throw new Error("Run task was not persisted.");
        return textResult(createTaskResult(dispatched.task, DEFAULT_TASK_TTL_MS));
      }
      // A run refused at dispatch (its budget group or run tree is spent) is
      // already terminal: say so now rather than only through get_run.
      if (dispatched.run.status === "refused") {
        return textResult({ runId: dispatched.run.id, status: "refused", error: dispatched.run.error });
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
