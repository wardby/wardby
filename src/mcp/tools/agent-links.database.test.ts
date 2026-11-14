import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerAgentLinkTools } from "./agent-links.js";

const db = createPrismaClient();
const principalIds: string[] = [];
const agentIds: string[] = [];
const groupIds: string[] = [];
const CANONICAL = "https://host/mcp";
const tag = randomUUID().slice(0, 8);
const REPO = `your-org/flows-${tag}`;

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `agent-links-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}
async function agent(ownerId: string, name: string, data: Record<string, unknown> = {}) {
  const a = await db.agent.create({
    data: {
      name: `${name}-${tag}`,
      systemPrompt: `\n  First line of ${name}\nsecond line`,
      model: "claude-sonnet-5-5",
      budgetUsd: 2,
      ownerId,
      ...data,
    },
  });
  agentIds.push(a.id);
  return a;
}
async function connect(who: Principal, admin = false) {
  const providers = {} as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext({
    principal: who,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: admin ? ["admin"] : [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerAgentLinkTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return async (args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name: "list_agent_links", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    if (result.isError) throw new Error(result.content[0].text);
    return { text: result.content[0].text, value: JSON.parse(result.content[0].text) };
  };
}

afterAll(async () => {
  await db.agentSubAgent.deleteMany({
    where: { OR: [{ parentAgentId: { in: agentIds } }, { childAgentId: { in: agentIds } }] },
  });
  await db.webhook.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agentIssueProject.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agentRepository.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.codingAgentProfile.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agent.deleteMany({ where: { id: { in: agentIds } } });
  await db.budgetGroup.deleteMany({ where: { id: { in: groupIds } } });
  await db.principal.deleteMany({ where: { id: { in: principalIds } } });
  await db.$disconnect();
});

describe("list_agent_links", () => {
  it("returns a flow, counts links to agents the caller cannot read, and never leaks link secrets", async () => {
    const me = await principal();
    const other = await principal();
    const group = await db.budgetGroup.create({ data: { name: `Shop-${tag}`, ownerId: me.id } });
    groupIds.push(group.id);
    const lead = await agent(me.id, "delivery", { budgetGroupId: group.id });
    const builder = await agent(me.id, "builder", { kind: "coding" });
    await db.codingAgentProfile.create({
      data: { agentId: builder.id, provider: "claude-code", repository: REPO, protectedPaths: [] },
    });
    const reviewer = await agent(me.id, "reviewer");
    const hiddenChild = await agent(other.id, "secret-child");
    await db.agentRepository.createMany({
      data: [
        {
          agentId: lead.id,
          provider: "github",
          repository: REPO,
          name: `github:${REPO}`,
          access: "read",
          triggers: ["mention", "review_fix"],
        },
        {
          agentId: reviewer.id,
          provider: "github",
          repository: REPO,
          name: `github:${REPO}`,
          access: "read",
          triggers: ["pull_request"],
          checkName: `review-${tag}`,
        },
      ],
    });
    await db.agentSubAgent.createMany({
      data: [
        { parentAgentId: lead.id, childAgentId: builder.id, boundName: "build" },
        { parentAgentId: lead.id, childAgentId: hiddenChild.id, boundName: "hidden" },
      ],
    });
    await db.webhook.create({ data: { agentId: lead.id, secretHash: "FAKE-WEBHOOK-SECRET-HASH", ownerId: me.id } });
    await db.agentIssueProject.create({
      data: {
        agentId: lead.id,
        provider: "jira",
        projectKey: "FLW",
        access: "write",
        triggers: ["status"],
        jqlFilter: "FAKE-JQL-FILTER",
        trustedAccountIds: ["FAKE-ACCOUNT-ID"],
        writableFields: ["FAKE-FIELD"],
        authorizedById: me.id,
      },
    });

    const call = await connect(me);
    const { text, value } = await call();

    for (const fake of ["FAKE-WEBHOOK-SECRET-HASH", "FAKE-JQL-FILTER", "FAKE-ACCOUNT-ID", "FAKE-FIELD"])
      expect(text).not.toContain(fake);
    expect(text).not.toContain(hiddenChild.id);
    expect(text).not.toContain("secret-child");
    expect(value.hidden).toEqual({ agents: 1, edges: 1 });

    const leadRow = value.agents.find((a: { id: string }) => a.id === lead.id);
    expect(leadRow.promptFirstLine).toBe("First line of delivery");
    expect(leadRow.entry).toEqual([`mention:github:${REPO}`, "jira:FLW", "webhook"]);
    expect(leadRow.budgetGroup).toEqual({ id: group.id, name: `Shop-${tag}` });
    expect(leadRow.access).toBe("owner");

    const flow = value.flows.find((f: { key: string }) => f.key === lead.id);
    expect(flow.name).toBe(REPO);
    expect([...flow.agentIds].sort()).toEqual([builder.id, lead.id, reviewer.id].sort());
    expect(value.edges).toEqual(
      expect.arrayContaining([
        { from: lead.id, to: builder.id, kind: "delegates", repository: null, label: "build" },
        { from: builder.id, to: reviewer.id, kind: "reviews", repository: `github:${REPO}`, label: "PR opened" },
        { from: reviewer.id, to: lead.id, kind: "fixes", repository: `github:${REPO}`, label: "fix ≤2" },
      ]),
    );
  });

  it("refuses all: true without admin:view, and an admin sees every agent", async () => {
    const me = await principal();
    const call = await connect(me);
    await expect(call({ all: true })).rejects.toThrow(/admin:view/);
    const admin = await connect(me, true);
    const { value } = await admin({ all: true });
    expect(value.agents.length).toBeGreaterThan(0);
  });
});
