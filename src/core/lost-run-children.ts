import type { PrismaClient } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import { DRIVABLE } from "./run-status.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "lost-run-children" });

/** The stop reason recorded on every child stopped because its parent run ended lost. */
export const PARENT_LOST_REASON = "parent run lost";

/** Stops the still-drivable children of a run that ended lost, so none keeps spending for nobody. */
export async function stopChildrenOfLostRun(
  db: Pick<PrismaClient, "run">,
  executor: Pick<Executor, "stop"> | undefined,
  runId: string,
): Promise<number> {
  if (!executor) return 0;
  let children: { id: string }[];
  try {
    children = await db.run.findMany({
      where: { parentRunId: runId, status: { in: [...DRIVABLE] } },
      select: { id: true },
    });
  } catch (err) {
    log.error({ err, runId }, "could not list the children of a lost run");
    return 0;
  }
  let stopped = 0;
  for (const child of children) {
    try {
      await executor.stop(child.id, PARENT_LOST_REASON);
      stopped++;
    } catch (err) {
      log.error({ err, runId, childRunId: child.id }, "could not stop a child of a lost run");
    }
  }
  return stopped;
}
