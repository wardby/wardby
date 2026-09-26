import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerSecretsTools } from "./secrets.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";
import type { SecretCipher } from "../../providers/secrets/types.js";

const CANONICAL_URI = "https://host/mcp";

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

interface FakeSecretRow {
  id: string;
  name: string;
  ciphertext: string;
  keyId: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeAgentRow {
  id: string;
  ownerId: string | null;
}

function fakeDb(agents: FakeAgentRow[] = [], grants: FakeGrantSeed[] = []) {
  const secrets = new Map<string, FakeSecretRow>();
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const agentSecrets: { agentId: string; secretId: string }[] = [];
  const elicitationOutcomes = new Map<
    string,
    { ownerId: string; secretName: string; outcome: unknown; expiresAt: Date }
  >();
  let counter = 0;

  return {
    resourceGrant: fakeResourceGrants(grants),
    agentSecretRows: agentSecrets,
    secret: {
      create: async ({ data }: { data: Partial<FakeSecretRow> & { name: string } }) => {
        const now = new Date();
        const row: FakeSecretRow = {
          id: `secret_${++counter}`,
          createdAt: now,
          updatedAt: now,
          ownerId: null,
          ...data,
        } as FakeSecretRow;
        secrets.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: { where: { ownerId: string } }) =>
        [...secrets.values()].filter((s) => s.ownerId === where.ownerId),
      findUnique: async ({ where }: { where: { id?: string; ownerId_name?: { ownerId: string; name: string } } }) => {
        if (where.id !== undefined) return secrets.get(where.id) ?? null;
        return (
          [...secrets.values()].find(
            (s) => s.ownerId === where.ownerId_name!.ownerId && s.name === where.ownerId_name!.name,
          ) ?? null
        );
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { ownerId_name: { ownerId: string; name: string } };
        create: Partial<FakeSecretRow> & { name: string };
        update: Partial<FakeSecretRow>;
      }) => {
        const existing = [...secrets.values()].find(
          (s) => s.ownerId === where.ownerId_name.ownerId && s.name === where.ownerId_name.name,
        );
        if (existing) {
          const row = { ...existing, ...update, updatedAt: new Date() };
          secrets.set(row.id, row);
          return row;
        }
        const now = new Date();
        const row: FakeSecretRow = {
          id: `secret_${++counter}`,
          createdAt: now,
          updatedAt: now,
          ownerId: null,
          ...create,
        } as FakeSecretRow;
        secrets.set(row.id, row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = secrets.get(where.id);
        secrets.delete(where.id);
        return row;
      },
    },
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    agentSecret: {
      create: async ({ data }: { data: { agentId: string; secretId: string } }) => {
        agentSecrets.push(data);
        return data;
      },
      deleteMany: async ({
        where,
      }: {
        where: { agentId: string; secretId?: string; boundName?: string; secret?: { name: string } };
      }) => {
        const matches = (a: { agentId: string; secretId: string; boundName?: string }) =>
          a.agentId === where.agentId &&
          (where.secretId === undefined || a.secretId === where.secretId) &&
          (where.boundName === undefined || a.boundName === where.boundName) &&
          (where.secret === undefined || secrets.get(a.secretId)?.name === where.secret.name);
        const before = agentSecrets.length;
        const kept = agentSecrets.filter((a) => !matches(a));
        agentSecrets.length = 0;
        agentSecrets.push(...kept);
        return { count: before - kept.length };
      },
      findFirst: async ({ where }: { where: { agentId: string; secret: { name: string } } }) => {
        const match = agentSecrets.find(
          (a) => a.agentId === where.agentId && secrets.get(a.secretId)?.name === where.secret.name,
        );
        return match ? { ...match, secret: secrets.get(match.secretId) } : null;
      },
    },
    secretElicitationOutcome: {
      findUnique: async ({
        where: { ownerId_secretName },
      }: {
        where: { ownerId_secretName: { ownerId: string; secretName: string } };
      }) => elicitationOutcomes.get(`${ownerId_secretName.ownerId}\0${ownerId_secretName.secretName}`) ?? null,
      upsert: async ({
        where: { ownerId_secretName },
        create,
        update,
      }: {
        where: { ownerId_secretName: { ownerId: string; secretName: string } };
        create: { ownerId: string; secretName: string; outcome: unknown; expiresAt: Date };
        update: { outcome: unknown; expiresAt: Date };
      }) => {
        const key = `${ownerId_secretName.ownerId}\0${ownerId_secretName.secretName}`;
        const existing = elicitationOutcomes.get(key);
        const row = existing ? { ...existing, ...update } : create;
        elicitationOutcomes.set(key, row);
        return row;
      },
      deleteMany: async ({ where: { expiresAt } }: { where: { expiresAt: { lte: Date } } }) => {
        let count = 0;
        for (const [key, row] of elicitationOutcomes) {
          if (row.expiresAt <= expiresAt.lte) {
            elicitationOutcomes.delete(key);
            count++;
          }
        }
        return { count };
      },
    },
  } as unknown as import("#prisma").PrismaClient;
}

function fakeCtx(
  db: ReturnType<typeof fakeDb>,
  cipher: SecretCipher,
  principalId: string,
  scopes: string[],
  extra: Partial<McpRequestContext> = {},
): McpRequestContext {
  return {
    ...extra,
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: { secrets: cipher } as never,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(
  mcp: ReturnType<typeof buildMcpServer>,
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
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("secrets tools", () => {
  it("create_secret requires secrets:write and never returns the value", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "create_secret",
      arguments: { name: "API_KEY", value: "sk-live-abc123" },
    });
    expect(result.isError).toBeFalsy();
    const body = parseText(result as never) as Record<string, unknown>;
    expect(body).not.toHaveProperty("value");
    expect(body).not.toHaveProperty("ciphertext");
    expect(JSON.stringify(body)).not.toContain("sk-live-abc123");
    await client.close();
  });

  it("create_secret without secrets:write is rejected", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["agents:read"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);

    const result = await client.callTool({ name: "create_secret", arguments: { name: "API_KEY", value: "x" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("list_secrets never returns the value", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);

    await client.callTool({ name: "create_secret", arguments: { name: "API_KEY", value: "sk-live-abc123" } });
    const listed = await client.callTool({ name: "list_secrets", arguments: {} });
    const list = parseText(listed as never) as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(JSON.stringify(list)).not.toContain("sk-live-abc123");
    await client.close();
  });

  it("attach_secret by a non-owner of the agent is forbidden", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "someone-else" }]);
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);

    await client.callTool({ name: "create_secret", arguments: { name: "API_KEY", value: "sk-live-abc123" } });
    const result = await client.callTool({ name: "attach_secret", arguments: { agentId: "a1", name: "API_KEY" } });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("A2/S2-2: a write-grantee, the stdio operator and anyone on an owner-less agent can't bind a secret", async () => {
    const db = fakeDb(
      [
        { id: "a-shared", ownerId: "owner" },
        { id: "a-ownerless", ownerId: null },
      ],
      [
        { resourceType: "agent", resourceId: "a-shared", principalId: "p1", level: "write" },
        { resourceType: "agent", resourceId: "a-ownerless", granteeKind: "everyone", level: "execute" },
      ],
    );
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);
    for (const extra of [{}, { operator: true }]) {
      mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"], extra));
      await client.callTool({ name: "create_secret", arguments: { name: "API_KEY", value: "sk-live-abc123" } });
      for (const agentId of ["a-shared", "a-ownerless"]) {
        const result = await client.callTool({ name: "attach_secret", arguments: { agentId, name: "API_KEY" } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toMatch(/owner/);
      }
    }
    expect((db as unknown as { agentSecretRows: unknown[] }).agentSecretRows).toEqual([]);
    await client.close();
  });

  it("the agent owner can detach a secret binding another owner's secret left on the agent", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    (db as unknown as { agentSecretRows: unknown[] }).agentSecretRows.push({
      agentId: "a1",
      secretId: "foreign",
      boundName: "TOKEN",
    });
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);
    const result = await client.callTool({ name: "detach_secret", arguments: { agentId: "a1", name: "TOKEN" } });
    expect(result.isError).toBeFalsy();
    expect((db as unknown as { agentSecretRows: unknown[] }).agentSecretRows).toEqual([]);
    await client.close();
  });

