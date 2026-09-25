import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { PostgresAgentMemory } from "./postgres.js";
import { MEMORY_CONTENT_MAX_BYTES, MEMORY_KEY_MAX_BYTES, MEMORY_MAX_KEYS_PER_AGENT } from "./types.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "[wardby tests] DATABASE_URL not set — skipping PostgresAgentMemory tests " +
      "(get/set/list/search/delete round-trip, bounds, per-agent scoping). Set DATABASE_URL to run them.",
  );
}

describe.skipIf(!databaseUrl)("PostgresAgentMemory (database)", () => {
  const prisma = createPrismaClient();
  const memory = new PostgresAgentMemory(prisma);
  const agentIds: string[] = [];

  function newAgentId(): string {
    const id = `memory-test-${randomUUID()}`;
    agentIds.push(id);
    return id;
  }

  afterAll(async () => {
    await prisma.agentMemory.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.$disconnect();
  });

  it("returns undefined for a key that was never set", async () => {
    const agentId = newAgentId();
    expect(await memory.get(agentId, "missing")).toBeUndefined();
  });

  it("round-trips get/set/delete, and set overwrites an existing key", async () => {
    const agentId = newAgentId();

    await memory.set(agentId, "note", "first draft");
    expect(await memory.get(agentId, "note")).toBe("first draft");

    await memory.set(agentId, "note", "revised");
    expect(await memory.get(agentId, "note")).toBe("revised");

    await memory.delete(agentId, "note");
    expect(await memory.get(agentId, "note")).toBeUndefined();
  });

  it("lists keys sorted, not content", async () => {
    const agentId = newAgentId();
    await memory.set(agentId, "zeta", "z");
    await memory.set(agentId, "alpha", "a");

    expect(await memory.list(agentId)).toEqual(["alpha", "zeta"]);
  });

  it("scopes entries per agent — one agent can't read or list another's keys", async () => {
    const agentA = newAgentId();
    const agentB = newAgentId();

    await memory.set(agentA, "secret", "a-only");

    expect(await memory.get(agentB, "secret")).toBeUndefined();
    expect(await memory.list(agentB)).toEqual([]);
    expect(await memory.get(agentA, "secret")).toBe("a-only");
  });

  it("full-text searches content, ranking the best match first, scoped per agent", async () => {
    const agentId = newAgentId();
    const other = newAgentId();
    await memory.set(agentId, "pref-color", "the user prefers dark mode themes");
    await memory.set(agentId, "pref-language", "the user writes in TypeScript");
    await memory.set(other, "unrelated", "dark mode dark mode dark mode");

    const hits = await memory.search(agentId, "dark mode");
    expect(hits.map((h) => h.key)).toEqual(["pref-color"]);
    expect(hits[0].content).toContain("dark mode");
  });

  it("rejects an empty or oversized key", async () => {
    const agentId = newAgentId();
    await expect(memory.set(agentId, "", "x")).rejects.toThrow("memory_key_limit");
    await expect(memory.set(agentId, "k".repeat(MEMORY_KEY_MAX_BYTES + 1), "x")).rejects.toThrow("memory_key_limit");
  });

  it("rejects oversized content", async () => {
    const agentId = newAgentId();
    await expect(memory.set(agentId, "big", "x".repeat(MEMORY_CONTENT_MAX_BYTES + 1))).rejects.toThrow(
      "memory_content_limit",
    );
  });

  it("caps new keys per agent, but always allows overwriting an existing key past the cap", async () => {
    const agentId = newAgentId();
    for (let i = 0; i < MEMORY_MAX_KEYS_PER_AGENT; i++) {
      await memory.set(agentId, `k${i}`, "v");
    }

    await expect(memory.set(agentId, "one-too-many", "v")).rejects.toThrow("memory_limit_exceeded");
    // Overwriting an existing key never counts against the cap.
    await memory.set(agentId, "k0", "updated");
    expect(await memory.get(agentId, "k0")).toBe("updated");
  }, 20_000);
});
