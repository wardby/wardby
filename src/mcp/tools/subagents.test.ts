import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { Prisma } from "#prisma";
import { buildMcpServer } from "../server.js";
import { registerSubAgentTools } from "./subagents.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

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

function fakeDb(agents: FakeAgentRow[], grants: FakeGrantSeed[] = []) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const edges: FakeEdgeRow[] = [];
  return {
    resourceGrant: fakeResourceGrants(grants),
    edges,
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
  } as unknown as import("#prisma").PrismaClient;
}

function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  principalId: string,
  scopes: string[],
  extra: Partial<McpRequestContext> = {},
): McpRequestContext {
  return {
    ...extra,
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
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

function setup(
  agents: FakeAgentRow[],
  principalId: string,
  grants: FakeGrantSeed[] = [],
  extra: Partial<McpRequestContext> = {},
) {
  const db = fakeDb(agents, grants);
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, principalId, ["agents:read", "agents:write"], extra));
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

  it("list_subagents hides an agent the caller can't read", async () => {
    const { mcp } = setup([{ id: "a", name: "a", ownerId: "someone-else" }], "p1");
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_subagents", arguments: { agentId: "a" } });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result)).toContain("not found");
    await client.close();
  });

  describe("across owners (N1)", () => {
    const agents: FakeAgentRow[] = [
      { id: "P", name: "alice-parent", ownerId: "alice" },
      { id: "C", name: "bob-child", ownerId: "bob" },
    ];
    const g = (resourceId: string, principalId: string, level: string): FakeGrantSeed => ({
      resourceType: "agent",
      resourceId,
      principalId,
      level,
    });
    const attach = { name: "attach_subagent", arguments: { parentAgentId: "P", childAgentId: "C" } };

    it("N1: owned child under foreign parent is refused at attach and at delegation (attach side)", async () => {
      // Bob can edit Alice's parent and owns the child, but Alice never gave
      // Bob's child to her agent: the edge would run Bob's agent (with Bob's
      // bindings) on behalf of anyone who can trigger Alice's.
      const { db, mcp } = setup(agents, "bob", [g("P", "bob", "write")]);
      const client = await connectClient(mcp);
      const refused = await client.callTool(attach);
      expect(refused.isError).toBeTruthy();
      expect(JSON.stringify(refused)).toMatch(/owner/);
      expect((db as any).edges).toEqual([]);
      await client.close();
    });

    it("the old N1 path: execute on a formerly public parent is not enough to attach to it", async () => {
      const { db, mcp } = setup(
        [
          { id: "P", name: "public-parent", ownerId: null },
          { id: "C", name: "bob-child", ownerId: "bob" },
        ],
        "bob",
        [{ resourceType: "agent", resourceId: "P", granteeKind: "everyone", level: "execute" }],
      );
      const client = await connectClient(mcp);
      const refused = await client.callTool(attach);
      expect(refused.isError).toBeTruthy();
      expect(JSON.stringify(refused)).toMatch(/owner/);
      expect((db as any).edges).toEqual([]);
      await client.close();
    });

    it("an owner-less parent can't take any sub-agent, even from the operator", async () => {
      const { mcp } = setup(
        [
          { id: "P", name: "public-parent", ownerId: null },
          { id: "C", name: "child", ownerId: null },
        ],
        "local",
        [],
        { operator: true },
      );
      const client = await connectClient(mcp);
      const refused = await client.callTool(attach);
      expect(refused.isError).toBeTruthy();
      expect(JSON.stringify(refused)).toMatch(/owner/);
      await client.close();
    });

    it("the caller needs execute on the child (404 when it can't even read it)", async () => {
      const { mcp } = setup(agents, "alice");
      const client = await connectClient(mcp);
      const refused = await client.callTool(attach);
      expect(JSON.stringify(refused)).toContain("not found");
      await client.close();
    });

    it("N1: the parent's owner can't attach another owner's child it holds only read on", async () => {
      const { db, mcp } = setup(agents, "alice", [g("C", "alice", "read")]);
      const client = await connectClient(mcp);
      const refused = await client.callTool(attach);
      expect(refused.isError).toBeTruthy();
      expect(JSON.stringify(refused)).toMatch(/execute/);
      expect((db as any).edges).toEqual([]);
      await client.close();
    });

    it("allowed when the parent's owner holds execute on the child", async () => {
      const { db, mcp } = setup(agents, "alice", [g("C", "alice", "execute")]);
      const client = await connectClient(mcp);
      const ok = await client.callTool(attach);
      expect(ok.isError).toBeFalsy();
      expect((db as any).edges).toHaveLength(1);
      await client.close();
    });

    it("I2: a write-grantee can't attach or detach sub-agents, even the parent owner's own agents", async () => {
      const sameOwner: FakeAgentRow[] = [
        { id: "P", name: "alice-parent", ownerId: "alice" },
        { id: "C", name: "alice-child", ownerId: "alice" },
      ];
      const { db, mcp } = setup(sameOwner, "w", [g("P", "w", "write"), g("C", "w", "execute")]);
      const client = await connectClient(mcp);
      const refused = await client.callTool(attach);
      expect(refused.isError).toBeTruthy();
      expect(JSON.stringify(refused)).toMatch(/owner/);
      expect((db as any).edges).toEqual([]);
      (db as any).edges.push({ parentAgentId: "P", childAgentId: "C", boundName: "c" });
      const noDetach = await client.callTool({
        name: "detach_subagent",
        arguments: { parentAgentId: "P", childAgentId: "C" },
      });
      expect(noDetach.isError).toBeTruthy();
      expect((db as any).edges).toHaveLength(1);
      await client.close();
    });

    it("the child's owner can always cut the edge, without write on the parent", async () => {
      const { db, mcp } = setup(agents, "bob");
      (db as any).edges.push({ parentAgentId: "P", childAgentId: "C", boundName: "c" });
      const client = await connectClient(mcp);
      const ok = await client.callTool({
        name: "detach_subagent",
        arguments: { parentAgentId: "P", childAgentId: "C" },
      });
      expect(ok.isError).toBeFalsy();
      expect((db as any).edges).toEqual([]);
      await client.close();
    });

    it("a stranger can't detach", async () => {
      const { db, mcp } = setup(agents, "mallory", [g("P", "mallory", "execute"), g("C", "mallory", "execute")]);
      (db as any).edges.push({ parentAgentId: "P", childAgentId: "C", boundName: "c" });
      const client = await connectClient(mcp);
      const refused = await client.callTool({
        name: "detach_subagent",
        arguments: { parentAgentId: "P", childAgentId: "C" },
      });
      expect(refused.isError).toBeTruthy();
      expect((db as any).edges).toHaveLength(1);
      await client.close();
    });

    it("list_subagents needs read, and names only agents the caller can read", async () => {
      const { db, mcp } = setup(agents, "reader", [g("P", "reader", "read")]);
      (db as any).edges.push({ parentAgentId: "P", childAgentId: "C", boundName: "c" });
      const client = await connectClient(mcp);
      const listed = await client.callTool({ name: "list_subagents", arguments: { agentId: "P" } });
      expect(listed.isError).toBeFalsy();
      const body = parseText(listed as never);
      expect(body).toEqual({ children: [], parents: [], hiddenChildren: 1 });
      expect(JSON.stringify(body)).not.toContain("bob-child");
      await client.close();
    });
  });
});
