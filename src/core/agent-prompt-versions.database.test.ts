import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { listPromptVersions, recordPromptVersion, restorePromptVersion } from "./agent-prompt-versions.js";

describe.skipIf(!process.env.DATABASE_URL)("agent prompt versions (database)", () => {
  const db = createPrismaClient();
  const ids: string[] = [];

  async function agent(prompt = "one") {
    const a = await db.agent.create({
      data: { name: `apv-${randomUUID()}`, systemPrompt: prompt, model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    ids.push(a.id);
    return a;
  }
  const numbers = async (agentId: string) => (await listPromptVersions(db, agentId)).map((v) => v.number);

  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it("records v1, skips the same text, and increments on a change", async () => {
    const a = await agent();
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "one", via: "create" });
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "one", via: "update" });
    expect(await numbers(a.id)).toEqual([1]);
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "two", via: "update", summary: "s" });
    const list = await listPromptVersions(db, a.id);
    expect(list.map((v) => v.number)).toEqual([2, 1]);
    expect(list[0]).toMatchObject({ summary: "s", via: "update", chars: 3 });
    expect(list[0]).not.toHaveProperty("systemPrompt");
  });

  it("never reuses a number under concurrent records", async () => {
    const a = await agent();
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "one", via: "create" });
    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map((t) => recordPromptVersion(db, { agentId: a.id, systemPrompt: t, via: "update" })),
    );
    const rows = await numbers(a.id);
    expect(new Set(rows).size).toBe(rows.length);
    expect(rows.length).toBe(1 + results.filter((r) => r.status === "fulfilled").length);
  });

  it("restores as a new version and enforces base, latest and not-found", async () => {
    const a = await agent("one");
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "one", via: "create" });
    await db.agent.update({ where: { id: a.id }, data: { systemPrompt: "two" } });
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "two", via: "update" });
    const restore = (number: number, baseNumber: number) =>
      restorePromptVersion(db, { agentId: a.id, number, baseNumber, createdById: "p" });

    await expect(restore(1, 1)).rejects.toThrow("agent_prompt_version_conflict");
    await expect(restore(2, 2)).rejects.toThrow("agent_prompt_version_is_latest");
    await expect(restore(9, 2)).rejects.toThrow("agent_prompt_version_not_found");
    const out = await restore(1, 2);
    expect(out).toEqual({ number: 3, before: "two", after: "one" });
    expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } })).systemPrompt).toBe("one");
    expect((await listPromptVersions(db, a.id))[0]).toMatchObject({
      number: 3,
      via: "restore",
      summary: "Restored v1",
    });
  });

  it("deletes versions with the agent", async () => {
    const a = await agent();
    await recordPromptVersion(db, { agentId: a.id, systemPrompt: "one", via: "create" });
    await db.agent.delete({ where: { id: a.id } });
    expect(await db.agentPromptVersion.count({ where: { agentId: a.id } })).toBe(0);
  });
});
