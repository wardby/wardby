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

  it("hints the lower-middle median output of the model's completed replies", async () => {
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
    // Another model's replies don't count: "m" has 40 and 10, "other" 30 and 20.
    expect(await ledger.settlementHints("s1", "m")).toEqual({ medianOutputTokens: 10 });
    expect(await ledger.settlementHints("s1", "other")).toEqual({ medianOutputTokens: 20 });
    expect(await ledger.settlementHints("s1", "none")).toEqual({});
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

describe("MemoryProxyLedger request leases", () => {
  const PRICING = { version: "v", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 };
  const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const START = new Date("2026-11-03T12:00:00.000Z");
  const LEASE_MS = 30_000;
  const setup = async () => {
    let now = START;
    const ledger = new MemoryProxyLedger({ now: () => now });
    await ledger.createSession({
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m"],
      deadlineAt: new Date(START.getTime() + 24 * 60 * 60_000),
      budgetUsd: 1,
      registryTokenHash: "registry-hash",
    });
    const reserve = (id: string, extra: { ownerId?: string; leaseMs?: number } = {}) =>
      ledger.reserve({
        id,
        sessionId: "s1",
        requestKey: id,
        requestFingerprint: id,
        model: "m",
        reservationUsd: 0.2,
        pricing: PRICING,
        now,
        maxOutputTokens: 100,
        ...extra,
      });
    return { ledger, reserve, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  };

  it("leases a request to its owner from the ledger's clock", async () => {
    const { ledger, reserve } = await setup();
    await reserve("a", { ownerId: "owner-1", leaseMs: LEASE_MS });
    expect(await ledger.getRequest("a")).toMatchObject({
      ownerId: "owner-1",
      maxOutputTokens: 100,
      leaseUntil: new Date(START.getTime() + LEASE_MS),
    });
  });

  it("leaves a request without an owner or a lease length unleased, and never lists it", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("no-lease");
    await reserve("no-owner", { leaseMs: LEASE_MS });
    expect((await ledger.getRequest("no-lease"))?.leaseUntil).toBeNull();
    expect((await ledger.getRequest("no-owner"))?.leaseUntil).toBeNull();
    advance(24 * 60 * 60_000);
    expect(await ledger.expiredLeases(10)).toEqual([]);
    expect(await ledger.settleExpired("no-lease")).toBe(false);
  });

  it("renews only the owner's own reserved requests", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("mine", { ownerId: "owner-1", leaseMs: LEASE_MS });
    await reserve("theirs", { ownerId: "owner-2", leaseMs: LEASE_MS });
    await reserve("done", { ownerId: "owner-1", leaseMs: LEASE_MS });
    await ledger.complete("done", usage, 0.01, 200);
    advance(10_000);
    expect(await ledger.renewLeases("owner-1", ["mine", "theirs", "done", "unknown"], LEASE_MS)).toEqual({
      renewed: ["mine"],
      cancelled: [],
    });
    const renewed = new Date(START.getTime() + 10_000 + LEASE_MS);
    expect((await ledger.getRequest("mine"))?.leaseUntil).toEqual(renewed);
    expect((await ledger.getRequest("theirs"))?.leaseUntil).toEqual(new Date(START.getTime() + LEASE_MS));
    expect((await ledger.getRequest("done"))?.leaseUntil).toBeNull();
  });

  it("lists the renewed requests whose session was cancelled", async () => {
    const { ledger, reserve } = await setup();
    await reserve("mine", { ownerId: "owner-1", leaseMs: LEASE_MS });
    await ledger.cancelSession("s1");
    expect(await ledger.renewLeases("owner-1", ["mine"], LEASE_MS)).toEqual({ renewed: ["mine"], cancelled: ["mine"] });
  });

  it("lists only reserved requests whose lease has passed, oldest lease first", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("early", { ownerId: "o", leaseMs: LEASE_MS });
    advance(5_000);
    await reserve("late", { ownerId: "o", leaseMs: LEASE_MS });
    advance(LEASE_MS - 6_000);
    expect(await ledger.expiredLeases(10)).toEqual([]);
    advance(2_000);
    const expired = await ledger.expiredLeases(10);
    expect(expired.map((item) => item.request.id)).toEqual(["early"]);
    expect(expired[0]).toMatchObject({ runId: "r1", createdAt: START });
    advance(5_000);
    expect((await ledger.expiredLeases(10)).map((item) => item.request.id)).toEqual(["early", "late"]);
    expect(await ledger.expiredLeases(1)).toHaveLength(1);
  });

  it("settles an expired request at an estimate, so it counts at it and not at its hold", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a", { ownerId: "o", leaseMs: LEASE_MS });
    advance(LEASE_MS + 1);
    expect(await ledger.settleExpired("a", { usage, costUsd: 0.01 })).toBe(true);
    expect(await ledger.getRequest("a")).toMatchObject({
      status: "uncertain",
      costEstimated: true,
      actualCostUsd: 0.01,
      leaseUntil: null,
      ownerId: "o",
    });
    // 0.01 spent + 0.2 would not fit beside a 0.85 hold if the old hold still counted: 0.2 + 0.85 >= 1.
    expect((await reserve("b")).outcome).toBe("reserved");
  });

  it("settles without an estimate by keeping the hold, and settles a request once", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a", { ownerId: "o", leaseMs: LEASE_MS });
    advance(LEASE_MS + 1);
    expect(await ledger.settleExpired("a")).toBe(true);
    expect((await ledger.getRequest("a"))?.costEstimated).toBeFalsy();
    expect(await ledger.settleExpired("a", { usage, costUsd: 0.01 })).toBe(false);
    expect((await ledger.getRequest("a"))?.actualCostUsd).toBeUndefined();
  });

  it("leaves a request alone when its owner renewed it before the sweep settled it", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a", { ownerId: "o", leaseMs: LEASE_MS });
    advance(LEASE_MS + 1);
    await ledger.renewLeases("o", ["a"], LEASE_MS);
    expect(await ledger.settleExpired("a", { usage, costUsd: 0.01 })).toBe(false);
    expect((await ledger.getRequest("a"))?.status).toBe("reserved");
  });

  it("clears the lease, and keeps the owner, when a request settles any other way", async () => {
    const { ledger, reserve } = await setup();
    for (const id of ["completed", "released", "uncertain"]) await reserve(id, { ownerId: "o", leaseMs: LEASE_MS });
    await ledger.complete("completed", usage, 0.01, 200);
    await ledger.release("released", 500);
    await ledger.markUncertain("uncertain", 502);
    for (const id of ["completed", "released", "uncertain"]) {
      expect(await ledger.getRequest(id)).toMatchObject({ leaseUntil: null, ownerId: "o" });
    }
  });

  it("lets a swept request finish at its real cost", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a", { ownerId: "o", leaseMs: LEASE_MS });
    advance(LEASE_MS + 1);
    await ledger.settleExpired("a", { usage, costUsd: 0.01 });
    expect(await ledger.complete("a", { ...usage, outputTokens: 50 }, 0.07, 200)).toMatchObject({
      status: "completed",
      costEstimated: false,
      actualCostUsd: 0.07,
    });
  });
});

