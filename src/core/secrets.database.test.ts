import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildSecretsAccessor } from "./secrets.js";
describe.skipIf(!process.env.DATABASE_URL)("bounded legacy secret reads (database)", () => {
  const db = new PrismaClient();
  const id = "secret-bound-" + randomUUID();
  afterAll(async () => {
    await db.agentSecret.deleteMany({ where: { agentId: id } });
    await db.secret.deleteMany({ where: { id } });
    await db.agent.deleteMany({ where: { id } });
    await db.$disconnect();
  });
  it("rejects oversized ciphertext before decryption", async () => {
    await db.agent.create({ data: { id, name: id, systemPrompt: "test", model: "test", budgetUsd: 1 } });
    await db.secret.create({ data: { id, name: "legacy", ciphertext: "x".repeat(262145), keyId: "test" } });
    await db.agentSecret.create({ data: { agentId: id, secretId: id, boundName: "legacy" } });
    let decrypted = false;
    const cipher = {
      keyId: () => "test",
      encrypt: async (s: string) => s,
      decrypt: async (s: string) => {
        decrypted = true;
        return s;
      },
    };
    await expect(buildSecretsAccessor(id, cipher, db).get("legacy")).rejects.toThrow("secret_value_limit");
    expect(decrypted).toBe(false);
  });
});
