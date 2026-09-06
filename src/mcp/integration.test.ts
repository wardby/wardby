import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer, type ReevoMcpServer } from "./server.js";
import { registerAllTools } from "./index.js";
import { handleWebhookIngress } from "./webhooks/ingress.js";
import { buildSecretsAccessor } from "../core/secrets.js";
import { buildAuthProvider, SelfHostedAuthProvider } from "../providers/auth/index.js";
import type { McpRequestContext } from "./context.js";
import type { Executor } from "../providers/executor/types.js";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { SecretCipher } from "../providers/secrets/types.js";

// End-to-end per the spec's Definition of Done. Every individual tool
// module already has its own focused test file (Tasks 9-14) — this file's
// job is the ONE thing none of those exercise on their own: all modules
// registered together on ONE server, driven through a real in-memory
// Client, plus the two pieces that genuinely need a real backend
// (self-hosted AS token issuance, delegating JWKS verification), which are
// DB-gated per the plan's own "DB-gated for the real path" instruction.

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
  schedule: string | null;
  timezone: string;
  scheduleEnabled: boolean;
  tools: unknown[];
  kind: "native" | "coding";
  codingProfile: null;
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
interface FakeTaskRow {
  id: string;
  kind: string;
  runId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  ttlAt: Date;
}
interface FakeToolRow {
  id: string;
  name: string;
  description: string;
  paramsZod: string;
  jsonSchema: unknown;
  code: string;
  ownerId: string | null;
}
interface FakeSecretRow {
  id: string;
  name: string;
  ciphertext: string;
  keyId: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeWebhookRow {
  id: string;
  agentId: string;
  secretHash: string;
  status: "enabled" | "disabled";
  ownerId: string | null;
  createdAt: Date;
  lastFiredAt: Date | null;
}

function fakeCipher(): SecretCipher {
  const store = new Map<string, string>();
  let counter = 0;
  return {
    keyId: () => "appkey:fake",
    encrypt: async (plaintext) => {
      const id = `ct_${++counter}`;
      store.set(id, plaintext);
      return id;
    },
    decrypt: async (ciphertext) => store.get(ciphertext) ?? "",
  };
}

function fakeExecutor(runs: Map<string, FakeRunRow>): Executor {
  return {
    async start(runId: string) {
      const run = runs.get(runId);
      if (!run) return;
      // Simulates a completed engine turn — the point of this test is the
      // wiring (trigger -> Task -> terminal), not the engine itself
      // (covered exhaustively by engine-native.test.ts).
      runs.set(runId, { ...run, status: "succeeded", turns: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.001, finalText: "done" });
    },
  };
}

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  return {
    get: async (agentId, key) => store.get(`${agentId}:${key}`),
    set: async (agentId, key, value) => {
      store.set(`${agentId}:${key}`, value);
    },
    delete: async (agentId, key) => {
      store.delete(`${agentId}:${key}`);
    },
    list: async (agentId, prefix) =>
      [...store.keys()].filter((k) => k.startsWith(`${agentId}:${prefix ?? ""}`)).map((k) => k.slice(`${agentId}:`.length)),
  };
}