describe("MemoryProxyLedger request attempts", () => {
  const PRICING = { version: "v", encoding: "o200k_base" as const, inputPerMTok: 1, outputPerMTok: 1 };
  const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const estimate = { usage, costUsd: 0.05 };
  const START = new Date("2026-11-04T12:00:00.000Z");
  const LEASE_MS = 30_000;
  const setup = async (budgetUsd = 1) => {
    let now = START;
    const ledger = new MemoryProxyLedger({ now: () => now });
    await ledger.createSession({
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["m"],
      deadlineAt: new Date(START.getTime() + 24 * 60 * 60_000),
      budgetUsd,
      registryTokenHash: "registry-hash",
    });
    // One request key ("k") and body ("body"), tried again under a new id each time.
    const reserve = (
      id: string,
      extra: Partial<Parameters<MemoryProxyLedger["reserve"]>[0]> = {},
      lease: { ownerId?: string; leaseMs?: number } = { ownerId: "o", leaseMs: LEASE_MS },
    ) =>
      ledger.reserve({
        id,
        sessionId: "s1",
        requestKey: "k",
        requestFingerprint: "body",
        model: "m",
        reservationUsd: 0.2,
        pricing: PRICING,
        now,
        maxOutputTokens: 100,
        maxAttempts: 3,
        ...lease,
        ...extra,
      });
    return { ledger, reserve, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  };

  it("answers a retry inside the lease as in progress, with the lease's remaining time", async () => {
    const { reserve, advance } = await setup();
    await reserve("a");
    advance(10_000);
    expect(await reserve("b")).toMatchObject({
      outcome: "in_progress",
      request: { id: "a", status: "reserved" },
      retryAfterMs: 20_000,
    });
  });

  it("reports a request whose lease ran out as orphaned, and changes nothing until told to take it over", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a");
    advance(LEASE_MS + 1);
    expect(await reserve("b")).toMatchObject({
      outcome: "orphaned",
      orphan: { runId: "r1", createdAt: START, request: { id: "a", attempt: 1 } },
    });
    expect(await ledger.getRequest("a")).toMatchObject({ status: "reserved" });
    expect(await ledger.getRequest("b")).toBeNull();
  });

  it("takes an orphan over: settles it at the estimate and reserves the next attempt", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a");
    advance(LEASE_MS + 1);
    const result = await reserve("b", { takeover: { requestId: "a", estimate } });
    expect(result).toMatchObject({
      outcome: "reserved",
      request: { id: "b", attempt: 2, requestKey: "k", status: "reserved" },
      tookOver: { requestId: "a" },
    });
    expect(await ledger.getRequest("a")).toMatchObject({
      status: "uncertain",
      costEstimated: true,
      actualCostUsd: 0.05,
      leaseUntil: null,
      attempt: 1,
    });
    expect((await ledger.getRequest("a"))?.orphanedAt).toBeInstanceOf(Date);
  });

  it("counts the first attempt's estimate and the new attempt's hold against the budget", async () => {
    // 0.05 estimate + 0.2 new hold + a third 0.8 would not fit in 1; the old 0.2 hold alone would not have mattered.
    const { reserve, advance } = await setup(0.5);
    await reserve("a");
    advance(LEASE_MS + 1);
    await reserve("b", { takeover: { requestId: "a", estimate } });
    expect(await reserve("c", { requestKey: "other", reservationUsd: 0.26 })).toMatchObject({
      outcome: "budget_exhausted",
      details: { spentUsd: 0.05, heldReservedUsd: 0.2, heldUncertainUsd: 0 },
    });
    expect((await reserve("d", { requestKey: "other", reservationUsd: 0.2 })).outcome).toBe("reserved");
  });

  it("still settles the orphan when the budget then refuses the new attempt", async () => {
    const { ledger, reserve, advance } = await setup(0.2);
    await reserve("a", { reservationUsd: 0.1 });
    advance(LEASE_MS + 1);
    expect(await reserve("b", { reservationUsd: 0.2, takeover: { requestId: "a", estimate } })).toMatchObject({
      outcome: "budget_exhausted",
    });
    expect(await ledger.getRequest("a")).toMatchObject({ status: "uncertain", costEstimated: true });
  });

  it("takes over a request the sweep already settled, without settling it again", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a");
    advance(LEASE_MS + 1);
    await ledger.settleExpired("a", estimate);
    expect(await reserve("b")).toMatchObject({
      outcome: "reserved",
      request: { id: "b", attempt: 2 },
      tookOver: { requestId: "a" },
    });
    expect(await ledger.getRequest("a")).toMatchObject({ status: "uncertain", actualCostUsd: 0.05 });
  });

  it("only one of two takeovers of the same orphan wins; the other sees the new attempt in progress", async () => {
    const { reserve, advance } = await setup();
    await reserve("a");
    advance(LEASE_MS + 1);
    const [first, second] = await Promise.all([
      reserve("b", { takeover: { requestId: "a", estimate } }),
      reserve("c", { takeover: { requestId: "a", estimate } }),
    ]);
    expect(first.outcome).toBe("reserved");
    expect(second).toMatchObject({ outcome: "in_progress", request: { id: "b", attempt: 2 } });
  });

  it("reads the newest attempt of a key and refuses once the attempts are used", async () => {
    const { ledger, reserve, advance } = await setup();
    await reserve("a");
    advance(LEASE_MS + 1);
    await reserve("b", { takeover: { requestId: "a", estimate }, maxAttempts: 2 });
    advance(LEASE_MS + 1);
    expect(await reserve("c", { maxAttempts: 2 })).toMatchObject({
      outcome: "attempts_exhausted",
      request: { id: "b", attempt: 2 },
    });
    expect(await ledger.getRequest("c")).toBeNull();
    // A cap of 3 would still have let it through to the next takeover.
    expect((await reserve("c", { maxAttempts: 3 })).outcome).toBe("orphaned");
  });

  it("keeps answering duplicate for completed, live-uncertain, unleased and different-body requests", async () => {
    const { ledger, reserve, advance } = await setup();
    const duplicateOf = async (id: string, extra: Parameters<typeof reserve>[1] = {}) => {
      const result = await reserve(`retry-${id}`, { requestKey: id, ...extra });
      return result.outcome === "duplicate" ? result.request.id : result.outcome;
    };
    await reserve("completed", { requestKey: "completed" });
    await ledger.complete("completed", usage, 0.01, 200);
    await reserve("uncertain", { requestKey: "uncertain" });
    await ledger.markUncertain("uncertain", 502, estimate);
    await reserve("released", { requestKey: "released" });
    await ledger.release("released", 500);
    await reserve("released-body", { requestKey: "released-body" });
    await ledger.release("released-body", 500);
    await reserve("unleased", { requestKey: "unleased" }, {});
    await reserve("body", { requestKey: "body" });
    advance(24 * 60 * 60_000 - 1);

    expect(await duplicateOf("completed")).toBe("completed");
    expect(await duplicateOf("uncertain")).toBe("uncertain");
    expect(await duplicateOf("unleased")).toBe("unleased");
    expect(await duplicateOf("body", { requestFingerprint: "another body" })).toBe("body");
    // A released row is tried again only with the same body, and only when the caller sets a cap.
    expect(await duplicateOf("released-body", { requestFingerprint: "another body" })).toBe("released-body");
    expect(await duplicateOf("released", { maxAttempts: undefined })).toBe("released");
    expect(await reserve("retry-released", { requestKey: "released" })).toMatchObject({
      outcome: "reserved",
      request: { id: "retry-released", attempt: 2 },
    });
  });

  it("holds nothing for a released attempt: its retry fits a budget with room for one hold", async () => {
    // Holds of 0.2 against 0.3: a second live hold would not fit.
    const { ledger, reserve } = await setup(0.3);
    await reserve("a");
    expect((await reserve("other", { requestKey: "other" })).outcome).toBe("budget_exhausted");
    await ledger.release("a", 429);
    const retry = await reserve("b");
    expect(retry).toMatchObject({ outcome: "reserved", request: { id: "b", attempt: 2 } });
    expect(await ledger.getRequest("a")).toMatchObject({ status: "released", attempt: 1 });
  });

  it("never takes a row over when the caller sets no attempt cap", async () => {
    const { reserve, advance } = await setup();
    await reserve("a");
    advance(LEASE_MS + 1);
    expect(await reserve("b", { maxAttempts: undefined })).toMatchObject({
      outcome: "duplicate",
      request: { id: "a" },
    });
  });
});

