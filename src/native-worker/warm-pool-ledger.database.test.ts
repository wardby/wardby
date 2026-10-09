import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { PrismaWarmPoolLedger } from "./warm-pool-ledger.js";

describe.skipIf(!process.env.DATABASE_URL)("PrismaWarmPoolLedger (database)", () => {
  const db = createPrismaClient();
  const ledger = new PrismaWarmPoolLedger(db);
  const tag = randomUUID().slice(0, 8);
  const agentId = `wpl-agent-${tag}`;
  const specs: string[] = [];
  let counter = 0;
  const token = () => `${tag}${String((counter += 1)).padStart(12, "0")}`;
  const nameFor = (t: string) => `wardby-nwarm-${t}`;
  const spec = () => {
    const s = `spec-${randomUUID()}`;
    specs.push(s);
    return s;
  };
  const longAgo = new Date(0);

  beforeAll(async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "s", model: "m", budgetUsd: 1 } });
  });

  afterAll(async () => {
    await db.nativeWarmWorker.deleteMany({ where: { specHash: { in: specs } } });
    await db.run.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  const run = async () => (await db.run.create({ data: { agentId, nativeExecutionMode: "sandbox" } })).id;

  async function idlePool(s: string, size: number) {
    const reserved = await ledger.reserve(s, size, token, nameFor);
    for (const worker of reserved) expect(await ledger.markIdle(worker.id)).toBe(true);
    return reserved;
  }

  it("reserves only the deficit, and concurrent reserves never overshoot the size", async () => {
    const s = spec();
    expect(await ledger.reserve(s, 2, token, nameFor)).toHaveLength(2);
    expect(await ledger.reserve(s, 2, token, nameFor)).toHaveLength(0);
    const t = spec();
    const results = await Promise.all(Array.from({ length: 6 }, () => ledger.reserve(t, 3, token, nameFor)));
    expect(results.flat()).toHaveLength(3);
    expect(await db.nativeWarmWorker.count({ where: { specHash: t } })).toBe(3);
  });

  it("gives each of 5 idle workers to exactly one of 20 concurrent claims", async () => {
    const s = spec();
    await idlePool(s, 5);
    const runs = await Promise.all(Array.from({ length: 20 }, run));
    const claims = await Promise.all(runs.map((runId) => ledger.claim(runId, s, longAgo)));
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(5);
    expect(new Set(won.map((c) => c.id)).size).toBe(5);
    const rows = await db.nativeWarmWorker.findMany({ where: { specHash: s } });
    expect(rows.every((r) => r.status === "claimed" && r.runId && r.claimedAt)).toBe(true);
    expect(new Set(rows.map((r) => r.runId)).size).toBe(5);
  });

  it("never claims a warming worker, another spec's, or one born before the cutoff", async () => {
    const s = spec();
    await ledger.reserve(s, 1, token, nameFor); // still warming
    expect(await ledger.claim(await run(), s, longAgo)).toBeNull();
    await idlePool(spec(), 1);
    expect(await ledger.claim(await run(), s, longAgo)).toBeNull();
    const u = spec();
    await idlePool(u, 1);
    expect(await ledger.claim(await run(), u, new Date(Date.now() + 60_000))).toBeNull();
    expect(await ledger.claim(await run(), u, longAgo)).not.toBeNull();
  });

  it("finds a claimed worker by its run, and retires only an idle one", async () => {
    const s = spec();
    const [a, b] = await idlePool(s, 2);
    const runId = await run();
    const claimed = await ledger.claim(runId, s, longAgo);
    expect((await ledger.forRun(runId))?.id).toBe(claimed?.id);
    const other = claimed?.id === a.id ? b : a;
    expect(await ledger.retire(claimed!.id)).toBe(false);
    expect(await ledger.retire(other.id)).toBe(true);
    expect(await ledger.markIdle(other.id)).toBe(false);
    await ledger.remove(other.id);
    expect(await ledger.workers()).not.toContainEqual(expect.objectContaining({ id: other.id }));
  });
});