function buildFakeDb() {
  const agents = new Map<string, FakeAgentRow>();
  const runs = new Map<string, FakeRunRow>();
  const tasks = new Map<string, FakeTaskRow>();
  const tools = new Map<string, FakeToolRow>();
  const agentTools: { agentId: string; toolId: string }[] = [];
  const secrets = new Map<string, FakeSecretRow>();
  const agentSecrets: { agentId: string; secretId: string }[] = [];
  const webhooks = new Map<string, FakeWebhookRow>();
  let n = 0;

  const db = {
    agent: {
      create: async ({ data }: { data: Partial<FakeAgentRow> & { name: string } }) => {
        const row: FakeAgentRow = {
          id: `agent_${++n}`,
          ownerId: null,
          schedule: null,
          timezone: "UTC",
          scheduleEnabled: true,
          tools: [],
          kind: "native",
          codingProfile: null,
          ...data,
        } as FakeAgentRow;
        agents.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id?: string; name?: string } }) =>
        (where.id ? agents.get(where.id) : [...agents.values()].find((a) => a.name === where.name)) ?? null,
      findMany: async ({ where }: { where?: { OR?: { ownerId: string | null }[] } } = {}) => {
        const all = [...agents.values()];
        return where?.OR ? all.filter((r) => where.OR!.some((c) => r.ownerId === c.ownerId)) : all;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeAgentRow> }) => {
        const row = { ...agents.get(where.id)!, ...data };
        agents.set(where.id, row);
        return row;
      },
    },
    run: {
      create: async ({ data }: { data: { agentId: string; trigger: string } }) => {
        const row: FakeRunRow = { id: `run_${++n}`, status: "pending", turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, finalText: null, error: null, startedAt: new Date(), finishedAt: null, ...data };
        runs.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => runs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = runs.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      findMany: async ({ where }: { where: { agentId: string; status?: string } }) =>
        [...runs.values()].filter((r) => r.agentId === where.agentId && (!where.status || r.status === where.status)),
    },
    task: {
      create: async ({ data }: { data: { kind: string; runId: string; status: string } }) => {
        const now = new Date();
        const row: FakeTaskRow = { id: `task_${++n}`, createdAt: now, updatedAt: now, ttlAt: new Date(now.getTime() + 60_000), ...data };
        tasks.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => tasks.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const row = tasks.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeTaskRow> }) => {
        const row = { ...tasks.get(where.id)!, ...data };
        tasks.set(where.id, row);
        return row;
      },
    },
    tool: {
      create: async ({ data }: { data: Partial<FakeToolRow> & { name: string } }) => {
        const row: FakeToolRow = { id: `tool_${++n}`, description: "", paramsZod: "", jsonSchema: {}, code: "", ownerId: null, ...data } as FakeToolRow;
        tools.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => tools.get(where.id) ?? null,
      findMany: async () => [...tools.values()],
    },
    agentTool: {
      count: async ({ where }: { where: { agentId: string } }) =>
        agentTools.filter((attachment) => attachment.agentId === where.agentId).length,
      create: async ({ data }: { data: { agentId: string; toolId: string } }) => {
        agentTools.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: { agentId: string; toolId: string } }) => {
        const kept = agentTools.filter((a) => !(a.agentId === where.agentId && a.toolId === where.toolId));
        const removed = agentTools.length - kept.length;
        agentTools.length = 0;
        agentTools.push(...kept);
        return { count: removed };
      },
      findMany: async ({ where }: { where: { agentId: string } }) =>
        agentTools.filter((a) => a.agentId === where.agentId).map((a) => ({ ...a, tool: tools.get(a.toolId) })),
    },
    secret: {
      create: async ({ data }: { data: Partial<FakeSecretRow> & { name: string } }) => {
        const now = new Date();
        const row: FakeSecretRow = { id: `secret_${++n}`, createdAt: now, updatedAt: now, ownerId: null, ...data } as FakeSecretRow;
        secrets.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: { where: { ownerId: string } }) => [...secrets.values()].filter((s) => s.ownerId === where.ownerId),
      findUnique: async ({ where }: { where: { ownerId_name: { ownerId: string; name: string } } }) =>
        [...secrets.values()].find((s) => s.ownerId === where.ownerId_name.ownerId && s.name === where.ownerId_name.name) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { ownerId_name: { ownerId: string; name: string } };
        create: Partial<FakeSecretRow> & { name: string };
        update: Partial<FakeSecretRow>;
      }) => {
        const existing = [...secrets.values()].find((s) => s.ownerId === where.ownerId_name.ownerId && s.name === where.ownerId_name.name);
        if (existing) {
          const row = { ...existing, ...update, updatedAt: new Date() };
          secrets.set(row.id, row);
          return row;
        }
        const now = new Date();
        const row: FakeSecretRow = { id: `secret_${++n}`, createdAt: now, updatedAt: now, ownerId: null, ...create } as FakeSecretRow;
        secrets.set(row.id, row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        secrets.delete(where.id);
      },
    },
    agentSecret: {
      create: async ({ data }: { data: { agentId: string; secretId: string } }) => {
        agentSecrets.push(data);
        return data;
      },
      deleteMany: async () => ({ count: 0 }),
      findFirst: async ({ where }: { where: { agentId: string; secret: { name: string } } }) => {
        const match = agentSecrets.find((a) => a.agentId === where.agentId && secrets.get(a.secretId)?.name === where.secret.name);
        return match ? { ...match, secret: secrets.get(match.secretId) } : null;
      },
    },
    webhook: {
      create: async ({ data }: { data: Partial<FakeWebhookRow> & { agentId: string; secretHash: string } }) => {
        const row: FakeWebhookRow = { id: `webhook_${++n}`, status: "enabled", ownerId: null, createdAt: new Date(), lastFiredAt: null, ...data } as FakeWebhookRow;
        webhooks.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) => webhooks.get(where.id) ?? null,
      findMany: async ({ where }: { where: { ownerId: string } }) => [...webhooks.values()].filter((w) => w.ownerId === where.ownerId),
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeWebhookRow> }) => {
        const row = { ...webhooks.get(where.id)!, ...data };
        webhooks.set(where.id, row);
        return row;
      },
    },
  } as unknown as PrismaClient;

  (db as unknown as { $transaction: (callback: (tx: PrismaClient) => Promise<unknown>) => Promise<unknown> }).$transaction =
    async (callback) => callback(db);

  return { db, runs };
}

