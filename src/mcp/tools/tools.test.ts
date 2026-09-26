import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerToolAuthoringTools } from "./tools.js";
import type { McpRequestContext } from "../context.js";
import { Prisma } from "#prisma";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {
  datastore: { get: async () => undefined, set: async () => {}, delete: async () => {} },
} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeToolRow {
  id: string;
  name: string;
  description: string;
  paramsZod: string;
  jsonSchema: unknown;
  code: string;
  ownerId: string | null;
}
interface FakeAgentRow {
  id: string;
  name?: string;
  ownerId: string | null;
  kind?: "native" | "coding";
}

function fakeDb(tools: FakeToolRow[] = [], agents: FakeAgentRow[] = []) {
  const toolRows = new Map(tools.map((t) => [t.id, t]));
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const attachments: {
    agentId: string;
    toolId: string;
    allowedSecrets?: string[];
    allowedDatastorePrefixes?: string[];
    allowedHosts?: string[];
  }[] = [];
  let counter = toolRows.size;

  const transactionDb = {
    tool: {
      create: async ({ data }: { data: Partial<FakeToolRow> & { name: string } }) => {
        // Mirrors Tool's unique index, so a duplicate surfaces as the same
        // P2002 the real database raises.
        if ([...toolRows.values()].some((t) => t.ownerId === (data.ownerId ?? null) && t.name === data.name)) {
          throw new Prisma.PrismaClientKnownRequestError("Invalid `prisma.tool.create()` invocation", {
            code: "P2002",
            clientVersion: "test",
            meta: { modelName: "Tool" },
          });
        }
        const row: FakeToolRow = {
          id: `tool_${++counter}`,
          description: "",
          paramsZod: "",
          jsonSchema: {},
          code: "",
          ownerId: null,
          ...data,
        };
        toolRows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => toolRows.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeToolRow> }) => {
        const row = { ...toolRows.get(where.id)!, ...data };
        toolRows.set(where.id, row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        // Mirrors AgentTool.toolId's ON DELETE RESTRICT.
        if (attachments.some((a) => a.toolId === where.id)) {
          throw new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated", {
            code: "P2003",
            clientVersion: "test",
            meta: { modelName: "Tool" },
          });
        }
        const row = toolRows.get(where.id)!;
        toolRows.delete(where.id);
        return row;
      },
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...toolRows.values()];
        if (!where?.OR) return all;
        return all.filter((r) => where.OR!.some((cond) => r.ownerId === cond.ownerId));
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    agentTool: {
      create: async ({ data }: { data: { agentId: string; toolId: string } }) => {
        attachments.push(data);
        return data;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { agentId_toolId: { agentId: string; toolId: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const idx = attachments.findIndex(
          (a) => a.agentId === where.agentId_toolId.agentId && a.toolId === where.agentId_toolId.toolId,
        );
        if (idx === -1) {
          const row = {
            agentId: where.agentId_toolId.agentId,
            toolId: where.agentId_toolId.toolId,
            allowedSecrets: [],
            allowedDatastorePrefixes: [],
            allowedHosts: [],
            ...create,
          };
          attachments.push(row);
          return row;
        }
        attachments[idx] = { ...attachments[idx], ...update };
        return attachments[idx];
      },
      deleteMany: async ({ where }: { where: { agentId: string | { in: string[] }; toolId: string } }) => {
        const matchesAgent = (agentId: string) =>
          typeof where.agentId === "string" ? agentId === where.agentId : where.agentId.in.includes(agentId);
        const before = attachments.length;
        const kept = attachments.filter((a) => !(matchesAgent(a.agentId) && a.toolId === where.toolId));
        attachments.length = 0;
        attachments.push(...kept);
        return { count: before - kept.length };
      },
      findMany: async ({ where }: { where: { agentId?: string; toolId?: string } }) =>
        attachments
          .filter(
            (a) =>
              (where.agentId === undefined || a.agentId === where.agentId) &&
              (where.toolId === undefined || a.toolId === where.toolId),
          )
          .map((a) => {
            const agent = agentRows.get(a.agentId);
            return {
              ...a,
              tool: toolRows.get(a.toolId),
              agent: { id: a.agentId, name: agent?.name ?? a.agentId, ownerId: agent?.ownerId ?? null },
            };
          }),
      findFirst: async ({ where }: { where: { agentId: string; toolId: { not: string }; tool: { name: string } } }) => {
        const hit = attachments.find(
          (a) =>
            a.agentId === where.agentId &&
            a.toolId !== where.toolId.not &&
            toolRows.get(a.toolId)?.name === where.tool.name,
        );
        return hit ? { tool: toolRows.get(hit.toolId) } : null;
      },
    },
  };
  return {
    ...transactionDb,
    $transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
  } as unknown as import("#prisma").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: fakeProviders,
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

describe("tool authoring tools", () => {
  it("private-agent listings do not reveal attached tools to another owner", async () => {
    const db = fakeDb(
      [
        {
          id: "t",
          name: "private",
          description: "x",
          paramsZod: "private schema",
          jsonSchema: {},
          code: "private source",
          ownerId: "p2",
        },
      ],
      [{ id: "a", ownerId: "p2" }],
    );
    await db.agentTool.create({ data: { agentId: "a", toolId: "t" } });
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({ name: "list_tools", arguments: { agentId: "a" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("not found");
    expect(JSON.stringify(result)).not.toContain("private source");
    await client.close();
  });
  it("public agents and catalog expose only public metadata and the caller's own source", async () => {
    const tools = ["p1", "p2", null].map((ownerId, i) => ({
      id: `t${i}`,
      name: `tool${i}`,
      description: "description",
      paramsZod: "schema",
      jsonSchema: {},
      code: `source${i}`,
      ownerId,
    }));
    const db = fakeDb(tools, [{ id: "a", ownerId: null }]);
    for (const tool of tools) await db.agentTool.create({ data: { agentId: "a", toolId: tool.id } });
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);
    for (const args of [{}, { agentId: "a" }]) {
      const result = await client.callTool({ name: "list_tools", arguments: args });
      const rows = parseText(result as never) as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0].code).toBe("source0");
      // `public: true` tells a public tool apart from the caller's own
      // same-named one now that names are only unique per owner.
      expect(rows[1]).toEqual({ id: "t2", name: "tool2", description: "description", public: true });
    }
    await client.close();
  });
  it("create_tool persists a valid tool with cached jsonSchema", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_tool",
      arguments: {
        name: "greet",
        description: "says hi",
        paramsZod: "z.object({ name: z.string() })",
        code: "return `hi ${params.name}`;",
      },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { name: string; jsonSchema: unknown; ownerId: string };
    expect(body.name).toBe("greet");
    expect(body.jsonSchema).toBeTruthy();
    expect(body.ownerId).toBe("p1");
    await client.close();
  });

  it("create_tool reports a duplicate name for the caller as a friendly 409 naming the tool", async () => {
    const db = fakeDb([
      { id: "t1", name: "greet", description: "x", paramsZod: "z.object({})", jsonSchema: {}, code: "", ownerId: "p1" },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_tool",
      arguments: { name: "greet", description: "x", paramsZod: "z.object({})", code: "return 1;" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain('A tool named "greet" already exists for your principal.');
    expect(text).not.toContain("Invalid `prisma");
    await client.close();
  });

  it("create_tool rejects a name reserved for a built-in memory tool", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_tool",
      arguments: { name: "memory_get", description: "x", paramsZod: "z.object({})", code: "return 1;" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/reserved/i);

    const stored = await db.tool.findMany();
    expect(stored.length).toBe(0);
    await client.close();
  });

  it("create_tool rejects every name a runtime built-in shadows", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    for (const name of ["parent_memory_get", "subagent_memory_get", "delegate_to_x"]) {
      const result = await client.callTool({
        name: "create_tool",
        arguments: { name, description: "x", paramsZod: "z.object({})", code: "return 1;" },
      });
      expect(result.isError, name).toBe(true);
      expect((result.content as { text: string }[])[0].text, name).toMatch(/reserved/i);
    }
    expect(await db.tool.findMany()).toHaveLength(0);
    await client.close();
  });

  it("create_tool with invalid Zod source returns a structured error and persists nothing", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_tool",
      arguments: { name: "bad", description: "x", paramsZod: "not valid zod {{{", code: "return 1;" },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { ok: boolean; errorKind?: string; errorMessage?: string };
    expect(body.ok).toBe(false);
    expect(body.errorMessage).toBeTruthy();

    const stored = await db.tool.findMany();
    expect(stored.length).toBe(0);
    await client.close();
  });

  it("dry_run_tool returns the derived schema + sandbox result and persists nothing", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "dry_run_tool",
      arguments: {
        paramsZod: "z.object({ name: z.string() })",
        code: "return `hi ${params.name}`;",
        sampleArgs: { name: "world" },
      },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { jsonSchema: unknown; result: { ok: boolean; value?: unknown } };
    expect(body.jsonSchema).toBeTruthy();
    expect(body.result.ok).toBe(true);
    expect(body.result.value).toBe("hi world");

    const stored = await db.tool.findMany();
    expect(stored.length).toBe(0);
    await client.close();
  });

  it("dry_run_tool denies fetch by default, same as a freshly attached tool", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "dry_run_tool",
      arguments: { paramsZod: "z.object({})", code: "return await fetch('http://8.8.8.8/');", sampleArgs: {} },
    });
    const body = parseText(result as never) as { result: { ok: boolean; errorMessage?: string } };
    expect(body.result.ok).toBe(false);
    expect(body.result.errorMessage).toContain("fetch_destination_blocked");
    await client.close();
  });

  it("dry_run_tool scopes fetch to only the declared allowedHosts, not a blanket allow", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "dry_run_tool",
      arguments: {
        paramsZod: "z.object({})",
        code: "return await fetch('http://1.1.1.1/');",
        sampleArgs: {},
        allowedHosts: ["8.8.8.8"],
      },
    });
    const body = parseText(result as never) as { result: { ok: boolean; errorMessage?: string } };
    expect(body.result.ok).toBe(false);
    expect(body.result.errorMessage).toContain("fetch_destination_blocked");
    await client.close();
  });

  it("dry_run_tool rejects a malformed allowedHosts entry", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "dry_run_tool",
      arguments: { paramsZod: "z.object({})", code: "return 1;", sampleArgs: {}, allowedHosts: ["not a host!"] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/Invalid allowedHosts/i);
    await client.close();
  });

  it("dry_run_tool surfaces a runtime error in the body as a structured result", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "dry_run_tool",
      arguments: { paramsZod: "z.object({})", code: "throw new Error('boom');", sampleArgs: {} },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { result: { ok: boolean; errorKind?: string; errorMessage?: string } };
    expect(body.result.ok).toBe(false);
    expect(body.result.errorMessage).toMatch(/boom/);
    await client.close();
  });

  it("attach_tool is owner-gated on both the agent and the tool", async () => {
    const db = fakeDb(
      [
        {
          id: "t1",
          name: "greet",
          description: "x",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "",
          ownerId: "p1",
        },
      ],
      [{ id: "a1", ownerId: "someone-else" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("attach_tool refuses a second, different tool with the same name on one agent", async () => {
    const tool = (id: string, ownerId: string | null) => ({
      id,
      name: "foo",
      description: "x",
      paramsZod: "z.object({})",
      jsonSchema: {},
      code: "",
      ownerId,
    });
    const db = fakeDb([tool("mine", "p1"), tool("public", null)], [{ id: "a1", ownerId: "p1" }]);
    await db.agentTool.create({ data: { agentId: "a1", toolId: "public" } });
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "mine" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/already has a different tool named "foo"/);
    expect((await db.agentTool.findMany({ where: { agentId: "a1" } })).map((r) => r.toolId)).toEqual(["public"]);

    // Re-attaching the same tool (a capability update) is not a clash.
    const again = await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "public", allowedHosts: ["api.example.com"] },
    });
    expect(again.isError).toBeFalsy();
    await client.close();
  });

  it("attach_tool rejects native sandbox tools for coding agents", async () => {
    const db = fakeDb(
      [
        {
          id: "t1",
          name: "greet",
          description: "x",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "",
          ownerId: "p1",
        },
      ],
      [{ id: "a1", ownerId: "p1", kind: "coding" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/coding|native/i);
    await client.close();
  });

  it("attach_tool and detach_tool succeed for the owner of both, and list_tools reflects it", async () => {
    const db = fakeDb(
      [
        {
          id: "t1",
          name: "greet",
          description: "x",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "",
          ownerId: "p1",
        },
      ],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const attach = await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1" } });
    expect(attach.isError).toBeFalsy();

    const listed = await client.callTool({ name: "list_tools", arguments: { agentId: "a1" } });
    const tools = parseText(listed as never) as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(["greet"]);

    const detach = await client.callTool({ name: "detach_tool", arguments: { agentId: "a1", toolId: "t1" } });
    expect(detach.isError).toBeFalsy();

    const listedAfter = await client.callTool({ name: "list_tools", arguments: { agentId: "a1" } });
    expect(parseText(listedAfter as never)).toEqual([]);
    await client.close();
  });

  it("attach_tool persists declared capabilities and rejects an invalid host", async () => {
    const db = fakeDb(
      [
        {
          id: "t1",
          name: "greet",
          description: "x",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "",
          ownerId: "p1",
        },
      ],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    const bad = await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "t1", allowedHosts: ["not a host!"] },
    });
    expect(bad.isError).toBe(true);

    const attach = await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "t1", allowedSecrets: ["API_KEY"], allowedHosts: ["api.example.com"] },
    });
    expect(attach.isError).toBeFalsy();

    const rows = await db.agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0]).toMatchObject({
      allowedSecrets: ["API_KEY"],
      allowedHosts: ["api.example.com"],
      allowedDatastorePrefixes: [],
    });
    await client.close();
  });

  it("attach_tool defaults to deny-all capabilities when none are declared", async () => {
    const db = fakeDb(
      [
        {
          id: "t1",
          name: "greet",
          description: "x",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "",
          ownerId: "p1",
        },
      ],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({ name: "attach_tool", arguments: { agentId: "a1", toolId: "t1" } });
    const rows = await db.agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0]).toMatchObject({ allowedSecrets: [], allowedDatastorePrefixes: [], allowedHosts: [] });
    await client.close();
  });

  it("re-attaching declares only the fields passed, leaving the rest untouched", async () => {
    const db = fakeDb(
      [
        {
          id: "t1",
          name: "greet",
          description: "x",
          paramsZod: "z.object({})",
          jsonSchema: {},
          code: "",
          ownerId: "p1",
        },
      ],
      [{ id: "a1", ownerId: "p1" }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["tools:write"]));
    registerToolAuthoringTools(mcp);
    const client = await connectClient(mcp);

    await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "t1", allowedSecrets: ["API_KEY"] },
    });
    await client.callTool({
      name: "attach_tool",
      arguments: { agentId: "a1", toolId: "t1", allowedHosts: ["api.example.com"] },
    });

    const rows = await db.agentTool.findMany({ where: { agentId: "a1" } });
    expect(rows[0]).toMatchObject({ allowedSecrets: ["API_KEY"], allowedHosts: ["api.example.com"] });
    await client.close();
  });

  describe("update_tool", () => {
    const owned = (overrides: Partial<FakeToolRow> = {}): FakeToolRow => ({
      id: "t1",
      name: "greet",
      description: "old description",
      paramsZod: "z.object({})",
      jsonSchema: { old: true },
      code: "return 'old';",
      ownerId: "p1",
      ...overrides,
    });

    async function setup(tools: FakeToolRow[], agents: FakeAgentRow[] = [], principal = "p1") {
      const db = fakeDb(tools, agents);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, principal, ["tools:write"]));
      registerToolAuthoringTools(mcp);
      return { db, client: await connectClient(mcp) };
    }

    it("lets the owner replace code, description and paramsZod, re-deriving the cached jsonSchema", async () => {
      const { db, client } = await setup([owned()], [{ id: "a1", name: "mine", ownerId: "p1" }]);
      // Attached to the caller's own agent: not a cross-owner attachment.
      await db.agentTool.create({ data: { agentId: "a1", toolId: "t1" } });

      const result = await client.callTool({
        name: "update_tool",
        arguments: {
          toolId: "t1",
          code: "return 'new';",
          description: "new description",
          paramsZod: "z.object({ who: z.string() })",
        },
      });
      expect(result.isError).toBeFalsy();
      const body = parseText(result as never) as FakeToolRow;
      expect(body).toMatchObject({ id: "t1", name: "greet", code: "return 'new';", description: "new description" });
      expect(JSON.stringify(body.jsonSchema)).toContain("who");
      expect((await db.tool.findUnique({ where: { id: "t1" } }))?.code).toBe("return 'new';");
      await client.close();
    });

    it("returns {ok:false} for an invalid paramsZod and leaves the row unchanged", async () => {
      const { db, client } = await setup([owned()]);
      const result = await client.callTool({
        name: "update_tool",
        arguments: { toolId: "t1", paramsZod: "not valid zod {{{", code: "return 'new';" },
      });
      expect(result.isError).toBeFalsy();
      const body = parseText(result as never) as { ok: boolean; errorMessage?: string };
      expect(body.ok).toBe(false);
      expect(body.errorMessage).toBeTruthy();
      expect(await db.tool.findUnique({ where: { id: "t1" } })).toMatchObject({
        code: "return 'old';",
        paramsZod: "z.object({})",
        jsonSchema: { old: true },
      });
      await client.close();
    });

    it("requires at least one field to change", async () => {
      const { client } = await setup([owned()]);
      const result = await client.callTool({ name: "update_tool", arguments: { toolId: "t1" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toMatch(/at least one/i);
      await client.close();
    });

    it("rejects `name` (a rename would silently break every attached agent's prompt)", async () => {
      const { db, client } = await setup([owned()]);
      // Alongside a valid field, so only the schema's additionalProperties
      // can be what refuses it.
      const result = await client.callTool({
        name: "update_tool",
        arguments: { toolId: "t1", name: "renamed", code: "return 'new';" },
      });
      expect(result.isError).toBe(true);
      expect(await db.tool.findUnique({ where: { id: "t1" } })).toMatchObject({ name: "greet", code: "return 'old';" });
      await client.close();
    });

    it("hides another principal's tool as not found", async () => {
      const { db, client } = await setup([owned({ ownerId: "p2" })]);
      const result = await client.callTool({ name: "update_tool", arguments: { toolId: "t1", code: "return 1;" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toMatch(/not found/);
      expect((await db.tool.findUnique({ where: { id: "t1" } }))?.code).toBe("return 'old';");
      await client.close();
    });

    it("refuses a public (null-owner) tool with 403, whoever asks", async () => {
      const { db, client } = await setup([owned({ ownerId: null })]);
      const result = await client.callTool({ name: "update_tool", arguments: { toolId: "t1", code: "return 1;" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toMatch(/public/i);
      expect((await db.tool.findUnique({ where: { id: "t1" } }))?.code).toBe("return 'old';");
      await client.close();
    });

    it("refuses while attached to another principal's agent, naming only agents the caller can read", async () => {
      const { db, client } = await setup(
        [owned()],
        [
          { id: "a-mine", name: "mine", ownerId: "p1" },
          { id: "a-public", name: "shared-bot", ownerId: null },
          { id: "a-theirs", name: "secret-project", ownerId: "p2" },
        ],
      );
      for (const agentId of ["a-mine", "a-public", "a-theirs"]) {
        await db.agentTool.create({ data: { agentId, toolId: "t1" } });
      }
      const result = await client.callTool({
        name: "update_tool",
        arguments: { toolId: "t1", description: "even a description" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as { text: string }[])[0].text;
      expect(text).toContain('"shared-bot" (a-public)');
      expect(text).toContain("1 agent(s) owned by other principals");
      expect(text).not.toContain("secret-project");
      expect(text).not.toContain("a-theirs");
      expect(text).not.toContain('"mine"');
      expect((await db.tool.findUnique({ where: { id: "t1" } }))?.description).toBe("old description");
      await client.close();
    });

    it("refuses while attached to a public agent", async () => {
      const { db, client } = await setup([owned()], [{ id: "a-public", name: "shared-bot", ownerId: null }]);
      await db.agentTool.create({ data: { agentId: "a-public", toolId: "t1" } });
      const result = await client.callTool({ name: "update_tool", arguments: { toolId: "t1", code: "return 1;" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain('"shared-bot" (a-public)');
      expect((await db.tool.findUnique({ where: { id: "t1" } }))?.code).toBe("return 'old';");
      await client.close();
    });
  });

  describe("delete_tool", () => {
    const tool = (ownerId: string | null = "p1"): FakeToolRow => ({
      id: "t1",
      name: "greet",
      description: "x",
      paramsZod: "z.object({})",
      jsonSchema: {},
      code: "",
      ownerId,
    });

    async function setup(tools: FakeToolRow[], agents: FakeAgentRow[] = [], principal = "p1") {
      const db = fakeDb(tools, agents);
      const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
      mcp.setFixedContext(fakeCtx(db, principal, ["tools:write"]));
      registerToolAuthoringTools(mcp);
      return { db, client: await connectClient(mcp) };
    }
    const errorText = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

    it("deletes an unattached tool", async () => {
      const { db, client } = await setup([tool()]);
      const result = await client.callTool({ name: "delete_tool", arguments: { toolId: "t1" } });
      expect(result.isError).toBeFalsy();
      expect(parseText(result as never)).toEqual({ deleted: "t1", detachedFrom: [] });
      expect(await db.tool.findUnique({ where: { id: "t1" } })).toBeNull();
      await client.close();
    });

    it("refuses while attached to the caller's own agent unless detach is passed, with a hint", async () => {
      const { db, client } = await setup([tool()], [{ id: "a1", name: "mine", ownerId: "p1" }]);
      await db.agentTool.create({ data: { agentId: "a1", toolId: "t1" } });

      const refused = await client.callTool({ name: "delete_tool", arguments: { toolId: "t1" } });
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toContain('"mine" (a1)');
      expect(errorText(refused)).toContain("detach: true");
      expect(await db.tool.findUnique({ where: { id: "t1" } })).not.toBeNull();

      const deleted = await client.callTool({ name: "delete_tool", arguments: { toolId: "t1", detach: true } });
      expect(deleted.isError).toBeFalsy();
      expect(parseText(deleted as never)).toEqual({ deleted: "t1", detachedFrom: ["a1"] });
      expect(await db.tool.findUnique({ where: { id: "t1" } })).toBeNull();
      expect(await db.agentTool.findMany({ where: { agentId: "a1" } })).toEqual([]);
      await client.close();
    });

    it("never auto-detaches from another principal's or a public agent, and then detaches nothing", async () => {
      const { db, client } = await setup(
        [tool()],
        [
          { id: "a-mine", name: "mine", ownerId: "p1" },
          { id: "a-public", name: "shared-bot", ownerId: null },
          { id: "a-theirs", name: "secret-project", ownerId: "p2" },
        ],
      );
      for (const agentId of ["a-mine", "a-public", "a-theirs"]) {
        await db.agentTool.create({ data: { agentId, toolId: "t1" } });
      }
      const result = await client.callTool({ name: "delete_tool", arguments: { toolId: "t1", detach: true } });
      expect(result.isError).toBe(true);
      const text = errorText(result);
      expect(text).toContain('"shared-bot" (a-public)');
      expect(text).toContain("1 agent(s) owned by other principals");
      expect(text).not.toContain("secret-project");
      expect(text).not.toContain('"mine"');
      expect(await db.tool.findUnique({ where: { id: "t1" } })).not.toBeNull();
      // Nothing was detached -- not even the caller's own agent.
      expect(await db.agentTool.findMany({ where: { agentId: "a-mine" } })).toHaveLength(1);
      await client.close();
    });

    it("hides another principal's tool as not found and refuses a public tool with 403", async () => {
      const others = await setup([tool("p2")]);
      const hidden = await others.client.callTool({ name: "delete_tool", arguments: { toolId: "t1" } });
      expect(hidden.isError).toBe(true);
      expect(errorText(hidden)).toMatch(/not found/);
      expect(await others.db.tool.findUnique({ where: { id: "t1" } })).not.toBeNull();
      await others.client.close();

      const publicTool = await setup([tool(null)]);
      const refused = await publicTool.client.callTool({ name: "delete_tool", arguments: { toolId: "t1" } });
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toMatch(/public/i);
      expect(await publicTool.db.tool.findUnique({ where: { id: "t1" } })).not.toBeNull();
      await publicTool.client.close();
    });

    it("maps an attachment that raced in after the check (the RESTRICT FK's P2003) to the same 409", async () => {
      const { db, client } = await setup([tool()], [{ id: "a1", name: "mine", ownerId: "p1" }]);
      await db.agentTool.create({ data: { agentId: "a1", toolId: "t1" } });
      // The attachment is invisible to the check but still blocks the delete.
      const realFindMany = db.agentTool.findMany.bind(db.agentTool);
      (db.agentTool as { findMany: unknown }).findMany = async (args: { where: { toolId?: string } }) =>
        args.where.toolId ? [] : realFindMany(args as never);
      const result = await client.callTool({ name: "delete_tool", arguments: { toolId: "t1" } });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toMatch(/still attached/);
      expect(errorText(result)).not.toContain("Foreign key");
      await client.close();
    });
  });
});
