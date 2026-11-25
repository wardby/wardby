import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import { loadTunnelHostPins } from "./coding-tunnel-hosts.js";
import { deriveTunnelToken } from "../coding/tunnel-token.js";
import { CodingProxy } from "../providers/coding-proxy/proxy.js";
import { PrismaProxyLedger } from "../providers/coding-proxy/prisma-ledger.js";
import { LedgerTunnelAuthenticator } from "../providers/coding-proxy/tunnel-auth.js";

const db = createPrismaClient();
const suffix = randomUUID();
const agentId = `tunnel-hosts-agent-${suffix}`;
const runIds = [`tunnel-hosts-run-a-${suffix}`, `tunnel-hosts-run-b-${suffix}`];

describe.skipIf(!process.env.DATABASE_URL)("tunnel host pins at dispatch (PostgreSQL)", () => {
  afterAll(async () => {
    await db.$executeRaw`DELETE FROM "CodingProxySession" WHERE "runId" = ANY(${runIds})`;
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.$disconnect();
  });

  async function dispatch(proxy: CodingProxy, runId: string, level: "exact" | "pattern" | "any") {
    await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
    await db.codingRun.create({
      data: {
        runId,
        task: "test",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "claude-code",
        model: "claude-haiku-4-5",
        timeoutSec: 60,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 1,
      },
    });
    const tunnelHosts = await loadTunnelHostPins(db, agentId, level, { warn: vi.fn() });
    return proxy.createSession({
      runId,
      credentialRef: "anthropic/test",
      protocol: "anthropic-messages",
      allowedModels: ["claude-haiku-4-5"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
      ...(tunnelHosts.length > 0 ? { tunnelHosts } : {}),
    });
  }

  it("pins the patterns the ceiling allows; an edit mid-run leaves the run alone and the next run picks it up", async () => {
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "x",
        model: "claude-haiku-4-5",
        budgetUsd: 1,
        kind: "coding",
        codingProfile: {
          create: {
            provider: "claude-code",
            repository: "openai/example",
            protectedPaths: [".github/**"],
            tunnelHosts: ["api.example.com", "*.apps.example.org", "*"],
          },
        },
      },
    });
    const ledger = new PrismaProxyLedger(db);
    const proxy = new CodingProxy({
      ledger,
      credentials: { resolve: async () => "UNUSED" },
      pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
    });
    const authenticator = new LedgerTunnelAuthenticator(ledger);

    // `*` has no recorded admin approval, so even the "any" ceiling leaves it out.
    const warn = vi.fn();
    expect(await loadTunnelHostPins(db, agentId, "any", { warn })).toEqual(["api.example.com", "*.apps.example.org"]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ leftOut: 1, agentId }), expect.any(String));
    expect(await loadTunnelHostPins(db, agentId, "exact", { warn })).toEqual(["api.example.com"]);
    expect(await loadTunnelHostPins(db, agentId, "off", { warn })).toEqual([]);

    const first = await dispatch(proxy, runIds[0], "pattern");
    const firstToken = deriveTunnelToken(first.capability);
    expect(await authenticator.authenticate(firstToken)).toMatchObject({
      ok: true,
      identity: { runId: runIds[0], tunnelHosts: ["api.example.com", "*.apps.example.org"] },
    });

    // The owner edits the agent while the run is going (and an admin approves *).
    await db.codingAgentProfile.update({
      where: { agentId },
      data: { tunnelHosts: ["*"], tunnelAnyHostAuthorizedById: "admin-1", tunnelAnyHostAuthorizedAt: new Date() },
    });
    expect(await authenticator.authenticate(firstToken)).toMatchObject({
      identity: { tunnelHosts: ["api.example.com", "*.apps.example.org"] },
    });

    const second = await dispatch(proxy, runIds[1], "any");
    expect(await authenticator.authenticate(deriveTunnelToken(second.capability))).toMatchObject({
      ok: true,
      identity: { runId: runIds[1], tunnelHosts: ["*"] },
    });
  });
});
