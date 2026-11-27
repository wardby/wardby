/**
 * Starts a router run for a review job (#646, spec §3.6, §5): one path for a review action and for request_work.
 * The persist transaction re-checks that the agent is still a router (review_router_invalid otherwise, and no run
 * is made) and any caller check, then records the run on the job and grants it read on the given documents, so the
 * run never exists without them. The job keeps its outcome: started, a refusal code, or route_failed when a
 * check or the dispatch throws (the error then propagates). Refusals are codes only.
 */
import type { PrismaClient } from "#prisma";
import { dispatchRun, type DispatchTx } from "../dispatch.js";

type BeforePersistAgent = Parameters<NonNullable<Parameters<typeof dispatchRun>[0]["beforePersist"]>>[1];

export interface StartRouterRunDeps {
  db: PrismaClient;
  executor: Parameters<typeof dispatchRun>[0]["executor"];
  cipher?: Parameters<typeof dispatchRun>[0]["secretCipher"];
  selfDefects?: Parameters<typeof dispatchRun>[0]["selfDefects"];
  dispatch?: typeof dispatchRun;
}

export async function startRouterRun(
  deps: StartRouterRunDeps,
  input: {
    routerAgentId: string;
    task: string;
    triggeredById: string | null;
    jobId: string;
    documentIds: string[];
    trigger: "review_action" | "manual";
    /** An extra check in the persist transaction; it throws to refuse. */
    recheck?: (tx: DispatchTx, agent: BeforePersistAgent) => Promise<void>;
  },
): Promise<{ runId: string } | { refused: string }> {
  const dispatch = deps.dispatch ?? dispatchRun;
  const guard = { notRouter: false };
  // The outcome is a record, never a reason to fail the start.
  const record = async (outcome: string, routerRunId?: string): Promise<void> => {
    try {
      await deps.db.reviewJob.update({
        where: { id: input.jobId },
        data: routerRunId ? { routerRunId, outcome } : { outcome },
      });
    } catch {
      /* the caller still gets the result */
    }
  };
  let dispatched: Awaited<ReturnType<typeof dispatchRun>>;
  try {
    dispatched = await dispatch({
      db: deps.db,
      executor: deps.executor,
      ...(deps.cipher ? { secretCipher: deps.cipher } : {}),
      ...(deps.selfDefects ? { selfDefects: deps.selfDefects } : {}),
      agentId: input.routerAgentId,
      trigger: input.trigger,
      taskOverride: input.task,
      triggeredById: input.triggeredById,
      // Read in the run's own transaction: turning `router` off stops a start that has not committed yet.
      beforePersist: async (tx, agent) => {
        if (input.recheck) await input.recheck(tx, agent);
        guard.notRouter = !agent.router;
        return !guard.notRouter;
      },
      afterPersist: async (tx, run) => {
        await tx.reviewJob.update({ where: { id: input.jobId }, data: { routerRunId: run.id } });
        if (input.documentIds.length > 0) {
          await tx.runDocumentGrant.createMany({
            data: input.documentIds.map((documentId) => ({ runId: run.id, documentId })),
            skipDuplicates: true,
          });
        }
      },
    });
  } catch (err) {
    await record("route_failed");
    throw err;
  }
  if (!dispatched) {
    const refused = guard.notRouter ? "review_router_invalid" : "run_refused";
    await record(refused);
    return { refused };
  }
  if (dispatched.run.status === "refused" || dispatched.run.status === "failed") {
    const refused = `run_${dispatched.run.status}`;
    await record(refused, dispatched.run.id);
    return { refused };
  }
  await record("started", dispatched.run.id);
  return { runId: dispatched.run.id };
}
