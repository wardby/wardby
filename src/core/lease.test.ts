import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import { releaseLease, tryAcquireLease } from "./lease.js";

// The lease's whole point is atomic conditional-write semantics under
// concurrency (Postgres's ON CONFLICT ... WHERE) — not faithfully fakeable,
// so this runs against a real local Postgres and is skipped without
// DATABASE_URL (same pattern as the OpenAI contract test).
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "[wardby tests] DATABASE_URL not set — skipping the lease acquire/renew/refuse/" +
      "expire tests (atomic INSERT ... ON CONFLICT ... WHERE). This is one of the " +
      "highest-risk pieces of Phase 2 (leader election); set DATABASE_URL before " +
      "trusting a scheduler change based on a green run that skipped it.",
  );
}

describe.skipIf(!databaseUrl)("tryAcquireLease (database)", () => {
  const db = createPrismaClient();
  const usedScopes: string[] = [];

  function newScope(): string {
    const scope = `lease-test-${randomUUID()}`;
    usedScopes.push(scope);
    return scope;
  }

  afterAll(async () => {
    await db.schedulerLease.deleteMany({ where: { scope: { in: usedScopes } } });
    await db.$disconnect();
  });

  it("acquires a lease that's never existed", async () => {
    const scope = newScope();
    const acquired = await tryAcquireLease(db, scope, "holder-a", 30_000);
    expect(acquired).toBe(true);
  });

  it("renews when the current holder re-acquires before expiry", async () => {
    const scope = newScope();
    await tryAcquireLease(db, scope, "holder-a", 30_000);

    const renewed = await tryAcquireLease(db, scope, "holder-a", 30_000);
    expect(renewed).toBe(true);
  });

  it("refuses a different holder while the lease is unexpired", async () => {
    const scope = newScope();
    await tryAcquireLease(db, scope, "holder-a", 30_000);

    const stolen = await tryAcquireLease(db, scope, "holder-b", 30_000);
    expect(stolen).toBe(false);

    const lease = await db.schedulerLease.findUnique({ where: { scope } });
    expect(lease?.holder).toBe("holder-a");
  });

  it("allows a different holder to acquire once the lease has expired", async () => {
    const scope = newScope();
    // Acquire with a negative TTL so it's already expired.
    await tryAcquireLease(db, scope, "holder-a", -1_000);

    const takeover = await tryAcquireLease(db, scope, "holder-b", 30_000);
    expect(takeover).toBe(true);

    const lease = await db.schedulerLease.findUnique({ where: { scope } });
    expect(lease?.holder).toBe("holder-b");
  });

  it("hands the lease over at once when its holder releases it", async () => {
    const scope = newScope();
    await tryAcquireLease(db, scope, "holder-a", 30_000);
    expect(await tryAcquireLease(db, scope, "holder-b", 30_000)).toBe(false);

    expect(await releaseLease(db, scope, "holder-a")).toBe(true);

    expect(await tryAcquireLease(db, scope, "holder-b", 30_000)).toBe(true);
    const lease = await db.schedulerLease.findUnique({ where: { scope } });
    expect(lease?.holder).toBe("holder-b");
  });

  it("releases only a lease the caller still holds", async () => {
    const scope = newScope();
    await tryAcquireLease(db, scope, "holder-a", -1_000);
    await tryAcquireLease(db, scope, "holder-b", 30_000);

    expect(await releaseLease(db, scope, "holder-a")).toBe(false);

    const lease = await db.schedulerLease.findUnique({ where: { scope } });
    expect(lease?.holder).toBe("holder-b");
  });

  it("releasing a lease that was never taken is a no-op", async () => {
    expect(await releaseLease(db, newScope(), "holder-a")).toBe(false);
  });

  it("stamps expiresAt from the database clock, whatever the process clock says", async () => {
    const scope = newScope();
    vi.useFakeTimers({ now: new Date("2001-01-01T00:00:00Z"), toFake: ["Date"] });
    try {
      await tryAcquireLease(db, scope, "holder-a", 30_000);
    } finally {
      vi.useRealTimers();
    }
    const lease = await db.schedulerLease.findUnique({ where: { scope } });
    const untilExpiry = lease!.expiresAt.getTime() - Date.now();
    expect(untilExpiry).toBeGreaterThan(20_000);
    expect(untilExpiry).toBeLessThanOrEqual(30_000);
  });
});
