/**
 * The agent-spend line a run's status comment carries, shared by every host that reports one
 * (Jira issue comments, GitHub status comments, Slack notifications). Best effort: nothing here throws.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { logger } from "./logger.js";

const log = logger.child({ module: "run-spend" });

export type RunSpendDb = Pick<PrismaClient, "$queryRaw">;

/**
 * Cents from $1 up ($12.34, $1234.50); below $1, two significant digits with at
 * least two decimals so fractions of a cent stay readable ($0.50, $0.12, $0.0035).
 * Never exponent form.
 */
const usd = (amount: number): string => {
  const abs = Math.abs(amount);
  const decimals = abs === 0 || abs >= 1 ? 2 : Math.max(2, 1 - Math.floor(Math.log10(abs)));
  // Trailing zeros past the cents are noise ($0.010, $0.100 from rounding up).
  return `$${amount.toFixed(Math.min(decimals, 20)).replace(/(\.\d\d\d*?)0+$/, "$1")}`;
};

export function formatSpendLine(input: {
  treeUsd: number;
  issueUsd: number | null;
  models: Array<{ model: string; costUsd: number }>;
}): string {
  const parts = [`Agent spend: ${usd(input.treeUsd)} this run`];
  if (input.issueUsd !== null) parts.push(`${usd(input.issueUsd)} on this issue so far`);
  if (input.models.length > 0) parts.push(input.models.map((m) => `${m.model} ${usd(m.costUsd)}`).join(", "));
  return parts.join(" · ");
}

/** The whole run tree under `runId` (every depth), the issue's total across all its runs, and the tree's models. */
export async function spendLine(db: RunSpendDb, runId: string): Promise<string> {
  try {
    const tree = Prisma.sql`
      WITH RECURSIVE tree AS (
        SELECT "id" FROM "Run" WHERE "id" = ${runId}
        -- UNION, not UNION ALL: a parentRunId cycle (never written, but not a constraint) can't recurse forever.
        UNION
        SELECT r."id" FROM "Run" r JOIN tree t ON r."parentRunId" = t."id"
      )`;
    const [treeTotal, issueTotal, models] = await Promise.all([
      db.$queryRaw<
        { usd: string | null }[]
      >`${tree} SELECT SUM(r."costUsd")::text AS usd FROM "Run" r JOIN tree t ON r."id" = t."id"`,
      db.$queryRaw<{ usd: string | null }[]>`
        SELECT SUM(r."costUsd")::text AS usd
        FROM "RunAttribution" a
        JOIN "Run" r ON r."id" = a."runId"
        WHERE a."workItemId" = (SELECT "workItemId" FROM "RunAttribution" WHERE "runId" = ${runId})`,
      db.$queryRaw<{ model: string; usd: string }[]>`${tree}
        SELECT u."model", SUM(u."costUsd")::text AS usd
        FROM "RunModelUsage" u JOIN tree t ON u."runId" = t."id"
        GROUP BY u."model" ORDER BY SUM(u."costUsd") DESC`,
    ]);
    const treeUsd = Number(treeTotal[0]?.usd ?? 0);
    if (!Number.isFinite(treeUsd)) return "";
    return formatSpendLine({
      treeUsd,
      issueUsd: issueTotal[0]?.usd == null ? null : Number(issueTotal[0].usd),
      models: models.map((m) => ({ model: m.model, costUsd: Number(m.usd) })),
    });
  } catch (err) {
    log.warn({ err, runId }, "could not compute the agent spend for the status comment");
    return "";
  }
}

/** Insert the spend line above the trailing footer, which must stay the last line. */
export function withSpend(body: string, spend: string): string {
  if (!spend) return body;
  const trimmed = body.trimEnd();
  const at = trimmed.lastIndexOf("\n");
  if (at < 0) return `${spend}\n\n${trimmed}`;
  return `${trimmed.slice(0, at).trimEnd()}\n\n${spend}\n\n${trimmed.slice(at + 1)}`;
}
