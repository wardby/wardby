import { describe, expect, it } from "vitest";

import { THOROUGH_REVIEWER_PROMPT } from "./reviewer-prompt.js";
import {
  BUILDER_AGENT,
  BUILDER_PROMPT,
  REVIEWER_AGENT,
  REVIEWER_PROMPT,
  SHORT_REVIEWER_PROMPT_V1,
  THOROUGH_REVIEWER_PROMPT_V3,
  THOROUGH_REVIEWER_PROMPT_V4,
  seedCodingAgents,
  type AgentData,
  type CodingSeedInput,
  type SeedDb,
} from "./coding-seed.js";

function memoryDb() {
  const agents = new Map<string, AgentData & { id: string }>();
  const profiles = new Map<string, Record<string, unknown>>();
  const links = new Map<string, { agentId: string; repository: string; access: string }>();
  let next = 1;
  const db: SeedDb = {
    async findAgent(name) {
      return agents.get(name) ?? null;
    },
    async createAgent(data) {
      if (agents.has(data.name)) throw new Error("unique violation");
      const row = { ...data, id: `agent-${next++}` };
      agents.set(data.name, row);
      return { id: row.id };
    },
    async updateAgent(id, data) {
      const row = [...agents.values()].find((agent) => agent.id === id)!;
      Object.assign(row, data);
    },
    async upsertCodingProfile(agentId, profile) {
      profiles.set(agentId, profile);
    },
    async upsertLocalLink(agentId, link) {
      links.set(`${agentId}|local|${link.repository}`, { agentId, repository: link.repository, access: link.access });
    },
  };
  return { db, agents, profiles, links };
}

const input: CodingSeedInput = {
  ownerId: "owner-1",
  provider: "codex",
  builderModel: "gpt-5.6-luna",
  reviewerModel: "gpt-5.6-luna",
  repository: "local:/work/repo",
  baseRef: "main",
  services: ["postgres"],
};

