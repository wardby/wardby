/**
 * Brokered secrets through the MCP surfaces against real Postgres: createSecret
 * with a broker and setSecretBroker run in transactions the fake dbs lack.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { createPrismaClient } from "../../core/db.js";
import type { SecretCipher } from "../../providers/secrets/types.js";
import type { McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerSecretsTools } from "./secrets.js";
import {
  fulfillSecretElicitation,
  fulfillUnbrokerElicitation,
  getSecretElicitationOutcome,
  type SecretElicitationPayload,
} from "./secret-elicitation.js";

const CANONICAL = "https://wardby.example/mcp";
const BROKER = {
  hosts: ["api.example.com"],
  placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
};
const VALUE = "sk-live-abc123";
const cipher: SecretCipher = { keyId: () => "test", encrypt: async (s) => s, decrypt: async (s) => s };

describe.skipIf(!process.env.DATABASE_URL)("brokered secrets over MCP (database)", () => {
  const db = createPrismaClient();
  const owners: string[] = [];
  const agents: string[] = [];
  const tools: string[] = [];

  afterAll(async () => {
    await db.agentTool.deleteMany({ where: { agentId: { in: agents } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agents } } });
    await db.tool.deleteMany({ where: { id: { in: tools } } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: owners } } });
    await db.secretElicitationOutcome.deleteMany({ where: { ownerId: { in: owners } } });
    await db.secret.deleteMany({ where: { ownerId: { in: owners } } });
    await db.principal.deleteMany({ where: { id: { in: owners } } });
    await db.$disconnect();
  });

  async function owner(): Promise<string> {
    const id = `broker-mcp-${randomUUID()}`;
    await db.principal.create({ data: { id, subject: id } });
    owners.push(id);
    return id;
  }

  async function connect(principalId: string, protocolElicitation = false) {
    const mcp = buildMcpServer({ providers: { secrets: cipher } as never, db, config: { canonicalUri: CANONICAL } });
    const ctx: McpRequestContext = {
      principal: { id: principalId, subject: principalId, createdAt: new Date() },
      scopes: new Set(["secrets:write"]),
      canonicalUri: CANONICAL,
      providers: { secrets: cipher } as never,
      db,
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    mcp.setFixedContext(ctx);
    registerSecretsTools(mcp, {
      buildElicitationUrl: async (token) => `https://test.invalid/elicit/secret?t=${token}`,
      protocolElicitation,
    });
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: "t", version: "1" },
      { versionNegotiation: { mode: "auto" }, capabilities: protocolElicitation ? { elicitation: { url: {} } } : {} },
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      const text = result.content[0].text;
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // error text stays a string
      }
      return { isError: Boolean(result.isError), text, body: body as Record<string, unknown> };
    };
    return { mcp, client, call };
  }

  const changes = (ownerId: string) =>
    db.secretBrokerChange.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });

  it("create_secret with value and broker creates a brokered secret, audited via mcp", async () => {
    const p = await owner();
    const { client, call } = await connect(p);
    const created = await call("create_secret", { name: "GH", value: VALUE, broker: BROKER });
    expect(created.isError).toBe(false);
    expect(created.body).toMatchObject({ name: "GH", broker: BROKER });
    expect(created.text).not.toContain(VALUE);

    const listed = await call("list_secrets");
    expect(listed.body).toEqual([expect.objectContaining({ name: "GH", broker: BROKER })]);
    expect(await changes(p)).toEqual([
      expect.objectContaining({ via: "mcp", actorId: p, before: null, after: BROKER }),
    ]);

    const short = await call("create_secret", { name: "SHORT", value: "abc", broker: BROKER });
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/secret_broker_value_invalid/);
    await client.close();
  });

  it("fulfillSecretElicitation saves the form's broker, audited via browser", async () => {
    const p = await owner();
    const payload: SecretElicitationPayload = { ownerId: p, secretName: "GH", kind: "create", broker: BROKER };
    const outcome = await fulfillSecretElicitation(payload, VALUE, cipher, db, BROKER);
    expect(outcome).toMatchObject({ ok: true, kind: "create", secret: { name: "GH", broker: BROKER } });
    expect(await changes(p)).toEqual([expect.objectContaining({ via: "browser", actorId: p, after: BROKER })]);

    // The polling create_secret retry reports the brokered secret.
    const { client, call } = await connect(p);
    const done = await call("create_secret", { name: "GH" });
    expect(done.body).toMatchObject({ name: "GH", broker: BROKER });
    await client.close();
  });

  it("set_secret_broker sets a config, warns about secrets.get() tools, and is owner-only", async () => {
    const p = await owner();
    const other = await owner();
    const agentId = `broker-mcp-agent-${randomUUID()}`;
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: p },
    });
    agents.push(agentId);
    const { client, call } = await connect(p);
    await call("create_secret", { name: "GH", value: VALUE });
    const secret = await db.secret.findUniqueOrThrow({ where: { ownerId_name: { ownerId: p, name: "GH" } } });
    await db.agentSecret.create({ data: { agentId, secretId: secret.id, boundName: "GITHUB" } });
    for (const [name, code] of [
      ["legacy", "export default async () => secrets.get('GITHUB')"],
      ["modern", "export default async () => fetch(u, { secrets: ['GITHUB'] })"],
    ]) {
      const tool = await db.tool.create({
        data: { name: `${name}-${randomUUID()}`, description: "", paramsZod: "z.object({})", jsonSchema: {}, code },
      });
      tools.push(tool.id);
      await db.agentTool.create({ data: { agentId, toolId: tool.id, allowedSecrets: ["GITHUB"] } });
    }

    const set = await call("set_secret_broker", { name: "GH", broker: BROKER });
    expect(set.isError).toBe(false);
    expect(set.body).toMatchObject({ name: "GH", before: null, broker: BROKER });
    const warnings = set.body.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^Tool "legacy-.*" reads secrets with secrets\.get\(\), but "GITHUB" is brokered/);
    expect((await call("list_secrets")).body).toEqual([expect.objectContaining({ name: "GH", broker: BROKER })]);
    expect(await changes(p)).toEqual([expect.objectContaining({ via: "mcp", actorId: p, after: BROKER })]);

    const theirs = await connect(other);
    const notFound = await theirs.call("set_secret_broker", {
      name: "GH",
      broker: { ...BROKER, hosts: ["evil.example"] },
    });
    expect(notFound.isError).toBe(true);
    expect(notFound.text).toMatch(/secret_not_found/);
    const notFoundNull = await theirs.call("set_secret_broker", { name: "GH", broker: null });
    expect(notFoundNull.text).toMatch(/secret_not_found/);
    expect((await call("list_secrets")).body).toEqual([expect.objectContaining({ broker: BROKER })]);
    await theirs.client.close();
    await client.close();
  });

  it("set_secret_broker with no warnings omits the warnings key", async () => {
    const p = await owner();
    const { client, call } = await connect(p);
    await call("create_secret", { name: "GH", value: VALUE });
    const set = await call("set_secret_broker", { name: "GH", broker: BROKER });
    expect(set.body).not.toHaveProperty("warnings");
    await client.close();
  });

  it("[polling] broker: null never removes directly: it waits for the browser confirmation", async () => {
    const p = await owner();
    const { mcp, client, call } = await connect(p);
    await call("create_secret", { name: "GH", value: VALUE, broker: BROKER });

    const first = await call("set_secret_broker", { name: "GH", broker: null });
    expect(first.body).toMatchObject({ status: "pending" });
    expect(first.body.message).toBe(
      'Open this link in your browser to confirm removing brokering for secret "GH", then call set_secret_broker again with broker: null to finish.',
    );
    const again = await call("set_secret_broker", { name: "GH", broker: null });
    expect(again.body).toMatchObject({ status: "pending" });
    expect((await call("list_secrets")).body).toEqual([expect.objectContaining({ broker: BROKER })]);

    const payload = await mcp.verifyRequestState<SecretElicitationPayload>(
      new URL(first.body.url as string).searchParams.get("t")!,
    );
    expect(payload).toEqual({ ownerId: p, secretName: "GH", kind: "unbroker" });
    // A create link can't stand in for the confirmation.
    expect(await fulfillSecretElicitation(payload, "other-value", cipher, db)).toMatchObject({ ok: false });
    expect(await fulfillUnbrokerElicitation({ ownerId: p, secretName: "GH" }, cipher, db)).toMatchObject({
      ok: false,
    });
    expect((await call("list_secrets")).body).toEqual([expect.objectContaining({ broker: BROKER })]);

    const confirmed = await fulfillUnbrokerElicitation(payload, cipher, db);
    expect(confirmed).toMatchObject({ ok: true, kind: "unbroker", secret: { name: "GH", broker: null } });
    // A resubmit returns the recorded outcome (stored as JSON, so dates come back as strings).
    expect(await fulfillUnbrokerElicitation(payload, cipher, db)).toEqual(JSON.parse(JSON.stringify(confirmed)));

    const done = await call("set_secret_broker", { name: "GH", broker: null });
    expect(done.body).toMatchObject({ unbrokered: true, secret: { name: "GH", broker: null } });
    expect(await changes(p)).toEqual([
      expect.objectContaining({ via: "mcp", after: BROKER }),
      expect.objectContaining({ via: "browser", actorId: p, before: BROKER, after: null }),
    ]);
    // The unbroker outcome never answers a create_secret retry.
    expect(await getSecretElicitationOutcome(p, "GH", db)).toBeUndefined();

    // Brokering it again forgets the old confirmation: a new removal needs a new one.
    await call("set_secret_broker", { name: "GH", broker: BROKER });
    const fresh = await call("set_secret_broker", { name: "GH", broker: null });
    expect(fresh.body).toMatchObject({ status: "pending" });
    await client.close();
  });

  it("broker: null on an unbrokered secret has nothing to confirm", async () => {
    const p = await owner();
    const { client, call } = await connect(p);
    await call("create_secret", { name: "PLAIN", value: VALUE });
    const result = await call("set_secret_broker", { name: "PLAIN", broker: null });
    expect(result.body).toMatchObject({ unbrokered: true, secret: { name: "PLAIN", broker: null } });
    expect(await changes(p)).toEqual([]);
    await client.close();
  });

  it("[protocolElicitation] broker: null elicits the browser confirmation, then reports it", async () => {
    const p = await owner();
    const { mcp, client, call } = await connect(p, true);
    await call("create_secret", { name: "GH", value: VALUE, broker: BROKER });

    let message: string | undefined;
    client.setRequestHandler("elicitation/create", async (request) => {
      const params = request.params as { mode?: string; url?: string; message?: string };
      if (params.mode === "url" && params.url) {
        message = params.message;
        const payload = await mcp.verifyRequestState<SecretElicitationPayload>(
          new URL(params.url).searchParams.get("t")!,
        );
        await fulfillUnbrokerElicitation(payload, cipher, db);
      }
      return { action: "accept" };
    });
    const result = await call("set_secret_broker", { name: "GH", broker: null });
    expect(message).toBe('Confirm removing brokering for secret "GH" in your browser.');
    expect(result.body).toMatchObject({ unbrokered: true, secret: { name: "GH", broker: null } });
    await client.close();
  });

  it("[protocolElicitation] a declined confirmation leaves the secret brokered", async () => {
    const p = await owner();
    const { client, call } = await connect(p, true);
    await call("create_secret", { name: "GH", value: VALUE, broker: BROKER });
    client.setRequestHandler("elicitation/create", async () => ({ action: "decline" }));
    const result = await call("set_secret_broker", { name: "GH", broker: null });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/declined/);
    expect((await call("list_secrets")).body).toEqual([expect.objectContaining({ broker: BROKER })]);
    await client.close();
  });
});
