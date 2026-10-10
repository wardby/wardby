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
  const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-compat-workspace-"));
  const config = await mkdtemp(join(tmpdir(), "wardby-claude-compat-config-"));
  workspaces.push(workspace, config);
  const messages = [];
  const stream = query({
    prompt: "Return the exact text compatibility-ok and do nothing else.",
    options: {
      abortController,
      cwd: workspace,
      model: overrides.model ?? MODEL,
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

const BASE_BETAS = [
  "claude-code-20250219",
  "context-management-2025-06-27",
  "effort-2025-11-24",
  "interleaved-thinking-2025-05-14",
  "mid-conversation-system-2026-04-07",
  "prompt-caching-scope-2026-01-05",
  "thinking-token-count-2026-05-13",
];

// The coding proxy accepts exactly these shapes (CLAUDE_CODE_ANTHROPIC_BETAS plus
// OPTIONAL_ANTHROPIC_BETAS, and the effort levels a model's catalog entry lists), so each model
// the shipped catalog offers for Claude Code is pinned here, not only the default one.
const MODEL_SHAPES = [
  { model: "claude-sonnet-5", betas: BASE_BETAS, effort: "high" },
  { model: "claude-opus-5-5", betas: [...BASE_BETAS, "per-turn-control-2026-07-01"].sort(), effort: "medium" },
];

for (const shape of MODEL_SHAPES)
  test(`pinned SDK uses only the configured Messages endpoint and capability (${shape.model})`, async () => {
    const fake = await fakeAnthropic((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.end(sse("compatibility-ok"));
    });
    try {
      const messages = await runQuery(fake.baseUrl, new AbortController(), [], { model: shape.model });
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
        shape.betas,
      );
      const body = JSON.parse(messageRequest.body);
      assert.equal(body.model, shape.model);
      assert.equal(body.stream, true);
      assert.equal(body.max_tokens, 4096);
      assert.equal(body.output_config.effort, shape.effort);
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

test("Wardby MCP tool loop preserves the pinned second-turn request shape", async () => {
  let turn = 0;
  const fake = await fakeAnthropic((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    if (turn++ === 0) {
      response.end(
        toolUseSse("toolu_wardby_compatibility", "mcp__wardby_tools__run_command", {
          command: "git status --short",
          timeout_ms: 1000,
        }),
      );
      return;
    }
    response.end(toolUseSse("toolu_structured_compatibility", "StructuredOutput", { outcome: "changes_ready" }));
  });
  const wardbyTools = createSdkMcpServer({
    name: "wardby_tools",
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
      mcpServers: { wardby_tools: wardbyTools },
      allowedTools: ["mcp__wardby_tools__run_command"],
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
          tool_use_id: "toolu_wardby_compatibility",
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

test("loads CLAUDE.md, its imports, and project skills from a wardby-built cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "wardby-claude-context-"));
  // HOME must differ from cwd: when they are the same directory the CLI treats
  // <cwd>/.claude as the user config dir and skips project skill discovery
  // (CLAUDE.md still loads). The real worker's HOME (/home/wardby) never equals its cwd.
  const home = await mkdtemp(join(tmpdir(), "wardby-claude-context-home-"));
  workspaces.push(root, home);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "CLAUDE.md"), "PROBE-CLAUDE-MARKER\n@docs/extra.md\n");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "extra.md"), "PROBE-IMPORT-MARKER\n");
  await mkdir(join(root, ".claude", "skills", "probe-skill"), { recursive: true });
  await writeFile(
    join(root, ".claude", "skills", "probe-skill", "SKILL.md"),
    "---\nname: probe-skill\ndescription: PROBE-SKILL-DESCRIPTION\n---\nbody\n",
  );
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse("done"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const stream = query({
      prompt: "hi",
      options: {
        cwd: root,
        model: MODEL,
        maxTurns: 1,
        tools: ["Skill"],
        allowedTools: ["Skill"],
        strictMcpConfig: true,
        settingSources: ["project"],
        // The worker's native-mode hook lock (sdk.ts); loading must still work with it.
        managedSettings: { allowManagedHooksOnly: true },
        systemPrompt: "Fixed security instructions",
        permissionMode: "dontAsk",
        persistSession: false,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: join(root, ".config-claude"),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          ANTHROPIC_API_KEY: CAPABILITY,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_UPDATES: "1",
        },
      },
    });
    for await (const _message of stream) {
      // drain
    }
  } finally {
    server.close();
  }
  const first = bodies.find((body) => body.includes('"messages"'));
  assert.ok(first, "the SDK made no Messages request");
  assert.match(first, /PROBE-CLAUDE-MARKER/, "CLAUDE.md did not reach the model");
  assert.match(first, /PROBE-IMPORT-MARKER/, "the @import did not reach the model");
  assert.match(first, /probe-skill/, "the project skill was not offered");
  assert.match(first, /PROBE-SKILL-DESCRIPTION/, "the skill description was not offered");
});

/**
 * Runs a native-mode query (the worker's option set) against a context directory that also holds
 * repository hooks: .claude/settings.json hooks and SKILL.md frontmatter hooks, each touching a
 * marker file when it runs. The fake model invokes the skill on its first turn so skill-scoped
 * hooks get a chance to run. Returns the markers that were created.
 */
async function runNativeWithRepoHooks(managedSettings) {
  const root = await mkdtemp(join(tmpdir(), "wardby-claude-hooks-"));
  const home = await mkdtemp(join(tmpdir(), "wardby-claude-hooks-home-"));
  const markers = await mkdtemp(join(tmpdir(), "wardby-claude-hooks-markers-"));
  workspaces.push(root, home, markers);
  const { mkdir, readdir, writeFile } = await import("node:fs/promises");
  const touch = (name) => [{ hooks: [{ type: "command", command: `touch ${join(markers, name)}` }] }];
  const toolTouch = (name) => [{ matcher: "*", hooks: [{ type: "command", command: `touch ${join(markers, name)}` }] }];
  await writeFile(join(root, "CLAUDE.md"), "PROBE-CLAUDE-MARKER\n");
  await mkdir(join(root, ".claude", "skills", "probe-skill"), { recursive: true });
  await writeFile(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: touch("settings-SessionStart"),
        UserPromptSubmit: touch("settings-UserPromptSubmit"),
        PreToolUse: toolTouch("settings-PreToolUse"),
        PostToolUse: toolTouch("settings-PostToolUse"),
        Stop: touch("settings-Stop"),
      },
    }),
  );
  await writeFile(
    join(root, ".claude", "skills", "probe-skill", "SKILL.md"),
    [
      "---",
      "name: probe-skill",
      "description: PROBE-SKILL-DESCRIPTION",
      "hooks:",
      "  PreToolUse:",
      '    - matcher: "*"',
      "      hooks:",
      "        - type: command",
      `          command: touch ${join(markers, "skill-PreToolUse")}`,
      "  PostToolUse:",
      '    - matcher: "*"',
      "      hooks:",
      "        - type: command",
      `          command: touch ${join(markers, "skill-PostToolUse")}`,
      "  Stop:",
      "    - hooks:",
      "        - type: command",
      `          command: touch ${join(markers, "skill-Stop")}`,
      "---",
      "body",
      "",
    ].join("\n"),
  );
  let turns = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (raw.includes('"messages"') && turns++ === 0) {
        res.end(toolUseSse("toolu_probe_skill", "Skill", { skill: "probe-skill" }));
      } else {
        res.end(sse("done"));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const stream = query({
      prompt: "hi",
      options: {
        cwd: root,
        model: MODEL,
        maxTurns: 3,
        tools: ["Skill"],
        allowedTools: ["Skill"],
        strictMcpConfig: true,
        settingSources: ["project"],
        ...(managedSettings ? { managedSettings } : {}),
        systemPrompt: "Fixed security instructions",
        permissionMode: "dontAsk",
        persistSession: false,
        env: {
          HOME: home,
          PATH: process.env.PATH,
          CLAUDE_CONFIG_DIR: join(home, ".config-claude"),
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          ANTHROPIC_API_KEY: CAPABILITY,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_UPDATES: "1",
        },
      },
    });
    for await (const _message of stream) {
      // drain
    }
  } finally {
    server.close();
  }
  return { markers: (await readdir(markers)).sort(), turns };
}

test("repository hooks run without the managed hook lock (control for the next case)", async () => {
  const { markers, turns } = await runNativeWithRepoHooks(undefined);
  assert.equal(turns, 2, "the fake model was not asked a second time after the skill ran");
  assert.ok(markers.includes("settings-SessionStart"), `settings.json hooks did not run: ${markers}`);
  assert.ok(markers.includes("skill-Stop"), `SKILL.md frontmatter hooks did not run: ${markers}`);
});

test("allowManagedHooksOnly in managedSettings stops every repository hook in native mode", async () => {
  const { markers, turns } = await runNativeWithRepoHooks({ allowManagedHooksOnly: true });
  assert.equal(turns, 2, "the fake model was not asked a second time after the skill ran");
  assert.deepEqual(markers, [], "a repository hook ran despite the managed hook lock");
});
