import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerRunTools } from "./runs.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}
interface FakeRunRow {
  id: string;
  agentId: string;
  status: string;
  trigger: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  finalText: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function fakeDb(agents: FakeAgentRow[], runs: FakeRunRow[]) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const runRows = new Map(runs.map((r) => [r.id, r]));
  return {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => runRows.get(where.id) ?? null,
      findMany: async ({ where }: { where: { agentId: string; status?: string } }) =>
        [...runRows.values()].filter((r) => r.agentId === where.agentId && (!where.status || r.status === where.status)),
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() } as never,
    scopes: new Set(scopes),
    providers: fakeProviders,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = mcp.factory({ era: "modern" }) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("run observability tools", () => {
  it("get_run returns full state incl. turns, cost, final text", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 3,
          tokensIn: 100,
          tokensOut: 50,
          costUsd: 0.01,
          finalText: "the answer",
          error: null,
          startedAt: now,
          finishedAt: now,
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { turns: number; costUsd: number; finalText: string };
    expect(body.turns).toBe(3);
    expect(body.costUsd).toBe(0.01);
    expect(body.finalText).toBe("the answer");
    await client.close();
  });

  it("get_run on a run belonging to another owner's agent is not found", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "owner-1" }],
      [
        {
          id: "r1",
          agentId: "a1",
          status: "succeeded",
          trigger: "manual",
          turns: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          finalText: "x",
          error: null,
          startedAt: now,
          finishedAt: now,
        },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("list_runs filters by agent and status", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: "p1" }],
      [
        { id: "r1", agentId: "a1", status: "succeeded", trigger: "manual", turns: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, finalText: "x", error: null, startedAt: now, finishedAt: now },
        { id: "r2", agentId: "a1", status: "failed", trigger: "manual", turns: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, finalText: null, error: "boom", startedAt: now, finishedAt: now },
      ],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_runs", arguments: { agentId: "a1", status: "failed" } });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as { id: string }[];
    expect(body.map((r) => r.id)).toEqual(["r2"]);
    await client.close();
  });

  it("list_runs on another owner's agent is not found", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "owner-1" }], []);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("get_run and list_runs on a public (ownerId: null) agent are readable by any principal", async () => {
    const now = new Date();
    const db = fakeDb(
      [{ id: "a1", ownerId: null }],
      [{ id: "r1", agentId: "a1", status: "succeeded", trigger: "manual", turns: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, finalText: "x", error: null, startedAt: now, finishedAt: now }],
    );
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "anyone", ["agents:read"]));
    registerRunTools(mcp);
    const client = await connectClient(mcp);

    const getResult = await client.callTool({ name: "get_run", arguments: { runId: "r1" } });
    expect(getResult.isError).toBeFalsy();

    const listResult = await client.callTool({ name: "list_runs", arguments: { agentId: "a1" } });
    expect(listResult.isError).toBeFalsy();
    await client.close();
  });
});
