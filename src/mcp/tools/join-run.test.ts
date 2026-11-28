import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerJoinRunTools } from "./join-run.js";
import type { McpRequestContext } from "../context.js";
import { fakeResourceGrants, type FakeGrantSeed } from "../../core/grants.test-support.js";

const CANONICAL_URI = "https://host/mcp";

interface Step {
  seq: number;
  kind: string;
  fromPrincipalId: string;
  text?: string;
}

async function setup(
  principalId: string,
  opts: {
    status?: string;
    provider?: string;
    workflowName?: string | null;
    grants?: FakeGrantSeed[];
    triggeredById?: string | null;
    noWriter?: boolean;
    link?: boolean;
    /** A native agent run: no CodingRun, its own time limit on the run. */
    native?: boolean;
  } = {},
) {
  const steps: Step[] = [];
  const run = {
    id: "r1",
    agentId: "a1",
    status: opts.status ?? "running",
    triggeredById: opts.triggeredById ?? null,
    startedAt: new Date(),
    timeoutSec: opts.native ? 1800 : null,
  };
  const db = {
    resourceGrant: fakeResourceGrants(opts.grants ?? []),
    agent: { findUnique: async () => ({ id: "a1", ownerId: "owner" }) },
    run: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "r1" ? run : null) },
    codingRun: {
      findUnique: async () =>
        opts.native
          ? null
          : { provider: opts.provider ?? "claude-code", workflowName: opts.workflowName ?? null, timeoutSec: 600 },
    },
    runStep: {
      findMany: async () => steps.filter((s) => s.kind === "join" || s.kind === "leave"),
    },
  } as unknown as import("#prisma").PrismaClient;
  const runSteps = {
    record: async () => {},
    recordJoin: async (_runId: string, step: { kind: string; principalId: string; text?: string }) => {
      const seq = steps.length + 1;
      // The real writer masks secrets; this fake stores the text as given.
      steps.push({ seq, kind: step.kind, fromPrincipalId: step.principalId, text: step.text });
      return { seq, text: step.text ?? "" };
    },
  };
  const providers = (opts.noWriter
    ? {}
    : { runSteps }) as unknown as import("../../providers/index.js").ProviderRegistry;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL_URI } });
  const ctx: McpRequestContext = {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(["runs:trigger"]),
    canonicalUri: CANONICAL_URI,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerJoinRunTools(
    mcp,
    opts.link ? { link: { origin: async () => "https://wardby.example.com", audience: "http" } } : {},
  );
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError === true, text: result.content[0].text };
  };
  return { call, steps, client, mcp };
}

describe("join_run / send_to_run / leave_run", () => {
  it("lets an execute-grantee join someone else's run, send a message and an interrupt, and leave", async () => {
    const t = await setup("g", {
      triggeredById: "other",
      grants: [{ resourceType: "agent", resourceId: "a1", principalId: "g", level: "execute" }],
    });
    expect((await t.call("join_run", { runId: "r1" })).isError).toBe(false);
    // Joining twice records nothing new.
    expect((await t.call("join_run", { runId: "r1" })).text).toContain("already joined");
    expect((await t.call("send_to_run", { runId: "r1", message: "check the tests" })).isError).toBe(false);
    expect((await t.call("send_to_run", { runId: "r1", message: "stop", interrupt: true })).isError).toBe(false);
    expect((await t.call("leave_run", { runId: "r1" })).isError).toBe(false);
    expect(t.steps.map((s) => [s.kind, s.fromPrincipalId, s.text ?? null])).toEqual([
      ["join", "g", null],
      ["message", "g", "check the tests"],
      ["interrupt", "g", "stop"],
      ["leave", "g", null],
    ]);
    await t.client.close();
  });

  it("returns the terminal command and a join link, token in the fragment, when the server serves the join API", async () => {
    const t = await setup("owner", { link: true });
    const joined = JSON.parse((await t.call("join_run", { runId: "r1" })).text) as {
      terminal?: { command: string; pasteCommand: string; link: string };
    };
    expect(joined.terminal?.command).toBe(`npx @wardby/cli@latest join '${joined.terminal?.link}'`);
    expect(joined.terminal?.pasteCommand).toBe("npx @wardby/cli@latest join -");
    expect(joined.terminal?.link).toMatch(/^https:\/\/wardby\.example\.com\/join#.+/);
    await t.client.close();
  });

  it("joins a native agent run; its link lasts until the run's own time limit plus the grace", async () => {
    const t = await setup("owner", { native: true, link: true });
    const joined = JSON.parse((await t.call("join_run", { runId: "r1" })).text) as { terminal: { link: string } };
    const token = decodeURIComponent(joined.terminal.link.split("#")[1]);
    const { exp } = await t.mcp.verifyRequestState<{ exp: number }>(token);
    // 1800 s (the run's timeoutSec), not the coding default: well past 30 minutes from now.
    expect(exp - Date.now()).toBeGreaterThan(1_700_000);
    expect((await t.call("send_to_run", { runId: "r1", message: "hello" })).isError).toBe(false);
    await t.client.close();
  });

  it("has no terminal link where the join API is not served", async () => {
    const t = await setup("owner");
    expect(JSON.parse((await t.call("join_run", { runId: "r1" })).text)).not.toHaveProperty("terminal");
    await t.client.close();
  });

  it("refuses sending before joining", async () => {
    const t = await setup("owner");
    const sent = await t.call("send_to_run", { runId: "r1", message: "hi" });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain("run_not_joined");
    await t.client.close();
  });

  it("hides the run from a read-grantee and from an everyone-execute grant", async () => {
    for (const grants of [
      [{ resourceType: "agent", resourceId: "a1", principalId: "g", level: "read" }],
      [{ resourceType: "agent", resourceId: "a1", granteeKind: "everyone", level: "execute" }],
    ] as FakeGrantSeed[][]) {
      const t = await setup("g", { triggeredById: "other", grants });
      const joined = await t.call("join_run", { runId: "r1" });
      expect(joined.isError).toBe(true);
      expect(joined.text).toContain("not found");
      expect(t.steps).toEqual([]);
      await t.client.close();
    }
  });

  it.each([
    [{ status: "succeeded" }, "run_not_running"],
    [{ provider: "codex" }, "join_not_supported"],
    [{ workflowName: "release" }, "join_not_supported"],
    [{ noWriter: true }, "join_unavailable"],
  ] as const)("refuses %o with %s", async (opts, code) => {
    const t = await setup("owner", opts);
    const joined = await t.call("join_run", { runId: "r1" });
    expect(joined.isError).toBe(true);
    expect(joined.text).toContain(code);
    await t.client.close();
  });

  it("rejects an empty or too long message", async () => {
    const t = await setup("owner");
    await t.call("join_run", { runId: "r1" });
    expect((await t.call("send_to_run", { runId: "r1", message: "" })).isError).toBe(true);
    expect((await t.call("send_to_run", { runId: "r1", message: "x".repeat(8_001) })).isError).toBe(true);
    await t.client.close();
  });
});
