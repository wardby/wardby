import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";
const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

interface FakeAgentRow {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  budgetUsd: number;
  maxTurns: number;
  schedule: string | null;
  timezone: string;
  scheduleEnabled: boolean;
  ownerId: string | null;
  tools: unknown[];
  kind: "native" | "coding";
  codingProfile: FakeCodingProfile | null;
}

interface FakeCodingProfile {
  provider: "codex";
  repository: string;
  baseRef: string;
  defaultTask: string | null;
  timeoutSec: number;
  allowedEgress: string[];
  protectedPaths: string[];
}

type FakeAgentSeed = Omit<FakeAgentRow, "kind" | "codingProfile" | "scheduleEnabled"> &
  Partial<Pick<FakeAgentRow, "kind" | "codingProfile" | "scheduleEnabled">>;

function fakeDb(seed: FakeAgentSeed[] = []) {
  const rows = new Map(
    seed.map((r) => [
      r.id,
      {
        kind: "native" as const,
        codingProfile: null,
        scheduleEnabled: true,
        ...r,
      },
    ]),
  );
  let counter = rows.size;
  const transactionDb = {
    agent: {
      create: async ({
        data,
      }: {
        data: Partial<FakeAgentRow> & { name: string; codingProfile?: { create: FakeCodingProfile } };
      }) => {
        const { codingProfile, ...agentData } = data;
        const row: FakeAgentRow = {
          id: `agent_${++counter}`,
          systemPrompt: "",
          model: "",
          budgetUsd: 0,
          maxTurns: 10,
          schedule: null,
          timezone: "UTC",
          scheduleEnabled: true,
          ownerId: null,
          tools: [],
          kind: "native",
          codingProfile: codingProfile?.create ?? null,
          ...agentData,
        };
        rows.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...rows.values()];
        if (!where?.OR) return all;
        return all.filter((r) => where.OR!.some((cond) => r.ownerId === cond.ownerId));
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeAgentRow> & {
          codingProfile?: { create?: FakeCodingProfile; update?: FakeCodingProfile; delete?: boolean };
        };
      }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        const { codingProfile, ...agentData } = data;
        const updated = {
          ...row,
          ...agentData,
          codingProfile: codingProfile?.delete
            ? null
            : (codingProfile?.create ?? codingProfile?.update ?? row.codingProfile),
        };
        rows.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        rows.delete(where.id);
        return row;
      },
    },
    agentTool: {
      count: async ({ where }: { where: { agentId: string } }) => rows.get(where.agentId)?.tools.length ?? 0,
    },
  };
  const db = {
    ...transactionDb,
    $transaction: async <T>(callback: (tx: typeof transactionDb) => Promise<T>) => callback(transactionDb),
  };
  return db as unknown as import("@prisma/client").PrismaClient;
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
  const server = mcp.factory({ era: "modern" }) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("agent CRUD tools", () => {
  it("create_agent persists with owner = caller", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "greeter", systemPrompt: "be nice", model: "gpt-4o", budgetUsd: 5 },
    });
    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.name).toBe("greeter");
    expect(created.ownerId).toBe("p1");
    expect(created.kind).toBe("native");
    expect(created.codingProfile).toBeNull();

    await client.close();
  });

  it("create_agent atomically creates a normalized coding profile", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: {
        name: "coder",
        systemPrompt: "Make the requested change.",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: {
          repository: "OpenAI/Example.git",
          baseRef: "refs/heads/main",
          allowedEgress: ["Registry.NPMJS.org"],
        },
      },
    });

    expect(result.isError).toBeFalsy();
    const created = JSON.parse((result.content as { text: string }[])[0].text);
    expect(created.kind).toBe("coding");
    expect(created.codingProfile).toMatchObject({
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      timeoutSec: 1800,
      allowedEgress: ["registry.npmjs.org"],
    });
    await client.close();
  });

  it.each([
    {
      label: "missing profile",
      arguments: { kind: "coding" },
    },
    {
      label: "scheduled without a default task",
      arguments: { kind: "coding", schedule: "0 * * * *", codingProfile: { repository: "openai/example" } },
    },
    {
      label: "profile on a native agent",
      arguments: { codingProfile: { repository: "openai/example" } },
    },
    {
      label: "credentialed repository",
      arguments: { kind: "coding", codingProfile: { repository: "https://token@github.com/openai/example" } },
    },
  ])("create_agent rejects $label", async ({ arguments: extra }) => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "coder", systemPrompt: "code", model: "gpt-5.6-luna", budgetUsd: 1, ...extra },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("update_agent transitions native to coding and coding back to native atomically", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const toCoding = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", kind: "coding", codingProfile: { repository: "OpenAI/Example" } },
    });
    expect(toCoding.isError).toBeFalsy();
    expect(JSON.parse((toCoding.content as { text: string }[])[0].text)).toMatchObject({
      kind: "coding",
      codingProfile: { repository: "openai/example" },
    });

    const toNative = await client.callTool({ name: "update_agent", arguments: { id: "a1", kind: "native" } });
    expect(toNative.isError).toBeFalsy();
    expect(JSON.parse((toNative.content as { text: string }[])[0].text)).toMatchObject({
      kind: "native",
      codingProfile: null,
    });
    await client.close();
  });

  it("update_agent rejects a coding transition while native tools remain attached", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [{}],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);
    const result = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", kind: "coding", codingProfile: { repository: "openai/example" } },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/attached|tool/i);
    await client.close();
  });

  it("update_agent validates a merged coding profile and preserves schedule invariants", async () => {
    const profile: FakeCodingProfile = {
      provider: "codex",
      repository: "openai/example",
      baseRef: "main",
      defaultTask: "Keep dependencies current.",
      timeoutSec: 1800,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
    };
    const db = fakeDb([
      {
        id: "a1",
        name: "agent",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: "0 * * * *",
        timezone: "UTC",
        scheduleEnabled: true,
        ownerId: "p1",
        tools: [],
        kind: "coding",
        codingProfile: profile,
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const updated = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { repository: "OpenAI/Other.git", timeoutSec: 600 } },
    });
    expect(updated.isError).toBeFalsy();
    expect(JSON.parse((updated.content as { text: string }[])[0].text).codingProfile).toMatchObject({
      repository: "openai/other",
      timeoutSec: 600,
      defaultTask: "Keep dependencies current.",
    });

    const unsafeClear = await client.callTool({
      name: "update_agent",
      arguments: { id: "a1", codingProfile: { defaultTask: null } },
    });
    expect(unsafeClear.isError).toBe(true);
    expect(JSON.stringify(unsafeClear)).toMatch(/default task/i);
    await client.close();
  });

  it("create_agent without agents:write scope is rejected (insufficient_scope, not forbidden)", async () => {
    const db = fakeDb();
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_agent",
      arguments: { name: "x", systemPrompt: "x", model: "x", budgetUsd: 1 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/scope/i);
    await client.close();
  });

  it("update_agent by a non-owner is forbidden", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "shared",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "owner-1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "update_agent", arguments: { id: "a1", systemPrompt: "hacked" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/owned|forbidden/i);
    await client.close();
  });

  it("delete_agent by a non-owner is forbidden", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "shared",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "owner-1",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "not-the-owner", ["agents:write"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "delete_agent", arguments: { id: "a1" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("list_agents returns caller's own agents plus public (null-owner) ones, not other owners'", async () => {
    const db = fakeDb([
      {
        id: "a1",
        name: "mine",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p1",
        tools: [],
      },
      {
        id: "a2",
        name: "public",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: null,
        tools: [],
      },
      {
        id: "a3",
        name: "someone-elses",
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        maxTurns: 10,
        schedule: null,
        timezone: "UTC",
        ownerId: "p2",
        tools: [],
      },
    ]);
    const mcp = buildMcpServer({ providers: fakeProviders, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, "p1", ["agents:read"]));
    registerAgentTools(mcp);
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "list_agents", arguments: {} });
    expect(result.isError).toBeFalsy();
    const list = JSON.parse((result.content as { text: string }[])[0].text) as { name: string }[];
    const names = list.map((a) => a.name).sort();
    expect(names).toEqual(["mine", "public"]);
    await client.close();
  });
});
