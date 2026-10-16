import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerPackageTools } from "./packages.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants } from "../../core/grants.test-support.js";

/** The control-plane log, captured: the promotion audit line is asserted on. */
const logged = vi.hoisted(() => [] as { payload: Record<string, unknown> }[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at = () => (payload: Record<string, unknown>) => {
      logged.push({ payload });
    };
    return {
      child: () => make(),
      trace: at(),
      debug: at(),
      info: at(),
      warn: at(),
      error: at(),
      fatal: at(),
    };
  };
  return { logger: make() };
});

const CANONICAL_URI = "https://host/mcp";

interface AgentRow {
  id: string;
  ownerId: string | null;
  kind: "coding" | "native";
  codingProfile: { packageAllowlist: Record<string, string[]> } | null;
}
interface RunRow {
  id: string;
  agentId: string;
  triggeredById?: string | null;
  parentRunId?: string | null;
  coding?: boolean;
}
interface AuditRow {
  runId: string;
  ecosystem: string;
  name: string;
  version: string;
  relation: string;
}

function fakeDb(agents: AgentRow[], runs: RunRow[], audits: AuditRow[]) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const runRows = new Map(runs.map((r) => [r.id, r]));
  const db = {
    resourceGrant: fakeResourceGrants([]),
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    run: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = runRows.get(where.id);
        return row ? { id: row.id, agentId: row.agentId, triggeredById: row.triggeredById ?? null } : null;
      },
      findMany: async ({ where }: { where: { parentRunId: string } }) =>
        [...runRows.values()]
          .filter((row) => row.parentRunId === where.parentRunId)
          .map((row) => ({ id: row.id, agentId: row.agentId, codingRun: row.coding ? { runId: row.id } : null })),
    },
    codingRun: {
      findUnique: async ({ where }: { where: { runId: string } }) =>
        runRows.get(where.runId)?.coding ? { runId: where.runId } : null,
    },
    registryAuditRecord: {
      findMany: async ({ where }: { where: { runId: { in: string[] } } }) =>
        audits.filter((row) => where.runId.in.includes(row.runId)),
    },
    codingAgentProfile: {
      update: async ({ where, data }: { where: { agentId: string }; data: { packageAllowlist: never } }) => {
        const agent = agentRows.get(where.agentId)!;
        agent.codingProfile = { ...agent.codingProfile!, packageAllowlist: data.packageAllowlist };
        return agent.codingProfile;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db: db as unknown as import("#prisma").PrismaClient, agentRows };
}

async function setup(
  principalId: string,
  scopes: string[],
  data: { agents: AgentRow[]; runs: RunRow[]; audits: AuditRow[] },
) {
  const { db, agentRows } = fakeDb(data.agents, data.runs, data.audits);
  const mcp = buildMcpServer({
    providers: {} as never,
    db,
    config: { canonicalUri: CANONICAL_URI },
  });
  const ctx: McpRequestContext = {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    roles: ["admin"],
    canonicalUri: CANONICAL_URI,
    providers: {} as never,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerPackageTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "approve_audited_packages", arguments: args });
    const text = (result.content as { text: string }[])[0].text;
    return { isError: result.isError === true, text };
  };
  return { call, agentRows, close: () => client.close() };
}

const APPROVER = ["agents:write", "packages:approve"];
const coder = (packageAllowlist: Record<string, string[]> = { npm: ["react"] }): AgentRow => ({
  id: "a1",
  ownerId: "owner",
  kind: "coding",
  codingProfile: { packageAllowlist },
});
const audit = (name: string, relation: string, extra: Partial<AuditRow> = {}): AuditRow => ({
  runId: "r1",
  ecosystem: "npm",
  name,
  version: "1.0.0",
  relation,
  ...extra,
});
const auditedRun = () => ({
  agents: [coder()],
  runs: [{ id: "r1", agentId: "a1", coding: true }],
  audits: [
    audit("expo-dev-client", "top-level"),
    audit("expo-dev-launcher", "transitive"),
    audit("left-pad", "unknown"),
    audit("lodash", "allowed"),
    audit("flask", "top-level", { ecosystem: "pypi" }),
    audit("expo-dev-client", "top-level", { version: "2.0.0" }),
  ],
});

