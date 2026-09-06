import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "./server.js";
import { TASKS_EXTENSION_ID } from "./capabilities.js";
import type { McpRequestContext } from "./context.js";

const fakeProviders = {} as unknown as import("../providers/index.js").ProviderRegistry;
const fakeDb = {} as unknown as import("@prisma/client").PrismaClient;

function fakeCtx(scopes: string[] = []): McpRequestContext {
  return {
    principal: { id: "p1", subject: "user-1", createdAt: new Date() } as never,
    scopes: new Set(scopes),
    providers: fakeProviders,
    db: fakeDb,
  };
}

/** Connects a real Client to a factory-built McpServer over an in-memory transport pair. */
async function connectClient(mcp: ReturnType<typeof import("./server.js").buildMcpServer>) {
  const server = mcp.factory({ era: "modern" }) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("buildMcpServer", () => {
  it("discover() advertises the Tasks extension", () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    const result = mcp.discover();
    expect(result.capabilities.extensions?.[TASKS_EXTENSION_ID]).toBeDefined();
  });

  it("a registered tool dispatches with the caller's resolved context", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    mcp.setFixedContext(fakeCtx(["agents:read"]));
    let receivedCtx: McpRequestContext | undefined;
    mcp.registerTool({
      name: "echo",
      scope: "agents:read",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: async (args: { text: string }, ctx) => {
        receivedCtx = ctx;
        return { content: [{ type: "text", text: args.text }] };
      },
    });

    const { client } = await connectClient(mcp);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });

    expect(result.isError).toBeFalsy();
    expect(receivedCtx?.principal.subject).toBe("user-1");
    await client.close();
  });

  it("a tool call without the required scope is rejected", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    mcp.setFixedContext(fakeCtx(["agents:read"]));
    mcp.registerTool({
      name: "needs-write",
      scope: "agents:write",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "should not run" }] }),
    });

    const { client } = await connectClient(mcp);
    const result = await client.callTool({ name: "needs-write", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("a tool call with no resolvable context (no fixed context, no authInfo) is rejected", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    mcp.registerTool({
      name: "whoami",
      scope: "agents:read",
      inputSchema: {},
      handler: async () => ({ content: [{ type: "text", text: "should not run" }] }),
    });

    const { client } = await connectClient(mcp);
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("an unknown tool name is rejected", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    const { client } = await connectClient(mcp);
    await expect(client.callTool({ name: "not-a-real-tool", arguments: {} })).rejects.toThrow();
    await client.close();
  });
});
