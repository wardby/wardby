// Runs the pinned Claude Code binary (through the worker's own @anthropic-ai/claude-agent-sdk, with
// the options sdk.ts builds) against the real coding proxy on a run with sub-agents on: the scripted
// model asks for a sub-agent, which asks for a nested one (each with a model override, a background
// ask and a worktree the guard must drop); every conversation comes through the proxy, and every
// request must pass the proxy's allowlist on the run's model. In bare mode (CLAUDE_CODE_SIMPLE) the
// pinned CLI offers no Agent tool at all, so sub-agents take effect only with claudeBareMode off. A recording pass-through in front of the proxy keeps each request's
// x-claude-code-agent-id header. The upstream model is a scripted in-process fake: nothing leaves
// the machine.
//
// Runs only when src/claude-coding-worker/node_modules is installed (the worker's SDK and its
// platform binary); otherwise the suite is skipped, unless WARDBY_REQUIRE_CLAUDE_COMPAT=1, which
// makes a missing SDK fail the file instead. To run it, from the repository root:
//   npm ci --prefix src/claude-coding-worker
//   WARDBY_REQUIRE_CLAUDE_COMPAT=1 npx vitest run src/claude-coding-worker/sub-agents-proxy-compatibility.test.ts
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_PROTOCOL_VERSION } from "../coding/protocol.js";
import { MemoryProxyLedger } from "../providers/coding-proxy/memory-ledger.js";
import { CodingProxy } from "../providers/coding-proxy/proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../providers/coding-proxy/server.js";
import type { ProxyAuditEvent } from "../providers/coding-proxy/types.js";
import { CLAUDE_OUTPUT_JSON_SCHEMA, claudeWorkerSecurityInstructions, type ClaudeSdkMessage } from "./driver.js";
import { buildClaudeSdkOptions } from "./sdk.js";

// Every proxy log line, for the secret sweep.
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
// The stop rule is only enforced by a run that cannot skip: with the flag, a missing SDK fails the file.
if (!loaded && process.env.WARDBY_REQUIRE_CLAUDE_COMPAT === "1") {
  throw new Error(
    "WARDBY_REQUIRE_CLAUDE_COMPAT=1 but the worker SDK is not installed (npm ci --prefix src/claude-coding-worker)",
  );
}

const MODEL = "claude-sonnet-5";
const RUN_ID = "claude-compat-sub-agents";
const SUBTASK = "SUBTASK-MARKER: list the files under test/";
const NESTED_TASK = "NESTED-MARKER: count the files under test/";
const SUB_ANSWER = "SUB-ANSWER: test/a.test.ts";
const NESTED_ANSWER = "NESTED-ANSWER: 1 file";
const AGENT_CALL_ID = "toolu_agent_compat";
const NESTED_CALL_ID = "toolu_agent_nested_compat";
/** What the scripted model asks for on top of a valid Agent call: the guard must drop all of it. */
const DROPPED = { model: "haiku", run_in_background: true, isolation: "worktree" };

