import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const MODEL = "claude-sonnet-5";
const CAPABILITY = "rrp_compatibility_only_not_a_real_credential";
const workspaces = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sse(text) {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "msg_compatibility",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ];
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

function toolUseSse(id, name, input) {
  const frames = [
    {
      type: "message_start",
      message: {
        id: "msg_tool_compatibility",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ];
  return frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
}

async function fakeAnthropic(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const captured = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(captured);
    if (request.method === "HEAD" && request.url === "/api/hello") {
      response.writeHead(200, { "cache-control": "no-store" });
      response.end();
      return;
    }
    await handler(captured, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function runQuery(baseUrl, abortController = new AbortController(), tools = [], overrides = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "reevo-claude-compat-workspace-"));
  const config = await mkdtemp(join(tmpdir(), "reevo-claude-compat-config-"));
  workspaces.push(workspace, config);
  const messages = [];
  const stream = query({
    prompt: "Return the exact text compatibility-ok and do nothing else.",
    options: {
      abortController,
      cwd: workspace,
      model: MODEL,
      maxTurns: overrides.maxTurns ?? (tools.length > 0 ? 2 : 1),
      maxBudgetUsd: 0.25,
      tools,
      allowedTools: overrides.allowedTools ?? tools,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: overrides.mcpServers ?? {},
      managedSettings: {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          enableWeakerNestedSandbox: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          credentials: {
            envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }],
          },
        },
      },
      systemPrompt: "You are a deterministic compatibility probe.",
      permissionMode: "dontAsk",
      outputFormat: overrides.outputFormat,
      permissionPrompts: "none",
      persistSession: false,
      env: {
        HOME: workspace,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        TMPDIR: tmpdir(),
        CLAUDE_CONFIG_DIR: config,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: CAPABILITY,
        CLAUDE_CODE_SIMPLE: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_UPDATES: "1",
        MCP_CONNECTION_NONBLOCKING: "true",
      },
    },
  });
  for await (const message of stream) messages.push(message);
  return messages;
}

test("pinned SDK uses only the configured Messages endpoint and capability", async () => {
  const fake = await fakeAnthropic((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.end(sse("compatibility-ok"));
  });
  try {
    const messages = await runQuery(fake.baseUrl);
    const result = messages.find((message) => message.type === "result");
    assert.equal(result?.subtype, "success");
    assert.equal(result?.result, "compatibility-ok");
    assert.deepEqual(
      fake.requests.map((request) => [request.method, request.url]),
      [
        ["HEAD", "/api/hello"],
        ["POST", "/v1/messages?beta=true"],
      ],
    );
    const messageRequest = fake.requests[1];
    assert.equal(messageRequest.headers["x-api-key"], CAPABILITY);
    assert.equal(messageRequest.headers.authorization, undefined);
    assert.match(String(messageRequest.headers["anthropic-version"]), /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(
      String(messageRequest.headers["anthropic-beta"])
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .sort(),
      [
        "claude-code-20250219",
        "context-management-2025-06-27",
        "effort-2025-11-24",
        "interleaved-thinking-2025-05-14",
        "mid-conversation-system-2026-04-07",
        "prompt-caching-scope-2026-01-05",
        "thinking-token-count-2026-05-13",
      ],
    );
    const body = JSON.parse(messageRequest.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.output_config.effort, "high");
    assert.equal(typeof JSON.parse(body.metadata.user_id).device_id, "string");
  } finally {
    await fake.close();
  }
});

test("provider budget rejection terminates with an error result", async () => {
  const fake = await fakeAnthropic((_request, response) => {
    response.writeHead(429, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "budget denied" } }));
  });
  try {
    await assert.rejects(runQuery(fake.baseUrl), /budget denied/);
    assert.equal(fake.requests.filter((request) => request.url === "/v1/messages?beta=true").length, 1);
  } finally {
    await fake.close();
  }
});

test("malformed provider stream fails closed", async () => {
  const fake = await fakeAnthropic((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.end("event: message_start\ndata: not-json\n\n");
  });
  try {
    await assert.rejects(runQuery(fake.baseUrl), /empty or malformed response/);
    const messageRequests = fake.requests.filter((request) => request.url === "/v1/messages?beta=true");
    assert.deepEqual(
      messageRequests.map((request) => JSON.parse(request.body).stream),
      [true, false],
    );
  } finally {
    await fake.close();
  }
});

test("tool subprocess scrubs the capability or fails closed", async () => {
  let turn = 0;
  const fake = await fakeAnthropic((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    if (turn++ === 0) {
      response.end(
        toolUseSse("toolu_capability_probe", "Bash", {
          command: 'if [ -n "$ANTHROPIC_API_KEY" ]; then printf exposed; else printf absent; fi',
          description: "Check credential scrubbing",
        }),
      );
      return;
    }
    response.end(sse("capability-probe-complete"));
  });
  try {
    const messages = await runQuery(fake.baseUrl, new AbortController(), ["Bash"]);
    const result = messages.find((message) => message.type === "result");
    assert.equal(result?.subtype, "success");
    const messageRequests = fake.requests.filter((request) => request.url === "/v1/messages?beta=true");
    assert.equal(messageRequests.length, 2);
    const secondBody = JSON.parse(messageRequests[1].body);
    const toolResult = secondBody.messages.at(-1).content.find((content) => content.type === "tool_result");
    assert.notEqual(toolResult.content, "exposed");
    assert.match(toolResult.content, /^(?:absent|Exit code 1\nbwrap: No permissions to create new namespace)/);
    assert.doesNotMatch(messageRequests[1].body, new RegExp(CAPABILITY));
  } finally {
    await fake.close();
  }
});

test("Reevo MCP tool loop preserves the pinned second-turn request shape", async () => {
  let turn = 0;
  const fake = await fakeAnthropic((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    if (turn++ === 0) {
      response.end(
        toolUseSse("toolu_reevo_compatibility", "mcp__reevo_tools__run_command", {
          command: "git status --short",
          timeout_ms: 1000,
        }),
      );
      return;
    }
    response.end(toolUseSse("toolu_structured_compatibility", "StructuredOutput", { outcome: "changes_ready" }));
  });
  const reevoTools = createSdkMcpServer({
    name: "reevo_tools",
    tools: [
      tool(
        "run_command",
        "Run one bounded command.",
        { command: z.string(), timeout_ms: z.number().int().optional() },
        async () => ({ content: [{ type: "text", text: "exit_code=0\n" }] }),
      ),
    ],
  });
  try {
    await runQuery(fake.baseUrl, new AbortController(), [], {
      maxTurns: 2,
      mcpServers: { reevo_tools: reevoTools },
      allowedTools: ["mcp__reevo_tools__run_command"],
      outputFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { outcome: { type: "string" } },
          required: ["outcome"],
          additionalProperties: false,
        },
      },
    });
    const messageRequests = fake.requests.filter((request) => request.url === "/v1/messages?beta=true");
    assert.equal(messageRequests.length, 2);
    assert.deepEqual(JSON.parse(messageRequests[1].body).messages.at(-1), {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_reevo_compatibility",
          content: [{ type: "text", text: "exit_code=0\n" }],
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  } finally {
    await fake.close();
  }
});

test("AbortController cancels an in-flight provider stream", async () => {
  const abortController = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fake = await fakeAnthropic((_request, _response) => {
    markStarted();
  });
  try {
    const running = runQuery(fake.baseUrl, abortController);
    await started;
    abortController.abort();
    await assert.rejects(running, /aborted|abort|cancel|process exited/i);
  } finally {
    await fake.close();
  }
});
