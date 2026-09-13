import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { Prisma } from "@prisma/client";
import { buildMcpServer } from "../server.js";
import { registerSubAgentTools } from "./subagents.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
}

interface FakeEdgeRow {
  parentAgentId: string;
  childAgentId: string;
  boundName: string;
}

function fakeDb(agents: FakeAgentRow[]) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const edges: FakeEdgeRow[] = [];
  return {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    agentSubAgent: {
      findMany: async (opts?: {
        where?: { parentAgentId?: string; childAgentId?: string };
        include?: { child?: unknown; parent?: unknown };
      }) => {
        let rows = edges;
        if (opts?.where?.parentAgentId !== undefined) {
          rows = rows.filter((e) => e.parentAgentId === opts.where!.parentAgentId);
        }
        if (opts?.where?.childAgentId !== undefined) {
          rows = rows.filter((e) => e.childAgentId === opts.where!.childAgentId);
        }
        return rows.map((e) => ({
          ...e,
          ...(opts?.include?.child ? { child: agentRows.get(e.childAgentId) } : {}),
          ...(opts?.include?.parent ? { parent: agentRows.get(e.parentAgentId) } : {}),
        }));
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { parentAgentId_childAgentId: { parentAgentId: string; childAgentId: string } };
        create: FakeEdgeRow;
        update: { boundName: string };
      }) => {
        const { parentAgentId, childAgentId } = where.parentAgentId_childAgentId;
        const existing = edges.find((e) => e.parentAgentId === parentAgentId && e.childAgentId === childAgentId);
        if (
          edges.some(
            (e) =>
              e.parentAgentId === parentAgentId && e.boundName === create.boundName && e.childAgentId !== childAgentId,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        if (existing) {
          existing.boundName = update.boundName;
          return existing;
        }
        edges.push(create);
        return create;
      },
      deleteMany: async ({ where }: { where: { parentAgentId: string; childAgentId: string } }) => {
        const before = edges.length;
        const kept = edges.filter(
          (e) => !(e.parentAgentId === where.parentAgentId && e.childAgentId === where.childAgentId),
        );
        edges.length = 0;
        edges.push(...kept);
        return { count: before - kept.length };
      },
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    providers: {} as unknown as import("../../providers/index.js").ProviderRegistry,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

function setup(agents: FakeAgentRow[], principalId: string) {
  const db = fakeDb(agents);
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, principalId, ["agents:read", "agents:write"]));
  registerSubAgentTools(mcp);
  return { db, mcp };
}

describe("subagent tools", () => {
  it("attach_subagent defaults boundName to the child's own name, then list_subagents shows it both ways", async () => {
    const { mcp } = setup(
      [
        { id: "parent1", name: "orchestrator", ownerId: "p1" },
        { id: "child1", name: "researcher", ownerId: "p1" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    const attach = await client.callTool({
      name: "attach_subagent",
      arguments: { parentAgentId: "parent1", childAgentId: "child1" },
    });
    expect(attach.isError).toBeFalsy();
    expect(parseText(attach as never)).toEqual({ attached: true, boundName: "researcher" });

    const fromParent = await client.callTool({ name: "list_subagents", arguments: { agentId: "parent1" } });
    expect(parseText(fromParent as never)).toEqual({
      children: [{ boundName: "researcher", agentId: "child1", agentName: "researcher" }],
      parents: [],
    });

    const fromChild = await client.callTool({ name: "list_subagents", arguments: { agentId: "child1" } });
    expect(parseText(fromChild as never)).toEqual({
      children: [],
      parents: [{ boundName: "researcher", agentId: "parent1", agentName: "orchestrator" }],
    });
    await client.close();
  });

  it("attach_subagent rejects an agent being its own sub-agent", async () => {
    const { mcp } = setup([{ id: "a1", name: "solo", ownerId: "p1" }], "p1");
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "attach_subagent",
      arguments: { parentAgentId: "a1", childAgentId: "a1" },
    });
    expect(result.isError).toBeTruthy();
    await client.close();
  });

  it("attach_subagent rejects an edge that would close a cycle", async () => {
    const { mcp } = setup(
      [
        { id: "a", name: "a", ownerId: "p1" },
        { id: "b", name: "b", ownerId: "p1" },
        { id: "c", name: "c", ownerId: "p1" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    // a -> b -> c already; attaching c -> a would close the cycle.
    await client.callTool({ name: "attach_subagent", arguments: { parentAgentId: "a", childAgentId: "b" } });
    await client.callTool({ name: "attach_subagent", arguments: { parentAgentId: "b", childAgentId: "c" } });

    const cyclic = await client.callTool({
      name: "attach_subagent",
      arguments: { parentAgentId: "c", childAgentId: "a" },
    });
    expect(cyclic.isError).toBeTruthy();
    await client.close();
  });

  it("attach_subagent surfaces a friendly conflict when boundName collides under the same parent", async () => {
    const { mcp } = setup(
      [
        { id: "p", name: "parent", ownerId: "p1" },
        { id: "c1", name: "c1", ownerId: "p1" },
        { id: "c2", name: "c2", ownerId: "p1" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    await client.callTool({
      name: "attach_subagent",
      arguments: { parentAgentId: "p", childAgentId: "c1", boundName: "shared" },
    });
    const conflict = await client.callTool({
      name: "attach_subagent",
      arguments: { parentAgentId: "p", childAgentId: "c2", boundName: "shared" },
    });
    expect(conflict.isError).toBeTruthy();
    await client.close();
  });

  it("attach_subagent refuses when the caller doesn't own the child agent", async () => {
    const { mcp } = setup(
      [
        { id: "p", name: "parent", ownerId: "p1" },
        { id: "c", name: "child", ownerId: "someone-else" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "attach_subagent",
      arguments: { parentAgentId: "p", childAgentId: "c" },
    });
    expect(result.isError).toBeTruthy();
    await client.close();
  });

  it("detach_subagent removes the edge", async () => {
    const { mcp } = setup(
      [
        { id: "p", name: "parent", ownerId: "p1" },
        { id: "c", name: "child", ownerId: "p1" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    await client.callTool({ name: "attach_subagent", arguments: { parentAgentId: "p", childAgentId: "c" } });
    await client.callTool({ name: "detach_subagent", arguments: { parentAgentId: "p", childAgentId: "c" } });
    const after = await client.callTool({ name: "list_subagents", arguments: { agentId: "p" } });
    expect(parseText(after as never)).toEqual({ children: [], parents: [] });
    await client.close();
  });

  it("list_subagents requires ownership of the queried agent", async () => {
    const { mcp } = setup([{ id: "a", name: "a", ownerId: "someone-else" }], "p1");
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_subagents", arguments: { agentId: "a" } });
    expect(result.isError).toBeTruthy();
    await client.close();
  });
});
