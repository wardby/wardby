import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal, RunStatus } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerAgentTools } from "./agents.js";
import { registerRunTools } from "./runs.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];
const CANONICAL = "https://host/mcp";

type Result = { isError?: boolean; content: { text: string }[] };
type Row = Record<string, unknown> & { id: string; agentId: string; agentName: string; agentBudgetUsd: number };

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `list-runs-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function agent(ownerId: string, name: string, budgetUsd = 1) {
  const a = await db.agent.create({
    data: {
      name: `${name}-${randomUUID()}`,
      systemPrompt: "a long standing prompt",
      model: "gpt-5.6-luna",
      budgetUsd,
      ownerId,
    },
  });
  agentIds.push(a.id);
  return a;
}

async function run(
  agentId: string,
  opts: {
    status?: RunStatus;
    startedAt?: Date;
    finishedAt?: Date | null;
    triggeredById?: string;
    finalText?: string;
  } = {},
) {
  return db.run.create({
    data: {
      agentId,
      status: opts.status ?? "succeeded",
      startedAt: opts.startedAt ?? new Date(),
      finishedAt: opts.finishedAt ?? null,
      triggeredById: opts.triggeredById ?? null,
      finalText: opts.finalText ?? "a long final answer",
    },
  });
}

async function connect(who: Principal, admin = false) {
  const providers = {} as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  mcp.setFixedContext({
    principal: who,
    scopes: new Set(SCOPES_SUPPORTED),
    roles: admin ? ["admin"] : [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  });
  registerRunTools(mcp);
  registerAgentTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  return {
    list: async (args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name: "list_runs", arguments: args })) as Result;
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text) as Row[];
    },
    raw: async (args: Record<string, unknown>, name = "list_runs") =>
      (await client.callTool({ name, arguments: args })) as Result,
    agents: async (args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: "list_agents", arguments: args })) as Result;
      if (result.isError) throw new Error(result.content[0].text);
      return JSON.parse(result.content[0].text) as Record<string, unknown>[];
    },
    close: () => client.close(),
  };
}

async function readGrant(agentId: string, granteeId: string) {
  await db.resourceGrant.create({
    data: {
      resourceType: "agent",
      resourceId: agentId,
      granteeKind: "principal",
      granteePrincipalId: granteeId,
      granteeKey: `principal:${granteeId}`,
      level: "read",
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)("list_runs across agents (PostgreSQL)", () => {
  let me: Principal;
  let other: Principal;

  beforeAll(async () => {
    me = await principal();
    other = await principal();
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("lists every run of my agents and only my own runs on agents I can read, newest first", async () => {
    const mine = await agent(me.id, "mine", 2.5);
    const shared = await agent(other.id, "shared");
    const hidden = await agent(other.id, "hidden");
    await readGrant(shared.id, me.id);
    const t = Date.now();
    const a = await run(mine.id, { startedAt: new Date(t - 3000) });
    const b = await run(mine.id, { startedAt: new Date(t - 2000), triggeredById: other.id });
    const c = await run(shared.id, { startedAt: new Date(t - 1000), triggeredById: me.id });
    await run(shared.id, { startedAt: new Date(t - 500), triggeredById: other.id });
    await run(hidden.id, { startedAt: new Date(t - 100), triggeredById: me.id });

    const mcp = await connect(me);
    const rows = await mcp.list();
    await mcp.close();

    expect(rows.map((row) => row.id)).toEqual([c.id, b.id, a.id]);
    expect(rows[0]).toMatchObject({ agentId: shared.id, agentName: shared.name, agentBudgetUsd: 1 });
    expect(rows[2]).toMatchObject({ agentId: mine.id, agentName: mine.name, agentBudgetUsd: 2.5 });
  });

  it("leaves finalText out of the rows and keeps the run's other fields", async () => {
    const mine = await agent(me.id, "final");
    await run(mine.id, { finalText: "the whole answer" });
    const mcp = await connect(me);
    const [row] = (await mcp.list()).filter((r) => r.agentId === mine.id);
    await mcp.close();
    expect(row).not.toHaveProperty("finalText");
    expect(row).toMatchObject({ status: "succeeded", trigger: "manual" });
    expect(row).not.toHaveProperty("systemPrompt");
  });

  it("active keeps pending and running runs; since keeps recent ones and anything still active", async () => {
    const mine = await agent(me.id, "filters");
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const running = await run(mine.id, { status: "running", startedAt: dayAgo });
    const pending = await run(mine.id, { status: "pending" });
    const recent = await run(mine.id, { status: "failed", startedAt: dayAgo, finishedAt: new Date() });
    const old = await run(mine.id, { status: "succeeded", startedAt: dayAgo, finishedAt: dayAgo });

    const mcp = await connect(me);
    const ids = async (args: Record<string, unknown>) =>
      (await mcp.list(args))
        .filter((r) => r.agentId === mine.id)
        .map((r) => r.id)
        .sort();
    expect(await ids({ active: true })).toEqual([running.id, pending.id].sort());
    const sinceHour = await ids({ since: hourAgo.toISOString() });
    expect(sinceHour).toEqual([running.id, pending.id, recent.id].sort());
    expect(sinceHour).not.toContain(old.id);
    // The same filters work with an agentId too.
    const scoped = (await mcp.list({ agentId: mine.id, active: true })).map((r) => r.id).sort();
    expect(scoped).toEqual([running.id, pending.id].sort());
    await mcp.close();
  });

  it("caps the limit and refuses a since that isn't a time", async () => {
    const mine = await agent(me.id, "limit");
    for (let i = 0; i < 3; i += 1) await run(mine.id);
    const mcp = await connect(me);
    expect(await mcp.list({ limit: 2 })).toHaveLength(2);
    const refused = await mcp.raw({ since: "yesterday-ish" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/since must be an ISO date or time/);
    await mcp.close();
  });

  it("returns nothing for a caller who can see no agents", async () => {
    const stranger = await principal();
    const mcp = await connect(stranger);
    expect(await mcp.list()).toEqual([]);
    await mcp.close();
  });

  it("list_agents summary returns the short shape, without prompts or the coding profile", async () => {
    const mine = await agent(me.id, "summary", 3);
    const mcp = await connect(me);
    const rows = await mcp.agents({ summary: true });
    await mcp.close();
    const row = rows.find((r) => r.id === mine.id);
    expect(row).toEqual({
      id: mine.id,
      name: mine.name,
      kind: "native",
      model: "gpt-5.6-luna",
      budgetUsd: 3,
      ownerId: me.id,
      codingProvider: null,
      access: "owner",
    });
    expect(rows.some((r) => r.ownerId === other.id && r.access === "none")).toBe(false);
  });

  it("all lists every agent and every run for an admin, and is refused for anyone else", async () => {
    const theirs = await agent(other.id, "theirs");
    const theirRun = await run(theirs.id, { triggeredById: other.id });

    const member = await connect(me);
    expect((await member.list()).some((r) => r.id === theirRun.id)).toBe(false);
    for (const [name, args] of [
      ["list_runs", { all: true }],
      ["list_agents", { all: true, summary: true }],
    ] as const) {
      const refused = await member.raw(args, name);
      expect(refused.isError, name).toBe(true);
    }
    await member.close();

    const admin = await connect(me, true);
    const runs = await admin.list({ all: true });
    expect(runs.find((r) => r.id === theirRun.id)).toMatchObject({ agentName: theirs.name });
    const agents = await admin.agents({ all: true, summary: true });
    expect(agents.find((a) => a.id === theirs.id)).toMatchObject({ access: "none", ownerId: other.id });
    const both = await admin.raw({ all: true, agentId: theirs.id });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toMatch(/leave out agentId/);
    await admin.close();
  });

  it("adds triggerInfo, outcomes and serviceReadiness, in the viewer's shapes, without free text", async () => {
    const reviewer = await agent(me.id, "graph-reviewer");
    const delivery = await agent(me.id, "graph-delivery");
    const FAKE = "fake-secret-value-9f3c"; // stands in for anything a review body or service log could quote
    const review = await db.run.create({ data: { agentId: reviewer.id, status: "succeeded", trigger: "host_event" } });
    await db.runHostCheck.create({
      data: {
        runId: review.id,
        provider: "github",
        repository: "your-org/api",
        checkId: "1",
        headSha: "a".repeat(40),
        prNumber: 12,
        completedAt: new Date(),
        verdict: "REQUEST_CHANGES",
        reviewBody: `please rotate ${FAKE}`,
      },
    });
    const fix = await db.run.create({ data: { agentId: delivery.id, status: "running", trigger: "host_event" } });
    await db.runHostStatus.create({
      data: {
        runId: fix.id,
        provider: "github",
        repository: "your-org/api",
        number: 12,
        commentKind: "status",
        commentId: "c1",
      },
    });
    await db.codingRunServiceStatus.create({
      data: {
        runId: fix.id,
        name: "postgres",
        state: "failed",
        attempts: 2,
        reason: `exited: ${FAKE}`,
        failedAt: new Date(),
      },
    });

    const mcp = await connect(me);
    const rows = await mcp.list();
    const reviewRow = rows.find((r) => r.id === review.id);
    const fixRow = rows.find((r) => r.id === fix.id);
    expect(reviewRow).toMatchObject({
      triggerInfo: { kind: "code_host", repository: "your-org/api", number: 12, event: "review" },
      outcomes: [{ kind: "check", repository: "your-org/api", number: 12, completed: true }],
    });
    expect(fixRow).toMatchObject({
      triggerInfo: { kind: "code_host", repository: "your-org/api", number: 12, event: "mention" },
      outcomes: [{ kind: "code_host_comment", repository: "your-org/api", number: 12 }],
      serviceReadiness: [{ name: "postgres", state: "failed", attempts: 2 }],
    });
    expect(rows[0]).not.toHaveProperty("pricingSnapshot");

    const detail = await mcp.raw({ runId: fix.id }, "get_run");
    expect(JSON.parse(detail.content[0].text)).toMatchObject({
      triggerInfo: { event: "mention" },
      serviceReadiness: [{ name: "postgres", state: "failed" }],
    });
    // Neither the review body nor the service's failure reason reaches either tool.
    const reviewDetail = await mcp.raw({ runId: review.id }, "get_run");
    for (const text of [JSON.stringify(rows), detail.content[0].text, reviewDetail.content[0].text]) {
      expect(text).not.toContain(FAKE);
    }
    await mcp.close();
  });
});
