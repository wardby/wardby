/**
 * The run-end hook that publishes a planner run's plan set (docs/private spec §4). Fire-and-forget
 * (R10d): nothing awaits it, and it never throws. Only an error's name is logged, never its message
 * or any plan text.
 */
import type { PrismaClient } from "#prisma";
import { outsideRunContext } from "../async-context.js";
import { logger } from "../logger.js";
import { defuseNotice, planChainHook } from "./approval.js";
import { publishPlanFromRun, type SecretCipher } from "./publish.js";
import { planSummaryLines } from "./wording.js";

const plansLog = logger.child({ module: "plans" });

/**
 * Posts a fixed notice on the plan's issue (issueNoticePoster in approval.ts). `agentIds`: the agents
 * whose Jira issue-project link (write access) may carry it, first match wins; GitHub ignores it.
 * The text is posted as given: callers redact and defuse it.
 */
export type PostIssueNotice = (
  set: { issueProvider: string | null; issueKey: string | null; repository: string; agentIds?: readonly string[] },
  text: string,
) => Promise<void>;

export function planRunFinishedHook(
  deps: () => { db: PrismaClient; cipher: SecretCipher; origin: string | null; postIssueNotice?: PostIssueNotice },
): (runId: string) => Promise<void> {
  // The promise settles when the work is done and never rejects; callers do not await it (R10d).
  return (runId) =>
    outsideRunContext(() =>
      Promise.resolve()
        .then(async () => {
          const { db, cipher, origin, postIssueNotice } = deps();
          // A ticket run that ended without success stops its plan's build chain (C3; never throws).
          await planChainHook()?.onTicketFinished(db, runId);
          // R11: a revision (a run given the set's files as input plan files) is published by B8's
          // onDocumentRunFinished, which then calls publishPlanFromRun for the rest of the set. Its input
          // files are written with the run, so this holds even after startReconcileRun re-stamps the
          // threads' sentRunId to a reconcile run.
          const revision = await db.codingRunPlanFile.findFirst({
            where: { runId, direction: "input" },
            select: { path: true },
          });
          if (revision) return;
          const published = await publishPlanFromRun(db, { cipher, origin }, runId);
          if (!published || !postIssueNotice) return;
          const run = await db.run.findUnique({
            where: { id: runId },
            select: {
              agentId: true,
              parentRunId: true,
              codingRun: { select: { repository: true, issueProvider: true, issueKey: true } },
            },
          });
          // A planner without a lead (spec §4): its reply goes on the issue. A delegated one's lead replies.
          if (!run?.codingRun?.issueKey || run.parentRunId) return;
          await postIssueNotice(
            { ...run.codingRun, agentIds: run.agentId ? [run.agentId] : [] },
            defuseNotice(planSummaryLines(published).join("\n")),
          );
        })
        .catch((err: unknown) => {
          plansLog.warn({ runId, errorName: err instanceof Error ? err.name : typeof err }, "plan hook failed");
        }),
    );
}