function frames(list: unknown[]): string {
  return list.map((frame) => `event: ${(frame as { type: string }).type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

function messageStart(id: string): unknown {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0 },
    },
  };
}

/** One tool call, stop_reason tool_use. */
function sseToolUse(id: string, name: string, input: unknown): string {
  return frames([
    messageStart(`msg_${id}`),
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
}

/** A text-only final reply (the sub-agent's answer): end_turn, no tool call. */
function sseText(text: string): string {
  return frames([
    messageStart("msg_text"),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

function finalAnswer(): string {
  return sseToolUse("toolu_final_compat", "StructuredOutput", {
    schemaVersion: CODING_PROTOCOL_VERSION,
    runId: RUN_ID,
    outcome: "no_changes",
    summary: "Listed tests.",
    tests: [],
  });
}

type Message = { role?: string; content?: unknown };

type Conversation = "main" | "sub" | "nested";

/** Each sub-agent's own conversation starts with the prompt the guard let through. */
function conversation(body: Record<string, unknown>): Conversation {
  const first = JSON.stringify((body.messages as unknown[])[0]);
  return first.includes("NESTED-MARKER") ? "nested" : first.includes("SUBTASK-MARKER") ? "sub" : "main";
}

function toolNames(body: Record<string, unknown>): string[] {
  return ((body.tools as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name);
}

function blocks(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body.messages as Message[]).flatMap((message) =>
    Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [],
  );
}

/** What Claude Code sent the proxy: path, status, the agent-id header and the body. */
interface Observed {
  url: string;
  status: number;
  agentId: string | undefined;
  body: Record<string, unknown> | undefined;
}

/** A pass-through in front of the proxy that records each request (headers stay as sent). */
async function recordingFront(target: string) {
  const observed: Observed[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "host" || name === "content-length" || name === "connection" || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const upstream = await fetch(`${target}${request.url ?? "/"}`, {
      method: request.method,
      headers,
      ...(raw.length > 0 ? { body: raw } : {}),
    });
    let body: Record<string, unknown> | undefined;
    try {
      body = raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    const agentHeader = request.headers["x-claude-code-agent-id"];
    observed.push({
      url: request.url ?? "",
      status: upstream.status,
      agentId: typeof agentHeader === "string" ? agentHeader : undefined,
      body,
    });
    const out: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (name !== "content-length" && name !== "content-encoding" && name !== "transfer-encoding") out[name] = value;
    });
    response.writeHead(upstream.status, out);
    if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(response);
    else response.end();
  };
  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** One harness: the real proxy (fake upstream), the recording front, and the worker's own options. */
async function harness(
  cleanup: Array<() => Promise<void>>,
  settings: { sessionSubAgents: boolean; workerSubAgents: boolean; bare: boolean },
) {
  const forwarded: Array<{ body: Record<string, unknown> }> = [];
  const audit: ProxyAuditEvent[] = [];
  const proxy = new CodingProxy({
    ledger: new MemoryProxyLedger(),
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
      forwarded.push({ body });
      // Main: start a sub-agent, then answer. Sub-agent: start a nested sub-agent (when offered Agent),
      // then answer. Nested: answer. Each asks for another model, the background and a worktree.
      const kind = conversation(body);
      const turns = forwarded.filter((entry) => conversation(entry.body) === kind).length;
      const offered = toolNames(body).includes("Agent");
      const turn =
        kind === "main"
          ? turns === 1 && offered
            ? sseToolUse(AGENT_CALL_ID, "Agent", {
                description: "list tests",
                prompt: SUBTASK,
                subagent_type: "general-purpose",
                ...DROPPED,
              })
            : finalAnswer()
          : kind === "sub"
            ? turns === 1 && offered
              ? sseToolUse(NESTED_CALL_ID, "Agent", {
                  description: "count tests",
                  prompt: NESTED_TASK,
                  subagent_type: "general-purpose",
                  ...DROPPED,
                })
              : sseText(SUB_ANSWER)
            : sseText(NESTED_ANSWER);
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
    subAgents: settings.sessionSubAgents,
  });
  let server: CodingProxyServerHandle | undefined = await startCodingProxyServer(proxy, {
    host: "127.0.0.1",
    port: 0,
  });
  cleanup.push(async () => {
    await server?.close();
    server = undefined;
  });
  const front = await recordingFront(`http://127.0.0.1:${server.port}`);
  cleanup.push(front.close);

  const root = await mkdtemp(join(tmpdir(), "wardby-claude-compat-sub-agents-"));
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
    prompt: "List the tests with a sub-agent.",
    model: MODEL,
    budgetUsd: 1,
    maxTurns: 6,
    signal: abort.signal,
    environment: {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: root,
      CLAUDE_CONFIG_DIR: config,
      ANTHROPIC_BASE_URL: front.url,
      ANTHROPIC_API_KEY: session.capability,
      // Bare mode (claudeBareMode, the default) as driver.ts sets it.
      ...(settings.bare ? { CLAUDE_CODE_SIMPLE: "1" } : {}),
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
      CLAUDE_CODE_MAX_RETRIES: "0",
      DISABLE_UPDATES: "1",
    },
    relayEnvironment: {},
    outputSchema: CLAUDE_OUTPUT_JSON_SCHEMA,
    developerInstructions: claudeWorkerSecurityInstructions(false),
    contextDirectory: null,
    skills: false,
    persistSession: false,
    subAgents: settings.workerSubAgents,
  });
  const { sdk, z } = loaded!;
  const relay = sdk.createSdkMcpServer({
    name: "wardby_tools",
    tools: [
      sdk.tool("run_command", "Run one bounded command.", { command: z.string() }, async () => ({
        content: [{ type: "text", text: "exit_code=0\n" }],
      })),
    ],
  });
  const messages: ClaudeSdkMessage[] = [];
  // A refused request ends the SDK's query with an error: kept for the refusal case to check.
  let error: unknown;
  try {
    for await (const message of sdk.query({
      prompt: "List the tests with a sub-agent.",
      options: {
        ...options,
        cwd: workspace,
        mcpServers: { ...(options.mcpServers as Record<string, unknown>), wardby_tools: relay },
      },
    })) {
      messages.push(message);
    }
  } catch (caught) {
    error = caught;
  }
  const modelRequests = front.observed.filter((entry) => entry.url.startsWith("/v1/messages"));
  return { session, forwarded, audit, modelRequests, messages, error };
}