describe("MemoryProxyLedger MCP sessions", () => {
  const pin = {
    exposedName: "docs__search",
    toolName: "search",
    serverId: "server-1",
    serverName: "docs",
    definition: { description: "Search docs", inputSchema: { type: "object" } },
  };
  const base = {
    credentialRef: "openai/test",
    protocol: "openai-responses" as const,
    allowedModels: ["m"],
    deadlineAt: new Date(Date.now() + 60_000),
    budgetUsd: 1,
  };

  it("finds a session with pinned MCP tools by its MCP token hash", async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      ...base,
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      registryTokenHash: "registry-hash",
      mcpTools: [pin],
      mcpTokenHash: "mcp-hash",
    });
    const found = await ledger.findSessionByMcpTokenHash("mcp-hash");
    expect(found).toMatchObject({ id: "s1", mcpTools: [pin], mcpTokenHash: "mcp-hash", mcpCallCount: 0 });
    expect(await ledger.findSessionByMcpTokenHash("other")).toBeUndefined();
    // A copy: changing it changes nothing stored.
    found!.mcpTools![0].exposedName = "changed";
    expect((await ledger.findSessionByMcpTokenHash("mcp-hash"))?.mcpTools?.[0]?.exposedName).toBe("docs__search");
  });

  it("finds a session by its tunnel token hash, as a copy, and not by any other hash", async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      ...base,
      id: "t1",
      runId: "rt1",
      capabilityHash: "cap-t1",
      registryTokenHash: "registry-t1",
      tunnelTokenHash: "tunnel-t1",
    });
    const found = await ledger.findSessionByTunnelTokenHash("tunnel-t1");
    expect(found).toMatchObject({ id: "t1", runId: "rt1", status: "active", tunnelTokenHash: "tunnel-t1" });
    expect(await ledger.findSessionByTunnelTokenHash("registry-t1")).toBeUndefined();
    expect(await ledger.findSessionByTunnelTokenHash("cap-t1")).toBeUndefined();
    found!.runId = "changed";
    expect((await ledger.findSessionByTunnelTokenHash("tunnel-t1"))?.runId).toBe("rt1");
  });

  it("refuses a second session with the same tunnel token hash, and allows sessions without one", async () => {
    const ledger = new MemoryProxyLedger();
    const session = { ...base, tunnelTokenHash: "same-tunnel" };
    await ledger.createSession({ ...session, id: "a", runId: "ra", capabilityHash: "ha", registryTokenHash: "ga" });
    await expect(
      ledger.createSession({ ...session, id: "b", runId: "rb", capabilityHash: "hb", registryTokenHash: "gb" }),
    ).rejects.toThrow("proxy_tunnel_token_collision");
    await ledger.createSession({ ...base, id: "c", runId: "rc", capabilityHash: "hc", registryTokenHash: "gc" });
    await ledger.createSession({ ...base, id: "d", runId: "rd", capabilityHash: "hd", registryTokenHash: "gd" });
  });

  it("reports a run's session active until it is cancelled or its deadline passes, on the ledger's clock", async () => {
    let now = new Date("2026-01-01T00:00:00Z");
    const ledger = new MemoryProxyLedger({ now: () => now });
    await ledger.createSession({
      ...base,
      id: "act",
      runId: "run-act",
      capabilityHash: "cap-act",
      registryTokenHash: "registry-act",
      deadlineAt: new Date("2026-01-01T00:10:00Z"),
    });
    expect(await ledger.sessionActiveForRun("run-act")).toBe(true);
    expect(await ledger.sessionActiveForRun("missing")).toBe(false);
    now = new Date("2026-01-01T00:10:00Z");
    expect(await ledger.sessionActiveForRun("run-act")).toBe(false);
    now = new Date("2026-01-01T00:05:00Z");
    expect(await ledger.sessionActiveForRun("run-act")).toBe(true);
    await ledger.cancelSession("act");
    expect(await ledger.sessionActiveForRun("run-act")).toBe(false);
  });

  it("gives a session without MCP tools no pins, no hash and no calls", async () => {
    const ledger = new MemoryProxyLedger();
    await ledger.createSession({
      ...base,
      id: "s2",
      runId: "r2",
      capabilityHash: "hash-2",
      registryTokenHash: "registry-hash-2",
    });
    expect(await ledger.findSessionByCapabilityHash("hash-2")).toMatchObject({
      mcpTools: null,
      mcpTokenHash: null,
      mcpCallCount: 0,
    });
  });

  it("refuses a second session with the same MCP token hash", async () => {
    const ledger = new MemoryProxyLedger();
    const session = { ...base, mcpTools: [pin], mcpTokenHash: "same" };
    await ledger.createSession({ ...session, id: "a", runId: "ra", capabilityHash: "ha", registryTokenHash: "ga" });
    await expect(
      ledger.createSession({ ...session, id: "b", runId: "rb", capabilityHash: "hb", registryTokenHash: "gb" }),
    ).rejects.toThrow("proxy_mcp_token_collision");
  });
});