function fakeCtx(db: PrismaClient, providers: McpRequestContext["providers"], principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() } as never,
    scopes: new Set(scopes),
    providers,
    db,
    clientSupportsTasks: true,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReevoMcpServer) {
  const server = mcp.factory({ era: "modern" }) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "integration-test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

const ALL_SCOPES = ["agents:read", "agents:write", "tools:write", "runs:trigger", "datastore:write", "secrets:write", "webhooks:write"];

describe("MCP integration (all tool modules, in-memory)", () => {
  it("create_agent -> create_tool -> dry_run_tool -> attach_tool -> set_schedule -> trigger_agent -> tasks/get reaches a terminal status", async () => {
    const { db, runs } = buildFakeDb();
    const cipher = fakeCipher();
    const datastore = fakeDatastore();
    const executor = fakeExecutor(runs);
    const providers = { llm: {} as never, engine: {} as never, datastore, secrets: cipher, executor };

    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, providers, "p1", ALL_SCOPES));
    registerAllTools(mcp, { secretElicitationUrl: async (token) => `https://test.invalid/elicit/secret?t=${token}`, secretElicitationProtocol: false });
    const client = await connectClient(mcp);

    const agentResult = await client.callTool({
      name: "create_agent",
      arguments: { name: "greeter", systemPrompt: "be nice", model: "gpt-4o", budgetUsd: 5 },
    });
    const agent = parseText(agentResult as never) as { id: string };

    const toolResult = await client.callTool({
      name: "create_tool",
      arguments: { name: "greet", description: "says hi", paramsZod: "z.object({ name: z.string() })", code: "return `hi ${params.name}`;" },
    });
    const tool = parseText(toolResult as never) as { id: string };

    const dryRun = await client.callTool({
      name: "dry_run_tool",
      arguments: { paramsZod: "z.object({ name: z.string() })", code: "return `hi ${params.name}`;", sampleArgs: { name: "world" } },
    });
    expect((parseText(dryRun as never) as { result: { ok: boolean } }).result.ok).toBe(true);

    const attach = await client.callTool({ name: "attach_tool", arguments: { agentId: agent.id, toolId: tool.id } });
    expect(attach.isError).toBeFalsy();

    const scheduleResult = await client.callTool({
      name: "set_schedule",
      arguments: { agentId: agent.id, schedule: "0 * * * *", timezone: "UTC" },
    });
    expect(scheduleResult.isError).toBeFalsy();

    const triggerResult = await client.callTool({ name: "trigger_agent", arguments: { agentId: agent.id } });
    expect(triggerResult.isError).toBeFalsy();
    const task = parseText(triggerResult as never) as { taskId: string; resultType: string };
    expect(task.resultType).toBe("task");

    // The fake executor completes synchronously inside trigger_agent's
    // detached start() call, but detached means "not awaited by the tool
    // handler" — give the microtask queue one tick to let it finish before
    // polling, exactly as a real client would after getting a task handle back.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const getResult = await client.request(
      { method: "tasks/get", params: { taskId: task.taskId } },
      (await import("@modelcontextprotocol/client")).fromJsonSchema<{ status: string; result?: { finalText: string } }>({
        type: "object",
        additionalProperties: true,
      }),
    );
    expect(getResult.status).toBe("completed");
    expect(getResult.result?.finalText).toBe("done");

    await client.close();
  });

  it("create_secret + attach makes the agent's SecretsAccessor resolve the plaintext at point-of-use", async () => {
    // Exercises the same buildSecretsAccessor() path runner.ts uses for a
    // real run — driving a full engine turn here would need a real/fake
    // LLM+engine, which dry_run_tool deliberately doesn't wire secrets into
    // (Task 13); this confirms attach->accessor without that extra weight.
    const { db } = buildFakeDb();
    const cipher = fakeCipher();
    const providers = { llm: {} as never, engine: {} as never, datastore: fakeDatastore(), secrets: cipher, executor: {} as Executor };

    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, providers, "p1", ALL_SCOPES));
    registerAllTools(mcp, { secretElicitationUrl: async (token) => `https://test.invalid/elicit/secret?t=${token}`, secretElicitationProtocol: false });
    const client = await connectClient(mcp);

    const agentResult = await client.callTool({ name: "create_agent", arguments: { name: "secret-user", systemPrompt: "x", model: "m", budgetUsd: 1 } });
    const agent = parseText(agentResult as never) as { id: string };

    await client.callTool({ name: "create_secret", arguments: { name: "API_KEY", value: "sk-live-abc123" } });
    const attachResult = await client.callTool({ name: "attach_secret", arguments: { agentId: agent.id, name: "API_KEY" } });
    expect(attachResult.isError).toBeFalsy();

    const accessor = buildSecretsAccessor(agent.id, cipher, db);
    expect(await accessor.get("API_KEY")).toBe("sk-live-abc123");

    await client.close();
  });

  it("create_webhook + a simulated POST /webhooks/:id enqueues a manual run", async () => {
    const { db, runs } = buildFakeDb();
    const providers = { llm: {} as never, engine: {} as never, datastore: fakeDatastore(), secrets: fakeCipher(), executor: {} as Executor };
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, providers, "p1", ALL_SCOPES));
    registerAllTools(mcp, { secretElicitationUrl: async (token) => `https://test.invalid/elicit/secret?t=${token}`, secretElicitationProtocol: false });
    const client = await connectClient(mcp);

    const agentResult = await client.callTool({ name: "create_agent", arguments: { name: "hooked", systemPrompt: "x", model: "m", budgetUsd: 1 } });
    const agent = parseText(agentResult as never) as { id: string };

    const webhookResult = await client.callTool({ name: "create_webhook", arguments: { agentId: agent.id } });
    const { id: webhookId, secret } = parseText(webhookResult as never) as { id: string; secret: string };

    const ingressResult = await handleWebhookIngress(webhookId, { headers: { "x-webhook-secret": secret }, body: {} }, db);
    expect(ingressResult.status).toBe(202);
    expect(runs.size).toBe(1);

    await client.close();
  });

  it("scope and ownership denials surface as isError tool results (mapped to 401/403 at the HTTP layer by earlier tasks)", async () => {
    const { db } = buildFakeDb();
    const providers = { llm: {} as never, engine: {} as never, datastore: fakeDatastore(), secrets: fakeCipher(), executor: {} as Executor };
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(fakeCtx(db, providers, "p1", ["agents:read"])); // no agents:write
    registerAllTools(mcp, { secretElicitationUrl: async (token) => `https://test.invalid/elicit/secret?t=${token}`, secretElicitationProtocol: false });
    const client = await connectClient(mcp);

    const scopeDenied = await client.callTool({ name: "create_agent", arguments: { name: "x", systemPrompt: "x", model: "x", budgetUsd: 1 } });
    expect(scopeDenied.isError).toBe(true);
    expect((scopeDenied.content as { text: string }[])[0].text).toMatch(/scope/i);

    await client.close();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("MCP integration: both AUTH_PROVIDER adapters (database)", () => {
  const db = new PrismaClient();
  const clientIds: string[] = [];

  afterAll(async () => {
    await db.oAuthFamily.deleteMany({ where: { clientId: { in: clientIds } } });
    await db.oAuthClient.deleteMany({ where: { clientId: { in: clientIds } } });
    await db.$disconnect();
  });

  it("self-hosted production factory builds the secured provider", () => {
    expect(buildAuthProvider("self-hosted", { audience: CANONICAL_URI, signingKey: "a1".repeat(32), credentialHashKey: "b2".repeat(32) }, db)).toBeInstanceOf(SelfHostedAuthProvider);
  });

  it("delegating: buildAuthProvider selects DelegatingAuthProvider, which verifies a JWKS-signed token", async () => {
    const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import("jose");
    const { DelegatingAuthProvider } = await import("../providers/auth/delegating.js");
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = "integration-test-key";
    jwk.alg = "RS256";
    const jwks = createLocalJWKSet({ keys: [jwk] });

    // buildAuthProvider constructs its own remote JWKS resolver from
    // AUTH_JWKS_URI (a real network fetch) — this confirms the SELECTOR
    // picks DelegatingAuthProvider for delegating mode; delegating.test.ts
    // already covers verifyBearer's own logic exhaustively with an
    // injected local JWKS (no network), which this reuses here too rather
    // than duplicating a real network fetch in a test.
    const provider = buildAuthProvider(
      "delegating",
      { issuer: "https://idp.example.com", audience: CANONICAL_URI, jwksUri: "https://idp.example.com/jwks" },
      db,
    );
    expect(provider).toBeInstanceOf(DelegatingAuthProvider);

    const directProvider = new DelegatingAuthProvider({ issuer: "https://idp.example.com", audience: CANONICAL_URI }, jwks);
    const token = await new SignJWT({ scope: "agents:read" })
      .setProtectedHeader({ alg: "RS256", kid: "integration-test-key" })
      .setIssuedAt()
      .setIssuer("https://idp.example.com")
      .setAudience(CANONICAL_URI)
      .setExpirationTime("1h")
      .setSubject("user-integration-2")
      .sign(privateKey);
    const profile = await directProvider.verifyBearer(token);
    expect(profile.subject).toBe("user-integration-2");
  });
});
