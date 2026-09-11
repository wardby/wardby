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
  it("two agents resolve the same boundName to distinct secrets via SQL", async () => {
    const a = "bn-a-" + randomUUID();
    const b = "bn-b-" + randomUUID();
    const sa = "bn-sa-" + randomUUID();
    const sb = "bn-sb-" + randomUUID();
    const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
    try {
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1 } });
      await db.agent.create({ data: { id: b, name: b, systemPrompt: "t", model: "t", budgetUsd: 1 } });
      await db.secret.create({ data: { id: sa, name: sa, ciphertext: "token-a", keyId: "test" } });
      await db.secret.create({ data: { id: sb, name: sb, ciphertext: "token-b", keyId: "test" } });
      await db.agentSecret.create({ data: { agentId: a, secretId: sa, boundName: "bitbucket" } });
      await db.agentSecret.create({ data: { agentId: b, secretId: sb, boundName: "bitbucket" } });

      expect(await buildSecretsAccessor(a, cipher, db).get("bitbucket")).toBe("token-a");
      expect(await buildSecretsAccessor(b, cipher, db).get("bitbucket")).toBe("token-b");
    } finally {
      await db.agentSecret.deleteMany({ where: { agentId: { in: [a, b] } } });
      await db.secret.deleteMany({ where: { id: { in: [sa, sb] } } });
      await db.agent.deleteMany({ where: { id: { in: [a, b] } } });
    }
  });
});
