import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../../core/db.js";
import { authCommand } from "./cli.js";

describe.skipIf(!process.env.DATABASE_URL)("auth user --name (database)", () => {
  const db = createPrismaClient();
  const hashKey = randomBytes(32).toString("hex");
  const subjects: string[] = [];
  afterAll(async () => {
    await db.authUser.deleteMany({ where: { principal: { subject: { in: subjects } } } });
    await db.principal.deleteMany({ where: { subject: { in: subjects } } });
    await db.$disconnect();
  });
  async function cli(...args: string[]): Promise<string> {
    const lines: string[] = [];
    await authCommand(args, db, hashKey, (s) => lines.push(s));
    return lines.join("\n");
  }
  const lookup = (subject: string) =>
    db.principal.findUniqueOrThrow({
      where: { subject },
      include: { profile: true, authUser: { select: { displayName: true } } },
    });

  it("user create --name sets AuthUser.displayName and the profile", async () => {
    const subject = "name-create-" + randomUUID();
    subjects.push(subject);
    await cli("user", "create", "--subject", subject, "--name", "  Ana Ruiz ");
    const p = await lookup(subject);
    expect(p.authUser?.displayName).toBe("Ana Ruiz");
    expect(p.profile).toMatchObject({ displayName: "Ana Ruiz", source: "operator" });
  });

  it("user create without --name writes no profile", async () => {
    const subject = "name-none-" + randomUUID();
    subjects.push(subject);
    await cli("user", "create", "--subject", subject);
    expect((await lookup(subject)).profile).toBeNull();
  });

  it("user name changes an existing user and rejects unknown or blank input", async () => {
    const subject = "name-update-" + randomUUID();
    subjects.push(subject);
    await cli("user", "create", "--subject", subject, "--name", "Old");
    await cli("user", "name", "--subject", subject, "--name", "Ana R.");
    const p = await lookup(subject);
    expect(p.authUser?.displayName).toBe("Ana R.");
    expect(p.profile?.displayName).toBe("Ana R.");
    await expect(cli("user", "name", "--subject", subject)).rejects.toThrow(/--name/);
    await expect(cli("user", "name", "--subject", subject, "--name", "   ")).rejects.toThrow(/--name/);
    await expect(cli("user", "name", "--subject", "ghost-" + randomUUID(), "--name", "X")).rejects.toThrow(
      /Unknown user/,
    );
    await expect(cli("key", "create", "--subject", subject, "--name", "X")).rejects.toThrow(/--name/);
  });
});
