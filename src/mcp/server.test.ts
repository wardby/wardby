import { describe, it, expect } from "vitest";
import { InMemoryTransport, inputRequired } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "./server.js";
import { TASKS_EXTENSION_ID } from "./capabilities.js";
import type { McpRequestContext } from "./context.js";

const fakeProviders = {} as unknown as import("../providers/index.js").ProviderRegistry;
const fakeDb = {} as unknown as import("@prisma/client").PrismaClient;

function fakeCtx(scopes: string[] = []): McpRequestContext {
  return {
    principal: { id: "p1", subject: "user-1", createdAt: new Date() },
    scopes: new Set(scopes),
    providers: fakeProviders,
    db: fakeDb,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

interface FakeAgentRow {
  id: string;
  name: string;
  model: string;
  systemPrompt: string;
  ownerId: string | null;
}

function fakeDbWithAgents(agents: FakeAgentRow[]) {
  return {
    agent: {
      findMany: async ({ where }: { where: { ownerId: string | null } | { OR: { ownerId: string | null }[] } }) => {
        if ("OR" in where) {
          const allowed = new Set(where.OR.map((c) => c.ownerId));
          return agents.filter((a) => allowed.has(a.ownerId));
        }
        return agents.filter((a) => a.ownerId === where.ownerId);
      },
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

/** Connects a real Client to a factory-built McpServer over an in-memory transport pair. */
async function connectClient(
  mcp: ReturnType<typeof import("./server.js").buildMcpServer>,
  capabilities?: import("@modelcontextprotocol/client").ClientCapabilities,
) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" }, capabilities },
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

describe("buildMcpServer", () => {
  it("discover() advertises the Tasks extension", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    const result = await mcp.discover();
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

  it("mintRequestState/verifyRequestState round-trip through a real multi-round-trip tool call", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    mcp.setFixedContext(fakeCtx(["agents:read"]));
    let urlVisited: string | undefined;
    mcp.registerTool({
      name: "needs-approval",
      scope: "agents:read",
      inputSchema: {},
      handler: async (_args, ctx) => {
        const state = ctx.mcpReq.requestState<{ step: string }>();
        if (!state) {
          const token = await mcp.mintRequestState({ step: "approve" });
          return inputRequired({
            requestState: token,
            inputRequests: {
              approval: inputRequired.elicitUrl({ url: "https://example.com/approve", message: "Approve?" }),
            },
          });
        }
        expect(state.step).toBe("approve");
        return { content: [{ type: "text" as const, text: "approved" }] };
      },
    });

    const { client } = await connectClient(mcp, { elicitation: { url: {} } });
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as { mode?: string; url?: string };
      if (params.mode === "url" && params.url) urlVisited = params.url;
      return { action: "accept" };
    });

    const result = await client.callTool({ name: "needs-approval", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0].text).toBe("approved");
    expect(urlVisited).toBe("https://example.com/approve");
    await client.close();
  });

  it("verifyRequestState rejects a tampered token", async () => {
    const mcp = buildMcpServer({ providers: fakeProviders, db: fakeDb, config: { canonicalUri: "https://host/mcp" } });
    const token = await mcp.mintRequestState({ ok: true });
    await expect(mcp.verifyRequestState(token.slice(0, -2) + "xx")).rejects.toThrow();
  });

  it("REQUEST_STATE_KEY unset: two instances mint independent keys, so one instance's token fails on the other", async () => {
    const a = buildMcpServer({
      providers: fakeProviders,
      db: fakeDb,
      config: { canonicalUri: "https://host/mcp" },
      env: {},
    });
    const b = buildMcpServer({
      providers: fakeProviders,
      db: fakeDb,
      config: { canonicalUri: "https://host/mcp" },
      env: {},
    });
    const token = await a.mintRequestState({ ok: true });
    await expect(b.verifyRequestState(token)).rejects.toThrow();
  });

  it("REQUEST_STATE_KEY set: a token minted on one instance verifies on another sharing the same key", async () => {
    const env = { REQUEST_STATE_KEY: "aa".repeat(32) };
    const a = buildMcpServer({
      providers: fakeProviders,
      db: fakeDb,
      config: { canonicalUri: "https://host/mcp" },
      env,
    });
    const b = buildMcpServer({
      providers: fakeProviders,
      db: fakeDb,
      config: { canonicalUri: "https://host/mcp" },
      env,
    });
    const token = await a.mintRequestState({ ok: true, step: "cross-instance" });
    await expect(b.verifyRequestState(token)).resolves.toEqual({ ok: true, step: "cross-instance" });
  });

  it("a malformed REQUEST_STATE_KEY (wrong byte length) throws at construction", () => {
    expect(() =>
      buildMcpServer({
        providers: fakeProviders,
        db: fakeDb,
        config: { canonicalUri: "https://host/mcp" },
        env: { REQUEST_STATE_KEY: "aabb" },
      }),
    ).toThrow(/32 bytes/);
  });

  it("connecting clients see the shift-left instructions", async () => {
    const mcp = buildMcpServer({
      providers: fakeProviders,
      db: fakeDbWithAgents([]),
      config: { canonicalUri: "https://host/mcp" },
    });
    const { client } = await connectClient(mcp);
    expect(client.getInstructions()).toMatch(/shift.+left/i);
    await client.close();
  });

  it("a public agent is registered as an MCP prompt carrying its system prompt", async () => {
    const mcp = buildMcpServer({
      providers: fakeProviders,
      db: fakeDbWithAgents([
        {
          id: "a1",
          name: "public-review-agent",
          model: "claude-sonnet-5",
          systemPrompt: "Review the diff for bugs.",
          ownerId: null,
        },
      ]),
      config: { canonicalUri: "https://host/mcp" },
    });
    const { client } = await connectClient(mcp);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("public-review-agent");

    const result = await client.getPrompt({ name: "public-review-agent" });
    const text = (result.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("Review the diff for bugs.");
    expect(text).toContain("public-review-agent");
    await client.close();
  });

  it("an owned agent is invisible as a prompt without a resolvable identity (HTTP-shaped connection)", async () => {
    const mcp = buildMcpServer({
      providers: fakeProviders,
      db: fakeDbWithAgents([
        { id: "a1", name: "private-agent", model: "m", systemPrompt: "secret process", ownerId: "owner-1" },
      ]),
      config: { canonicalUri: "https://host/mcp" },
    });
    // No setFixedContext call — mirrors the HTTP path, where factory() runs before any per-request identity is known.
    const { client } = await connectClient(mcp);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).not.toContain("private-agent");
    await client.close();
  });

  it("an owned agent IS visible as a prompt once its owner is the fixed context (stdio-shaped connection)", async () => {
    const mcp = buildMcpServer({
      providers: fakeProviders,
      db: fakeDbWithAgents([
        { id: "a1", name: "private-agent", model: "m", systemPrompt: "secret process", ownerId: "owner-1" },
      ]),
      config: { canonicalUri: "https://host/mcp" },
    });
    mcp.setFixedContext({ ...fakeCtx(), principal: { id: "owner-1", subject: "owner-1", createdAt: new Date() } });
    const { client } = await connectClient(mcp);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("private-agent");
    await client.close();
  });
});
