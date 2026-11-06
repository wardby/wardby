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
      serverOwnerId: "p1",
      url: URL_,
      secretNames: [],
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
      ctx: { db, cipher, agentId, signal: extra.signal ?? new AbortController().signal, fetchImpl, log, ...extra },
    };
  };

  it("pins only allowed tools present in the snapshot, with the server's live details", async () => {
    const pins = await loadMcpToolPins(db, agentId);
    expect(pins.map((p) => p.exposedName)).toEqual(["datadog__search", "datadog__slow"]);
    expect(pins[0]).toMatchObject({
      toolName: "search",
      serverId,
      serverName: "datadog",
      serverOwnerId: owner,
      url: URL_,
      secretNames: ["DD_KEY"],
      definition: { description: "Searches logs.", inputSchema: { type: "object" } },
    });
    expect("callTimeoutMs" in pins[0]).toBe(false);
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
    expect(fields).toMatchObject({ serverId, tool: "search", outcome: "ok", resultChars: out.length });
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
});
