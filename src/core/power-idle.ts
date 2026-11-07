/**
 * Low-power mode's idle rules: whether the coding proxy or native gateway has
 * had work since `since`. A target is busy while any of its runs is pending
 * (queued included) or running, or finished at or after `since`; the gateway
 * is also busy while any gateway session is active. The gateway's runs are
 * sandboxed native runs plus coding runs with MCP tools: a coding run's MCP
 * calls go coding proxy -> gateway, so it needs both. powerBlockers lists the
 * run ids that keep a target busy right now (recent finishes do not count).
 */
import type { PrismaClient, RunStatus } from "#prisma";
import type { PowerTarget } from "./power.js";

const ACTIVE = { in: ["pending", "running"] as RunStatus[] };
/** A coding run whose proxy session holds an MCP token: it has MCP tools, served through the gateway. */
const WITH_MCP_TOOLS = { proxySession: { is: { mcpTokenHash: { not: null } } } };

export async function proxyBusy(db: PrismaClient, since: Date): Promise<boolean> {
  const n = await db.codingRun.count({
    where: { run: { OR: [{ status: ACTIVE }, { finishedAt: { gte: since } }] } },
  });
  return n > 0;
}

export async function gatewayBusy(db: PrismaClient, since: Date): Promise<boolean> {
  const runs = await db.run.count({
    where: { nativeExecutionMode: "sandbox", OR: [{ status: ACTIVE }, { finishedAt: { gte: since } }] },
  });
  if (runs > 0) return true;
  const mcpCodingRuns = await db.codingRun.count({
    where: { ...WITH_MCP_TOOLS, run: { OR: [{ status: ACTIVE }, { finishedAt: { gte: since } }] } },
  });
  if (mcpCodingRuns > 0) return true;
  return (await db.nativeGatewaySession.count({ where: { status: "active" } })) > 0;
}

export function powerBusy(db: PrismaClient): (target: PowerTarget, since: Date) => Promise<boolean> {
  return (target, since) => (target === "proxy" ? proxyBusy(db, since) : gatewayBusy(db, since));
}

/**
 * Run ids keeping `target` busy right now: active or queued runs (plus, for the gateway, active
 * gateway sessions and active or queued coding runs with MCP tools). "Active" for a coding run is
 * the proxy's rule: its run is pending or running.
 */
export async function powerBlockers(db: PrismaClient, target: PowerTarget): Promise<string[]> {
  if (target === "proxy") {
    const rows = await db.codingRun.findMany({ where: { run: { status: ACTIVE } }, select: { runId: true } });
    return [...new Set(rows.map((r) => r.runId))].sort();
  }
  const [runs, sessions, mcpCodingRuns] = await Promise.all([
    db.run.findMany({ where: { nativeExecutionMode: "sandbox", status: ACTIVE }, select: { id: true } }),
    db.nativeGatewaySession.findMany({ where: { status: "active" }, select: { runId: true } }),
    db.codingRun.findMany({ where: { ...WITH_MCP_TOOLS, run: { status: ACTIVE } }, select: { runId: true } }),
  ]);
  return [
    ...new Set([...runs.map((r) => r.id), ...sessions.map((s) => s.runId), ...mcpCodingRuns.map((r) => r.runId)]),
  ].sort();
}