describe("seedCodingAgents", () => {
  it("creates the builder and the reviewer with a local write link", async () => {
    const { db, agents, profiles, links } = memoryDb();
    const result = await seedCodingAgents(db, input);
    expect(result.builder).toMatchObject({ status: "created" });
    expect(result.reviewer).toMatchObject({ status: "created" });

    const builder = agents.get(BUILDER_AGENT)!;
    expect(builder).toMatchObject({ kind: "coding", budgetUsd: 2, systemPrompt: BUILDER_PROMPT, ownerId: "owner-1" });
    expect(profiles.get(builder.id)).toMatchObject({
      provider: "codex",
      repository: "local:/work/repo",
      baseRef: "main",
      services: ["postgres"],
      repositoryAuthorizedVia: "local_root",
      repositoryAuthorizedById: "owner-1",
    });

    const reviewer = agents.get(REVIEWER_AGENT)!;
    expect(reviewer).toMatchObject({ kind: "native", budgetUsd: 1.5, systemPrompt: REVIEWER_PROMPT });
    expect([...links.values()]).toEqual([{ agentId: reviewer.id, repository: "local:/work/repo", access: "write" }]);
  });

  it("defaults to the Node toolchain and stores node-python 3.12 when asked", async () => {
    const plain = memoryDb();
    await seedCodingAgents(plain.db, input);
    const plainProfile = plain.profiles.get(plain.agents.get(BUILDER_AGENT)!.id)!;
    expect(plainProfile).toMatchObject({ toolchain: "node", toolchainVersion: null });

    const { db, agents, profiles } = memoryDb();
    await seedCodingAgents(db, { ...input, toolchain: "node-python", toolchainVersion: "3.12" });
    expect(profiles.get(agents.get(BUILDER_AGENT)!.id)).toMatchObject({
      toolchain: "node-python",
      toolchainVersion: "3.12",
    });
  });

  it("updates an existing builder's toolchain on a re-run, in both directions", async () => {
    const { db, agents, profiles } = memoryDb();
    await seedCodingAgents(db, input);
    await seedCodingAgents(db, { ...input, toolchain: "node-python", toolchainVersion: "3.12" });
    const id = agents.get(BUILDER_AGENT)!.id;
    expect(profiles.get(id)).toMatchObject({ toolchain: "node-python", toolchainVersion: "3.12" });
    await seedCodingAgents(db, input);
    expect(profiles.get(id)).toMatchObject({ toolchain: "node", toolchainVersion: null });
  });

  it("writes the package allowlist, and a re-run sets it to the current set (empty when none)", async () => {
    const { db, agents, profiles } = memoryDb();
    await seedCodingAgents(db, { ...input, packageAllowlist: { npm: ["express"], pypi: ["flask", "pytest"] } });
    const id = agents.get(BUILDER_AGENT)!.id;
    expect(profiles.get(id)).toMatchObject({ packageAllowlist: { npm: ["express"], pypi: ["flask", "pytest"] } });
    await seedCodingAgents(db, { ...input, packageAllowlist: { pypi: ["flask"] } });
    expect(profiles.get(id)!.packageAllowlist).toEqual({ pypi: ["flask"] });
    await seedCodingAgents(db, input);
    expect(profiles.get(id)!.packageAllowlist).toEqual({});
  });

  it("does not write a package allowlist onto an agent quickstart did not create", async () => {
    const { db, profiles } = memoryDb();
    await db.createAgent({
      name: BUILDER_AGENT,
      kind: "coding",
      model: "m",
      budgetUsd: 9,
      systemPrompt: "mine",
      maxTurns: 1,
      ownerId: "someone",
    });
    const result = await seedCodingAgents(db, { ...input, packageAllowlist: { npm: ["express"] } });
    expect(result.builder.status).toBe("skipped");
    expect(profiles.size).toBe(0);
  });

  it("refuses an allowlist the coding profile would reject", async () => {
    const { db } = memoryDb();
    await expect(seedCodingAgents(db, { ...input, packageAllowlist: { cargo: ["serde"] } })).rejects.toThrow();
  });

  it("is idempotent: a second run updates in place without duplicating agents or links", async () => {
    const { db, agents, links } = memoryDb();
    const first = await seedCodingAgents(db, input);
    const second = await seedCodingAgents(db, { ...input, baseRef: "develop" });
    expect(second.builder).toEqual({ id: (first.builder as { id: string }).id, status: "updated" });
    expect(second.reviewer).toEqual({ id: (first.reviewer as { id: string }).id, status: "updated" });
    expect(agents.size).toBe(2);
    expect(links.size).toBe(1);
  });

  it("a re-run updates a quickstart-owned reviewer's model", async () => {
    const { db, agents } = memoryDb();
    await seedCodingAgents(db, input);
    await seedCodingAgents(db, { ...input, reviewerModel: "gpt-5.6-terra" });
    expect(agents.get("local-reviewer")!.model).toBe("gpt-5.6-terra");
    expect(agents.get("local-builder")!.model).toBe("gpt-5.6-luna");
  });

  it("leaves an agent of the same name that quickstart did not create alone", async () => {
    const { db, agents, profiles } = memoryDb();
    await db.createAgent({
      name: BUILDER_AGENT,
      kind: "coding",
      model: "m",
      budgetUsd: 9,
      systemPrompt: "mine",
      maxTurns: 1,
      ownerId: "someone",
    });
    const result = await seedCodingAgents(db, input);
    expect(result.builder.status).toBe("skipped");
    expect(agents.get(BUILDER_AGENT)!.budgetUsd).toBe(9);
    expect(profiles.size).toBe(0);
    expect(result.reviewer.status).toBe("created");
  });

  it("gives the reviewer the thorough review prompt", async () => {
    const { db, agents } = memoryDb();
    await seedCodingAgents(db, input);
    expect(REVIEWER_PROMPT).toBe(THOROUGH_REVIEWER_PROMPT);
    expect(agents.get(REVIEWER_AGENT)).toMatchObject({ systemPrompt: THOROUGH_REVIEWER_PROMPT, maxTurns: 25 });
  });

  it("moves a reviewer an earlier quickstart created onto the thorough prompt", async () => {
    const { db, agents, links } = memoryDb();
    const { id } = await db.createAgent({
      name: REVIEWER_AGENT,
      kind: "native",
      model: "m",
      budgetUsd: 1,
      systemPrompt: SHORT_REVIEWER_PROMPT_V1,
      maxTurns: 12,
      ownerId: "owner-1",
    });
    const result = await seedCodingAgents(db, input);
    expect(result.reviewer).toEqual({ id, status: "updated" });
    expect(agents.get(REVIEWER_AGENT)).toMatchObject({ systemPrompt: THOROUGH_REVIEWER_PROMPT, maxTurns: 25 });
    expect(links.size).toBe(1);
  });

  it.each([
    ["V3", THOROUGH_REVIEWER_PROMPT_V3],
    ["V4", THOROUGH_REVIEWER_PROMPT_V4],
  ])("moves a reviewer seeded with the thorough prompt %s onto the current one", async (_name, prompt) => {
    expect(prompt).not.toBe(THOROUGH_REVIEWER_PROMPT);
    const { db, agents } = memoryDb();
    const { id } = await db.createAgent({
      name: REVIEWER_AGENT,
      kind: "native",
      model: "m",
      budgetUsd: 1,
      systemPrompt: prompt,
      maxTurns: 25,
      ownerId: "owner-1",
    });
    const result = await seedCodingAgents(db, input);
    expect(result.reviewer).toEqual({ id, status: "updated" });
    expect(agents.get(REVIEWER_AGENT)?.systemPrompt).toBe(THOROUGH_REVIEWER_PROMPT);
  });

  it("refuses a model the coding provider does not support", async () => {
    const { db } = memoryDb();
    await expect(seedCodingAgents(db, { ...input, provider: "claude-code" })).rejects.toThrow(/not supported/);
  });
});
