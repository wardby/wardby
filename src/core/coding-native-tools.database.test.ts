import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleNativeTool,
  loadNativeToolPins,
  NATIVE_TOOL_SECRETS_UNAVAILABLE_MESSAGE,
  type NativeToolContext,
  type NativeToolPin,
} from "./coding-native-tools.js";
import { handleCodingMcpRequest } from "./coding-mcp.js";
import { createPrismaClient } from "./db.js";
import { mcpTokenHash, mintMcpToken } from "../coding/mcp-token.js";
import type { Logger } from "./logger.js";
import { PostgresDatastore } from "../providers/datastore/index.js";

// Fake values only.
const SECRET = "fake-native-tool-secret-ABCD1234";
const BROKERED = "fake-native-brokered-secret-WXYZ9876";

describe.skipIf(!process.env.DATABASE_URL)("native tools in coding runs (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const owner = `cnt-owner-${tag}`;
  const other = `cnt-other-${tag}`;
  const agentId = `cnt-agent-${tag}`;
  const runId = `cnt-run-${tag}`;
  const sharedId = `cnt-shared-${tag}`;
  const tools = {
    echo: `cnt-echo-${tag}`,
    stores: `cnt-stores-${tag}`,
    slow: `cnt-slow-${tag}`,
    thrower: `cnt-thrower-${tag}`,
    badName: `cnt-badname-${tag}`,
    brokered: `cnt-brokered-${tag}`,
  };
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const datastore = new PostgresDatastore(db, cipher);
  const info = vi.fn();
  const warn = vi.fn();
  const log = { info, warn, error: vi.fn() } as unknown as Logger;
  const consoleLines: unknown[] = [];
  const consoleLogger = {
    child: () => consoleLogger,
    info: (...a: unknown[]) => consoleLines.push(a),
    warn: (...a: unknown[]) => consoleLines.push(a),
    error: (...a: unknown[]) => consoleLines.push(a),
  } as unknown as Logger;

  const pinOf = (toolId: string, name: string): NativeToolPin => ({
    kind: "native",
    exposedName: name,
    toolId,
    toolName: name,
    definition: { description: name, inputSchema: { type: "object" } },
  });
  const ctx = (extra: Partial<NativeToolContext> = {}): NativeToolContext => ({
    db,
    secrets: cipher,
    datastore,
    agentId,
    runId,
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 60_000),
    consoleLogger,
    log,
    ...extra,
  });

  const tool = async (id: string, name: string, code: string, timeoutMs?: number) => {
    await db.tool.create({
      data: {
        id,
        name,
        description: `The ${name} tool.`,
        paramsZod: "z.object({ q: z.string().optional() })",
        jsonSchema: { type: "object", properties: { q: { type: "string" } } },
        code,
        ownerId: owner,
        ...(timeoutMs ? { timeoutMs } : {}),
      },
    });
  };

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.principal.create({ data: { id: other, subject: other } });
    await db.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "m", budgetUsd: 1, maxTurns: 2, ownerId: owner },
    });
    const secret = await db.secret.create({
      data: { name: `api-${tag}`, ciphertext: SECRET, keyId: "test", ownerId: owner },
    });
    await db.agentSecret.create({ data: { agentId, secretId: secret.id, boundName: "API_KEY" } });
    const brokered = await db.secret.create({
      data: {
        name: `brokered-${tag}`,
        ciphertext: BROKERED,
        keyId: "test",
        ownerId: owner,
        broker: {
          hosts: ["api.example.com"],
          placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
        },
      },
    });
    await db.agentSecret.create({ data: { agentId, secretId: brokered.id, boundName: "SEARCH_KEY" } });
    await db.datastore.create({ data: { id: sharedId, name: `kb-${tag}`, ownerId: owner } });
    await db.agentDatastore.create({ data: { agentId, datastoreId: sharedId, boundName: "kb" } });
    await datastore.setShared(sharedId, "public/a", "shared-a");
    await datastore.setShared(sharedId, "private/b", "shared-b");
    await datastore.set(agentId, "notes/x", "private-x");
    await datastore.set(agentId, "other/y", "private-y");

    await tool(
      tools.echo,
      "echo_secret",
      `const v = await secrets.get("API_KEY");
       console.log("value is", v);
       if (params.q === "throw") throw new Error("failed with " + v);
       return { echoed: v, enc: encodeURIComponent(v), q: params.q ?? null };`,
    );
    await tool(
      tools.stores,
      "stores",
      `const r = {};
       try { r.privateOk = await datastore.get("notes/x"); } catch (e) { r.privateOk = "denied"; }
       try { r.privateDenied = await datastore.get("other/y"); } catch (e) { r.privateDenied = "denied"; }
       try { r.sharedOk = await sharedDatastore.get("kb", "public/a"); } catch (e) { r.sharedOk = "denied"; }
       try { r.sharedDenied = await sharedDatastore.get("kb", "private/b"); } catch (e) { r.sharedDenied = "denied"; }
       try { r.secret = (await secrets.get("API_KEY")) ? "read" : "none"; } catch (e) { r.secret = "denied"; }
       return r;`,
    );
    await tool(tools.slow, "slow", `await new Promise((r) => setTimeout(r, 30000)); return "late";`);
    await tool(tools.thrower, "thrower", `throw new Error("plain failure");`);
    await tool(tools.badName, "bad name!", `return 1;`);
    // A brokered value the tool can't read, reaching it another way (here, a stored note).
    await datastore.set(agentId, "notes/b", `token ${BROKERED}`);
    await tool(tools.brokered, "leak_brokered", `return { note: await datastore.get("notes/b") };`);

    const grant = {
      allowedSecrets: ["API_KEY", "SEARCH_KEY"],
      allowedDatastorePrefixes: ["notes/"],
      allowedSharedDatastorePrefixes: { kb: ["public/"] },
      capabilitiesGrantedById: owner,
    };
    for (const id of Object.values(tools)) {
      await db.agentTool.create({ data: { agentId, toolId: id, ...grant } });
    }
  });
  beforeEach(() => {
    info.mockClear();
    warn.mockClear();
    consoleLines.length = 0;
  });
  afterAll(async () => {
    await db.codingProxySession.deleteMany({ where: { runId } });
    await db.codingRun.deleteMany({ where: { runId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.agentTool.deleteMany({ where: { agentId } });
    await db.tool.deleteMany({ where: { id: { in: Object.values(tools) } } });
    await db.agentDatastore.deleteMany({ where: { agentId } });
    await db.datastoreEntry.deleteMany({ where: { OR: [{ agentId }, { datastoreId: sharedId }] } });
    await db.datastore.deleteMany({ where: { id: sharedId } });
    await db.agentSecret.deleteMany({ where: { agentId } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: { in: [owner, other] } } });
    await db.$disconnect();
  });

  it("pins the attached tools by name with their description and schema, leaving out a name Claude Code can't take", async () => {
    const pins = await loadNativeToolPins(db, agentId, log);
    expect(pins.map((p) => p.exposedName)).toEqual(["echo_secret", "leak_brokered", "slow", "stores", "thrower"]);
    expect(pins[0]).toEqual({
      kind: "native",
      exposedName: "echo_secret",
      toolId: tools.echo,
      toolName: "echo_secret",
      definition: {
        description: "The echo_secret tool.",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    });
    // No code and no grants in a pin.
    expect(JSON.stringify(pins)).not.toContain("secrets.get");
    expect(JSON.stringify(pins)).not.toContain("API_KEY");
    expect(warn).toHaveBeenCalledWith(
      { agentId, toolId: tools.badName },
      "native tool left out of the coding run: its name can't be offered",
    );
  });

  it("runs the tool with the attachment's grants: private and shared datastore prefixes enforced", async () => {
    const text = await handleNativeTool(pinOf(tools.stores, "stores"), "{}", ctx());
    expect(JSON.parse(text)).toEqual({
      privateOk: "private-x",
      // Outside the granted prefixes: nothing comes back.
      privateDenied: null,
      sharedOk: "shared-a",
      sharedDenied: null,
      secret: "read",
    });
  });

  it("redacts a fake secret value from the result, in plain and encoded forms, and from the console line", async () => {
    const text = await handleNativeTool(pinOf(tools.echo, "echo_secret"), '{"q":"hi"}', ctx());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(encodeURIComponent(SECRET));
    expect(JSON.parse(text)).toMatchObject({ q: "hi" });
    expect(JSON.stringify(consoleLines)).toContain("value is");
    expect(JSON.stringify(consoleLines)).not.toContain(SECRET);
    // The call's log line: ids, name, outcome and sizes only.
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, message] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe("native tool call");
    expect(Object.keys(fields).sort()).toEqual(
      ["agentId", "durationMs", "outcome", "resultChars", "runId", "tool", "toolId"].sort(),
    );
    expect(fields.outcome).toBe("ok");
    expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(info.mock.calls)).not.toContain('"hi"');
  });

  it("redacts a brokered secret's fake value too, though the tool can't read it", async () => {
    const text = await handleNativeTool(pinOf(tools.brokered, "leak_brokered"), "{}", ctx());
    expect(text).toContain("token ");
    expect(text).not.toContain(BROKERED);
  });

  it("redacts a fake secret value from a tool's error", async () => {
    const text = await handleNativeTool(pinOf(tools.echo, "echo_secret"), '{"q":"throw"}', ctx());
    expect(JSON.parse(text)).toMatchObject({ error: expect.any(String) });
    expect(text).toContain("failed with");
    expect(text).not.toContain(SECRET);
    expect((info.mock.calls[0] as [Record<string, unknown>])[0].outcome).toBe("tool_error");
  });

  it("returns a fixed error and never runs the tool when the secrets can't be read", async () => {
    const broken = { ...cipher, decrypt: async () => Promise.reject(new Error(`cannot decrypt ${SECRET}`)) };
    const text = await handleNativeTool(pinOf(tools.echo, "echo_secret"), "{}", ctx({ secrets: broken }));
    expect(JSON.parse(text)).toEqual({
      error: "secret_check_unavailable",
      message: NATIVE_TOOL_SECRETS_UNAVAILABLE_MESSAGE,
    });
    expect(consoleLines).toEqual([]);
    expect(text).not.toContain(SECRET);
  });

  it("runs an attachment the agent's owner never granted with no capabilities", async () => {
    await db.agentTool.update({
      where: { agentId_toolId: { agentId, toolId: tools.stores } },
      data: { capabilitiesGrantedById: other },
    });
    try {
      const text = await handleNativeTool(pinOf(tools.stores, "stores"), "{}", ctx());
      expect(JSON.parse(text)).toEqual({
        privateOk: null,
        privateDenied: null,
        sharedOk: null,
        sharedDenied: null,
        secret: "none",
      });
    } finally {
      await db.agentTool.update({
        where: { agentId_toolId: { agentId, toolId: tools.stores } },
        data: { capabilitiesGrantedById: owner },
      });
    }
  });

  it("refuses a tool that was detached after the run was pinned", async () => {
    const text = await handleNativeTool(pinOf(`cnt-gone-${tag}`, "gone"), "{}", ctx());
    expect(JSON.parse(text)).toEqual({
      error: "mcp_tool_not_allowed",
      message: 'The tool "gone" is no longer allowed for this agent: it was detached.',
    });
  });

  it("stops a call in flight when its signal aborts, and refuses one already stopped", async () => {
    const stop = new AbortController();
    const pending = handleNativeTool(pinOf(tools.slow, "slow"), "{}", ctx({ signal: stop.signal }));
    setTimeout(() => stop.abort(), 200);
    const text = await pending;
    expect(JSON.parse(text)).toMatchObject({ error: expect.any(String) });
    expect(text).not.toContain("late");
    expect(JSON.parse(await handleNativeTool(pinOf(tools.slow, "slow"), "{}", ctx({ signal: stop.signal })))).toEqual({
      error: "mcp_call_timeout",
      message: "The call was stopped.",
    });
  });

  it("never runs past the session deadline", async () => {
    const text = await handleNativeTool(pinOf(tools.slow, "slow"), "{}", ctx({ deadlineAt: new Date(Date.now() - 1) }));
    expect(JSON.parse(text)).toEqual({ error: "mcp_call_timeout", message: "The run's time limit has been reached." });
  });

  it("reports a tool's own failure as its error", async () => {
    const text = await handleNativeTool(pinOf(tools.thrower, "thrower"), "{}", ctx());
    expect(JSON.parse(text)).toMatchObject({
      error: expect.any(String),
      message: expect.stringContaining("plain failure"),
    });
  });

  describe("through /coding-mcp", () => {
    const token = mintMcpToken();
    const callBody = (name: string, args: Record<string, unknown> = {}) =>
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const resultOf = (body: string) =>
      (JSON.parse(body) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    const gateway = (body: string) =>
      handleCodingMcpRequest(`Bearer ${token}`, body, { db, cipher, datastore, log, stopPollMs: 25 });

    beforeAll(async () => {
      await db.run.create({ data: { id: runId, agentId, status: "running", executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId,
          task: "test",
          repository: "your-org/your-repo",
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "claude-code",
          model: "claude-sonnet-4-6",
          timeoutSec: 60,
          allowedEgress: [],
          protectedPaths: [],
          budgetReservedUsd: 0.01,
          budgetLimitedBy: "week",
        },
      });
      await db.codingProxySession.create({
        data: {
          runId,
          capabilityHash: `cap-${tag}`,
          credentialRef: "anthropic/test",
          protocol: "anthropic-messages",
          allowedModels: ["claude-sonnet-4-6"],
          deadlineAt: new Date(Date.now() + 10 * 60_000),
          budgetUsd: 1,
          mcpTools: JSON.parse(JSON.stringify(await loadNativeToolPins(db, agentId, log))),
          mcpTokenHash: mcpTokenHash(token),
        },
      });
    });

    it("lists the native tools and runs one with its grants, the secret value redacted", async () => {
      const list = await gateway(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
      const names = (JSON.parse(list.body) as { result: { tools: { name: string }[] } }).result.tools.map(
        (t) => t.name,
      );
      expect(names).toEqual(["echo_secret", "leak_brokered", "slow", "stores", "thrower"]);
      const res = await gateway(callBody("echo_secret", { q: "hi" }));
      expect(res.status).toBe(200);
      expect(res.body).not.toContain(SECRET);
      expect(JSON.parse(resultOf(res.body).content[0].text)).toMatchObject({ q: "hi" });
      const stores = await gateway(callBody("stores"));
      expect(JSON.parse(resultOf(stores.body).content[0].text)).toMatchObject({
        privateOk: "private-x",
        sharedOk: "shared-a",
      });
      // Neither the route's log line nor the call's carries the arguments or the result.
      expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET);
      expect(JSON.stringify(info.mock.calls)).not.toContain('"hi"');
    });

    it("stops a native call in flight when the run is stopped", async () => {
      const pending = gateway(callBody("slow"));
      await new Promise((r) => setTimeout(r, 150));
      await db.run.update({ where: { id: runId }, data: { status: "cancelled" } });
      try {
        const result = resultOf((await pending).body);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).not.toContain("late");
      } finally {
        await db.run.update({ where: { id: runId }, data: { status: "running" } });
      }
    });

    it("refuses a native tool after it is detached", async () => {
      await db.agentTool.delete({ where: { agentId_toolId: { agentId, toolId: tools.thrower } } });
      const result = resultOf((await gateway(callBody("thrower"))).body);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ error: "mcp_tool_not_allowed" });
    });
  });
});
