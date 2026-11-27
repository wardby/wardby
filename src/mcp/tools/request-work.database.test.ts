import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerRequestWorkTool } from "./request-work.js";

const db = createPrismaClient();
const principalIds: string[] = [];
const agentIds: string[] = [];
const CANONICAL = "https://host/mcp";
const tag = randomUUID().slice(0, 8);
const executor = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `request-work-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}
async function agent(ownerId: string, name: string, data: Record<string, unknown> = {}) {
  const a = await db.agent.create({
    data: {
      name: `${name}-${tag}`,
      systemPrompt: "route",
      model: "claude-sonnet-5-5",
      budgetUsd: 2,
      ownerId,
      ...data,
    },
  });
  agentIds.push(a.id);
  return a;
}
async function connect(who: Principal) {
  const providers = { executor } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext({
    principal: who,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerRequestWorkTool(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return async (args: Record<string, unknown>) => {
    const result = (await client.callTool({ name: "request_work", arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError === true, text: result.content[0].text };
  };
}

afterAll(async () => {
  await db.reviewJob.deleteMany({ where: { routerAgentId: { in: agentIds } } });
  await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: { in: agentIds } } });
  await db.agent.deleteMany({ where: { id: { in: agentIds } } });
  await db.principal.deleteMany({ where: { id: { in: principalIds } } });
  await db.$disconnect();
});

describe("request_work", () => {
  it("ranks only routers the caller can run, and starts nothing", async () => {
    const me = await principal();
    const other = await principal();
    const mine = await agent(me.id, "mobile-router", { router: true, description: "mobile app screens and design" });
    await agent(other.id, "hidden-router", { router: true, description: "mobile design too" });
    const shared = await agent(other.id, "shared-router", { router: true, description: "mobile design shared" });
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: shared.id,
        granteeKind: "principal",
        granteePrincipalId: me.id,
        granteeKey: `principal:${me.id}`,
        level: "execute",
      },
    });
    const readOnly = await agent(other.id, "readonly-router", { router: true, description: "mobile design read" });
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: readOnly.id,
        granteeKind: "principal",
        granteePrincipalId: me.id,
        granteeKey: `principal:${me.id}`,
        level: "read",
      },
    });
    const call = await connect(me);
    const before = await db.run.count({ where: { agentId: { in: agentIds } } });
    const ranked = await call({ request: "mobile design for checkout" });
    expect(ranked.isError).toBe(false);
    expect(
      JSON.parse(ranked.text)
        .routers.map((r: { id: string }) => r.id)
        .sort(),
    ).toEqual([mine.id, shared.id].sort());
    expect(await db.run.count({ where: { agentId: { in: agentIds } } })).toBe(before);

    const none = JSON.parse((await call({ request: "quarterly taxes" })).text);
    expect(none.routers).toEqual([]);
    expect(none.yours.sort()).toEqual([mine.name, shared.name].sort());
    expect(none.yours).not.toContain(`hidden-router-${tag}`);
    expect(none.yours).not.toContain(readOnly.name);
  });

  it("with router starts a run with the request as its task and a job pointing at that run", async () => {
    const me = await principal();
    const router = await agent(me.id, "starter", { router: true, description: "anything" });
    const call = await connect(me);
    const out = await call({ request: "please plan the checkout", router: router.id });
    expect(out.isError).toBe(false);
    const body = JSON.parse(out.text);
    expect(body.router).toEqual({ id: router.id, name: router.name });
    const run = await db.run.findUniqueOrThrow({ where: { id: body.runId } });
    expect(run.taskOverride).toBe("please plan the checkout");
    expect(run.trigger).toBe("manual");
    expect(run.triggeredById).toBe(me.id);
    const job = await db.reviewJob.findFirstOrThrow({ where: { routerAgentId: router.id } });
    expect(job.routerRunId).toBe(run.id);
    expect(job.outcome).toBe("started");
    expect(job.reviewEventId.startsWith("request:")).toBe(true);
    expect(job.documentId).toBeNull();
  });

  it("refuses an agent that is not a router, without echoing the request", async () => {
    const me = await principal();
    const plain = await agent(me.id, "plain");
    const call = await connect(me);
    const out = await call({ request: "SECRET-REQUEST-TEXT", router: plain.id });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("review_router_invalid");
    expect(out.text).not.toContain("SECRET-REQUEST-TEXT");
    expect(await db.reviewJob.count({ where: { routerAgentId: plain.id } })).toBe(0);
  });

  it("refuses a router the caller cannot run as trigger_agent does", async () => {
    const me = await principal();
    const other = await principal();
    const theirs = await agent(other.id, "theirs", { router: true, description: "x" });
    const readOnly = await agent(other.id, "read-only", { router: true, description: "x" });
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: readOnly.id,
        granteeKind: "principal",
        granteePrincipalId: me.id,
        granteeKey: `principal:${me.id}`,
        level: "read",
      },
    });
    const call = await connect(me);
    const hidden = await call({ request: "work", router: theirs.id });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toMatch(/not found/i);
    const denied = await call({ request: "work", router: readOnly.id });
    expect(denied.isError).toBe(true);
    expect(denied.text).not.toContain("review_router_invalid");
    expect(await db.run.count({ where: { agentId: { in: [theirs.id, readOnly.id] } } })).toBe(0);
    expect(await db.reviewJob.count({ where: { routerAgentId: { in: [theirs.id, readOnly.id] } } })).toBe(0);
  });

  it("lists a router everyone may run, and caps the no-match list at 20 names", async () => {
    const me = await principal();
    const other = await principal();
    const open = await agent(other.id, "open-router", { router: true, description: "zebra stripes" });
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: open.id,
        granteeKind: "everyone",
        granteeKey: "everyone",
        level: "execute",
      },
    });
    const call = await connect(me);
    const ranked = JSON.parse((await call({ request: "zebra stripes" })).text);
    expect(ranked.routers.map((r: { id: string }) => r.id)).toContain(open.id);
    for (let i = 0; i < 21; i++)
      await agent(me.id, `many-${String(i).padStart(2, "0")}`, { router: true, description: "q" });
    const none = JSON.parse((await call({ request: "nothing matches this wording" })).text);
    expect(none.yours).toHaveLength(20);
    expect([...none.yours].sort()).toEqual(none.yours);
  });

  it("refuses at persist when the router was switched off mid-dispatch, and keeps the job with its outcome", async () => {
    const me = await principal();
    const router = await agent(me.id, "flipped", { router: true, description: "x" });
    const stale = await db.agent.findUniqueOrThrow({ where: { id: router.id }, include: { codingProfile: true } });
    await db.agent.update({ where: { id: router.id }, data: { router: false } });
    const spy = vi.spyOn(db.agent, "findUnique").mockResolvedValueOnce(stale);
    const call = await connect(me);
    const out = await call({ request: "SECRET-REQUEST-TEXT", router: router.id });
    spy.mockRestore();
    expect(out.isError).toBe(true);
    expect(out.text).toContain("review_router_invalid");
    expect(await db.run.count({ where: { agentId: router.id } })).toBe(0);
    const job = await db.reviewJob.findFirstOrThrow({ where: { routerAgentId: router.id } });
    expect(job.outcome).toBe("review_router_invalid");
    expect(job.routerRunId).toBeNull();
  });
});