describe.skipIf(!loaded)("pinned Claude Code sub-agents through the coding proxy", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task();
  });

  it("native mode: a sub-agent and its nested sub-agent run in the foreground on the run model, none refused", async () => {
    logged.length = 0;
    const { session, forwarded, audit, modelRequests, messages } = await harness(cleanup, {
      sessionSubAgents: true,
      workerSubAgents: true,
      bare: false,
    });

    // Evidence for the operator docs: the sub-agent types the pinned CLI lists, and the request sequence.
    const init = messages.find((message) => message.type === "system") as { agents?: unknown } | undefined;
    process.stderr.write(`[claude-sub-agents-compat] init agents: ${JSON.stringify(init?.agents ?? null)}\n`);
    process.stderr.write(
      `[claude-sub-agents-compat] requests: ${JSON.stringify(
        modelRequests.map((entry) => ({
          status: entry.status,
          model: entry.body?.model,
          conversation: entry.body ? conversation(entry.body) : null,
          agentId: entry.agentId ?? null,
        })),
      )}\n`,
    );

    // Every request Claude Code sent passed the proxy (nothing refused) and reached the upstream.
    expect(audit.filter((event) => event.type === "request.rejected")).toEqual([]);
    expect(modelRequests.every((entry) => entry.status === 200)).toBe(true);
    expect(forwarded).toHaveLength(modelRequests.length);
    // On the run's model only: the guard dropped every "haiku" and CLAUDE_CODE_SUBAGENT_MODEL pins the rest.
    expect(new Set(modelRequests.map((entry) => entry.body?.model))).toEqual(new Set([MODEL]));

    const of = (kind: Conversation) => modelRequests.filter((entry) => entry.body && conversation(entry.body) === kind);
    const main = of("main");
    const sub = of("sub");
    const nested = of("nested");
    expect(main).toHaveLength(2);
    expect(sub).toHaveLength(2);
    expect(nested).toHaveLength(1);
    expect(toolNames(main[0].body!)).toContain("Agent");
    // Each sub-agent's requests carry its own Claude Code agent id; the main session's carry none.
    expect(main.every((entry) => entry.agentId === undefined)).toBe(true);
    const subIds = new Set(sub.map((entry) => entry.agentId));
    const nestedIds = new Set(nested.map((entry) => entry.agentId));
    expect(subIds.size).toBe(1);
    expect(nestedIds.size).toBe(1);
    for (const id of [...subIds, ...nestedIds]) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect([...subIds][0]).not.toBe([...nestedIds][0]);

    // Executed in the foreground (the guard's run_in_background: false): each child finishes before its
    // parent's next turn, whose Agent tool result carries the child's answer.
    const order = modelRequests.map((entry) => conversation(entry.body!));
    expect(order).toEqual(["main", "sub", "nested", "sub", "main"]);
    const resultFor = (body: Record<string, unknown>, id: string) =>
      blocks(body).find((block) => block.type === "tool_result" && block.tool_use_id === id);
    expect(JSON.stringify(resultFor(sub[1].body!, NESTED_CALL_ID))).toContain(NESTED_ANSWER);
    expect(JSON.stringify(resultFor(main[1].body!, AGENT_CALL_ID))).toContain(SUB_ANSWER);
    // The history keeps the model's original call (the guard's updatedInput applies to execution
    // only); the proxy accepts the replayed Agent block whatever input it shows.
    const replayed = blocks(main[1].body!).find((block) => block.type === "tool_use" && block.name === "Agent");
    expect(replayed?.id).toBe(AGENT_CALL_ID);

    // The run finished.
    const final = messages.find((message) => message.type === "result") as
      { subtype?: string; structured_output?: { outcome?: string } } | undefined;
    expect(final?.subtype).toBe("success");
    expect(final?.structured_output?.outcome).toBe("no_changes");

    // Nothing secret reached a log line.
    expect(JSON.stringify(logged)).not.toContain(session.capability);
    expect(JSON.stringify(logged)).not.toContain("UPSTREAM_SECRET_NOT_REAL");
  }, 120_000);

  it("bare mode: sub-agents on are accepted and have no effect (Claude Code offers no Agent tool)", async () => {
    const { audit, modelRequests, messages } = await harness(cleanup, {
      sessionSubAgents: true,
      workerSubAgents: true,
      bare: true,
    });
    expect(audit.filter((event) => event.type === "request.rejected")).toEqual([]);
    expect(modelRequests).toHaveLength(1);
    expect(toolNames(modelRequests[0].body!)).not.toContain("Agent");
    const final = messages.find((message) => message.type === "result") as { subtype?: string } | undefined;
    expect(final?.subtype).toBe("success");
  }, 120_000);

  it.each([true, false])(
    "offers no Agent tool when sub-agents are off (today's runs; bare mode %s)",
    async (bare) => {
      const { audit, modelRequests, messages } = await harness(cleanup, {
        sessionSubAgents: false,
        workerSubAgents: false,
        bare,
      });
      expect(audit.filter((event) => event.type === "request.rejected")).toEqual([]);
      expect(modelRequests).toHaveLength(1);
      expect(toolNames(modelRequests[0].body!)).not.toContain("Agent");
      const final = messages.find((message) => message.type === "result") as { subtype?: string } | undefined;
      expect(final?.subtype).toBe("success");
    },
    120_000,
  );

  it("refuses the Agent tool on a session without sub-agents, so a worker that offers it by mistake fails visibly", async () => {
    logged.length = 0;
    const { session, forwarded, audit, modelRequests, messages, error } = await harness(cleanup, {
      sessionSubAgents: false,
      workerSubAgents: true,
      bare: false,
    });
    expect(modelRequests.length).toBeGreaterThan(0);
    expect(toolNames(modelRequests[0].body!)).toContain("Agent");
    expect(modelRequests.every((entry) => entry.status === 400)).toBe(true);
    expect(audit.filter((event) => event.type === "request.rejected")).toEqual(
      modelRequests.map(() => expect.objectContaining({ type: "request.rejected", reason: "tools_not_allowed" })),
    );
    // The fake upstream was never called.
    expect(forwarded).toEqual([]);
    expect(String(error)).toContain("tools_not_allowed");
    const final = messages.find((message) => message.type === "result") as { is_error?: boolean } | undefined;
    expect(final?.is_error).toBe(true);
    expect(JSON.stringify(logged)).not.toContain(session.capability);
  }, 120_000);
});
