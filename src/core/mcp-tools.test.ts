import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import { createSecret } from "./secrets.js";
import { loadAgentSecretValues } from "./secret-guard.js";
import {
  handleMcpTool,
  loadMcpToolPins,
  mcpSecretValuesForAgent,
  mcpToolDefs,
  withoutClashingPins,
  type McpToolPin,
} from "./mcp-tools.js";
import type { safeFetch } from "../sandbox/safe-fetch.js";
import { fakeMcpServer as fakeServer, textResult } from "./mcp-tools.test-support.js";
import { MCP_RESULT_MAX_CHARS } from "./mcp-client/results.js";
import type { Logger } from "./logger.js";

// Fake values only.
const SECRET = "sk-fake-mcp-tools-ABCDEF123456";
const URL_ = "https://mcp.example.com/mcp?team=your-org";

function fakeLog() {
  const info = vi.fn();
  const warn = vi.fn();
  return { log: { info, warn } as unknown as Logger, info, warn };
}

describe("mcpToolDefs", () => {
  it("prefixes the description with the server name and uses the exposed name and input schema", () => {
    const pin: McpToolPin = {
      exposedName: "datadog__search",
      toolName: "search",
      serverId: "s1",
      serverName: "datadog",
      definition: { description: "Searches logs.", inputSchema: { type: "object" } },
    };
    expect(mcpToolDefs([pin])).toEqual([
      {
        name: "datadog__search",
        description: "From MCP server datadog: Searches logs.",
        jsonSchema: { type: "object" },
      },
    ]);
  });

  it("leaves out a pin whose exposed name clashes with another tool, with a warning", () => {
    const { log, warn } = fakeLog();
    const pin = { exposedName: "lookup", serverId: "s1", toolName: "lookup" } as McpToolPin;
    const other = { ...pin, exposedName: "datadog__x" };
    expect(withoutClashingPins([pin, other], ["lookup"], log)).toEqual([other]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("lookup");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("MCP tools in runs (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID().slice(0, 8);
  const owner = `mcpt-owner-${suffix}`;
  const agentId = `mcpt-agent-${suffix}`;
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  let serverId = "";
  const env = { ...process.env };

  const broker = {
    hosts: ["mcp.example.com"],
    placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
  };

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 2, ownerId: owner },
    });
    await createSecret("DD_KEY", SECRET, owner, cipher, db, { broker });
    const server = await db.mcpServer.create({
      data: {
        ownerId: owner,
        name: "datadog",
        url: URL_,
        secretNames: ["DD_KEY"],
        toolSnapshot: [
          { name: "search", description: "Searches logs.", inputSchema: { type: "object" } },
          { name: "slow", description: "Takes its time.", inputSchema: { type: "object" } },
          { name: "unallowed", description: "Not allowed.", inputSchema: { type: "object" } },
        ],
      },
    });
    serverId = server.id;
  });
  beforeEach(async () => {
    await db.agentMcpServer.deleteMany({ where: { agentId } });
    await db.agentMcpServer.create({
      data: { agentId, serverId, allowedTools: ["search", "slow", "missing"], attachedById: owner },
    });
  });
  afterEach(() => {
    process.env = { ...env };
  });
  afterAll(async () => {
    await db.agentMcpServer.deleteMany({ where: { agentId } });
    await db.mcpServer.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.secretBrokerChange.deleteMany({ where: { ownerId: owner } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  const pinFor = async (tool: string) => {
    const pin = (await loadMcpToolPins(db, agentId)).find((p) => p.toolName === tool);
    if (!pin) throw new Error(`no pin for ${tool}`);
    return pin;
  };
  const ctx = (fetchImpl: typeof safeFetch, extra: { signal?: AbortSignal; deadlineAt?: Date } = {}) => {
    const { log, info } = fakeLog();
    return {
      info,
      ctx: {
        db,
        cipher,
        agentId,
        runId: `mcpt-run-${suffix}`,
        signal: extra.signal ?? new AbortController().signal,
        fetchImpl,
        log,
        ...extra,
      },
    };
  };

  it("keeps a tool out of a Codex run once a refresh drops its readOnlyHint, and refuses a call already pinned", async () => {
    const codexId = `mcpt-codex-${suffix}`;
    const claudeId = `mcpt-claude-${suffix}`;
    for (const [id, provider] of [
      [codexId, "codex"],
      [claudeId, "claude-code"],
    ] as const) {
      await db.agent.create({
        data: {
          id,
          name: id,
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          ownerId: owner,
          kind: "coding",
          codingProfile: { create: { provider, repository: "your-org/your-repo", protectedPaths: [] } },
        },
      });
      await db.agentMcpServer.create({
        data: { agentId: id, serverId, allowedTools: ["search"], attachedById: owner },
      });
    }
    const setSnapshot = (annotations?: Record<string, boolean>) =>
      db.mcpServer.update({
        where: { id: serverId },
        data: { toolSnapshot: [{ name: "search", description: "x", inputSchema: { type: "object" }, annotations }] },
      });
    try {
      await setSnapshot({ readOnlyHint: true });
      const codexPins = await loadMcpToolPins(db, codexId);
      expect(codexPins.map((p) => p.toolName)).toEqual(["search"]);

      await setSnapshot({ readOnlyHint: false });
      expect(await loadMcpToolPins(db, codexId)).toEqual([]);
      expect((await loadMcpToolPins(db, claudeId)).map((p) => p.toolName)).toEqual(["search"]);

      // A pin taken before the refresh is refused at call time.
      const server = fakeServer(() => textResult("ran"));
      const base = ctx(server.impl).ctx;
      const refused = JSON.parse(await handleMcpTool(codexPins[0], "{}", { ...base, agentId: codexId }));
      expect(refused.error).toBe("mcp_tool_not_allowed");
      expect(refused.message).toContain("read-only");
      expect(server.seen).toEqual([]);
      expect(await handleMcpTool(codexPins[0], "{}", { ...base, agentId: claudeId })).toBe("ran");
    } finally {
      await db.mcpServer.update({
        where: { id: serverId },
        data: {
          toolSnapshot: [
            { name: "search", description: "Searches logs.", inputSchema: { type: "object" } },
            { name: "slow", description: "Takes its time.", inputSchema: { type: "object" } },
            { name: "unallowed", description: "Not allowed.", inputSchema: { type: "object" } },
          ],
        },
      });
      await db.agentMcpServer.deleteMany({ where: { agentId: { in: [codexId, claudeId] } } });
      await db.agent.deleteMany({ where: { id: { in: [codexId, claudeId] } } });
    }
  });

  it("pins only allowed tools present in the snapshot, without the URL, secret names or owner id", async () => {
    const pins = await loadMcpToolPins(db, agentId);
    expect(pins.map((p) => p.exposedName)).toEqual(["datadog__search", "datadog__slow"]);
    expect(pins[0]).toEqual({
      exposedName: "datadog__search",
      toolName: "search",
      serverId,
      serverName: "datadog",
      definition: { description: "Searches logs.", inputSchema: { type: "object" } },
    });
    // Pins are saved in step results: a URL query can carry a token.
    expect(JSON.stringify(pins)).not.toContain("mcp.example.com");
    expect(JSON.stringify(pins)).not.toContain("DD_KEY");
  });

  it("still calls through a pin saved before pins dropped url, secretNames and serverOwnerId", async () => {
    const server = fakeServer(() => textResult("old pin ok"));
    const legacy = {
      ...(await pinFor("search")),
      serverOwnerId: owner,
      url: "https://stale.example.com/mcp",
      secretNames: ["STALE"],
    } as McpToolPin;
    expect(await handleMcpTool(legacy, "{}", ctx(server.impl).ctx)).toBe("old pin ok");
    // The live row decides where the call goes and which secret it carries.
    expect(server.seen[0].authorization).toBe(`Bearer ${SECRET}`);
  });

  it("pins nothing when WARDBY_MCP_SERVERS is off", async () => {
    process.env.WARDBY_MCP_SERVERS = "off";
    expect(await loadMcpToolPins(db, agentId)).toEqual([]);
  });

  it("calls the tool with the brokered secret and returns its text, logging one line without arguments", async () => {
    const server = fakeServer((name, args) => textResult(`${name} found ${String(args.q)}`));
    const { ctx: c, info } = ctx(server.impl);
    const out = await handleMcpTool(await pinFor("search"), JSON.stringify({ q: "errors-arg" }), c);
    expect(out).toBe("search found errors-arg");
    expect(server.seen.map((s) => s.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ]);
    expect(server.seen[0].authorization).toBe(`Bearer ${SECRET}`);
    expect(info).toHaveBeenCalledTimes(1);
    const [fields] = info.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      runId: `mcpt-run-${suffix}`,
      agentId,
      serverId,
      tool: "search",
      outcome: "ok",
      resultChars: out.length,
    });
    expect(Object.keys(fields).sort()).toEqual(
      ["agentId", "durationMs", "outcome", "resultChars", "runId", "serverId", "tool"].sort(),
    );
    expect(typeof fields.durationMs).toBe("number");
    expect(JSON.stringify(info.mock.calls)).not.toContain("errors-arg");
    expect(JSON.stringify(info.mock.calls)).not.toContain("mcp.example.com");
  });

  it("redacts the server's secret from the result", async () => {
    const server = fakeServer(() => textResult(`the key is ${SECRET} and ${Buffer.from(SECRET).toString("base64")}`));
    const out = await handleMcpTool(await pinFor("search"), "{}", ctx(server.impl).ctx);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(out).toContain("[REDACTED]");
  });

  it("refuses a call once the server is detached or the tool is no longer allowed", async () => {
    const server = fakeServer(() => textResult("never"));
    const pin = await pinFor("search");
    await db.agentMcpServer.update({
      where: { agentId_serverId: { agentId, serverId } },
      data: { allowedTools: ["slow"] },
    });
    expect(JSON.parse(await handleMcpTool(pin, "{}", ctx(server.impl).ctx)).error).toBe("mcp_tool_not_allowed");
    await db.agentMcpServer.deleteMany({ where: { agentId } });
    expect(JSON.parse(await handleMcpTool(pin, "{}", ctx(server.impl).ctx)).error).toBe("mcp_tool_not_allowed");
    expect(server.seen).toEqual([]);
  });

  it("refuses a call once the tool is gone from the server's saved list", async () => {
    const server = fakeServer(() => textResult("never"));
    const pin = await pinFor("search");
    const before = await db.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    await db.mcpServer.update({
      where: { id: serverId },
      data: { toolSnapshot: [{ name: "slow", description: "", inputSchema: { type: "object" } }] },
    });
    try {
      expect(JSON.parse(await handleMcpTool(pin, "{}", ctx(server.impl).ctx)).error).toBe("mcp_tool_removed");
    } finally {
      await db.mcpServer.update({ where: { id: serverId }, data: { toolSnapshot: before.toolSnapshot as object } });
    }
  });

  it("refuses a call when WARDBY_MCP_SERVERS is off", async () => {
    const pin = await pinFor("search");
    process.env.WARDBY_MCP_SERVERS = "off";
    const out = JSON.parse(await handleMcpTool(pin, "{}", ctx(fakeServer(() => textResult("x")).impl).ctx));
    expect(out).toEqual({
      error: "mcp_servers_off",
      message: "Remote MCP servers are turned off on this server (WARDBY_MCP_SERVERS=off).",
    });
  });

  it("times out a call that outlasts callTimeoutMs", async () => {
    await db.agentMcpServer.update({ where: { agentId_serverId: { agentId, serverId } }, data: { callTimeoutMs: 50 } });
    const server = fakeServer(() => new Promise(() => {}));
    const out = JSON.parse(await handleMcpTool(await pinFor("slow"), "{}", ctx(server.impl).ctx));
    expect(out.error).toBe("mcp_call_timeout");
    expect(out.message).toContain("50 ms");
  });

  it("cuts the time limit to the run's deadline when that is sooner", async () => {
    const server = fakeServer(() => new Promise(() => {}));
    const started = Date.now();
    const out = JSON.parse(
      await handleMcpTool(await pinFor("slow"), "{}", ctx(server.impl, { deadlineAt: new Date(Date.now() + 80) }).ctx),
    );
    expect(out.error).toBe("mcp_call_timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("stops a call in flight when the run's stop signal fires", async () => {
    const controller = new AbortController();
    const server = fakeServer(() => {
      setTimeout(() => controller.abort(new Error("run_cancelled")), 20);
      return new Promise(() => {});
    });
    const out = JSON.parse(
      await handleMcpTool(await pinFor("slow"), "{}", ctx(server.impl, { signal: controller.signal }).ctx),
    );
    expect(out).toEqual({ error: "mcp_call_timeout", message: "The call was stopped." });
  });

  it("stops a call whose stop signal fires while the server's secrets are loading", async () => {
    const controller = new AbortController();
    const server = fakeServer(() => textResult("never"));
    const stoppingCipher = {
      ...cipher,
      decrypt: async (s: string) => {
        controller.abort(new Error("run_cancelled"));
        return s;
      },
    };
    const c = { ...ctx(server.impl, { signal: controller.signal }).ctx, cipher: stoppingCipher };
    const out = JSON.parse(await handleMcpTool(await pinFor("slow"), "{}", c));
    expect(out).toEqual({ error: "mcp_call_timeout", message: "The call was stopped." });
    expect(server.seen.map((s) => s.method)).not.toContain("tools/call");
  });

  it("redacts a secret that straddles the result cap before truncating it", async () => {
    const encoded = Buffer.from(SECRET).toString("base64");
    for (const value of [SECRET, encoded]) {
      const pad = "x".repeat(MCP_RESULT_MAX_CHARS - Math.floor(value.length / 2));
      for (const isError of [false, true]) {
        const server = fakeServer(() => ({
          isError,
          content: [{ type: "text", text: `${pad}${value}${"y".repeat(200)}` }],
        }));
        const { ctx: c, info } = ctx(server.impl);
        const out = await handleMcpTool(await pinFor("search"), "{}", c);
        const prefix = value.slice(0, Math.floor(value.length / 2));
        const text = isError ? (JSON.parse(out) as { message: string }).message : out;
        expect(text.startsWith(pad)).toBe(true);
        expect(text.slice(pad.length)).not.toContain(prefix);
        expect(text).toContain("[REDACTED]");
        expect(text).toMatch(/\[truncated: \d+ characters omitted\]$/);
        const [fields] = info.mock.calls[0] as [Record<string, unknown>];
        expect(fields.outcome).toBe(isError ? "mcp_server_error" : "ok");
      }
    }
  });

  it("refuses arguments that are not a JSON object", async () => {
    const server = fakeServer(() => textResult("never"));
    for (const args of ["[1]", '"text"', "not json", "null"]) {
      const out = JSON.parse(await handleMcpTool(await pinFor("search"), args, ctx(server.impl).ctx));
      expect(out.error).toBe("invalid_arguments");
    }
    expect(server.seen).toEqual([]);
  });

  it("reports mcp_server_auth_failed when the server refuses the credentials", async () => {
    const server = fakeServer(() => textResult("never"), { status: 401 });
    const out = JSON.parse(await handleMcpTool(await pinFor("search"), "{}", ctx(server.impl).ctx));
    expect(out.error).toBe("mcp_server_auth_failed");
  });

  it("redacts the secret from an error the server sends back", async () => {
    const server = fakeServer(() => ({ isError: true, content: [{ type: "text", text: `bad key ${SECRET}` }] }));
    const out = await handleMcpTool(await pinFor("search"), "{}", ctx(server.impl).ctx);
    expect(JSON.parse(out).error).toBe("mcp_server_error");
    expect(out).not.toContain(SECRET);
  });

  it("adds every attached server's secret values to the agent's redaction list", async () => {
    expect((await mcpSecretValuesForAgent(db, cipher, agentId)).includes(SECRET)).toBe(true);
    const named = await loadAgentSecretValues(db, cipher, agentId);
    const entry = named.find((n) => n.name === "mcp:datadog/DD_KEY");
    expect(entry?.values.includes(SECRET)).toBe(true);
    expect(entry?.values.includes(Buffer.from(SECRET).toString("base64"))).toBe(true);
  });
  describe("an agent whose owner uses the server through a grant", () => {
    const guest = `mcpt-guest-${suffix}`;
    const guestAgentId = `mcpt-gagent-${suffix}`;
    const guestCtx = (fetchImpl: typeof safeFetch) => ({ ...ctx(fetchImpl).ctx, agentId: guestAgentId });
    const guestPin = async () => {
      const pin = (await loadMcpToolPins(db, guestAgentId)).find((p) => p.toolName === "search");
      if (!pin) throw new Error("no guest pin");
      return pin;
    };
    const setGrant = (level: string | null) =>
      level === null
        ? db.resourceGrant.deleteMany({ where: { resourceType: "mcp_server", resourceId: serverId } })
        : db.resourceGrant.upsert({
            where: {
              resourceType_resourceId_granteeKey: {
                resourceType: "mcp_server",
                resourceId: serverId,
                granteeKey: `principal:${guest}`,
              },
            },
            create: {
              resourceType: "mcp_server",
              resourceId: serverId,
              granteeKind: "principal",
              granteePrincipalId: guest,
              granteeKey: `principal:${guest}`,
              level,
              source: "owner",
              grantedById: owner,
            },
            update: { level },
          });

    beforeAll(async () => {
      await db.principal.create({ data: { id: guest, subject: guest } });
      await db.agent.create({
        data: {
          id: guestAgentId,
          name: guestAgentId,
          systemPrompt: "x",
          model: "m",
          budgetUsd: 1,
          maxTurns: 2,
          ownerId: guest,
        },
      });
    });
    beforeEach(async () => {
      await setGrant("use");
      await db.agentMcpServer.deleteMany({ where: { agentId: guestAgentId } });
      await db.agentMcpServer.create({
        data: { agentId: guestAgentId, serverId, allowedTools: ["search"], attachedById: guest },
      });
    });
    afterAll(async () => {
      await db.agentMcpServer.deleteMany({ where: { agentId: guestAgentId } });
      await setGrant(null);
      await db.agent.deleteMany({ where: { id: guestAgentId } });
      await db.principal.deleteMany({ where: { id: guest } });
    });

    it("pins and calls the server while the grant is use", async () => {
      const server = fakeServer(() => textResult("shared ok"));
      expect(await handleMcpTool(await guestPin(), "{}", guestCtx(server.impl))).toBe("shared ok");
    });

    it.each([null, "read"])("after the grant becomes %s, the run's pins leave the server out", async (level) => {
      await setGrant(level);
      expect(await loadMcpToolPins(db, guestAgentId)).toEqual([]);
      // The server owner's own agent is untouched.
      expect((await loadMcpToolPins(db, agentId)).map((p) => p.exposedName)).toEqual([
        "datadog__search",
        "datadog__slow",
      ]);
    });

    it.each([null, "read"])(
      "a run already holding the pin gets mcp_tool_not_allowed on its next call (grant %s)",
      async (level) => {
        const server = fakeServer(() => textResult("never"));
        const pin = await guestPin();
        await setGrant(level);
        const out = JSON.parse(await handleMcpTool(pin, "{}", guestCtx(server.impl)));
        expect(out.error).toBe("mcp_tool_not_allowed");
        expect(out.message).toContain("no longer has use access");
        expect(server.seen).toEqual([]);
        // The owner's own agent keeps calling.
        expect(
          await handleMcpTool(await pinFor("search"), "{}", ctx(fakeServer(() => textResult("ok")).impl).ctx),
        ).toBe("ok");
      },
    );

    it("hides the owner's secret names from a grantee's run when the credentials can't be loaded", async () => {
      const before = await db.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
      await db.mcpServer.update({ where: { id: serverId }, data: { secretNames: ["DD_KEY", "OWNER_ONLY_NAME"] } });
      try {
        const server = fakeServer(() => textResult("never"));
        const shared = JSON.parse(await handleMcpTool(await guestPin(), "{}", guestCtx(server.impl)));
        expect(shared).toEqual({
          error: "mcp_server_error",
          message: "The MCP server's credentials can't be used; ask its owner to check it.",
        });
        // The owner's own run keeps the detail it can act on.
        const own = JSON.parse(await handleMcpTool(await pinFor("search"), "{}", ctx(server.impl).ctx));
        expect(own.error).toBe("mcp_server_error");
        expect(own.message).toContain("OWNER_ONLY_NAME");
        expect(own.message).toContain("your secrets");
        expect(server.seen).toEqual([]);
      } finally {
        await db.mcpServer.update({ where: { id: serverId }, data: { secretNames: before.secretNames } });
      }
    });
  });
});
