import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { profileNames, upsertProfile } from "./profiles.js";

describe.skipIf(!process.env.DATABASE_URL)("principal profiles (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  let a: Principal;
  let b: Principal;
  beforeAll(async () => {
    a = await db.principal.create({ data: { subject: `prof-a-${s}` } });
    b = await db.principal.create({ data: { subject: `prof-b-${s}` } });
  });
  afterAll(async () => {
    await db.principal.deleteMany({ where: { id: { in: [a.id, b.id] } } });
    await db.$disconnect();
  });

  it("upsert keeps the newest values, including source", async () => {
    await upsertProfile(db, a.id, { displayName: "Old Name", email: "old@example.com", source: "oidc" });
    await upsertProfile(db, a.id, { displayName: "New Name", email: "new@example.com", source: "operator" });
    const row = await db.principalProfile.findUniqueOrThrow({ where: { principalId: a.id } });
    expect(row).toMatchObject({ displayName: "New Name", email: "new@example.com", source: "operator" });
  });

  it("a field left undefined keeps the stored value", async () => {
    await upsertProfile(db, a.id, { email: "kept@example.com", source: "self-hosted" });
    const row = await db.principalProfile.findUniqueOrThrow({ where: { principalId: a.id } });
    expect(row).toMatchObject({ displayName: "New Name", email: "kept@example.com", source: "self-hosted" });
  });

  it("profileNames never returns email and skips blank names", async () => {
    await upsertProfile(db, b.id, { displayName: "   ", email: "b@example.com", source: "oidc" });
    const names = await profileNames(db, [a.id, b.id, a.id]);
    expect([...names.entries()]).toEqual([[a.id, "New Name"]]);
    expect(JSON.stringify([...names])).not.toContain("@example.com");
  });

  it("trims names and caps them at 80 characters", async () => {
    await upsertProfile(db, b.id, { displayName: `  ${"x".repeat(120)}  `, source: "oidc" });
    expect((await profileNames(db, [b.id])).get(b.id)).toBe("x".repeat(80));
  });

  it("an empty id list returns an empty map", async () => {
    expect((await profileNames(db, [])).size).toBe(0);
  });
});