describe("approve_audited_packages", () => {
  it("adds the run's top-level names as bare entries, deduplicated, and logs it; unknown ones are listed apart", async () => {
    logged.length = 0;
    const { call, agentRows, close } = await setup("owner", APPROVER, auditedRun());
    const result = await call({ runId: "r1" });
    expect(result.isError).toBe(false);
    expect(agentRows.get("a1")!.codingProfile!.packageAllowlist).toEqual({
      npm: ["react", "expo-dev-client"],
      pypi: ["flask"],
    });
    expect(JSON.parse(result.text)).toMatchObject({
      agents: [{ agentId: "a1", added: { npm: ["expo-dev-client"], pypi: ["flask"] } }],
      unknown: [{ ecosystem: "npm", name: "left-pad" }],
    });
    expect(JSON.parse(result.text).unknownNote).toMatch(/relation unknown/);
    expect(logged.map((entry) => entry.payload)).toContainEqual({
      event: "coding.package_audit.promoted",
      agentId: "a1",
      runId: "r1",
      added: 2,
      by: "owner",
    });
    // Approving again adds nothing.
    expect(JSON.parse((await call({ runId: "r1" })).text)).toMatchObject({ agents: [{ agentId: "a1", added: {} }] });
    expect(agentRows.get("a1")!.codingProfile!.packageAllowlist.npm).toEqual(["react", "expo-dev-client"]);
    await close();
  });

  it("approves only the names given, including an unknown one named explicitly", async () => {
    const { call, agentRows, close } = await setup("owner", APPROVER, auditedRun());
    await call({ runId: "r1", names: ["left-pad", "lodash"] });
    expect(agentRows.get("a1")!.codingProfile!.packageAllowlist).toEqual({ npm: ["react", "left-pad"] });
    await close();
  });

  it("approves a parent run's coding children for their own agents", async () => {
    const { call, agentRows, close } = await setup("owner", APPROVER, {
      agents: [{ id: "lead", ownerId: "owner", kind: "native", codingProfile: null }, coder()],
      runs: [
        { id: "parent", agentId: "lead" },
        { id: "r1", agentId: "a1", parentRunId: "parent", coding: true },
      ],
      audits: [audit("expo-dev-client", "top-level")],
    });
    expect((await call({ runId: "parent" })).isError).toBe(false);
    expect(agentRows.get("a1")!.codingProfile!.packageAllowlist.npm).toEqual(["react", "expo-dev-client"]);
    await close();
  });

  it("changes no allowlist when any target agent is refused", async () => {
    const seconds: AgentRow[] = [
      { id: "a2", ownerId: "someone-else", kind: "coding" as const, codingProfile: { packageAllowlist: {} } },
      {
        id: "a2",
        ownerId: "owner",
        kind: "coding" as const,
        codingProfile: { packageAllowlist: { npm: Array.from({ length: 256 }, (_, i) => `pkg-${i}`) } },
      },
    ];
    for (const second of seconds) {
      const { call, agentRows, close } = await setup("owner", APPROVER, {
        agents: [{ id: "lead", ownerId: "owner", kind: "native", codingProfile: null }, coder(), second],
        runs: [
          { id: "parent", agentId: "lead" },
          { id: "r1", agentId: "a1", parentRunId: "parent", coding: true },
          { id: "r2", agentId: "a2", parentRunId: "parent", coding: true },
        ],
        audits: [audit("expo-dev-client", "top-level"), audit("left-pad", "top-level", { runId: "r2" })],
      });
      expect((await call({ runId: "parent" })).isError).toBe(true);
      expect(agentRows.get("a1")!.codingProfile!.packageAllowlist).toEqual({ npm: ["react"] });
      expect(agentRows.get("a2")!.codingProfile!.packageAllowlist).toEqual(second.codingProfile!.packageAllowlist);
      await close();
    }
  });

  it("needs packages:approve or agents:admin", async () => {
    const { call, close } = await setup("owner", ["agents:write"], auditedRun());
    const result = await call({ runId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Insufficient scope/);
    await close();
  });

  it("is owner-only, and hides runs the caller cannot see", async () => {
    const triggered = {
      ...auditedRun(),
      runs: [{ id: "r1", agentId: "a1", coding: true, triggeredById: "someone" }],
    };
    const stranger = await setup("someone", APPROVER, triggered);
    const refused = await stranger.call({ runId: "r1" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/only its owner/);
    await stranger.close();

    const outsider = await setup("outsider", APPROVER, auditedRun());
    const hidden = await outsider.call({ runId: "r1" });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toMatch(/not found/);
    expect((await outsider.call({ runId: "missing" })).text).toMatch(/not found/);
    await outsider.close();
  });

  it("refuses to grow an ecosystem past 256 entries", async () => {
    const full = Array.from({ length: 256 }, (_, i) => `pkg-${i}`);
    const { call, agentRows, close } = await setup("owner", APPROVER, {
      ...auditedRun(),
      agents: [coder({ npm: full })],
    });
    const result = await call({ runId: "r1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/256/);
    expect(agentRows.get("a1")!.codingProfile!.packageAllowlist.npm).toHaveLength(256);
    await close();
  });
});
