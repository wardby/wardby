import { createPrismaClient } from "./db.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { attachSecret, buildSecretsAccessor, createSecret, listSecrets, setSecretBroker } from "./secrets.js";
describe.skipIf(!process.env.DATABASE_URL)("bounded legacy secret reads (database)", () => {
  const db = createPrismaClient();
  const id = "secret-bound-" + randomUUID();
  afterAll(async () => {
    await db.agentSecret.deleteMany({ where: { agentId: id } });
    await db.secret.deleteMany({ where: { id } });
    await db.agent.deleteMany({ where: { id } });
    await db.principal.deleteMany({ where: { id } });
    await db.$disconnect();
  });
  it("rejects oversized ciphertext before decryption", async () => {
    await db.principal.create({ data: { id, subject: id } });
    await db.agent.create({ data: { id, name: id, systemPrompt: "test", model: "test", budgetUsd: 1, ownerId: id } });
    await db.secret.create({
      data: { id, name: "legacy", ciphertext: "x".repeat(262145), keyId: "test", ownerId: id },
    });
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
    const owner = "bn-owner-" + randomUUID();
    const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
    try {
      await db.principal.create({ data: { id: owner, subject: owner } });
      await db.agent.create({ data: { id: a, name: a, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner } });
      await db.agent.create({ data: { id: b, name: b, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner } });
      await db.secret.create({ data: { id: sa, name: sa, ciphertext: "token-a", keyId: "test", ownerId: owner } });
      await db.secret.create({ data: { id: sb, name: sb, ciphertext: "token-b", keyId: "test", ownerId: owner } });
      await db.agentSecret.create({ data: { agentId: a, secretId: sa, boundName: "bitbucket" } });
      await db.agentSecret.create({ data: { agentId: b, secretId: sb, boundName: "bitbucket" } });

      expect(await buildSecretsAccessor(a, cipher, db).get("bitbucket")).toBe("token-a");
      expect(await buildSecretsAccessor(b, cipher, db).get("bitbucket")).toBe("token-b");
    } finally {
      await db.agentSecret.deleteMany({ where: { agentId: { in: [a, b] } } });
      await db.secret.deleteMany({ where: { id: { in: [sa, sb] } } });
      await db.agent.deleteMany({ where: { id: { in: [a, b] } } });
      await db.principal.deleteMany({ where: { id: owner } });
    }
  });

  it("A2/S2-2: cross-owner binding is inert at run time (SQL)", async () => {
    const owner = "x-owner-" + randomUUID();
    const other = "x-other-" + randomUUID();
    const agent = "x-agent-" + randomUUID();
    const ownerless = "x-ownerless-" + randomUUID();
    const own = "x-own-" + randomUUID();
    const foreign = "x-foreign-" + randomUUID();
    const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
    try {
      await db.principal.createMany({
        data: [
          { id: owner, subject: owner },
          { id: other, subject: other },
        ],
      });
      await db.agent.create({
        data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
      });
      await db.agent.create({ data: { id: ownerless, name: ownerless, systemPrompt: "t", model: "t", budgetUsd: 1 } });
      await db.secret.create({ data: { id: own, name: own, ciphertext: "own", keyId: "test", ownerId: owner } });
      await db.secret.create({
        data: { id: foreign, name: foreign, ciphertext: "foreign", keyId: "test", ownerId: other },
      });
      await db.agentSecret.createMany({
        data: [
          { agentId: agent, secretId: own, boundName: "OWN" },
          { agentId: agent, secretId: foreign, boundName: "FOREIGN" },
          { agentId: ownerless, secretId: own, boundName: "OWN" },
        ],
      });

      const accessor = buildSecretsAccessor(agent, cipher, db);
      expect(await accessor.get("OWN")).toBe("own");
      expect(await accessor.get("FOREIGN")).toBeUndefined();
      expect(await buildSecretsAccessor(ownerless, cipher, db).get("OWN")).toBeUndefined();
    } finally {
      await db.agentSecret.deleteMany({ where: { agentId: { in: [agent, ownerless] } } });
      await db.secret.deleteMany({ where: { id: { in: [own, foreign] } } });
      await db.agent.deleteMany({ where: { id: { in: [agent, ownerless] } } });
      await db.principal.deleteMany({ where: { id: { in: [owner, other] } } });
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("brokered secrets (database)", () => {
  const db = createPrismaClient();
  const owner = "brk-owner-" + randomUUID();
  const agent = "brk-agent-" + randomUUID();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const broker = {
    hosts: ["api.example.com"],
    placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
  };
  afterAll(async () => {
    await db.agentSecret.deleteMany({ where: { agentId: agent } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: owner } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: agent } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("creates brokered, audits, hides from get, exposes via resolve, lists config", async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agent, name: agent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
    });
    await createSecret("GH", "ghp_abcdef123", owner, cipher, db, { broker, via: "mcp" });
    await attachSecret(agent, "GH", owner, db);
    const accessor = buildSecretsAccessor(agent, cipher, db);
    await expect(accessor.get("GH")).rejects.toThrow("secret_brokered");
    expect(await accessor.resolve!("GH")).toEqual({ value: "ghp_abcdef123", broker });
    expect((await listSecrets(owner, db)).find((s) => s.name === "GH")?.broker).toEqual(broker);
    const rows = await db.secretBrokerChange.findMany({ where: { ownerId: owner } });
    expect(rows).toMatchObject([{ secretName: "GH", actorId: owner, before: null, after: broker, via: "mcp" }]);
  });

  it("refuses to create a brokered secret with an unscrubbable value", async () => {
    await expect(createSecret("SHORT", "abc", owner, cipher, db, { broker })).rejects.toThrow(
      "secret_broker_value_invalid",
    );
    expect(await db.secret.findUnique({ where: { ownerId_name: { ownerId: owner, name: "SHORT" } } })).toBeNull();
  });

  it("set, change, and remove each write one audit row; unchanged writes none", async () => {
    await createSecret("K", "plain-value-1", owner, cipher, db);
    await setSecretBroker(db, cipher, { ownerId: owner, name: "K", broker, actorId: owner, via: "mcp" });
    await setSecretBroker(db, cipher, { ownerId: owner, name: "K", broker, actorId: owner, via: "mcp" });
    const changed = { ...broker, pathPrefixes: ["/repos/"] };
    await setSecretBroker(db, cipher, { ownerId: owner, name: "K", broker: changed, actorId: owner, via: "mcp" });
    const result = await setSecretBroker(db, cipher, {
      ownerId: owner,
      name: "K",
      broker: null,
      actorId: owner,
      via: "browser",
    });
    expect(result).toEqual({ before: changed, after: null });
    // SQL NULL, not a JSON null: "unbrokered" has one representation in the column.
    const [{ unset }] = await db.$queryRaw<{ unset: boolean }[]>`
      SELECT "broker" IS NULL AS "unset" FROM "Secret" WHERE "ownerId" = ${owner} AND "name" = 'K'`;
    expect(unset).toBe(true);
    const rows = await db.secretBrokerChange.findMany({
      where: { ownerId: owner, secretName: "K" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.before, r.after, r.via])).toEqual([
      [null, broker, "mcp"],
      [broker, changed, "mcp"],
      [changed, null, "browser"],
    ]);
    const accessor = buildSecretsAccessor(agent, cipher, db);
    await attachSecret(agent, "K", owner, db);
    expect(await accessor.get("K")).toBe("plain-value-1");
  });

  it("set on a missing secret throws secret_not_found", async () => {
    await expect(
      setSecretBroker(db, cipher, { ownerId: owner, name: "NOPE", broker, actorId: owner, via: "mcp" }),
    ).rejects.toThrow("secret_not_found");
  });
});
