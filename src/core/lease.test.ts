import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { tryAcquireLease } from "./lease.js";

// The lease's whole point is atomic conditional-write semantics under
// concurrency (Postgres's ON CONFLICT ... WHERE) — not faithfully fakeable,
// so this runs against a real local Postgres and is skipped without
// DATABASE_URL (same pattern as the OpenAI contract test).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("tryAcquireLease (database)", () => {
  const db = new PrismaClient();
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
});
