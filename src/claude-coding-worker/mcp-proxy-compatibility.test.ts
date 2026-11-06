// Runs the pinned Claude Code binary (through the worker's own @anthropic-ai/claude-agent-sdk, with
// the options sdk.ts builds) against the real coding proxy: its model requests go through the
// proxy's Anthropic allowlist with the session's pinned MCP tool names, and its wardby_mcp HTTP MCP
// requests go through the proxy's /mcp route to a fake native gateway. The upstream model is a
// scripted in-process fake: nothing leaves the machine. Skipped when the worker's SDK (or its
// platform binary) is not installed: run `npm ci` in src/claude-coding-worker to install it.
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpTokenHash, mintMcpToken } from "../coding/mcp-token.js";
import { CODING_PROTOCOL_VERSION } from "../coding/protocol.js";
import { WARDBY_MCP_SERVER, wardbyMcpUrl } from "../coding-worker/mcp-config.js";
import { createMcpRoute } from "../providers/coding-proxy/mcp-route.js";
import { MemoryProxyLedger } from "../providers/coding-proxy/memory-ledger.js";
import { CodingProxy } from "../providers/coding-proxy/proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../providers/coding-proxy/server.js";
import type { ProxyAuditEvent } from "../providers/coding-proxy/types.js";
import { CLAUDE_OUTPUT_JSON_SCHEMA, claudeWorkerSecurityInstructions, type ClaudeSdkMessage } from "./driver.js";
import { buildClaudeSdkOptions } from "./sdk.js";

// Every proxy and /mcp route log line, for the token sweep.
const logged = vi.hoisted(() => [] as unknown[]);
vi.mock("../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at = (...line: unknown[]): void => {
      logged.push(line);
    };
    return { child: () => make(), trace: at, debug: at, info: at, warn: at, error: at, fatal: at };
  };
  return { logger: make() };
});

// Resolved from this folder: the worker's own pinned dependencies (src/claude-coding-worker/node_modules).
const workerRequire = createRequire(import.meta.url);

interface ClaudeSdk {
  query(input: { prompt: string; options: Record<string, unknown> }): AsyncIterable<ClaudeSdkMessage>;
  createSdkMcpServer(options: { name: string; tools: unknown[] }): unknown;
  tool(name: string, description: string, schema: unknown, handler: () => Promise<unknown>): unknown;
}

function loadSdk(): { sdk: ClaudeSdk; z: { string(): unknown } } | undefined {
  try {
    // The SDK runs the native Claude Code binary from its platform package (an optional dependency).
    workerRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const sdk = workerRequire("@anthropic-ai/claude-agent-sdk") as ClaudeSdk;
    const { z } = workerRequire("zod") as { z: { string(): unknown } };
    return { sdk, z };
  } catch {
    return undefined;
  }
}

const loaded = loadSdk();
const MODEL = "claude-sonnet-5";
const RUN_ID = "claude-compat-mcp";
const PINNED = `mcp__${WARDBY_MCP_SERVER}__echo`;
const UNPINNED = `mcp__${WARDBY_MCP_SERVER}__other`;

