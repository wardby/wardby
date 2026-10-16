import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../core/db.js";
import { PrismaGatewayLedger } from "./ledger.js";

describe.skipIf(!process.env.DATABASE_URL)("PrismaGatewayLedger (database)", () => {
  const db = createPrismaClient();
  const ledger = new PrismaGatewayLedger(db);
  const tag = randomUUID().slice(0, 8);
  const agentId = `gwl-agent-${tag}`;
  const now = new Date();
  const later = new Date(now.getTime() + 60_000);

  beforeAll(async () => {
    await db.agent.create({ data: { id: agentId, name: agentId, systemPrompt: "s", model: "m", budgetUsd: 1 } });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId } }); // cascades sessions and calls
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  async function session(budgetUsd = 1, deadlineAt = later) {
    const run = await db.run.create({ data: { agentId, nativeExecutionMode: "sandbox" } });
    const hash = `hash-${randomUUID()}`;
    const created = await ledger.createSession({
      runId: run.id,
      capabilityHash: hash,
      deadlineAt,
      budgetUsd,
      snapshot: { note: "no secrets here" },
    });
    return { run, hash, created };
  }

  it("finds an active session by capability hash, and no longer once it is finished", async () => {
    const { hash, created } = await session();
    expect((await ledger.findSessionByCapabilityHash(hash))?.id).toBe(created.id);
    expect(await ledger.findSessionByCapabilityHash("hash-unknown")).toBeNull();
    await ledger.endSession(created.id, "finished");
    expect((await ledger.findSessionByCapabilityHash(hash))?.status).toBe("finished");
  });

  it("reserves within budget, replays a duplicate callId, and refuses past the budget", async () => {
    const { created } = await session(1);
    const first = await ledger.reserve({ sessionId: created.id, callId: "llm-1", reservationUsd: 0.6, now });
    expect(first.outcome).toBe("reserved");
    expect((await ledger.reserve({ sessionId: created.id, callId: "llm-1", reservationUsd: 0.6, now })).outcome).toBe(
      "duplicate",
    );
    expect((await ledger.reserve({ sessionId: created.id, callId: "llm-2", reservationUsd: 0.6, now })).outcome).toBe(
      "budget_exhausted",
    );
    const row = await db.nativeGatewaySession.findUnique({ where: { id: created.id } });
    expect(row?.budgetExhaustedAt).toBeInstanceOf(Date);
  });

  it("settles a reservation at its actual cost, freeing the rest of the hold", async () => {
    const { created } = await session(1);
    await ledger.reserve({ sessionId: created.id, callId: "llm-1", reservationUsd: 0.9, now });
    await ledger.complete(created.id, "llm-1", {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.1,
    });
    expect((await ledger.reserve({ sessionId: created.id, callId: "llm-2", reservationUsd: 0.5, now })).outcome).toBe(
      "reserved",
    );
    const totals = await ledger.totals(created.id);
    expect(totals).toMatchObject({ tokensIn: 100, tokensOut: 10, costUsd: 0.1 });
    expect(totals.heldUsd).toBeCloseTo(0.6, 10);
  });

  it("releases a failed call's hold, and keeps an uncertain one held", async () => {
    const { created } = await session(1);
    await ledger.reserve({ sessionId: created.id, callId: "a", reservationUsd: 0.5, now });
    await ledger.reserve({ sessionId: created.id, callId: "b", reservationUsd: 0.4, now });
    await ledger.release(created.id, "a");
    await ledger.markUncertain(created.id, "b");
    expect((await ledger.totals(created.id)).heldUsd).toBeCloseTo(0.4, 10);
  });

  it("counts an interrupted call at its estimate, not its hold", async () => {
    const created = (await session(1, new Date(Date.now() + 60_000))).created;
    await ledger.reserve({ sessionId: created.id, callId: "cut", reservationUsd: 0.4, now: new Date() });
    await ledger.markUncertain(created.id, "cut", {
      inputTokens: 1_000,
      outputTokens: 50,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });
    const totals = await ledger.totals(created.id);
    expect(totals.heldUsd).toBeCloseTo(0.01, 10);
    expect(totals.costUsd).toBeCloseTo(0.01, 10);
    expect(totals.tokensIn).toBe(1_000);
  });

  it("never overspends under concurrent reservations", async () => {
    const { created } = await session(1);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        ledger.reserve({ sessionId: created.id, callId: `c-${i}`, reservationUsd: 0.3, now }),
      ),
    );
    expect(outcomes.filter((o) => o.outcome === "reserved")).toHaveLength(3);
    expect((await ledger.totals(created.id)).heldUsd).toBeLessThan(1);
  });

  it("refuses reservations once the session is past its deadline or ended", async () => {
    const expired = await session(1, new Date(now.getTime() - 1));
    expect(
      (await ledger.reserve({ sessionId: expired.created.id, callId: "x", reservationUsd: 0.1, now })).outcome,
    ).toBe("inactive");
    const cancelled = await session(1);
    await ledger.endSession(cancelled.created.id, "cancelled");
    expect(
      (await ledger.reserve({ sessionId: cancelled.created.id, callId: "x", reservationUsd: 0.1, now })).outcome,
    ).toBe("inactive");
  });

  it("claims a one-shot call once, then replays its recorded result", async () => {
    const { created } = await session();
    expect(await ledger.claim(created.id, "b-1", "builtin.call")).toEqual({ outcome: "claimed" });
    expect(await ledger.claim(created.id, "b-1", "builtin.call")).toEqual({ outcome: "in_flight" });
    await ledger.recordResult(created.id, "b-1", "result-text");
    expect(await ledger.claim(created.id, "b-1", "builtin.call")).toEqual({ outcome: "done", result: "result-text" });
  });

  it("tracks a delegation's child run and budget wait on its call", async () => {
    const { created } = await session();
    await ledger.claim(created.id, "d-1", "builtin.call");
    await ledger.claim(created.id, "d-2", "builtin.call");
    await ledger.setDelegation(created.id, "d-1", { status: "waiting_budget", childAgentId: "agent-a" });
    await ledger.setDelegation(created.id, "d-2", { status: "waiting_budget", childAgentId: "agent-b" });
    expect(await ledger.delegation(created.id, "d-1")).toMatchObject({
      status: "waiting_budget",
      childRunId: null,
      childAgentId: "agent-a",
    });
    expect(await ledger.waitingChildAgentIds(created.id, "d-1")).toEqual(["agent-b"]);
    await ledger.setDelegation(created.id, "d-1", {
      status: "pending",
      childAgentId: "agent-a",
      childRunId: "child-run-1",
    });
    expect(await ledger.delegation(created.id, "d-1")).toMatchObject({ status: "pending", childRunId: "child-run-1" });
    expect(await ledger.openDelegationChildren(created.id)).toEqual(["child-run-1"]);
  });
});
