/**
 * Overrun from available room, against real PostgreSQL: a coding run reserves
 * its base at dispatch, and the control plane grants top-ups up to its limit
 * (CodingRun.budgetLimitUsd) only out of room its budget group and run tree
 * have left, under the group dispatch lock. Group caps and run-tree ceilings
 * stay hard however runs interleave.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Executor } from "../providers/executor/types.js";
import { computeGroupSpend } from "./budget-groups.js";
import { hostBudgetSentence, loadBudgetEvent, ownerBudgetSentence, recordBudgetEvent } from "./budget-events.js";
import { topUpCodingBudget } from "./budget-topup.js";
import { createPrismaClient } from "./db.js";
import { dispatchRun } from "./dispatch.js";

describe.skipIf(!process.env.DATABASE_URL)("coding budget top-ups (database)", () => {
  const db = createPrismaClient();
  const PREFIX = "bgtop-";
  const suffix = randomUUID();
  const owner = `${PREFIX}owner-${suffix}`;
  const id = (name: string) => `${PREFIX}${name}-${suffix}`;
  const executor: Executor = { async start() {}, async stop() {} };

  async function group(name: string, dailyBudgetUsd: number): Promise<string> {
    const g = await db.budgetGroup.create({ data: { id: id(name), name: id(name), ownerId: owner, dailyBudgetUsd } });
    return g.id;
  }

  async function codingAgent(
    name: string,
    budgetUsd: number,
    allowedOverrunPercent: number,
    budgetGroupId: string | null,
    provider = "codex",
  ): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "Fix things.",
        model: provider === "codex" ? "gpt-5.6-luna" : "claude-sonnet-4-6",
        budgetUsd,
        allowedOverrunPercent,
        kind: "coding",
        ownerId: owner,
        budgetGroupId,
        codingProfile: {
          create: { provider, repository: "your-org/your-repo", defaultTask: "Fix it.", protectedPaths: [] },
        },
      },
    });
    return agentId;
  }

  async function nativeAgent(
    name: string,
    budgetUsd: number,
    allowedOverrunPercent: number,
    budgetGroupId: string | null,
  ): Promise<string> {
    const agentId = id(name);
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "t",
        model: "t",
        budgetUsd,
        allowedOverrunPercent,
        ownerId: owner,
        budgetGroupId,
      },
    });
    return agentId;
  }

  /** Dispatches a coding run, marks it running and opens its proxy session at its reservation. */
  async function start(agentId: string, parentRunId?: string): Promise<string> {
    const result = await dispatchRun({
      db,
      executor,
      agentId,
      ...(parentRunId ? { trigger: "subagent" as const, parentRunId } : {}),
    });
    const runId = result!.run.id;
    await db.run.update({ where: { id: runId }, data: { status: "running", heartbeatAt: new Date() } });
    const reserved = await reservedUsd(runId);
    if (reserved > 0) {
      await db.codingProxySession.create({
        data: {
          runId,
          capabilityHash: `${PREFIX}${randomUUID()}`,
          credentialRef: "env:TEST",
          allowedModels: ["gpt-5.6-luna"],
          deadlineAt: new Date(Date.now() + 3_600_000),
          budgetUsd: reserved,
        },
      });
    }
    return runId;
  }

  /** One completed model request: its cost goes to the session and to the run's costUsd, as the proxy's does. */
  async function spend(runId: string, costUsd: number, ceilingUsd = 0.05): Promise<void> {
    const session = await db.codingProxySession.findUniqueOrThrow({ where: { runId } });
    await db.codingProxyRequest.create({
      data: {
        sessionId: session.id,
        requestKey: randomUUID(),
        requestFingerprint: "f",
        model: "gpt-5.6-luna",
        status: "completed",
        reservationUsd: ceilingUsd,
        ceilingUsd,
        actualCostUsd: costUsd,
        pricingVersion: "t",
        pricingSnapshot: {},
      },
    });
    await db.run.update({ where: { id: runId }, data: { costUsd: { increment: costUsd } } });
  }

  async function reservedUsd(runId: string): Promise<number> {
    const row = await db.codingRun.findUnique({ where: { runId }, select: { budgetReservedUsd: true } });
    return row ? Number(row.budgetReservedUsd) : 0;
  }

  async function sessionBudgetUsd(runId: string): Promise<number> {
    return Number((await db.codingProxySession.findUniqueOrThrow({ where: { runId } })).budgetUsd);
  }

  async function costUsd(runId: string): Promise<number> {
    return Number((await db.run.findUniqueOrThrow({ where: { id: runId } })).costUsd);
  }

  /** Spends right up to the run's grant (leaving `gap`), then asks for a top-up. */
  async function spendToGrantAndAsk(runId: string, gap = 0.01) {
    const left = (await reservedUsd(runId)) - (await costUsd(runId)) - gap;
    if (left > 0) await spend(runId, Number(left.toFixed(6)));
    return topUpCodingBudget(db, runId);
  }

  async function groupTotal(groupId: string): Promise<number> {
    const g = await db.budgetGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: { agents: { select: { id: true, budgetUsd: true } } },
    });
    const [day] = await computeGroupSpend(db, g, g.agents);
    return day.spentUsd + day.reservedUsd;
  }

  async function cleanup(): Promise<void> {
    const agents = { agentId: { startsWith: PREFIX } };
    await db.codingRun.deleteMany({ where: { run: agents } });
    await db.run.deleteMany({ where: { ...agents, parentRunId: { not: null } } });
    await db.run.deleteMany({ where: agents });
    await db.codingAgentProfile.deleteMany({ where: agents });
    await db.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.budgetGroup.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await db.principal.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  async function finish(...runIds: string[]): Promise<void> {
    await db.run.updateMany({
      where: { id: { in: runIds } },
      data: { status: "cancelled", finishedAt: new Date() },
    });
  }

  beforeAll(async () => {
    await cleanup();
    await db.principal.create({ data: { id: owner, subject: owner } });
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it("dispatch reserves the base and records the limit; nothing is reserved for the overrun", async () => {
    const agent = await codingAgent("dispatch", 1, 50, null);
    const runId = await start(agent);
    const row = await db.codingRun.findUniqueOrThrow({ where: { runId } });
    expect(Number(row.budgetReservedUsd)).toBeCloseTo(1, 6);
    expect(Number(row.budgetBaseUsd)).toBeCloseTo(1, 6);
    expect(Number(row.budgetLimitUsd)).toBeCloseTo(1.5, 6);
    await finish(runId);
  });

  it("a standalone run spends past its base up to its limit through top-ups", async () => {
    const agent = await codingAgent("standalone", 1, 50, null);
    const runId = await start(agent);

    // Far from its grant: nothing is asked for.
    await spend(runId, 0.5);
    expect((await topUpCodingBudget(db, runId)).outcome).toBe("not_needed");
    expect(await reservedUsd(runId)).toBeCloseTo(1, 6);

    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await spendToGrantAndAsk(runId);
      outcomes.push(result.outcome);
      if (result.outcome === "closed") break;
    }
    // Steps of 10% of the base until the limit, then nothing more to grant.
    expect(outcomes).toEqual(["granted", "granted", "granted", "granted", "granted", "closed"]);
    expect(await reservedUsd(runId)).toBeCloseTo(1.5, 6);
    expect(await sessionBudgetUsd(runId)).toBeCloseTo(1.5, 6);
    expect(await costUsd(runId)).toBeGreaterThan(1.4);
    expect(await db.runBudgetEvent.count({ where: { runId } })).toBe(0);
    await finish(runId);
  });

  it("a run in a full group stops at its base, with the overrun_unavailable wording", async () => {
    const g = await group("full", 2);
    const holder = await codingAgent("full-holder", 1, 0, g);
    const agent = await codingAgent("full-runner", 1, 10, g);
    const holderRun = await start(holder);
    const runId = await start(agent);
    expect(await reservedUsd(runId)).toBeCloseTo(1, 6);

    const result = await spendToGrantAndAsk(runId);
    expect(result.outcome).toBe("unavailable");
    expect(await reservedUsd(runId)).toBeCloseTo(1, 6);
    expect(await sessionBudgetUsd(runId)).toBeCloseTo(1, 6);
    const events = await db.runBudgetEvent.findMany({ where: { runId } });
    expect(events).toEqual([
      expect.objectContaining({
        kind: "overrun_unavailable",
        limit: "day",
        details: expect.objectContaining({ source: "top-up", baseBudgetUsd: 1, limitUsd: 1.1, grantedUsd: 1 }),
      }),
    ]);
    // Refused once: it never asks again, even when the group frees up.
    await finish(holderRun);
    expect((await topUpCodingBudget(db, runId)).outcome).toBe("closed");
    expect(await reservedUsd(runId)).toBeCloseTo(1, 6);

    // The proxy then refuses the next request at the base; the sentences say why.
    await recordBudgetEvent(db, runId, "run", {
      source: "proxy",
      budgetUsd: 1,
      spentUsd: 0.99,
      heldReservedUsd: 0,
      heldUncertainUsd: 0,
      refusedHoldUsd: 0.05,
      model: "gpt-5.6-luna",
      turn: 7,
    });
    const loaded = await loadBudgetEvent(db, runId);
    expect(loaded?.event.limit).toBe("run");
    const owner = ownerBudgetSentence(loaded!.event, loaded!.agentName);
    expect(owner).toContain("this run's $1.00 budget was left");
    expect(owner).toContain(
      `Its 10% allowed overrun wasn't available because the "${id("full")}" group had $0.00 left of its daily cap.`,
    );
    expect(owner).toContain("To continue, raise the group's daily cap.");
    expect(hostBudgetSentence(loaded!.event)).toContain(
      `Its 10% allowed overrun wasn't available because the "${id("full")}" group had $0.00 left of its daily cap.`,
    );
    await finish(runId);
  });

  it("B2: a run started between a lead and its builder: nothing passes the $20 cap, and a full group gives the builder no overrun", async () => {
    const g = await group("b2", 20);
    const lead = await nativeAgent("b2-lead", 10, 50, g);
    const builder = await codingAgent("b2-builder", 10, 50, g);
    const other = await codingAgent("b2-other", 10, 0, g);
    const parent = await db.run.create({ data: { agentId: lead, status: "running", costUsd: 0 } });
    const between = await start(other);
    const child = await start(builder, parent.id);

    expect(await reservedUsd(between)).toBeCloseTo(10, 6);
    expect(await reservedUsd(child)).toBeCloseTo(10, 6);
    expect(await groupTotal(g)).toBeLessThanOrEqual(20 + 1e-6);

    // The group is full: the builder's overrun is not available.
    expect((await spendToGrantAndAsk(child)).outcome).toBe("unavailable");
    expect(await reservedUsd(child)).toBeCloseTo(10, 6);
    expect(await groupTotal(g)).toBeLessThanOrEqual(20 + 1e-6);
    await finish(parent.id, between, child);
  });

  it("B2 with leftover room: the builder overruns only from what the group has left", async () => {
    const g = await group("b2-room", 20);
    const lead = await nativeAgent("b2r-lead", 10, 50, g);
    const builder = await codingAgent("b2r-builder", 10, 50, g);
    const other = await codingAgent("b2r-other", 10, 0, g);
    const parent = await db.run.create({ data: { agentId: lead, status: "running", costUsd: 0 } });
    const between = await start(other);
    const child = await start(builder, parent.id);
    // The other run finishes at $6, which leaves $4 of the cap for the builder's overrun.
    await spend(between, 6);
    await db.run.update({ where: { id: between }, data: { status: "succeeded", finishedAt: new Date() } });

    const outcomes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const result = await spendToGrantAndAsk(child);
      outcomes.push(result.outcome);
      expect(await groupTotal(g)).toBeLessThanOrEqual(20 + 1e-6);
      if (result.outcome !== "granted") break;
    }
    expect(outcomes.at(-1)).toBe("unavailable");
    expect(await reservedUsd(child)).toBeCloseTo(14, 6);
    await finish(parent.id, child);
  });

  it("concurrent top-ups from two runs in one group never pass the cap together", async () => {
    const g = await group("concurrent", 12);
    const a = await codingAgent("conc-a", 5, 50, g);
    const b = await codingAgent("conc-b", 5, 50, g);
    const runA = await start(a);
    const runB = await start(b);
    expect((await reservedUsd(runA)) + (await reservedUsd(runB))).toBeCloseTo(10, 6);

    for (let round = 0; round < 10; round++) {
      await Promise.all([spendToGrantAndAsk(runA), spendToGrantAndAsk(runB)]);
      expect(await groupTotal(g)).toBeLessThanOrEqual(12 + 1e-6);
    }
    expect((await reservedUsd(runA)) + (await reservedUsd(runB))).toBeCloseTo(12, 6);
    for (const runId of [runA, runB]) expect(await sessionBudgetUsd(runId)).toBeCloseTo(await reservedUsd(runId), 6);
    await finish(runA, runB);
  });

  it("two coding siblings' top-ups never pass the lead's raised tree ceiling", async () => {
    const lead = await nativeAgent("tree-lead", 10, 50, null);
    const a = await codingAgent("tree-a", 6, 50, null);
    const b = await codingAgent("tree-b", 6, 50, null);
    const parent = await db.run.create({ data: { agentId: lead, status: "running", costUsd: 0 } });
    const runA = await start(a, parent.id);
    const runB = await start(b, parent.id);
    // The tree holds the lead's base: $6 and the $4 left of it.
    expect(await reservedUsd(runA)).toBeCloseTo(6, 6);
    expect(await reservedUsd(runB)).toBeCloseTo(4, 6);

    for (let round = 0; round < 20; round++) {
      await Promise.all([spendToGrantAndAsk(runA), spendToGrantAndAsk(runB)]);
      expect((await reservedUsd(runA)) + (await reservedUsd(runB))).toBeLessThanOrEqual(15 + 1e-6);
    }
    expect((await reservedUsd(runA)) + (await reservedUsd(runB))).toBeCloseTo(15, 6);
    await finish(parent.id, runA, runB);
  });

  it("an old run (null budgetLimitUsd) behaves exactly as before: no top-up, its reservation stays", async () => {
    const agent = await codingAgent("old", 1, 50, null);
    const runId = await start(agent);
    // An old row: the reservation already included the overrun, and no limit was recorded.
    await db.codingRun.update({ where: { runId }, data: { budgetReservedUsd: 1.5, budgetLimitUsd: null } });
    await db.codingProxySession.update({ where: { runId }, data: { budgetUsd: 1.5 } });
    const result = await spendToGrantAndAsk(runId);
    expect(result.outcome).toBe("closed");
    expect(await reservedUsd(runId)).toBeCloseTo(1.5, 6);
    expect(await sessionBudgetUsd(runId)).toBeCloseTo(1.5, 6);
    await finish(runId);
  });
});
