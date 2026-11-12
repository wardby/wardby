import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { sweepExpiredDocumentRows } from "./sweep.js";

describe.skipIf(!process.env.DATABASE_URL)("expired document rows sweep (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  let p: Principal;
  beforeAll(async () => {
    p = await db.principal.create({ data: { subject: `sweep-${s}` } });
  });
  afterAll(async () => {
    await db.webSession.deleteMany({ where: { principalId: p.id } });
    await db.authRateLimit.deleteMany({ where: { key: { startsWith: `sweep-${s}` } } });
    await db.principal.deleteMany({ where: { id: p.id } });
    await db.$disconnect();
  });

  it("deletes expired web sessions and rate-limit windows, and keeps live ones", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1000);
    const future = new Date(now.getTime() + 60_000);
    const session = (tag: string, expiresAt: Date) =>
      db.webSession.create({
        data: { tokenHash: `${tag}-${s}`, csrfHash: "x", principalId: p.id, expiresAt },
      });
    const dead = await session("dead", past);
    const live = await session("live", future);
    await db.authRateLimit.create({ data: { key: `sweep-${s}-dead`, hits: 1, expiresAt: past } });
    await db.authRateLimit.create({ data: { key: `sweep-${s}-live`, hits: 1, expiresAt: future } });

    const out = await sweepExpiredDocumentRows(db, now);
    expect(out.webSessions).toBeGreaterThanOrEqual(1);
    expect(out.rateLimits).toBeGreaterThanOrEqual(1);
    expect(await db.webSession.findUnique({ where: { id: dead.id } })).toBeNull();
    expect(await db.webSession.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(await db.authRateLimit.findUnique({ where: { key: `sweep-${s}-dead` } })).toBeNull();
    expect(await db.authRateLimit.findUnique({ where: { key: `sweep-${s}-live` } })).not.toBeNull();
  });
});
