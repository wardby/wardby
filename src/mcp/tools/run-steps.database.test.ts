import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { RunStepWriter } from "../../core/run-steps/writer.js";
import type { McpProviders } from "../context.js";
import { buildMcpServer } from "../server.js";
import { SCOPES_SUPPORTED } from "../auth/resource-server.js";
import { registerRunTools } from "./runs.js";
import { registerRunStepsTool } from "./run-steps.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];
const CANONICAL = "https://host/mcp";
// A fake value only: never a real credential.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";

async function connect(who: Principal) {
  const providers = {} as McpProviders;
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
  registerRunTools(mcp);
  registerRunStepsTool(mcp, { level: "summary", retentionDays: 30 });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) =>
    ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0].text;
  return { call, close: () => client.close() };
}

describe.skipIf(!process.env.DATABASE_URL)("run steps through MCP (PostgreSQL)", () => {
  afterAll(async () => {
    await db.run.deleteMany({ where: { agentId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("never shows a fake secret in get_run_steps, get_run's lastStep or list_runs' lastStep", async () => {
    const me = await db.principal.create({ data: { subject: `run-steps-${randomUUID()}` } });
    principalIds.push(me.id);
    const agent = await db.agent.create({
      data: { name: `steps-${randomUUID()}`, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1, ownerId: me.id },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "running" } });
    const writer = new RunStepWriter({
      db,
      secretValues: async () => [FAKE_SECRET],
      level: "summary",
      retentionDays: 30,
    });
    await writer.record(run.id, {
      steps: [
        { kind: "said", callId: "said:turn:1", text: `Using ${FAKE_SECRET} now.`, truncated: false },
        { kind: "tool", callId: "c1", tool: "Bash", text: `echo ${FAKE_SECRET}`, truncated: false },
      ],
      results: [{ callId: "c1", status: "exit 1" }],
    });

    const mcp = await connect(me);
    const steps = await mcp.call("get_run_steps", { runId: run.id });
    const got = await mcp.call("get_run", { runId: run.id });
    const listed = await mcp.call("list_runs", {});
    await mcp.close();

    for (const text of [steps, got, listed]) expect(text).not.toContain(FAKE_SECRET);
    expect(JSON.parse(steps).steps.map((s: { summary: string }) => s.summary)).toEqual([
      "Using [REDACTED] now.",
      "echo [REDACTED]",
    ]);
    expect(JSON.parse(got).lastStep).toMatchObject({
      seq: 2,
      kind: "tool",
      tool: "Bash",
      status: "exit 1",
      line: "Bash: echo [REDACTED] (exit 1)",
    });
    const row = (JSON.parse(listed) as { id: string; lastStep?: { line: string } }[]).find((r) => r.id === run.id);
    expect(row?.lastStep?.line).toBe("Bash: echo [REDACTED] (exit 1)");
  });
});