function sse(blocks: Array<{ type: "tool_use"; id: string; name: string; input: unknown }>): string {
  const frames: unknown[] = [
    {
      type: "message_start",
      message: {
        id: `msg_${blocks[0]?.id ?? "final"}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    frames.push(
      {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      },
      {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      },
      { type: "content_block_stop", index },
    );
  });
  frames.push(
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  );
  return frames
    .map((frame) => `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join("");
}

/**
 * A stand-in for the native gateway's /coding-mcp route: one tool, `echo`, JSON answers, 401 unless
 * the bearer is the run's MCP token. Records every JSON-RPC message.
 */
async function fakeGateway(token: string) {
  const calls: Array<{ method: string; authorized: boolean; params?: unknown }> = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const authorized = request.headers.authorization === `Bearer ${token}`;
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as {
      id?: number;
      method: string;
      params?: { name?: string; protocolVersion?: string; arguments?: { text?: string } };
    };
    calls.push({ method: message.method, authorized, params: message.params });
    if (request.url !== "/coding-mcp" || !authorized) {
      response.writeHead(401, { "content-type": "application/json" }).end('{"jsonrpc":"2.0","id":null,"error":{}}');
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "wardby", version: "1" },
      },
      "tools/list": {
        tools: [
          {
            name: "echo",
            description: "Echo the text back.",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        ],
      },
      "tools/call": { content: [{ type: "text", text: `ECHO:${message.params?.arguments?.text ?? ""}` }] },
    };
    const result = results[message.method];
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify(
          result
            ? { jsonrpc: "2.0", id: message.id, result }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } },
        ),
      );
  };
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe.skipIf(!loaded)("pinned Claude Code calling wardby_mcp through the coding proxy", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task();
  });

  it("runs one pinned MCP tool call with the worker's options; the proxy refuses an unpinned name", async () => {
    const { sdk, z } = loaded!;
    logged.length = 0;
    const token = mintMcpToken();
    const gateway = await fakeGateway(token);
    cleanup.push(gateway.close);

    // The scripted model: call the pinned MCP tool, then give the structured final answer.
    const forwarded: Array<{ body: Record<string, unknown>; beta: string | null }> = [];
    const ledger = new MemoryProxyLedger();
    const audit: ProxyAuditEvent[] = [];
    const proxy = new CodingProxy({
      ledger,
      credentials: { resolve: async () => "UPSTREAM_SECRET_NOT_REAL" },
      pricing: () => ({
        encoding: "o200k_base",
        inputPerMTok: 3,
        cachedInputPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        outputPerMTok: 15,
      }),
      audit: (event) => audit.push(event),
      fetch: async (_input, init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        forwarded.push({ body, beta: new Headers(init?.headers).get("anthropic-beta") });
        const turn =
          forwarded.length === 1
            ? sse([
                { type: "tool_use", id: "toolu_mcp_compat", name: PINNED, input: { text: "hello-from-fake-model" } },
              ])
            : sse([
                {
                  type: "tool_use",
                  id: "toolu_final_compat",
                  name: "StructuredOutput",
                  input: {
                    schemaVersion: CODING_PROTOCOL_VERSION,
                    runId: RUN_ID,
                    outcome: "no_changes",
                    summary: "Echoed hello.",
                    tests: [],
                  },
                },
              ]);
        return new Response(turn, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const session = await proxy.createSession({
      runId: RUN_ID,
      credentialRef: "anthropic/compatibility",
      protocol: "anthropic-messages",
      allowedModels: [MODEL],
      deadlineAt: new Date(Date.now() + 120_000),
      budgetUsd: 10,
      mcpTools: [
        {
          exposedName: "echo",
          toolName: "echo",
          serverId: "srv_compat",
          serverName: "compat",
          definition: { description: "Echo the text back.", inputSchema: { type: "object" } },
        },
      ],
      mcpTokenHash: mcpTokenHash(token),
    });
    const requests: Array<{ protocol: string; status: number }> = [];
    let server: CodingProxyServerHandle | undefined = await startCodingProxyServer(proxy, {
      host: "127.0.0.1",
      port: 0,
      onRequest: (event) => requests.push({ protocol: event.protocol, status: event.status }),
      mcp: createMcpRoute({ ledger, gatewayUrl: gateway.url }),
    });
    cleanup.push(async () => {
      await server?.close();
      server = undefined;
    });
    const proxyBaseUrl = `http://127.0.0.1:${server.port}`;

    const root = await mkdtemp(join(tmpdir(), "wardby-claude-compat-mcp-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const config = join(root, "config");
    const workspace = join(root, "workspace");
    for (const directory of [home, config, workspace]) await mkdir(directory, { recursive: true });

    // The worker's own options (sdk.ts) with the worker's agent environment (driver.ts), host paths
    // in place of the image's. Only the wardby_tools relay (a socket into the tool runner) is
    // replaced, by an in-process server with the same tool name.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 90_000);
    cleanup.push(async () => clearTimeout(timer));
    const options = buildClaudeSdkOptions({
      prompt: "Echo hello with the wardby_mcp echo tool.",
      model: MODEL,
      budgetUsd: 1,
      maxTurns: 4,
      signal: abort.signal,
      environment: {
        HOME: home,
        LANG: "C.UTF-8",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: root,
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: proxyBaseUrl,
        ANTHROPIC_API_KEY: session.capability,
        CLAUDE_CODE_SIMPLE: "1",
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_UPDATES: "1",
      },
      relayEnvironment: {},
      outputSchema: CLAUDE_OUTPUT_JSON_SCHEMA,
      developerInstructions: claudeWorkerSecurityInstructions(true),
      contextDirectory: null,
      skills: false,
      persistSession: false,
      mcp: { url: wardbyMcpUrl(proxyBaseUrl), token },
    });
    const mcpServers = options.mcpServers as Record<string, unknown>;
    const relay = sdk.createSdkMcpServer({
      name: "wardby_tools",
      tools: [
        sdk.tool("run_command", "Run one bounded command.", { command: z.string() }, async () => ({
          content: [{ type: "text", text: "exit_code=0\n" }],
        })),
      ],
    });
    const messages: ClaudeSdkMessage[] = [];
    for await (const message of sdk.query({
      prompt: "Echo hello with the wardby_mcp echo tool.",
      options: { ...options, cwd: workspace, mcpServers: { ...mcpServers, wardby_tools: relay } },
    })) {
      messages.push(message);
    }

    // Every model request passed the proxy's allowlist with the pinned MCP tool name.
    expect(requests.filter((r) => r.protocol === "anthropic-messages")).toEqual([
      { protocol: "anthropic-messages", status: 200 },
      { protocol: "anthropic-messages", status: 200 },
    ]);
    expect(audit.filter((event) => event.type === "request.rejected")).toEqual([]);
    expect(forwarded).toHaveLength(2);
    const advertised = (forwarded[0].body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(advertised).toContain(PINNED);

    // tools/list and tools/call reached the gateway through /mcp, with the run's token only.
    expect(gateway.calls.length).toBeGreaterThan(0);
    expect(gateway.calls.every((call) => call.authorized)).toBe(true);
    expect(gateway.calls.map((call) => call.method)).toContain("tools/list");
    const toolCalls = gateway.calls.filter((call) => call.method === "tools/call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.params).toMatchObject({ name: "echo", arguments: { text: "hello-from-fake-model" } });
    expect(requests.some((r) => r.protocol === "other" && r.status === 200)).toBe(true);
    // The gateway's result reached the model; the token never did.
    expect(JSON.stringify(forwarded[1].body)).toContain("ECHO:hello-from-fake-model");
    expect(JSON.stringify(forwarded)).not.toContain(token);

    // The run finished.
    const result = messages.find((message) => message.type === "result") as
      { subtype?: string; structured_output?: { outcome?: string } } | undefined;
    expect(result?.subtype).toBe("success");
    expect(result?.structured_output?.outcome).toBe("no_changes");

    // The same request with an unpinned wardby_mcp tool added is refused before it reaches the model.
    const refusedBody = structuredClone(forwarded[0].body);
    const pinnedDefinition = (refusedBody.tools as Array<{ name: string }>).find((t) => t.name === PINNED)!;
    (refusedBody.tools as unknown[]).push({ ...pinnedDefinition, name: UNPINNED });
    const refused = await fetch(`${proxyBaseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": session.capability,
        "anthropic-version": "2023-06-01",
        ...(forwarded[0].beta ? { "anthropic-beta": forwarded[0].beta } : {}),
      },
      body: JSON.stringify(refusedBody),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("tools_not_allowed");
    expect(forwarded).toHaveLength(2);

    // Neither the MCP token nor the run capability shows up in any proxy log line.
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(session.capability);
  }, 120_000);
});
