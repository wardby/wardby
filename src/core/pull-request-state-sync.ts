/**
 * Keeps IssuePullRequest.state current when a pr_closed webhook was missed
 * (an outage, a redelivery that never came). Each reconciler pass reads a
 * small batch of rows still marked open — least recently checked first —
 * from the code host and settles merged or closed ones through
 * handlePullRequestClosed, the webhook's own path. Sibling continuation hints
 * and the Related pull requests section read this state. Best effort: never throws.
 */
import type { PrismaClient } from "#prisma";
import type { IssueTrackerRegistry } from "../providers/issue-tracker/types.js";
import type { ReviewHostProvider, ReviewHostRegistry } from "../providers/review-host/types.js";
import { handlePullRequestClosed } from "./issue-bridge.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "pull-request-state-sync" });

/** Rows checked per pass (each is one token mint + one GET + one revoke). */
export const PR_STATE_SYNC_BATCH = 10;
/** A row is re-checked at most this often. */
export const PR_STATE_SYNC_MIN_AGE_MS = 10 * 60_000;

export type PullRequestStateSyncDb = Pick<PrismaClient, "issuePullRequest" | "agentIssueProject">;

export async function syncOpenPullRequestStates(
  db: PullRequestStateSyncDb,
  hosts: ReviewHostRegistry | undefined,
  trackers: IssueTrackerRegistry | undefined,
  now: Date = new Date(),
): Promise<number> {
  // Without trackers the rows (a GitHub issue's, say) are still settled; only tracker actions are skipped.
  if (!hosts) return 0;
  let settled = 0;
  try {
    const rows = await db.issuePullRequest.findMany({
      where: { state: "open", updatedAt: { lt: new Date(now.getTime() - PR_STATE_SYNC_MIN_AGE_MS) } },
      orderBy: { updatedAt: "asc" },
      take: PR_STATE_SYNC_BATCH,
      select: { id: true, codeProvider: true, repository: true, number: true },
    });
    const touch = (id: string) =>
      db.issuePullRequest
        .updateMany({ where: { id, state: "open" }, data: { updatedAt: now } })
        .catch((err: unknown) => log.warn({ err, id }, "could not mark a pull request as checked"));
    for (const row of rows) {
      const host = hosts[row.codeProvider as ReviewHostProvider];
      if (!host?.pullRequestOrigin) continue;
      try {
        const origin = await host.pullRequestOrigin(row.repository, row.number);
        if (origin.state === "open" && origin.merged !== true) {
          await touch(row.id);
          continue;
        }
        const merged = origin.merged === true;
        await handlePullRequestClosed(db, trackers, {
          codeProvider: row.codeProvider,
          repository: row.repository,
          number: row.number,
          merged,
        });
        settled += 1;
        log.info(
          { repository: row.repository, number: row.number, merged },
          "settled a pull request whose close was missed",
        );
      } catch (err) {
        log.warn({ err, repository: row.repository, number: row.number }, "could not sync a pull request's state");
        await touch(row.id);
      }
    }
  } catch (err) {
    log.warn({ err }, "pull request state sync failed");
  }
  return settled;
}
