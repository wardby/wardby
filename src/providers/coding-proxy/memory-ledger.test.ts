import { describe, expect, it } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";

describe("MemoryProxyLedger upstream failures", () => {
  it("keeps only the first upstream failure code of a session", async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
      registryTokenHash: "registry-hash",
    });
    expect(await ledger.upstreamFailure("s1")).toBeNull();
    expect((await ledger.findSessionByCapabilityHash("hash"))?.upstreamFailure ?? null).toBeNull();
    await ledger.recordUpstreamFailure("s1", "project_spend_limit_exceeded");
    await ledger.recordUpstreamFailure("s1", "server_error");
    expect(await ledger.upstreamFailure("s1")).toBe("project_spend_limit_exceeded");
    expect((await ledger.findSessionByCapabilityHash("hash"))?.upstreamFailure).toBe("project_spend_limit_exceeded");
    await ledger.recordUpstreamFailure("missing", "server_error");
    expect(await ledger.upstreamFailure("missing")).toBeNull();
  });
});

describe("MemoryProxyLedger interrupted replies", () => {
  const u = (inputTokens: number, outputTokens: number) => ({
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  });
  const setup = async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m", "other"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
      registryTokenHash: "registry-hash",
    });
    const reserve = (id: string, reservationUsd: number, model = "m") =>
      ledger.reserve({
        id,
        sessionId: "s1",
        requestKey: id,
        requestFingerprint: id,
        model,
        reservationUsd,
        pricing: { version: "v", encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 },
        now: new Date(),
      });
    return { ledger, reserve };
  };

  it("counts an estimated uncertain request at its estimate and an un-estimated one at its hold", async () => {
    const { ledger, reserve } = await setup();
    await reserve("estimated", 0.4);
    await ledger.markUncertain("estimated", 200, { usage: u(10, 2), costUsd: 0.1 });
    expect(await ledger.getRequest("estimated")).toMatchObject({
      status: "uncertain",
      costEstimated: true,
      actualCostUsd: 0.1,
      usage: u(10, 2),
    });
    // 0.1 (estimate) + 0.85 < 1, but 0.4 (hold) + 0.85 would not be.
    expect((await reserve("fits", 0.85)).outcome).toBe("reserved");
    await ledger.release("fits", 500);
    await reserve("held", 0.4);
    await ledger.markUncertain("held", 502);
    const held = await ledger.getRequest("held");
    expect(held?.status).toBe("uncertain");
    expect(held?.costEstimated).toBeFalsy();
    expect(held?.actualCostUsd).toBeUndefined();
    // 0.1 + 0.4 (hold) + 0.5 = 1: refused.
    expect((await reserve("over", 0.5)).outcome).toBe("budget_exhausted");
  });

  it("clears the estimate flag when an estimated request completes", async () => {
    const { ledger, reserve } = await setup();
    await reserve("late", 0.4);
    await ledger.markUncertain("late", 200, { usage: u(10, 2), costUsd: 0.1 });
    const done = await ledger.complete("late", u(20, 4), 0.2, 200);
    expect(done).toMatchObject({ status: "completed", costEstimated: false, actualCostUsd: 0.2 });
  });

  it("hints the latest completed, non-estimated reply of the model and the lower-middle median output", async () => {
    const { ledger, reserve } = await setup();
    expect(await ledger.settlementHints("s1", "m")).toEqual({});
    for (const [id, model, output] of [
      ["c1", "m", 40],
      ["c2", "m", 10],
      ["c3", "other", 30],
      ["c4", "other", 20],
    ] as const) {
      await reserve(id, 0.01, model);
      await ledger.complete(id, u(100, output), 0.001, 200);
    }
    await reserve("cut", 0.01);
    await ledger.markUncertain("cut", 200, { usage: u(5, 1), costUsd: 0.0001 });
    expect(await ledger.settlementHints("s1", "m")).toEqual({ previous: u(100, 10), medianOutputTokens: 20 });
    expect(await ledger.settlementHints("s1", "none")).toEqual({ medianOutputTokens: 20 });
  });
});

describe("MemoryProxyLedger previousReply", () => {
  const usage = { inputTokens: 100, outputTokens: 5, cachedInputTokens: 90, cacheWriteTokens: 0, reasoningTokens: 0 };
  const PRICING = { version: "v", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 };
  const setup = async (clock: Date) => {
    const ledger = new MemoryProxyLedger({ now: () => clock });
    await ledger.createSession({
      id: "s",
      runId: "r",
      capabilityHash: "hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m"],
      deadlineAt: new Date(clock.getTime() + 60_000),
      budgetUsd: 10,
      registryTokenHash: "registry-hash",
    });
    const base = { sessionId: "s", model: "m", pricing: PRICING, now: clock };
    const reserve = (id: string, requestBytes: number, conversationKey: string) =>
      ledger.reserve({
        ...base,
        id,
        requestKey: id,
        requestFingerprint: id,
        reservationUsd: 0.1,
        requestBytes,
        ceilingUsd: 0.1,
        reservationBasis: "full",
        conversationKey,
      });
    return { ledger, reserve };
  };

  it("returns the latest finished request of the conversation, with its size and reservation time", async () => {
    const clock = new Date("2026-10-16T12:00:00Z");
    const { ledger, reserve } = await setup(clock);
    const first = await reserve("a", 1000, "k1");
    if (first.outcome !== "reserved") throw new Error(first.outcome);
    await ledger.complete("a", usage, 0.01, 200);
    await reserve("b", 500, "k2");
    expect(await ledger.previousReply("s", "k1")).toEqual({
      model: "m",
      status: "completed",
      costEstimated: false,
      usage,
      requestBytes: 1000,
      startedAt: clock,
    });
    // b is still reserved, so k2 has no finished request yet; an unknown key has none either.
    expect(await ledger.previousReply("s", "k2")).toBeNull();
    expect(await ledger.previousReply("s", "none")).toBeNull();
  });

  it("reports an interrupted request settled at an estimate as such", async () => {
    const clock = new Date("2026-10-16T12:00:00Z");
    const { ledger, reserve } = await setup(clock);
    const reserved = await reserve("c", 700, "k1");
    if (reserved.outcome !== "reserved") throw new Error(reserved.outcome);
    await ledger.markUncertain("c", 200, { usage, costUsd: 0.02 });
    expect(await ledger.previousReply("s", "k1")).toEqual({
      model: "m",
      status: "uncertain",
      costEstimated: true,
      usage,
      requestBytes: 700,
      startedAt: clock,
    });
  });
});
