import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { hostAccountCommand } from "./host-account-cli.js";

const db = createPrismaClient();
const principalIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("wardby auth host-account (PostgreSQL)", () => {
  afterAll(async () => {
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("lists and unlinks a principal's host identity by subject, in either auth mode", async () => {
    const subject = `cli-${randomUUID()}`;
    const other = `cli-${randomUUID()}`;
    const p = await db.principal.create({ data: { subject } });
    const q = await db.principal.create({ data: { subject: other } });
    principalIds.push(p.id, q.id);
    await db.hostIdentity.create({
      data: { principalId: p.id, provider: "github", hostUserId: `${Date.now()}7`, login: "octo" },
    });
    await db.hostIdentity.create({
      data: { principalId: q.id, provider: "github", hostUserId: `${Date.now()}8`, login: "other" },
    });

    const lines: string[] = [];
    await hostAccountCommand(["list", "--subject", subject], db, (v) => lines.push(v));
    expect(JSON.parse(lines[0])).toEqual([expect.objectContaining({ subject, provider: "github", login: "octo" })]);

    lines.length = 0;
    await hostAccountCommand(["list"], db, (v) => lines.push(v));
    const all = JSON.parse(lines[0]) as Array<{ subject: string }>;
    expect(all.map((r) => r.subject)).toEqual(expect.arrayContaining([subject, other]));

    await hostAccountCommand(["unlink", "--subject", subject], db, (v) => lines.push(v));
    expect(await db.hostIdentity.count({ where: { principalId: p.id } })).toBe(0);
    expect(await db.hostIdentity.count({ where: { principalId: q.id } })).toBe(1);

    await expect(hostAccountCommand(["unlink"], db, () => undefined)).rejects.toThrow(/--subject/);
    await expect(hostAccountCommand(["unlink", "--subject", "nobody-here"], db, () => undefined)).rejects.toThrow(
      /No principal/,
    );
    await expect(hostAccountCommand(["frobnicate"], db, () => undefined)).rejects.toThrow(/host-account list/);
    await expect(hostAccountCommand(["list", "--role", "x"], db, () => undefined)).rejects.toThrow();
  });
});
