/**
 * Secrets, datastores and webhooks over MCP, against real PostgreSQL: a missing or
 * invisible row is 404, a Team member owns what the Team owns, a read grant shows the
 * resource without letting the grantee bind, change or delete it, nothing can be shared
 * with everyone, and deleting a resource drops its grants.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { resolveStanding } from "../../core/teams/standing.js";
import { addMember, createTeam, type TeamActor } from "../../core/teams/teams.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerDatastoreTools } from "./datastore.js";
import { registerGrantTools } from "./grants.js";
import { registerSecretsTools } from "./secrets.js";
import { registerWebhookTools } from "./webhooks.js";

const db = createPrismaClient();
const CANONICAL = "https://host/mcp";
const suffix = randomUUID();
const principalIds: string[] = [];
const teamIds: string[] = [];
const agentIds: string[] = [];
const secretIds: string[] = [];
const datastoreIds: string[] = [];
const webhookIds: string[] = [];

type Result = { isError?: boolean; content: { text: string }[] };
const text = (r: Result) => r.content[0].text;

async function principal(label: string): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `owned-share-${label}-${suffix}` } });
  principalIds.push(p.id);
  return p;
}

async function secret(ownerId: string) {
  const s = await db.secret.create({
    data: { name: `os-${randomUUID()}`, ownerId, ciphertext: "x", keyId: "k" } as never,
  });
  secretIds.push(s.id);
  return s;
}

async function datastore(ownerId: string) {
  const d = await db.datastore.create({ data: { name: `os-${randomUUID()}`, ownerId } });
  datastoreIds.push(d.id);
  return d;
}

async function agent(ownerId: string) {
  const a = await db.agent.create({
    data: { name: `os-${randomUUID()}`, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1, ownerId },
  });
  agentIds.push(a.id);
  return a;
}

async function webhook(ownerId: string, agentId: string) {
  const w = await db.webhook.create({ data: { agentId, ownerId, secretHash: `h-${randomUUID()}` } as never });
  webhookIds.push(w.id);
  return w;
}

async function connect(who: Principal) {
  const standing = await resolveStanding(db, who.id);
  const providers = {} as McpProviders;
  const ctx: McpRequestContext = {
    principal: who,
    scopes: new Set(["wardby:write"]),
    roles: [...standing.roles],
    actsFor: standing.actsFor,
    teamIds: standing.teamIds,
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext(ctx);
  registerSecretsTools(mcp, {
    buildElicitationUrl: async () => "https://test.invalid/e",
    protocolElicitation: false,
    oauthLoopback: { origin: async () => "https://test.invalid", audience: "http" },
  });
  registerDatastoreTools(mcp);
  registerWebhookTools(mcp);
  registerGrantTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as Result,
    close: () => client.close(),
  };
}

const share = (resourceType: string, resourceId: string, grantee: Principal | "everyone", level = "read") => ({
  resourceType,
  resourceId,
  grantee: grantee === "everyone" ? "everyone" : { principalId: grantee.id },
  level,
});

describe.skipIf(!process.env.DATABASE_URL)("secrets, datastores and webhooks (PostgreSQL)", () => {
  afterAll(async () => {
    await db.resourceGrant.deleteMany({
      where: { resourceId: { in: [...secretIds, ...datastoreIds, ...webhookIds] } },
    });
    await db.webhook.deleteMany({ where: { id: { in: webhookIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.secret.deleteMany({ where: { id: { in: secretIds } } });
    await db.datastore.deleteMany({ where: { id: { in: datastoreIds } } });
    await db.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
    await db.team.deleteMany({ where: { id: { in: teamIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("a missing or someone else's row is 404 for a stranger, on every type", async () => {
    const owner = await principal("owner1");
    const stranger = await principal("stranger1");
    const s = await secret(owner.id);
    const d = await datastore(owner.id);
    const a = await agent(owner.id);
    const w = await webhook(owner.id, a.id);

    const asStranger = await connect(stranger);
    for (const [tool, args] of [
      ["delete_secret", { id: s.id }],
      ["delete_secret", { id: "missing" }],
      ["delete_datastore", { id: d.id }],
      ["delete_datastore", { id: "missing" }],
      ["delete_webhook", { id: w.id }],
      ["delete_webhook", { id: "missing" }],
    ] as const) {
      const r = await asStranger.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(text(r), `${tool} ${JSON.stringify(args)}`).toMatch(/not found/);
    }
    for (const list of ["list_secrets", "list_datastores", "list_webhooks"]) {
      const listed = text(await asStranger.call(list, {}));
      expect(listed).not.toContain(s.id);
      expect(listed).not.toContain(d.id);
      expect(listed).not.toContain(w.id);
    }
    await asStranger.close();
  });

  it("a legacy webhook with no creator is deletable only through the agent's owner, not by any caller", async () => {
    const owner = await principal("owner0");
    const stranger = await principal("stranger0");
    const a = await agent(owner.id);
    const w = await db.webhook.create({
      data: { agentId: a.id, ownerId: null, secretHash: `h-${randomUUID()}` } as never,
    });
    webhookIds.push(w.id);
    const asStranger = await connect(stranger);
    expect((await asStranger.call("delete_webhook", { id: w.id })).isError).toBe(true);
    await asStranger.close();
    const asOwner = await connect(owner);
    expect((await asOwner.call("delete_webhook", { id: w.id })).isError).toBeFalsy();
    await asOwner.close();
  });

  it("a read grant shows the resource, and the grantee still binds, changes and deletes nothing", async () => {
    const owner = await principal("owner2");
    const reader = await principal("reader2");
    const s = await secret(owner.id);
    const d = await datastore(owner.id);
    const a = await agent(owner.id);
    const w = await webhook(owner.id, a.id);
    const readersAgent = await agent(reader.id);

    const asOwner = await connect(owner);
    for (const [type, id] of [
      ["secret", s.id],
      ["datastore", d.id],
      ["webhook", w.id],
    ] as const) {
      expect((await asOwner.call("grant_access", share(type, id, reader))).isError, type).toBeFalsy();
    }
    await asOwner.close();

    const asReader = await connect(reader);
    expect(text(await asReader.call("list_secrets", {}))).toContain(s.id);
    expect(text(await asReader.call("list_datastores", {}))).toContain(d.id);
    expect(text(await asReader.call("list_webhooks", {}))).toContain(w.id);
    // Visible, but not theirs: deleting is refused with 403, and nothing can be bound to their own agent.
    for (const [tool, args] of [
      ["delete_secret", { id: s.id }],
      ["delete_datastore", { id: d.id }],
      ["delete_webhook", { id: w.id }],
    ] as const) {
      const r = await asReader.call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(text(r), tool).toMatch(/needs its owner; you have read access/);
    }
    const bind = await asReader.call("attach_datastore", { agentId: readersAgent.id, datastoreId: d.id });
    expect(bind.isError).toBe(true);
    expect(await db.agentDatastore.count({ where: { agentId: readersAgent.id } })).toBe(0);
    // The listing never carries a value.
    expect(text(await asReader.call("list_secrets", {}))).not.toContain("ciphertext");
    await asReader.close();
  });

  it("nothing is shared with everyone, a higher level is refused, and only the owner grants", async () => {
    const owner = await principal("owner3");
    const other = await principal("other3");
    const s = await secret(owner.id);
    const asOwner = await connect(owner);
    const everyone = await asOwner.call("grant_access", share("secret", s.id, "everyone"));
    expect(everyone.isError).toBe(true);
    expect(text(everyone)).toMatch(/cannot be shared with everyone/);
    expect((await asOwner.call("grant_access", share("secret", s.id, other, "write"))).isError).toBe(true);
    await asOwner.close();

    const asOther = await connect(other);
    expect((await asOther.call("grant_access", share("secret", s.id, other))).isError).toBe(true);
    await asOther.close();
  });

  it("a Team member owns the Team's secret, datastore and webhook, and deleting one drops its grants", async () => {
    const member = await principal("member4");
    const other = await principal("other4");
    const admin: TeamActor = { principalId: member.id, roles: new Set(["admin"]) };
    const team = await createTeam(db, admin, { name: `os-${suffix}` });
    teamIds.push(team.id);
    principalIds.push(team.principalId);
    await addMember(db, admin, team.id, member.id);
    const s = await secret(team.principalId);
    const d = await datastore(team.principalId);
    const a = await agent(team.principalId);
    const w = await webhook(team.principalId, a.id);

    const asMember = await connect(member);
    expect(text(await asMember.call("list_secrets", {}))).toContain(s.id);
    expect(text(await asMember.call("list_datastores", {}))).toContain(d.id);
    expect(text(await asMember.call("list_webhooks", {}))).toContain(w.id);
    expect((await asMember.call("grant_access", share("datastore", d.id, other))).isError).toBeFalsy();
    expect(await db.resourceGrant.count({ where: { resourceId: d.id } })).toBe(1);
    expect((await asMember.call("delete_datastore", { id: d.id })).isError).toBeFalsy();
    expect(await db.resourceGrant.count({ where: { resourceId: d.id } })).toBe(0);
    expect((await asMember.call("delete_webhook", { id: w.id })).isError).toBeFalsy();
    await asMember.close();
  });
});
