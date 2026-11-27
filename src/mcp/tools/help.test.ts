import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { HelpCatalog } from "../../help/catalog.js";
import { buildMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import { registerHelpTools } from "./help.js";

const CANONICAL_URI = "https://host/mcp";
const fakeDb = { agent: { findMany: async () => [] } } as never;
const catalog: HelpCatalog = {
  schemaVersion: 1,
  pages: [
    {
      id: "deploy-gke",
      title: "Deploy Wardby on GKE Autopilot",
      summary: "Create a Kubernetes cluster with private Cloud SQL.",
      audience: "operator",
      tags: ["deployment", "gke", "kubernetes"],
      appliesTo: ">=0.2.1",
      sourcePath: "deploy-gke.md",
      markdown: "# Deploy Wardby on GKE Autopilot\n\nUse private Cloud SQL.",
      plainText: "Deploy Wardby on GKE Autopilot. Use private Cloud SQL.",
      headings: [{ level: 1, text: "Deploy Wardby on GKE Autopilot", slug: "deploy-wardby-on-gke-autopilot" }],
    },
    {
      id: "agent-flows",
      title: "See how your agents work together (flows)",
      summary: "list_agent_links returns agents, how they link and how they start, grouped into flows.",
      audience: "operator",
      tags: ["flows", "agent links", "list_agent_links", "agents tab"],
      appliesTo: ">=0.9.14",
      sourcePath: "agent-flows.md",
      markdown: "# See how your agents work together\n\nA flow is a group of agents that hand work to each other.",
      plainText: "See how your agents work together. A flow is a group of agents that hand work to each other.",
      headings: [{ level: 1, text: "See how your agents work together", slug: "see-how-your-agents-work-together" }],
    },
    {
      id: "route-work-from-reviews",
      title: "Route work from reviews (review routers)",
      summary:
        "A router agent decides who works next when someone acts on a document in review; request_work sends work to a router.",
      audience: "operator",
      tags: [
        "review router",
        "router",
        "route work",
        "request_work",
        "onApproved",
        "choose option agent",
        "which agent",
      ],
      appliesTo: ">=0.11.0",
      sourcePath: "route-work-from-reviews.md",
      markdown: "# Route work from reviews\n\nA router agent decides who works next.",
      plainText: "Route work from reviews. A router agent decides who works next.",
      headings: [{ level: 1, text: "Route work from reviews", slug: "route-work-from-reviews" }],
    },
  ],
};

function fakeCtx(scopes: string[] = ["agents:read"]): McpRequestContext {
  return {
    principal: { id: "p1", subject: "p1", createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: {} as McpRequestContext["providers"],
    db: fakeDb,
    operator: true,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connect(scopes?: string[]) {
  const mcp = buildMcpServer({
    providers: {} as McpRequestContext["providers"],
    db: fakeDb,
    config: { canonicalUri: CANONICAL_URI },
  });
  mcp.setFixedContext(fakeCtx(scopes));
  registerHelpTools(mcp, async () => catalog);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function content(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  return JSON.parse((result.content as { text: string }[])[0].text);
}

describe("help MCP tools", () => {
  it("searches the release-bundled catalog with the CLI's fuzzy matcher", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "search_help", arguments: { query: "kuber clod" } });

    expect(result.isError).toBeFalsy();
    expect(content(result)).toEqual({
      results: [
        expect.objectContaining({
          id: "deploy-gke",
          title: "Deploy Wardby on GKE Autopilot",
          excerpt: expect.stringContaining("Cloud SQL"),
        }),
      ],
    });
    await client.close();
  });

  it.each(["flow", "agent links", "list_agent_links"])("finds the agent-flows article for %j", async (query) => {
    const client = await connect();
    const result = await client.callTool({ name: "search_help", arguments: { query } });
    const ids = (content(result) as { results: { id: string }[] }).results.map((r) => r.id);
    expect(ids[0]).toBe("agent-flows");
    await client.close();
  });

  it.each(["review router", "request work", "onApproved", "choose option agent"])(
    "finds the route-work-from-reviews article for %j",
    async (query) => {
      const client = await connect();
      const result = await client.callTool({ name: "search_help", arguments: { query } });
      const ids = (content(result) as { results: { id: string }[] }).results.map((r) => r.id);
      expect(ids.slice(0, 3)).toContain("route-work-from-reviews");
      await client.close();
    },
  );

  it("returns full Markdown for an exact article id and a friendly miss", async () => {
    const client = await connect();
    const article = await client.callTool({ name: "get_help_article", arguments: { id: "deploy-gke" } });
    expect(article.isError).toBeFalsy();
    expect(content(article)).toEqual(
      expect.objectContaining({ id: "deploy-gke", markdown: expect.stringContaining("Cloud SQL") }),
    );

    // An id written with underscores, the way error codes are, finds the hyphenated article.
    const underscored = await client.callTool({ name: "get_help_article", arguments: { id: "deploy_gke" } });
    expect(underscored.isError).toBeFalsy();
    expect(content(underscored)).toEqual(expect.objectContaining({ id: "deploy-gke" }));

    const absent = await client.callTool({ name: "get_help_article", arguments: { id: "missing" } });
    expect(absent.isError).toBe(true);
    expect((absent.content as { text: string }[])[0].text).toContain('Help article "missing" not found.');
    await client.close();
  });

  it("requires the existing read scope", async () => {
    const client = await connect([]);
    const result = await client.callTool({ name: "search_help", arguments: { query: "gke" } });
    expect(result.isError).toBe(true);
    await client.close();
  });
});
