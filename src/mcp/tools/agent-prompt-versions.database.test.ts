import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { identityCipher } from "../../native-worker/fixtures.test-support.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerAgentTools } from "./agents.js";
import { registerAgentPromptVersionTools } from "./agent-prompt-versions.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const secretIds: string[] = [];
const principalIds: string[] = [];
const CANONICAL = "https://host/mcp";
const SECRET = "fake-secret-value-123";

type Result = { isError?: boolean; content: { text: string }[] };

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `apv-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function agent(ownerId: string, systemPrompt = "first") {
  const a = await db.agent.create({
    data: { name: `apv-${randomUUID()}`, systemPrompt, model: "gpt-5.6-luna", budgetUsd: 1, ownerId },
  });
  agentIds.push(a.id);
  return a;
}

async function connect(who: Principal) {
  const providers = { secrets: identityCipher } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext({
    principal: who,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerAgentTools(mcp);
  registerAgentPromptVersionTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result,
    close: () => client.close(),
  };
}

describe.skipIf(!process.env.DATABASE_URL)("agent prompt version tools (PostgreSQL)", () => {
  let owner: Principal;
  let reader: Principal;
  let stranger: Principal;

  beforeAll(async () => {
    owner = await principal();
    reader = await principal();
    stranger = await principal();
  });

  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.secret.deleteMany({ where: { id: { in: secretIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("records create/update versions and restores through the tools", async () => {
    const mcp = await connect(owner);
    const created = JSON.parse(
      (
        await mcp.call("create_agent", {
          name: `apv-${randomUUID()}`,
          systemPrompt: "v-one",
          model: "gpt-5.6-luna",
          budgetUsd: 1,
        })
      ).content[0].text,
    );
    agentIds.push(created.id);
    await mcp.call("update_agent", { id: created.id, systemPrompt: "v-two", promptSummary: "second" });
    // An update that leaves the prompt alone records nothing.
    await mcp.call("update_agent", { id: created.id, budgetUsd: 2 });
    const listed = JSON.parse((await mcp.call("list_agent_prompt_versions", { agentId: created.id })).content[0].text);
    expect(listed.versions.map((v: { number: number; via: string }) => [v.number, v.via])).toEqual([
      [2, "update"],
      [1, "create"],
    ]);
    expect(listed.versions[0].summary).toBe("second");
    expect(JSON.stringify(listed)).not.toContain("v-two");

    const got = JSON.parse(
      (await mcp.call("get_agent_prompt_version", { agentId: created.id, versionNumber: 1 })).content[0].text,
    );
    expect(got.systemPromptText).toBe("v-one");

    const stale = await mcp.call("restore_agent_prompt_version", {
      agentId: created.id,
      versionNumber: 1,
      baseNumber: 1,
    });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(/agent_prompt_version_conflict/);
    const restored = JSON.parse(
      (await mcp.call("restore_agent_prompt_version", { agentId: created.id, versionNumber: 1, baseNumber: 2 }))
        .content[0].text,
    );
    expect(restored).toEqual({ number: 3, restored: 1 });
    expect((await db.agent.findUniqueOrThrow({ where: { id: created.id } })).systemPrompt).toBe("v-one");
    await mcp.close();
  });

  it("lets a read grantee list and get but not restore, and hides the agent from a stranger", async () => {
    const a = await agent(owner.id);
    await db.agentPromptVersion.create({
      data: { agentId: a.id, number: 1, systemPrompt: "first", contentHash: "h", via: "backfill" },
    });
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: a.id,
        granteeKind: "principal",
        granteePrincipalId: reader.id,
        granteeKey: `principal:${reader.id}`,
        level: "read",
      },
    });
    const r = await connect(reader);
    expect((await r.call("list_agent_prompt_versions", { agentId: a.id })).isError).toBeFalsy();
    expect((await r.call("get_agent_prompt_version", { agentId: a.id, versionNumber: 1 })).isError).toBeFalsy();
    const denied = await r.call("restore_agent_prompt_version", { agentId: a.id, versionNumber: 1, baseNumber: 1 });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/write access/);
    await r.close();

    const s = await connect(stranger);
    const hidden = await s.call("list_agent_prompt_versions", { agentId: a.id });
    expect(hidden.isError).toBe(true);
    expect(hidden.content[0].text).toMatch(/not found/);
    await s.close();
  });

  it("masks secret values in get, keeps them out of list/restore, and restores the raw text", async () => {
    const a = await agent(owner.id, `use ${SECRET} now`);
    const secretId = `apv-secret-${randomUUID()}`;
    secretIds.push(secretId);
    await db.secret.create({
      data: { id: secretId, name: `apv-${randomUUID()}`, ciphertext: SECRET, keyId: "test", ownerId: owner.id },
    });
    await db.agentSecret.create({ data: { agentId: a.id, secretId, boundName: "api" } });
    await db.agentPromptVersion.create({
      data: { agentId: a.id, number: 1, systemPrompt: `use ${SECRET} now`, contentHash: "h1", via: "backfill" },
    });
    await db.agent.update({ where: { id: a.id }, data: { systemPrompt: "plain" } });
    await db.agentPromptVersion.create({
      data: { agentId: a.id, number: 2, systemPrompt: "plain", contentHash: "h2", via: "update" },
    });
    const mcp = await connect(owner);
    const got = await mcp.call("get_agent_prompt_version", { agentId: a.id, versionNumber: 1 });
    expect(got.content[0].text).not.toContain(SECRET);
    const list = await mcp.call("list_agent_prompt_versions", { agentId: a.id });
    expect(list.content[0].text).not.toContain(SECRET);
    const restored = await mcp.call("restore_agent_prompt_version", { agentId: a.id, versionNumber: 1, baseNumber: 2 });
    expect(restored.content[0].text).not.toContain(SECRET);
    expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } })).systemPrompt).toBe(`use ${SECRET} now`);
    await mcp.close();
  });

  it("fails closed when the agent's secrets cannot be loaded", async () => {
    const a = await agent(owner.id, "leaky");
    const secretId = `apv-secret-${randomUUID()}`;
    secretIds.push(secretId);
    await db.secret.create({
      data: { id: secretId, name: `apv-${randomUUID()}`, ciphertext: SECRET, keyId: "test", ownerId: owner.id },
    });
    await db.agentSecret.create({ data: { agentId: a.id, secretId, boundName: "api" } });
    await db.agentPromptVersion.create({
      data: { agentId: a.id, number: 1, systemPrompt: `leaky ${SECRET}`, contentHash: "h", via: "backfill" },
    });
    const mcp = await connect(owner);
    const spy = vi.spyOn(identityCipher, "decrypt").mockRejectedValue(new Error("kms down"));
    const got = await mcp.call("get_agent_prompt_version", { agentId: a.id, versionNumber: 1 });
    spy.mockRestore();
    expect(got.isError).toBe(true);
    expect(got.content[0].text).not.toContain(SECRET);
    expect(got.content[0].text).not.toContain("leaky");
    await mcp.close();
  });
});