describe("MemoryProxyLedger pinned tools", () => {
  it("holds a native pin as listed: name, description and schema, never its pinned code or grants", async () => {
    const ledger = new MemoryProxyLedger();
    const definition = { description: "Search code", inputSchema: { type: "object" } };
    await ledger.createSession({
      id: "s1",
      runId: "r1",
      capabilityHash: "hash",
      credentialRef: "anthropic/test",
      protocol: "anthropic-messages",
      allowedModels: ["m"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
      registryTokenHash: "registry-hash",
      mcpTokenHash: "mcp-hash",
      mcpTools: [
        {
          kind: "native",
          exposedName: "code_search",
          toolId: "tool-1",
          toolName: "code_search",
          definition,
          pinned: {
            code: 'return await secrets.get("API_KEY");',
            paramsZod: "z.object({})",
            grants: {
              allowedSecrets: ["API_KEY"],
              allowedDatastorePrefixes: [],
              allowedHosts: [],
              allowedSharedDatastorePrefixes: {},
            },
          },
        },
      ],
    });
    const session = await ledger.findSessionByCapabilityHash("hash");
    expect(session?.mcpTools).toEqual([
      { kind: "native", exposedName: "code_search", toolId: "tool-1", toolName: "code_search", definition },
    ]);
  });
});

describe("retry after an upstream rejection", () => {
  it("gives a released request's identical retry the next attempt, up to maxAttempts, and refuses a different body", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const ledger = new MemoryProxyLedger({ now: () => now });
    await ledger.createSession({
      id: "s",
      runId: "r",
      capabilityHash: "c",
      credentialRef: "env:GEMINI_API_KEY",
      protocol: "gemini-generate-content",
      allowedModels: ["m"],
      deadlineAt: new Date(now.getTime() + 60_000),
      budgetUsd: 10,
      registryTokenHash: "g",
    });
    const reserve = (id: string, fingerprint = "f") =>
      ledger.reserve({
        id,
        sessionId: "s",
        requestKey: "body:f",
        requestFingerprint: fingerprint,
        model: "m",
        reservationUsd: 0.01,
        pricing: { version: "v", encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 },
        now,
        maxAttempts: 3,
      });
    const first = await reserve("a");
    expect(first).toMatchObject({ outcome: "reserved", request: { attempt: 1 } });
    await ledger.release("a", 429);
    expect(await reserve("x", "other")).toMatchObject({ outcome: "duplicate" });
    const second = await reserve("b");
    expect(second).toMatchObject({ outcome: "reserved", request: { attempt: 2 } });
    expect("tookOver" in second && second.tookOver).toBeFalsy();
    await ledger.release("b", 503);
    expect(await reserve("c")).toMatchObject({ outcome: "reserved", request: { attempt: 3 } });
    await ledger.release("c", 503);
    expect(await reserve("d")).toMatchObject({ outcome: "attempts_exhausted" });
  });

  it("gives two concurrent identical retries of a released request exactly one new attempt", async () => {
    const now = new Date("2026-11-26T12:00:00Z");
    const ledger = new MemoryProxyLedger({ now: () => now });
    await ledger.createSession({
      id: "s",
      runId: "r",
      capabilityHash: "c",
      credentialRef: "env:GEMINI_API_KEY",
      protocol: "gemini-generate-content",
      allowedModels: ["m"],
      deadlineAt: new Date(now.getTime() + 60_000),
      budgetUsd: 10,
      registryTokenHash: "g",
    });
    const reserve = (id: string) =>
      ledger.reserve({
        id,
        sessionId: "s",
        requestKey: "body:f",
        requestFingerprint: "f",
        model: "m",
        reservationUsd: 0.01,
        pricing: { version: "v", encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 },
        now,
        maxAttempts: 3,
        ownerId: "owner",
        leaseMs: 30_000,
      });
    await reserve("a");
    await ledger.release("a", 429);
    const results = await Promise.all([reserve("b"), reserve("c")]);
    expect(results.filter((result) => result.outcome === "reserved")).toHaveLength(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(["in_progress", "reserved"]);
  });
});
