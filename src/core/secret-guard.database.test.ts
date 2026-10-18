import { createPrismaClient } from "./db.js";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { attachSecret, createSecret } from "./secrets.js";
import { loadAgentSecretValues, secretNamesIn } from "./secret-guard.js";

describe.skipIf(!process.env.DATABASE_URL)("loadAgentSecretValues (database)", () => {
  const db = createPrismaClient();
  const owner = "sg-owner-" + randomUUID();
  const agent = "sg-agent-" + randomUUID();
  const bare = "sg-bare-" + randomUUID();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const broker = {
    hosts: ["api.example.com"],
    placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
  };
  afterAll(async () => {
    await db.agentSecret.deleteMany({ where: { agentId: { in: [agent, bare] } } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: owner } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: { in: [agent, bare] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("returns readable and brokered secrets with their values; none attached gives []", async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const id of [agent, bare]) {
      await db.agent.create({
        data: { id, name: id, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
      });
    }
    await createSecret("API_KEY", "fake-secret-value-1234", owner, cipher, db);
    await createSecret("BROKERED_KEY", "fake-brokered-value-5678", owner, cipher, db, { broker });
    await attachSecret(agent, "API_KEY", owner, db);
    await attachSecret(agent, "BROKERED_KEY", owner, db);

    const named = await loadAgentSecretValues(db, cipher, agent);
    expect(named.map((n) => n.name).sort()).toEqual(["API_KEY", "BROKERED_KEY"]);
    expect(named.find((n) => n.name === "API_KEY")?.values).toContain("fake-secret-value-1234");
    expect(named.find((n) => n.name === "BROKERED_KEY")?.values).toContain("fake-brokered-value-5678");
    expect(secretNamesIn("x fake-brokered-value-5678", named)).toEqual(["BROKERED_KEY"]);

    expect(await loadAgentSecretValues(db, cipher, bare)).toEqual([]);
  });
});
