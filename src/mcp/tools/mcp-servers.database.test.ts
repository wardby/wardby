import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { createSecret } from "../../core/secrets.js";
import type { SecretCipher } from "../../providers/secrets/types.js";
import type { safeFetch } from "../../sandbox/safe-fetch.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerAgentTools } from "./agents.js";
import { registerMcpServerTools } from "./mcp-servers.js";

const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at = (...line: unknown[]): void => {
      logged.push(line);
    };
    return { child: () => make(), trace: at, debug: at, info: at, warn: at, error: at, fatal: at };
  };
  return { logger: make() };
});

const OFF = "Remote MCP servers are turned off on this server (WARDBY_MCP_SERVERS=off).";
const CANONICAL = "https://wardby.example/mcp";
const URL_ = "https://mcp.example.com/mcp?team=acme";
const SECRET = "sk-test-MCPSERVER-0123456789";
const cipher: SecretCipher = { keyId: () => "k", encrypt: async (v) => v, decrypt: async (c) => c };
const broker = {
  hosts: ["mcp.example.com"],
  placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
};

type Tool = { name: string; description?: string; inputSchema?: object; annotations?: object };

/** A fake Streamable HTTP MCP server behind the safeFetch seam; `tools` and `failWith` are swapped by tests. */
const fake = {
  tools: [] as Tool[],
  failWith: undefined as string | undefined,
  impl: (async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as { id?: number; method?: string }) : {};
    const respond = (status: number, payload: unknown) => ({
      ok: status < 400,
      status,
      statusText: "OK",
      url,
      headers: { "content-type": "application/json" },
      bodyBase64: Buffer.from(payload === undefined ? "" : JSON.stringify(payload)).toString("base64"),
    });
    if (body.id === undefined) return respond(202, undefined);
    if (fake.failWith && body.method === "tools/list") {
      return respond(200, { jsonrpc: "2.0", id: body.id, error: { code: -1, message: fake.failWith } });
    }
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
        : {
            tools: fake.tools.map((t) => ({
              inputSchema: { type: "object" },
              description: `does ${t.name}`,
              ...t,
            })),
          };
    return respond(200, { jsonrpc: "2.0", id: body.id, result });
  }) as unknown as typeof safeFetch,
};

const db = createPrismaClient();
const principalIds: string[] = [];
const agentIds: string[] = [];
const savedMode = process.env.WARDBY_MCP_SERVERS;

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `mcp-servers-${randomUUID()}` } });
  principalIds.push(p.id);
  await createSecret("MCP_TOKEN", SECRET, p.id, cipher, db, { broker });
  return p;
}

async function agent(p: Principal, kind: "native" | "coding" = "native") {
  const row = await db.agent.create({
    data: {
      name: `mcp-agent-${randomUUID()}`,
      systemPrompt: "x",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      ownerId: p.id,
      kind,
    },
  });
  agentIds.push(row.id);
  return row;
}

