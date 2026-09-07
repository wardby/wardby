import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerToolAuthoringTools } from "./tools.js";
import type { McpRequestContext } from "../context.js";

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
      deleteMany: async ({ where }: { where: { agentId: string; toolId: string } }) => {
        const before = attachments.length;
        const kept = attachments.filter((a) => !(a.agentId === where.agentId && a.toolId === where.toolId));
        attachments.length = 0;
        attachments.push(...kept);
        return { count: before - kept.length };
      },
      findMany: async ({ where }: { where: { agentId: string } }) =>
        attachments.filter((a) => a.agentId === where.agentId).map((a) => ({ ...a, tool: toolRows.get(a.toolId) })),
    },
  };
  return {
    ...transactionDb,
    $transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
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
      expect(rows[1]).toEqual({ id: "t2", name: "tool2", description: "description" });
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
});