  it("attach_secret + delete_secret round-trip for the owner", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);

    const created = await client.callTool({
      name: "create_secret",
      arguments: { name: "API_KEY", value: "sk-live-abc123" },
    });
    const { id } = parseText(created as never) as { id: string };

    const attached = await client.callTool({ name: "attach_secret", arguments: { agentId: "a1", name: "API_KEY" } });
    expect(attached.isError).toBeFalsy();

    const deleted = await client.callTool({ name: "delete_secret", arguments: { id } });
    expect(deleted.isError).toBeFalsy();

    const listed = await client.callTool({ name: "list_secrets", arguments: {} });
    expect(parseText(listed as never)).toEqual([]);
    await client.close();
  });

  it("detach_secret accepts the alias or the secret's own name, and errors when nothing is attached", async () => {
    const db = fakeDb([{ id: "a1", ownerId: "p1" }]);
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);
    await client.callTool({ name: "create_secret", arguments: { name: "REVIEW_TOKEN", value: "ghp-abc" } });

    await client.callTool({
      name: "attach_secret",
      arguments: { agentId: "a1", name: "REVIEW_TOKEN", alias: "GITHUB_TOKEN" },
    });
    const byName = await client.callTool({ name: "detach_secret", arguments: { agentId: "a1", name: "REVIEW_TOKEN" } });
    expect(parseText(byName as never)).toEqual({ detached: true, count: 1 });

    await client.callTool({
      name: "attach_secret",
      arguments: { agentId: "a1", name: "REVIEW_TOKEN", alias: "GITHUB_TOKEN" },
    });
    const byAlias = await client.callTool({
      name: "detach_secret",
      arguments: { agentId: "a1", name: "GITHUB_TOKEN" },
    });
    expect(parseText(byAlias as never)).toEqual({ detached: true, count: 1 });

    const again = await client.callTool({ name: "detach_secret", arguments: { agentId: "a1", name: "GITHUB_TOKEN" } });
    expect(again.isError).toBe(true);
    expect((again.content as { text: string }[])[0].text).toContain(
      'No secret is attached to agent "a1" as "GITHUB_TOKEN"',
    );
    await client.close();
  });

  it("[protocolElicitation: true] create_secret without a value elicits it via a one-time browser URL, then succeeds once submitted", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: true,
    });
    const client = await connectClient(mcp, { elicitation: { url: {} } });

    let visitedUrl: string | undefined;
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as { mode?: string; url?: string };
      if (params.mode === "url" && params.url) {
        visitedUrl = params.url;
        // Simulates the user's browser POSTing the form directly against the
        // server's secret store — the point under test is create_secret's
        // handler branches, not the HTTP form itself (covered separately).
        const token = new URL(params.url).searchParams.get("t")!;
        const payload = await mcp.verifyRequestState<{ ownerId: string; secretName: string }>(token);
        const { fulfillSecretElicitation } = await import("./secret-elicitation.js");
        await fulfillSecretElicitation(payload, "sk-live-abc123", cipher, db);
      }
      return { action: "accept" };
    });

    const result = await client.callTool({ name: "create_secret", arguments: { name: "API_KEY" } });
    expect(result.isError).toBeFalsy();
    expect(visitedUrl).toContain("https://test.invalid/elicit/secret?t=");
    const body = parseText(result as never) as { name: string };
    expect(body.name).toBe("API_KEY");
    expect(JSON.stringify(body)).not.toContain("sk-live-abc123");

    const listed = await client.callTool({ name: "list_secrets", arguments: {} });
    expect((parseText(listed as never) as unknown[]).length).toBe(1);
    await client.close();
  });

  it("[protocolElicitation: true] create_secret without a value surfaces a clear error if the user declines", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: true,
    });
    const client = await connectClient(mcp, { elicitation: { url: {} } });
    client.setRequestHandler("elicitation/create", async () => ({ action: "decline" }));

    const result = await client.callTool({ name: "create_secret", arguments: { name: "DECLINED_KEY" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/declined/i);
    await client.close();
  });

  it("[default: polling] create_secret without a value returns a plain link, then a plain 'still pending' link, then succeeds once submitted", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const mcp = buildMcpServer({
      providers: { secrets: cipher } as never,
      db,
      config: { canonicalUri: CANONICAL_URI },
    });
    mcp.setFixedContext(fakeCtx(db, cipher, "p1", ["secrets:write"]));
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token: string) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation: false,
    });
    const client = await connectClient(mcp);

    const first = await client.callTool({ name: "create_secret", arguments: { name: "POLL_KEY" } });
    expect(first.isError).toBeFalsy();
    const firstBody = parseText(first as never) as { status: string; url: string };
    expect(firstBody.status).toBe("pending");
    expect(firstBody.url).toContain("https://test.invalid/elicit/secret?t=");

    // No plain-text/manual protocol feature is needed here — a second call
    // before the "browser" ever submits just reports pending again.
    const second = await client.callTool({ name: "create_secret", arguments: { name: "POLL_KEY" } });
    expect((parseText(second as never) as { status: string }).status).toBe("pending");

    const token = new URL(firstBody.url).searchParams.get("t")!;
    const payload = await mcp.verifyRequestState<{ ownerId: string; secretName: string }>(token);
    const { fulfillSecretElicitation } = await import("./secret-elicitation.js");
    await fulfillSecretElicitation(payload, "sk-live-abc123", cipher, db);

    const third = await client.callTool({ name: "create_secret", arguments: { name: "POLL_KEY" } });
    expect(third.isError).toBeFalsy();
    const thirdBody = parseText(third as never) as { name: string };
    expect(thirdBody.name).toBe("POLL_KEY");
    expect(JSON.stringify(thirdBody)).not.toContain("sk-live-abc123");
    await client.close();
  });
});
