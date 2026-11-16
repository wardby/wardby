/**
 * The run-end hook that publishes a planner run's plan set (docs/private spec §4). Fire-and-forget
 * (R10d): nothing awaits it, and it never throws. Only an error's name is logged, never its message
 * or any plan text.
 */
import type { PrismaClient } from "#prisma";
import { outsideRunContext } from "../async-context.js";
import { logger } from "../logger.js";
import { publishPlanFromRun, type SecretCipher } from "./publish.js";

const plansLog = logger.child({ module: "plans" });

/** Posts a fixed notice on the plan's issue (wired by C2). */
export type PostIssueNotice = (
  set: { issueProvider: string | null; issueKey: string | null; repository: string },
  text: string,
) => Promise<void>;

export function planRunFinishedHook(
  deps: () => { db: PrismaClient; cipher: SecretCipher; origin: string | null; postIssueNotice?: PostIssueNotice },
): (runId: string) => void {
  return (runId) =>
    outsideRunContext(() => {
      void Promise.resolve()
        .then(async () => {
          const { db, cipher, origin } = deps();
          // R11: a revision (a document run: its threads were sent with this run) is published by
          // B8's onDocumentRunFinished, which then calls publishPlanFromRun for the rest of the set.
          if (await db.commentThread.findFirst({ where: { sentRunId: runId }, select: { id: true } })) return;
          await publishPlanFromRun(db, { cipher, origin }, runId);
        })
        .catch((err: unknown) =>
          plansLog.warn({ runId, errorName: err instanceof Error ? err.name : typeof err }, "plan hook failed"),
        );
    });
}
