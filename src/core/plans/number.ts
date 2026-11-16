import type { PrismaClient } from "#prisma";
import type { AttributionIntent } from "../attribution.js";
import { GITHUB_ISSUE_KEY, ISSUE_KEY } from "../../providers/issue-tracker/types.js";

/** The CodingRun.planNumber column is a Postgres integer. */
const MAX_PLAN_NUMBER = 2_147_483_647;

export function planNumberFromIssueKey(
  provider: string | null | undefined,
  key: string | null | undefined,
): number | undefined {
  if (!provider || !key) return undefined;
  let n: number | undefined;
  if (provider === "github" && GITHUB_ISSUE_KEY.test(key)) n = Number(key.slice(key.lastIndexOf("#") + 1));
  else if (provider === "jira" && ISSUE_KEY.test(key)) n = Number(key.slice(key.lastIndexOf("-") + 1));
  return n !== undefined && Number.isSafeInteger(n) && n >= 1 && n <= MAX_PLAN_NUMBER ? n : undefined;
}

/**
 * The plan number, decided before dispatch's transaction (R6): the caller's planNumber, then the
 * caller's issue intent, then the issue the parent (or continued) run is attributed to: a
 * read-only look at what attributeRun will copy inside the transaction.
 */
export async function resolvePlanNumber(
  db: Pick<PrismaClient, "runAttribution" | "codingRun">,
  options: {
    planNumber?: number;
    attribution?: AttributionIntent;
    parentRunId?: string;
    continuesCodingRunId?: string;
  },
): Promise<number | undefined> {
  if (options.planNumber !== undefined) return options.planNumber;
  if (options.attribution) {
    return planNumberFromIssueKey(options.attribution.item.provider, options.attribution.item.key);
  }
  for (const ancestorId of [options.parentRunId, options.continuesCodingRunId]) {
    if (!ancestorId) continue;
    const inherited = await db.runAttribution.findUnique({
      where: { runId: ancestorId },
      select: { workItem: { select: { provider: true, key: true } } },
    });
    if (inherited) return planNumberFromIssueKey(inherited.workItem.provider, inherited.workItem.key);
    const coding = await db.codingRun.findUnique({
      where: { runId: ancestorId },
      select: { issueProvider: true, issueKey: true },
    });
    if (coding?.issueKey) return planNumberFromIssueKey(coding.issueProvider, coding.issueKey);
  }
  return undefined;
}
