import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerTriggerTool } from "./trigger.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants } from "../../core/grants.test-support.js";
import { ContinuationRefusedError } from "../../core/dispatch.js";

const dispatchRun = vi.hoisted(() => vi.fn());
vi.mock("../../core/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/dispatch.js")>()),
  dispatchRun,
}));

const CANONICAL_URI = "https://host/mcp";
const providers = { executor: { start: vi.fn(), stop: vi.fn() } } as never;

type Row = { id: string; name: string; ownerId: string; kind: "native" | "coding"; codingProfile: object | null };
const coding = (id = "a1"): Row => ({
  id,
  name: id,
  ownerId: "p1",
  kind: "coding",
  codingProfile: { provider: "codex", repository: "o/r", baseRef: "main", allowWebhookTaskOverride: false },
});

function setup(agents: Row[], runs: { id: string; agentId: string }[], principalId = "p1") {
  const db: any = {
    resourceGrant: fakeResourceGrants([]),
    agent: {
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id: string } }) => agents.find((a) => a.id === where.id) ?? null,
    },
    run: { findUnique: async ({ where }: { where: { id: string } }) => runs.find((r) => r.id === where.id) ?? null },
    agentRepository: { findMany: async () => [] },
    codingRun: { findUnique: async () => null },
  };
  const ctx: McpRequestContext = {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(["runs:trigger"]),
    canonicalUri: CANONICAL_URI,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  return async (args: Record<string, unknown>) => {
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
    mcp.setFixedContext(ctx);
    registerTriggerTool(mcp);
    const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(st);
    await client.connect(ct);
    const result = await client.callTool({ name: "trigger_agent", arguments: args });
    await client.close();
    return result;
  };
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;

describe("trigger_agent continuePriorRun", () => {
  beforeEach(() => {
    dispatchRun.mockReset();
    dispatchRun.mockResolvedValue({ run: { id: "run_new", status: "pending" } });
  });

  it("passes the prior run id to dispatch for the owner of a coding agent", async () => {
    const trigger = setup([coding()], [{ id: "prior", agentId: "a1" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
    expect(result.isError).toBeFalsy();
    expect(dispatchRun).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a1", continuesCodingRunId: "prior" }));
  });

  it("is refused for a native agent", async () => {
    const trigger = setup([{ ...coding(), kind: "native", codingProfile: null }], [{ id: "prior", agentId: "a1" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("continuation_requires_coding_agent");
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("is refused for a caller who is not the owner", async () => {
    const trigger = setup([{ ...coding(), ownerId: "someone-else" }], [{ id: "prior", agentId: "a1" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
    expect(result.isError).toBe(true);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("is refused when the run is unknown or belongs to another agent", async () => {
    const trigger = setup([coding(), coding("a2")], [{ id: "other", agentId: "a2" }]);
    for (const id of ["missing", "other"]) {
      const result = await trigger({ agentId: "a1", continuePriorRun: id });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("prior run of agent");
    }
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("reports a refused continuation with its fixed reason code", async () => {
    dispatchRun.mockRejectedValue(new ContinuationRefusedError("no_pushed_branch"));
    const trigger = setup([coding()], [{ id: "prior", agentId: "a1" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(
      "no_pushed_branch: Cannot continue a local-repository coding run that never pushed a branch.",
    );
  });
});
