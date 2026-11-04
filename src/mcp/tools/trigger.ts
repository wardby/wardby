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
import { RepositoryChoiceRefusedError, resolveCodingRepository } from "../../core/coding-repository.js";
import {
  AttributionError,
  explicitAttribution,
  RESPONSE_PATH_SNAPSHOT_BUDGET,
  type AttributionIntent,
} from "../../core/attribution.js";
import { CodingBaseRefSchema, CodingTaskOverrideSchema, isLocalRepository } from "../../coding/protocol.js";
import { loadLocalRepoRoots, resolveLocalRepository, LocalRepoError } from "../../coding/local-repo.js";
import { localRepoWarnings } from "../../coding/local-repo-status.js";
import { SHA, isSafeRefName, localGit } from "../../coding/local-git.js";
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
    repository: z.string().min(1).max(300).optional(),
    issue: z.unknown().optional(),
    review: z
      .object({
        repository: z.string().optional(),
        branch: z.string().min(1).max(250),
        base: z.string().min(1).max(250).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Resolves a manual local review request to a canonical repository and the two
 * commit SHAs. Roots are re-checked now (they can narrow after linking); every
 * failure is a 400 whose message carries the code, before any row exists.
 */
async function resolveLocalReview(
  ctx: McpRequestContext,
  agentId: string,
  review: { repository?: string; branch: string; base?: string },
): Promise<{ repository: string; branch: string; base: string; headSha: string }> {
  let repository = review.repository;
  const links = await ctx.db.agentRepository.findMany({ where: { agentId, provider: "local" } });
  if (repository === undefined) {
    if (links.length !== 1) throw new McpError(400, "pass review.repository");
    repository = links[0].repository;
  }
  let resolved;
  try {
    resolved = await resolveLocalRepository(repository, loadLocalRepoRoots(process.env).roots);
  } catch (err) {
    if (err instanceof LocalRepoError) throw new McpError(400, err.message);
    throw new McpError(400, `local_repo_not_found: ${(err as Error).message}`);
  }
  if (!links.some((l) => l.repository === resolved.repository)) {
    throw new McpError(
      400,
      `Agent "${agentId}" is not linked to ${resolved.repository}; link it with link_repository first.`,
    );
  }
  const dir = resolved.path;
  let base = review.base;
  if (base === undefined) {
    try {
      base = (await localGit(dir, ["symbolic-ref", "--short", "HEAD"])).trim();
    } catch {
      throw new McpError(400, "local_ref_invalid: the repository's HEAD is not on a branch; pass review.base");
    }
  }
  const sha = async (ref: string): Promise<string> => {
    if (!(await isSafeRefName(dir, ref)))
      throw new McpError(400, `local_ref_invalid: "${ref}" is not a valid branch name`);
    try {
      const out = (await localGit(dir, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
      if (SHA.test(out)) return out;
    } catch {
      // fall through
    }
    throw new McpError(400, `local_ref_not_found: "${ref}" does not name a commit in ${resolved.repository}`);
  };
  const headSha = await sha(review.branch);
  await sha(base);
  return { repository: resolved.repository, branch: review.branch, base, headSha };
}

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
  args: { task?: string; baseRef?: string; repository?: string },
): void {
  // Strictly the owner: the stdio operator's owner-level access doesn't make
  // it the owner whose repository authority the task steers (review M8).
  const isOwner = agent.ownerId !== null && agent.ownerId === principalId;
  if (isOwner || (args.task === undefined && args.baseRef === undefined && args.repository === undefined)) return;
  if (!agent.codingProfile?.allowWebhookTaskOverride) {
    throw new McpError(
      403,
      `Agent "${agent.id}": only its owner can pass a task, baseRef or repository, unless the owner allows it (codingProfile.allowWebhookTaskOverride).`,
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
  args: { task?: string; baseRef?: string; repository?: string },
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
      properties: {
        agentId: { type: "string" },
        task: { type: "string" },
        baseRef: { type: "string" },
        repository: {
          type: "string",
          description:
            "Coding agents only: a repository on the agent's list (see get_agent). Default: codingProfile.repository. " +
            "Required when the agent has more than one repository and no default applies.",
        },
        review: {
          type: "object",
          additionalProperties: false,
          description:
            "Native review agents only, owner only: review a branch of a linked local repository (local:/abs/path). " +
            "The result appears in get_run as `review`.",
          properties: {
            repository: {
              type: "string",
              description: "The local repository (local:/abs/path). Default: the agent's only local link.",
            },
            branch: { type: "string", description: "The branch to review (resolved to its current commit)." },
            base: {
              type: "string",
              description: "The branch to review against. Default: the branch currently checked out in the repository.",
            },
          },
          required: ["branch"],
        },
        issue: {
          type: "object",
          description: "Count this run's cost toward an issue in a project the agent is linked to.",
          properties: { provider: { type: "string", enum: ["jira"] }, key: { type: "string" } },
          required: ["provider", "key"],
        },
      },
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
      let review: Awaited<ReturnType<typeof resolveLocalReview>> | undefined;
      if (args.review !== undefined) {
        if (agent.kind !== "native") throw new McpError(400, "review is only valid for native review agents.");
        if (agent.ownerId === null || agent.ownerId !== ctx.principal.id) {
          throw new McpError(403, `Agent "${agent.id}": only its owner can start a manual review.`);
        }
        review = await resolveLocalReview(ctx, agent.id, args.review);
      }
      if (
        agent.kind !== "coding" &&
        (args.task !== undefined || args.baseRef !== undefined || args.repository !== undefined)
      ) {
        throw new McpError(400, "Task, baseRef and repository overrides are only valid for coding agents.");
      }

      // A local repository is re-checked against the roots as they are now
      // (they can narrow after the agent was saved), before any run exists.
      let warnings: string[] = [];
      // The resolver's refusal lists the agent's repositories, so it runs only
      // after requireTriggerable (execute on the agent) and never echoes the
      // requested value.
      const refused = (err: unknown): never => {
        if (err instanceof RepositoryChoiceRefusedError) throw new McpError(400, `${err.code}: ${err.message}`);
        throw err;
      };
      const repository =
        agent.kind === "coding" && agent.codingProfile
          ? (
              await resolveCodingRepository(ctx.db, {
                agentId: agent.id,
                profile: agent.codingProfile,
                requested: args.repository,
              }).catch(refused)
            ).repository
          : undefined;
      if (repository !== undefined && isLocalRepository(repository)) {
        try {
          const resolved = await resolveLocalRepository(repository, loadLocalRepoRoots(process.env).roots);
          warnings = await localRepoWarnings(resolved.path);
        } catch (err) {
          if (err instanceof LocalRepoError) throw new McpError(400, err.message);
          throw err;
        }
      }
      const withWarnings = <T extends object>(result: T) => (warnings.length > 0 ? { ...result, warnings } : result);

      // Refused before any run exists: an invalid or unlinked issue is never
      // silently dropped into an unattributed run.
      let attribution: AttributionIntent | undefined;
      if (args.issue !== undefined) {
        try {
          attribution = await explicitAttribution(
            ctx.db,
            ctx.providers.issueTrackers,
            agent.id,
            args.issue,
            RESPONSE_PATH_SNAPSHOT_BUDGET,
          );
        } catch (err) {
          if (err instanceof AttributionError) throw new McpError(400, err.message);
          throw err;
        }
      }

      // The pull request row is made first (its serial number is in the task
      // text) and removed again if the run is not dispatched.
      const pullRequest = review
        ? await ctx.db.localPullRequest.create({
            data: { repository: review.repository, branch: review.branch, base: review.base },
          })
        : undefined;
      let dispatched;
      try {
        dispatched = await dispatchRun({
          db: ctx.db,
          executor: ctx.providers.executor,
          selfDefects: { db: ctx.db, issueTrackers: ctx.providers.issueTrackers },
          agentId: agent.id,
          trigger: "manual",
          codingTask: args.task,
          codingBaseRef: args.baseRef,
          codingRepository: args.repository,
          attribution,
          task: ctx.clientSupportsTasks ? { principalId: ctx.principal.id, ttlMs: DEFAULT_TASK_TTL_MS } : undefined,
          triggeredById: ctx.principal.id,
          ...(review && pullRequest
            ? {
                taskOverride: `Review pull request #${pullRequest.number} in ${review.repository} (head ${review.headSha}).`,
                afterPersist: async (tx, run) => {
                  await tx.localPullRequest.update({ where: { id: pullRequest.id }, data: { runId: run.id } });
                },
              }
            : {}),
          // Re-checked through the transaction: a concurrent revoke or
          // make_owner conflicts instead of racing the run in.
          beforePersist: async (tx, current) => {
            await requireTriggerable(ctx, current, agent.id, args, tx);
            return true;
          },
        });
        if (!dispatched) throw new Error("Run dispatch was not claimed.");
      } catch (err) {
        if (pullRequest) await ctx.db.localPullRequest.deleteMany({ where: { id: pullRequest.id } }).catch(() => {});
        return refused(err);
      }

      if (ctx.clientSupportsTasks) {
        if (!dispatched.task) throw new Error("Run task was not persisted.");
        return textResult(withWarnings(createTaskResult(dispatched.task, DEFAULT_TASK_TTL_MS)));
      }
      // A run refused at dispatch (its budget group or run tree is spent), or
      // failed there (a coding agent's model is unavailable), is already
      // terminal: say so now rather than only through get_run.
      if (dispatched.run.status === "refused" || dispatched.run.status === "failed") {
        return textResult(
          withWarnings({ runId: dispatched.run.id, status: dispatched.run.status, error: dispatched.run.error }),
        );
      }
      return textResult(withWarnings({ runId: dispatched.run.id }));
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
