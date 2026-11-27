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
const toolIds: string[] = [];
const secretIds: string[] = [];
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
  await db.runHook.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agentTool.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agentSecret.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agentMcpServer.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.mcpServer.deleteMany({ where: { ownerId: { in: principalIds } } });
  await db.tool.deleteMany({ where: { id: { in: toolIds } } });
  await db.secret.deleteMany({ where: { id: { in: secretIds } } });
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
        allowedTransitions: ["Plan review"],
        authorizedById: me.id,
      },
    });
    // The builder starts when a ticket reaches the status the lead moves it to.
    await db.agentIssueProject.create({
      data: {
        agentId: builder.id,
        provider: "jira",
        projectKey: "FLW",
        access: "write",
        triggers: ["transitioned"],
        triggerStatuses: ["Plan review"],
        authorizedById: me.id,
      },
    });

    // A tool, a run hook, a bound secret and an MCP server on the lead, all with fake values.
    const tool = await db.tool.create({
      data: {
        name: `notify-${tag}`,
        description: "FAKE-TOOL-DESCRIPTION",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "return 'FAKE-TOOL-CODE';",
        ownerId: me.id,
      },
    });
    toolIds.push(tool.id);
    await db.agentTool.create({
      data: {
        agentId: lead.id,
        toolId: tool.id,
        allowedSecrets: ["FAKE_TOOL_SECRET_NAME"],
        allowedHosts: ["fake-tool-host.example"],
      },
    });
    await db.runHook.createMany({
      data: [
        {
          agentId: lead.id,
          toolId: tool.id,
          events: ["run_completed"],
          config: { channel: "FAKE-HOOK-CONFIG" },
          allowedSecrets: ["FAKE_HOOK_SECRET_NAME"],
          allowedHosts: ["fake-hook-host.example"],
          createdById: me.id,
        },
        { agentId: lead.id, toolId: tool.id, events: [], createdById: me.id },
      ],
    });
    const secret = await db.secret.create({
      data: { name: "FAKE_BOUND_SECRET_NAME", ciphertext: "FAKE-SECRET-CIPHERTEXT", keyId: "fake-key", ownerId: me.id },
    });
    secretIds.push(secret.id);
    await db.agentSecret.create({ data: { agentId: lead.id, secretId: secret.id, boundName: "FAKE_BOUND_NAME" } });
    const mcpServer = await db.mcpServer.create({
      data: {
        ownerId: me.id,
        name: `docs-${tag}`,
        url: "https://mcp.example/FAKE-MCP-URL-PATH",
        secretNames: ["FAKE_MCP_SECRET_NAME"],
      },
    });
    await db.agentMcpServer.create({
      data: { agentId: lead.id, serverId: mcpServer.id, allowedTools: ["search"], attachedById: me.id },
    });

    const call = await connect(me);
    const { text, value } = await call();

    for (const fake of [
      "FAKE-WEBHOOK-SECRET-HASH",
      "FAKE-JQL-FILTER",
      "FAKE-ACCOUNT-ID",
      "FAKE-FIELD",
      "FAKE-TOOL-DESCRIPTION",
      "FAKE-TOOL-CODE",
      "FAKE_TOOL_SECRET_NAME",
      "fake-tool-host.example",
      "FAKE-HOOK-CONFIG",
      "FAKE_HOOK_SECRET_NAME",
      "fake-hook-host.example",
      "FAKE_BOUND_SECRET_NAME",
      "FAKE-SECRET-CIPHERTEXT",
      "FAKE_BOUND_NAME",
      "FAKE-MCP-URL-PATH",
      "FAKE_MCP_SECRET_NAME",
    ])
      expect(text).not.toContain(fake);
    expect(text).not.toContain(hiddenChild.id);
    expect(text).not.toContain("secret-child");
    expect(value.hidden).toEqual({ agents: 1, edges: 1 });

    const leadRow = value.agents.find((a: { id: string }) => a.id === lead.id);
    expect(leadRow.promptFirstLine).toBe("First line of delivery");
    expect(leadRow.entry).toEqual([`mention:github:${REPO}`, "jira:FLW", "webhook"]);
    expect(leadRow.budgetGroup).toEqual({ id: group.id, name: `Shop-${tag}` });
    expect(leadRow.access).toBe("owner");
    expect(leadRow.notes).toEqual([`mcp:docs-${tag}`, "runHook:all", "runHook:run_completed"]);

    const flow = value.flows.find((f: { key: string }) => f.key === lead.id);
    expect(flow.name).toBe(REPO);
    expect([...flow.agentIds].sort()).toEqual([builder.id, lead.id, reviewer.id].sort());
    expect(value.edges).toEqual(
      expect.arrayContaining([
        { from: lead.id, to: builder.id, kind: "delegates", repository: null, label: "build" },
        { from: builder.id, to: reviewer.id, kind: "reviews", repository: `github:${REPO}`, label: "PR opened" },
        { from: reviewer.id, to: lead.id, kind: "fixes", repository: `github:${REPO}`, label: "fix ≤2" },
        { from: lead.id, to: builder.id, kind: "status", repository: "jira:FLW", label: "Plan review" },
      ]),
    );
    expect(flow.issueProjects).toEqual(["jira:FLW"]);
  });

  it("links an agent to its review router with routes_reviews (#646)", async () => {
    const me = await principal();
    const router = await agent(me.id, "router", { router: true, description: "routes" });
    const writer = await agent(me.id, "writer", { reviewRouterId: router.id });
    const { value } = await (await connect(me))();
    expect(value.edges).toContainEqual({
      from: writer.id,
      to: router.id,
      kind: "routes_reviews",
      repository: null,
      label: "reviews",
    });
  });

  it("strips terminal control sequences from the prompt's first line", async () => {
    const me = await principal();
    const a = await agent(me.id, "escapes", {
      systemPrompt: "\x1b]8;;https://evil.example\x07Click\x1b]8;;\x07 \x1b[31mred\x1b[0m line\x07\r\nsecond",
    });
    const { value } = await (await connect(me))();
    const row = value.agents.find((r: { id: string }) => r.id === a.id);
    expect(row.promptFirstLine).toBe("Click red line");
  });

  it("notes each tunnel host pattern an agent's runs are given (#627)", async () => {
    const me = await principal();
    const recon = await agent(me.id, "recon", {
      kind: "coding",
      codingProfile: {
        create: {
          repository: REPO,
          protectedPaths: [".github/**"],
          tunnelHosts: ["*.apps.example.org", "*"],
          tunnelAnyHostAuthorizedById: me.id,
        },
      },
    });
    const plain = await agent(me.id, "plain-coder", {
      kind: "coding",
      codingProfile: { create: { repository: REPO, protectedPaths: [".github/**"] } },
    });
    const { value } = await (await connect(me))();
    const row = (id: string) => value.agents.find((r: { id: string }) => r.id === id);
    expect(row(recon.id).notes).toEqual(["tunnel:*.apps.example.org", "tunnel:*"]);
    expect(row(plain.id).notes).toEqual([]);
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
