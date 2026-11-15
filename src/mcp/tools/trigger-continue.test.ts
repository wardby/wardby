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

type RunRow = {
  id: string;
  agentId: string;
  status?: string;
  codingRun?: { repository: string; rootCodingRunId: string | null } | null;
};

function setup(agents: Row[], runs: RunRow[], principalId = "p1") {
  const run = (r: RunRow) => ({
    agentId: r.agentId,
    status: r.status ?? "succeeded",
    codingRun: r.codingRun === undefined ? { repository: "o/r", rootCodingRunId: null } : r.codingRun,
  });
  const db: any = {
    resourceGrant: fakeResourceGrants([]),
    agent: {
      findMany: async () => [],
      findUnique: async ({ where }: { where: { id: string } }) => agents.find((a) => a.id === where.id) ?? null,
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = runs.find((r) => r.id === where.id);
        return found ? run(found) : null;
      },
    },
    agentRepository: { findMany: async () => [] },
    codingRun: {
      findUnique: async ({ where }: { where: { runId: string } }) => {
        const found = runs.find((r) => r.id === where.runId);
        return found ? run(found).codingRun : null;
      },
    },
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

  it("refuses an unknown run with unknown_run, without echoing the id", async () => {
    const trigger = setup([coding()], []);
    const result = await trigger({ agentId: "a1", continuePriorRun: "missing-run-id" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unknown_run: Cannot continue an unknown coding run.");
    expect(text(result)).not.toContain("missing-run-id");
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("refuses another agent's run with other_agent_run when the caller can read that agent", async () => {
    const trigger = setup([coding(), coding("a2")], [{ id: "other", agentId: "a2" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "other" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("other_agent_run: ");
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("refuses an unreadable agent's run as unknown_run, so its existence never leaks", async () => {
    const trigger = setup([coding(), { ...coding("a2"), ownerId: "someone-else" }], [{ id: "other", agentId: "a2" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "other" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("unknown_run: ");
    expect(text(result)).not.toContain("other_agent_run");
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("refuses a run without a coding run with not_a_coding_run", async () => {
    const trigger = setup([coding()], [{ id: "prior", agentId: "a1", status: "refused", codingRun: null }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not_a_coding_run: ");
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("refuses a run that has not finished with run_not_finished", async () => {
    for (const status of ["pending", "running"]) {
      const trigger = setup([coding()], [{ id: "prior", agentId: "a1", status }]);
      const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("run_not_finished: ");
    }
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("continues a run that ended in any terminal state", async () => {
    for (const status of ["succeeded", "failed", "budget_exhausted", "cancelled", "lost"]) {
      const trigger = setup([coding()], [{ id: "prior", agentId: "a1", status }]);
      const result = await trigger({ agentId: "a1", continuePriorRun: "prior" });
      expect(result.isError).toBeFalsy();
    }
    expect(dispatchRun).toHaveBeenCalledTimes(5);
  });

  it("refuses a repository other than the root run's with other_repository", async () => {
    const trigger = setup(
      [coding()],
      [
        { id: "root", agentId: "a1", codingRun: { repository: "o/r", rootCodingRunId: null } },
        { id: "round", agentId: "a1", codingRun: { repository: "o/r", rootCodingRunId: "root" } },
      ],
    );
    const refused = await trigger({ agentId: "a1", continuePriorRun: "round", repository: "o/elsewhere" });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("other_repository: ");
    expect(text(refused)).not.toContain("o/elsewhere");
    expect(dispatchRun).not.toHaveBeenCalled();

    const same = await trigger({ agentId: "a1", continuePriorRun: "round", repository: "O/R" });
    expect(same.isError).toBeFalsy();
    expect(dispatchRun).toHaveBeenCalledWith(expect.objectContaining({ continuesCodingRunId: "round" }));
  });

  it("refuses baseRef with a continuation", async () => {
    const trigger = setup([coding()], [{ id: "prior", agentId: "a1" }]);
    const result = await trigger({ agentId: "a1", continuePriorRun: "prior", baseRef: "develop" });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("leave baseRef out");
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
