import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { resolvePrincipal } from "./principal.js";

// Find-or-create semantics rely on a real unique-constraint upsert
// (Principal.subject) — run against a real local Postgres, skipped without
// DATABASE_URL (same pattern as lease.test.ts / Phase 2).
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "[reevo-run tests] DATABASE_URL not set — skipping resolvePrincipal find-or-create tests " +
      "(Principal.subject upsert). Set DATABASE_URL before trusting an auth change based on a " +
      "green run that skipped it.",
  );
}

describe.skipIf(!databaseUrl)("resolvePrincipal (database)", () => {
  const db = new PrismaClient();
  const usedSubjects: string[] = [];

  function newSubject(): string {
    const subject = `principal-test-${randomUUID()}`;
    usedSubjects.push(subject);
    return subject;
  }

  afterAll(async () => {
    await db.principal.deleteMany({ where: { subject: { in: usedSubjects } } });
    await db.$disconnect();
  });

  it("creates a Principal on first sight", async () => {
    const subject = newSubject();
    const principal = await resolvePrincipal(subject, db);
    expect(principal.subject).toBe(subject);
    expect(principal.id).toBeTruthy();
  });

  it("returns the same row on repeat", async () => {
    const subject = newSubject();
    const first = await resolvePrincipal(subject, db);
    const second = await resolvePrincipal(subject, db);
    expect(second.id).toBe(first.id);
  });
});