type Call = (name: string, a?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;

async function connect(p: Principal, options: { scopes?: string[]; roles?: string[] } = {}): Promise<Call> {
  const providers = { secrets: cipher, sandboxFetch: fake.impl } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  const ctx: McpRequestContext = {
    principal: p,
    scopes: new Set(options.scopes ?? ["tools:write", "agents:read", "hosts:admin"]),
    roles: options.roles ?? [],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerMcpServerTools(mcp);
  registerAgentTools(mcp);
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return async (name, a = {}) => {
    const result = (await client.callTool({ name, arguments: a })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: Boolean(result.isError), text: result.content[0].text };
  };
}

async function register(call: Call, name = "acme", secretNames = ["MCP_TOKEN"]) {
  const result = await call("register_mcp_server", { name, url: URL_, secretNames });
  expect(result.isError, result.text).toBe(false);
  return JSON.parse(result.text) as { id: string; tools: { name: string; description: string }[] };
}

const ok = (r: { isError: boolean; text: string }) => {
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text);
};

beforeAll(() => {
  delete process.env.WARDBY_MCP_SERVERS;
});
afterEach(() => {
  delete process.env.WARDBY_MCP_SERVERS;
  fake.tools = [{ name: "search" }, { name: "get_issue" }];
  fake.failWith = undefined;
});
afterAll(async () => {
  if (savedMode === undefined) delete process.env.WARDBY_MCP_SERVERS;
  else process.env.WARDBY_MCP_SERVERS = savedMode;
  await db.agent.deleteMany({ where: { id: { in: agentIds } } });
  await db.mcpServer.deleteMany({ where: { ownerId: { in: principalIds } } });
  await db.tool.deleteMany({ where: { ownerId: { in: principalIds } } });
  await db.secretBrokerChange.deleteMany({ where: { ownerId: { in: principalIds } } });
  await db.secret.deleteMany({ where: { ownerId: { in: principalIds } } });
  await db.principal.deleteMany({ where: { id: { in: principalIds } } });
  await db.$disconnect();
});

fake.tools = [{ name: "search" }, { name: "get_issue" }];

describe.skipIf(!process.env.DATABASE_URL)("MCP server tools (PostgreSQL)", () => {
  it("off mode refuses every MCP server tool, list and get included", async () => {
    const p = await principal();
    const call = await connect(p);
    const { id } = await register(call);
    const a = await agent(p);
    process.env.WARDBY_MCP_SERVERS = "off";
    for (const [name, args] of [
      ["register_mcp_server", { name: "other", url: URL_, secretNames: [] }],
      ["update_mcp_server", { id }],
      ["refresh_mcp_server", { id }],
      ["list_mcp_servers", {}],
      ["get_mcp_server", { id }],
      ["delete_mcp_server", { id }],
      ["attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search"] }],
      ["detach_mcp_server", { agentId: a.id, serverId: id }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toContain(OFF);
    }
  });

  it("admins mode needs hosts:admin (with a role granting it) to register, update or refresh", async () => {
    process.env.WARDBY_MCP_SERVERS = "admins";
    const p = await principal();
    const member = await connect(p, { roles: [] });
    const refused = await member("register_mcp_server", { name: "acme", url: URL_, secretNames: ["MCP_TOKEN"] });
    expect(refused.isError).toBe(true);
    expect(await db.mcpServer.count({ where: { ownerId: p.id } })).toBe(0);
    const admin = await connect(p, { roles: ["host-manager"] });
    const { id } = await register(admin);
    expect((await member("refresh_mcp_server", { id })).isError).toBe(true);
    expect((await member("update_mcp_server", { id })).isError).toBe(true);
    ok(await member("list_mcp_servers"));
    ok(await admin("refresh_mcp_server", { id }));
  });

  it("registers a server: validates input, saves the snapshot, refuses a duplicate name", async () => {
    const p = await principal();
    const call = await connect(p);
    fake.tools = [{ name: "search", description: "x".repeat(500), annotations: { readOnlyHint: true } }];
    const view = ok(await call("register_mcp_server", { name: "acme", url: URL_, secretNames: ["MCP_TOKEN"] }));
    expect(view).toMatchObject({ name: "acme", url: URL_, secretNames: ["MCP_TOKEN"], serverInfo: { name: "fake" } });
    expect(view.tools).toEqual([{ name: "search", description: "x".repeat(300), annotations: { readOnlyHint: true } }]);
    const row = await db.mcpServer.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.snapshotAt).not.toBeNull();
    expect((row.toolSnapshot as Tool[])[0].description).toBe("x".repeat(500));

    const dup = await call("register_mcp_server", { name: "acme", url: URL_, secretNames: [] });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("acme");
    for (const bad of [
      { name: "Bad Name", url: URL_, secretNames: [] },
      { name: "plain", url: "http://mcp.example.com/mcp", secretNames: [] },
      { name: "nosecret", url: URL_, secretNames: ["NOPE"] },
    ]) {
      const result = await call("register_mcp_server", bad);
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(await db.mcpServer.count({ where: { ownerId: p.id } })).toBe(1);
    const audit = logged.find((line) => JSON.stringify(line).includes("mcp.server.register"));
    expect(JSON.stringify(audit)).toContain("mcp.example.com");
    expect(JSON.stringify(audit)).not.toContain("team=acme");
  });

  it("maps a server error to a 502-style message with the client code, and saves nothing", async () => {
    const p = await principal();
    const call = await connect(p);
    fake.failWith = "upstream exploded";
    const result = await call("register_mcp_server", { name: "acme", url: URL_, secretNames: ["MCP_TOKEN"] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("mcp_server_error");
    expect(await db.mcpServer.count({ where: { ownerId: p.id } })).toBe(0);
  });

  it("never shows a secret value in register or get output, the stored snapshot, errors or logs", async () => {
    const p = await principal();
    const call = await connect(p);
    fake.tools = [{ name: "search", description: `Search with ${SECRET}` }];
    const registered = await call("register_mcp_server", { name: "acme", url: URL_, secretNames: ["MCP_TOKEN"] });
    expect(registered.text).not.toContain(SECRET);
    const { id } = ok(registered);
    const got = await call("get_mcp_server", { id });
    expect(got.text).not.toContain(SECRET);
    const row = await db.mcpServer.findUniqueOrThrow({ where: { id } });
    expect(JSON.stringify(row.toolSnapshot)).not.toContain(SECRET);
    fake.failWith = `bad key ${SECRET}`;
    const failed = await call("refresh_mcp_server", { id });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("mcp_server_error");
    expect(failed.text).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
  });

  it("update re-checks and re-snapshots, returning a diff; only the owner may update", async () => {
    const p = await principal();
    const call = await connect(p);
    const { id } = await register(call);
    fake.tools = [{ name: "search", description: "new words" }, { name: "create_issue" }];
    const view = ok(await call("update_mcp_server", { id, secretNames: [] }));
    expect(view.secretNames).toEqual([]);
    expect(view.diff).toEqual({ added: ["create_issue"], removed: ["get_issue"], changed: ["search"] });
    expect((await call("update_mcp_server", { id, url: "http://x.example.com/" })).isError).toBe(true);

    const stranger = await connect(await principal());
    const refused = await stranger("update_mcp_server", { id, secretNames: [] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("not found");
  });

  it("refresh applies straight away and reports the diff and agents left with missing tools", async () => {
    const p = await principal();
    const call = await connect(p);
    const { id } = await register(call);
    const a = await agent(p);
    ok(await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search", "get_issue"] }));
    fake.tools = [{ name: "search" }, { name: "list_projects" }];
    const result = ok(await call("refresh_mcp_server", { id }));
    expect(result.diff).toEqual({ added: ["list_projects"], removed: ["get_issue"], changed: [] });
    expect(result.affectedAgents).toEqual([{ agentId: a.id, missingTools: ["get_issue"] }]);

    const got = ok(await call("get_agent", { id: a.id }));
    expect(got.mcpServers).toEqual([
      {
        serverId: id,
        serverName: "acme",
        allowedTools: ["search", "get_issue"],
        exposedNames: ["acme__search", "acme__get_issue"],
        callTimeoutMs: null,
        missingTools: ["get_issue"],
      },
    ]);
  });

  it("lists only the caller's servers, with host and tool count, never the URL's query", async () => {
    const p = await principal();
    const call = await connect(p);
    const { id } = await register(call);
    const other = await connect(await principal());
    await register(other, "theirs");
    const list = ok(await call("list_mcp_servers"));
    expect(list.servers).toEqual([
      expect.objectContaining({ id, name: "acme", host: "mcp.example.com", ownerId: p.id, toolCount: 2, yours: true }),
    ]);
    expect(JSON.stringify(list)).not.toContain("team=acme");
    expect((await other("get_mcp_server", { id })).isError).toBe(true);
    const got = ok(await call("get_mcp_server", { id }));
    expect(got.tools.map((t: Tool) => t.name)).toEqual(["search", "get_issue"]);
    expect(got.tools[0].inputSchema).toEqual({ type: "object" });
  });

  it("delete removes the server and its attachments; only the owner may delete", async () => {
    const p = await principal();
    const call = await connect(p);
    const { id } = await register(call);
    const a = await agent(p);
    ok(await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search"] }));
    const stranger = await connect(await principal());
    expect((await stranger("delete_mcp_server", { id })).isError).toBe(true);
    ok(await call("delete_mcp_server", { id }));
    expect(await db.mcpServer.findUnique({ where: { id } })).toBeNull();
    expect(await db.agentMcpServer.count({ where: { agentId: a.id } })).toBe(0);
  });

  it("attach checks agent ownership, kind, server ownership, tool names and the time limit", async () => {
    const p = await principal();
    const call = await connect(p);
    const { id } = await register(call);
    const a = await agent(p);

    const coding = await agent(p, "coding");
    const codingResult = await call("attach_mcp_server", {
      agentId: coding.id,
      serverId: id,
      allowedTools: ["search"],
    });
    expect(codingResult.text).toContain("MCP servers attach to native agents only for now.");

    const q = await principal();
    const theirs = await agent(q);
    expect(
      (await call("attach_mcp_server", { agentId: theirs.id, serverId: id, allowedTools: ["search"] })).isError,
    ).toBe(true);
    const qCall = await connect(q);
    const qServer = await register(qCall, "qserver");
    const foreign = await call("attach_mcp_server", { agentId: a.id, serverId: qServer.id, allowedTools: ["search"] });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("not found");

    expect((await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: [] })).isError).toBe(true);
    expect((await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["*"] })).isError).toBe(true);
    const unknown = await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search", "nope"] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("nope");
    const dup = await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search", "search"] });
    expect(dup.isError).toBe(true);
    const slow = await call("attach_mcp_server", {
      agentId: a.id,
      serverId: id,
      allowedTools: ["search"],
      callTimeoutMs: 10_000_000,
    });
    expect(slow.isError).toBe(true);
    expect(slow.text).toMatch(/at most \d+/);
    expect(
      (await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search"], callTimeoutMs: 999 }))
        .isError,
    ).toBe(true);

    ok(await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["search"], callTimeoutMs: 5000 }));
    let row = await db.agentMcpServer.findUniqueOrThrow({
      where: { agentId_serverId: { agentId: a.id, serverId: id } },
    });
    expect(row).toMatchObject({ allowedTools: ["search"], callTimeoutMs: 5000, attachedById: p.id });
    // Re-attach replaces; an omitted callTimeoutMs is cleared.
    ok(await call("attach_mcp_server", { agentId: a.id, serverId: id, allowedTools: ["get_issue"] }));
    row = await db.agentMcpServer.findUniqueOrThrow({ where: { agentId_serverId: { agentId: a.id, serverId: id } } });
    expect(row).toMatchObject({ allowedTools: ["get_issue"], callTimeoutMs: null });

    ok(await call("detach_mcp_server", { agentId: a.id, serverId: id }));
    expect(await db.agentMcpServer.count({ where: { agentId: a.id } })).toBe(0);
  });

  it("attach refuses exposed names that clash with built-ins, attached tools or another server's tools", async () => {
    const p = await principal();
    const call = await connect(p);
    fake.tools = [{ name: "search" }, { name: "get_issue" }];
    const acme = await register(call, "acme");
    const a = await agent(p);

    const tool = await db.tool.create({
      data: {
        name: "acme__search",
        description: "d",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "",
        ownerId: p.id,
      },
    });
    await db.agentTool.create({ data: { agentId: a.id, toolId: tool.id, attachedById: p.id } });
    const clash = await call("attach_mcp_server", { agentId: a.id, serverId: acme.id, allowedTools: ["search"] });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("acme__search");
    await db.agentTool.deleteMany({ where: { agentId: a.id } });

    // Server "delegate_to_x" makes reserved delegate_to_* names.
    const delegate = await register(call, "delegate_to_x");
    const reserved = await call("attach_mcp_server", {
      agentId: a.id,
      serverId: delegate.id,
      allowedTools: ["search"],
    });
    expect(reserved.isError).toBe(true);
    expect(reserved.text).toContain("delegate_to_x__search");

    // Two tools of one server mapping to the same exposed name.
    fake.tools = [{ name: "get.issue" }, { name: "get_issue" }, { name: "get__issue" }];
    const odd = await register(call, "odd");
    const same = await call("attach_mcp_server", {
      agentId: a.id,
      serverId: odd.id,
      allowedTools: ["get.issue", "get_issue"],
    });
    expect(same.isError).toBe(true);
    expect(same.text).toContain("odd__get_issue");

    // Another server's exposed name already on the agent: odd + get__issue = odd__get + issue.
    ok(await call("attach_mcp_server", { agentId: a.id, serverId: odd.id, allowedTools: ["get__issue"] }));
    fake.tools = [{ name: "issue" }];
    const odd2 = await register(call, "odd__get");
    const cross = await call("attach_mcp_server", { agentId: a.id, serverId: odd2.id, allowedTools: ["issue"] });
    expect(cross.isError).toBe(true);
    expect(cross.text).toContain("odd__get__issue");
  });
});
