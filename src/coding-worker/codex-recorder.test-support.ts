// Records the OpenAI Responses requests the pinned Codex CLI makes, for the
// coding proxy's allowlist fixture (src/providers/coding-proxy/fixtures/
// codex-<version>-responses-requests.json). Each scenario drives the real Codex
// SDK, configured as the worker configures it, against a scripted local fake
// of the proxy's /v1/responses endpoint: nothing leaves the machine. The fake
// sits where the proxy would, so a request the allowlist would refuse is still
// recorded and shows up in the request-shape diff; the compatibility test then
// replays Codex through the real proxy. Run through `npm run codex:rerecord`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { CODING_OUTPUT_JSON_SCHEMA, WORKER_SECURITY_INSTRUCTIONS } from "./driver.js";
import { codexSdkOptions } from "./sdk.js";
import { CODEX_BUILTIN_SKILLS } from "./skills.js";

export interface RecordedCodexRequest {
  scenario: string;
  body: Record<string, unknown>;
}

/** One request as the fake upstream saw it, numbered per Codex thread. */
export interface CapturedRequest {
  body: Record<string, unknown>;
  /** 1-based request number within this request's Codex thread. */
  call: number;
  /** True for a request made by a spawned sub-agent thread. */
  subagent: boolean;
}

interface ScriptedResponse {
  items: unknown[];
  usage?: Record<string, unknown>;
  /** Hold the response until this resolves (e.g. until a sub-agent has spoken). */
  after?: () => Promise<void>;
}

export interface CodexRecordScenario {
  name: string;
  model: string;
  /** Pass the worker's structured-output schema, as the worker does. */
  outputSchema: boolean;
  /** Extra Codex `--config` overrides on top of the worker's own. */
  config?: Record<string, unknown>;
  respond(request: CapturedRequest, state: ScenarioState): ScriptedResponse;
  /** Which captured requests go into the fixture, with their labels. */
  record: Array<{ scenario: string; match: (request: CapturedRequest) => boolean }>;
}

export interface ScenarioState {
  subagentSeen: Promise<void>;
}

export const RECORD_PROMPT = "Add hello.txt";
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 15,
};
/** Reported after the first compaction-scenario turn to cross the auto-compact limit. */
const HUGE_USAGE = { ...USAGE, input_tokens: 900_000, total_tokens: 900_005 };
const EXEC_SCRIPT = [
  'const r = await tools.exec_command({cmd: "echo hi"});',
  "text(r.output);",
  'const v = await tools.view_image({path: "pic.png"});',
  "image(v);",
  'await tools.apply_patch(["*** Begin Patch", "*** Add File: hello.txt", "+hello", "*** End Patch", ""].join(String.fromCharCode(10)));',
].join(" ");

const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "thinking" }],
  encrypted_content: "gAAAAencrypted",
};
const rawReasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "plan" }],
  content: [{ type: "reasoning_text", text: "raw thought" }],
  encrypted_content: "gAAAAenc",
};
const commentary = {
  type: "message",
  id: "msg_c",
  role: "assistant",
  phase: "commentary",
  content: [{ type: "output_text", text: "Looking around.", annotations: [] }],
};
const exec = (input: string) => ({ type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input });
const functionCall = (id: number, name: string, args: unknown, namespace?: string) => ({
  type: "function_call",
  id: `fc_${id}`,
  call_id: `call_${id}`,
  ...(namespace ? { namespace } : {}),
  name,
  arguments: JSON.stringify(args),
});
const message = (text: string) => ({
  type: "message",
  id: "msg_final",
  role: "assistant",
  content: [{ type: "output_text", text, annotations: [] }],
});
const finalAnswer = () =>
  message(
    JSON.stringify({
      schemaVersion: 1,
      runId: "run-record",
      outcome: "changes_ready",
      summary: "Added hello.txt.",
      tag: null,
      tests: [],
    }),
  );
const done = (): ScriptedResponse => ({ items: [finalAnswer()] });
const call = (n: number) => (request: CapturedRequest) => !request.subagent && request.call === n;

/** The request shapes of the committed fixture, one scenario per kind of request. */
export const CODEX_RECORD_SCENARIOS: CodexRecordScenario[] = [
  {
    name: "lite-exec",
    model: "gpt-5.6-terra",
    outputSchema: true,
    respond: (r) => (r.call === 1 ? { items: [reasoning, exec(EXEC_SCRIPT)] } : done()),
    record: [
      {
        scenario:
          "responses-lite (gpt-5.6-terra): code-mode exec custom tool call whose output carries text and an inline view_image data: URL",
        match: call(2),
      },
    ],
  },
  {
    name: "lite-commentary",
    model: "gpt-5.6-terra",
    outputSchema: true,
    respond: (r) => (r.call === 1 ? { items: [rawReasoning, commentary, exec('text("x")')] } : done()),
    record: [
      {
        scenario:
          "responses-lite (gpt-5.6-terra): reasoning with raw content, commentary-phase assistant message, custom tool call",
        match: call(2),
      },
    ],
  },
  {
    name: "lite-namespaced",
    model: "gpt-5.6-terra",
    outputSchema: true,
    respond: (r) =>
      r.call === 1
        ? { items: [rawReasoning, commentary, functionCall(1, "list_agents", {}, "collaboration")] }
        : done(),
    record: [
      {
        scenario: "responses-lite (gpt-5.6-terra): namespaced collaboration function call (list_agents)",
        match: call(2),
      },
    ],
  },
  {
    name: "lite-subagent",
    model: "gpt-5.6-terra",
    outputSchema: true,
    respond: (r, state) => {
      if (r.subagent) return { items: [message("hi")] };
      if (r.call === 1) {
        const args = {
          task_name: "child",
          message: "say hi",
          model: "gpt-5.6-luna",
          reasoning_effort: "high",
          fork_turns: "none",
        };
        return { items: [functionCall(1, "spawn_agent", args, "collaboration")] };
      }
      return { ...done(), after: () => state.subagentSeen };
    },
    record: [
      {
        scenario:
          "responses-lite subagent (gpt-5.6-luna, reasoning high) spawned by spawn_agent: agent_message item with encrypted_content part",
        match: (r) => r.subagent && r.call === 1,
      },
    ],
  },
  {
    name: "lite-astra",
    model: "gpt-6-astra",
    outputSchema: true,
    respond: done,
    record: [{ scenario: "responses-lite (gpt-6-astra): first turn", match: call(1) }],
  },
  {
    name: "lite-sol",
    model: "gpt-5.6-sol",
    outputSchema: true,
    respond: done,
    record: [{ scenario: "responses-lite (gpt-5.6-sol): first turn", match: call(1) }],
  },
  {
    name: "lite-compaction",
    model: "gpt-5.6-terra",
    outputSchema: true,
    config: { model_auto_compact_token_limit: 100_000 },
    respond: (r) => {
      if (r.call === 1) return { items: [reasoning, exec(EXEC_SCRIPT)], usage: HUGE_USAGE };
      if (r.call === 2) return { items: [message("Summary: hello.txt is being added.")] };
      return done();
    },
    record: [
      { scenario: "responses-lite (gpt-5.6-terra): local context compaction request", match: call(2) },
      { scenario: "responses-lite (gpt-5.6-terra): request after local compaction", match: call(3) },
    ],
  },
  {
    name: "classic-tools",
    model: "gpt-4.1",
    outputSchema: true,
    respond: (r) => {
      if (r.call === 1) return { items: [reasoning, functionCall(1, "view_image", { path: "pic.png" })] };
      if (r.call === 2) return { items: [functionCall(2, "exec_command", { cmd: "echo hi" })] };
      return done();
    },
    record: [
      {
        scenario:
          "classic Responses tools (gpt-4.1 fallback family): top-level tools and instructions, view_image function output with inline image, exec_command",
        match: call(3),
      },
    ],
  },
  {
    name: "classic-namespaced",
    model: "gpt-4.1",
    outputSchema: true,
    respond: (r) =>
      r.call === 1
        ? {
            items: [
              rawReasoning,
              commentary,
              functionCall(1, "wait_agent", { targets: ["x"], timeout_ms: 10 }, "multi_agent_v1"),
            ],
          }
        : done(),
    record: [
      { scenario: "classic Responses tools (gpt-4.1): namespaced multi_agent_v1 function call", match: call(2) },
    ],
  },
];

export function sse(id: string, items: unknown[], usage: Record<string, unknown> = USAGE): string {
  const events: unknown[] = [{ type: "response.created", response: { id } }];
  for (const item of items) events.push({ type: "response.output_item.done", item });
  events.push({ type: "response.completed", response: { id, usage } });
  return events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const TEXT_KEYS = new Set(["text", "description", "instructions"]);
export const FIXTURE_TEXT_LIMIT = 400;
export const FIXTURE_TRUNCATION = "…[truncated for the fixture]";
export const CAPTURE_ROOT = "/tmp/codex-capture";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function truncateTexts(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key && TEXT_KEYS.has(key) && value.length > FIXTURE_TEXT_LIMIT
      ? value.slice(0, FIXTURE_TEXT_LIMIT) + FIXTURE_TRUNCATION
      : value;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateTexts(entry, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateTexts(v, k)]));
  }
  return value;
}

/** Makes recorded requests reproducible: the capture's temporary paths become
 *  /tmp/codex-capture, every UUID is renumbered in order of first appearance,
 *  timestamps, dates, the host's shell and timings are pinned, client_metadata keys are sorted,
 *  and long prompt and tool texts are cut to their first 400 characters (none
 *  of which changes a request's shape). */
export function normalizeRecordedRequests(
  requests: RecordedCodexRequest[],
  roots: readonly string[],
): RecordedCodexRequest[] {
  // Codex emits client_metadata in hash order: sort it first, so ids are
  // renumbered in the same order on every recording and re-records diff cleanly.
  const sorted = requests.map(({ scenario, body }) => {
    const metadata = body.client_metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { scenario, body };
    const ordered = Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)));
    return { scenario, body: { ...body, client_metadata: ordered } };
  });
  let json = JSON.stringify(sorted);
  for (const root of [...roots].sort((a, b) => b.length - a.length)) json = json.split(root).join(CAPTURE_ROOT);
  const uuids = new Map<string, string>();
  json = json.replace(UUID, (uuid) => {
    let replacement = uuids.get(uuid);
    if (!replacement) {
      replacement = `00000000-0000-7000-8000-${(uuids.size + 1).toString(16).padStart(12, "0")}`;
      uuids.set(uuid, replacement);
    }
    return replacement;
  });
  json = json
    .replace(/(\\"turn_started_at_unix_ms\\":)\d+/g, "$11790000000000")
    .replace(/<current_date>[^<]*<\/current_date>/g, "<current_date>2026-01-01</current_date>")
    .replace(/<timezone>[^<]*<\/timezone>/g, "<timezone>UTC</timezone>")
    .replace(/<shell>[^<]*<\/shell>/g, "<shell>bash</shell>")
    .replace(/Wall time:? [0-9.]+ seconds/g, (match) => match.replace(/[0-9.]+/, "0.0"))
    .replace(/Chunk ID: [0-9a-f]+/g, "Chunk ID: 000000");
  return (JSON.parse(json) as RecordedCodexRequest[]).map(({ scenario, body }) => ({
    scenario,
    body: truncateTexts(body) as Record<string, unknown>,
  }));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

async function runScenario(
  scenario: CodexRecordScenario,
  root: string,
  timeoutMs: number,
): Promise<{ captured: CapturedRequest[]; errors: string[] }> {
  const captured: CapturedRequest[] = [];
  const errors: string[] = [];
  const perThread = new Map<string, number>();
  let rootThread: string | undefined;
  let markSubagentSeen!: () => void;
  const state: ScenarioState = {
    subagentSeen: new Promise<void>((resolve) => {
      markSubagentSeen = resolve;
    }),
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        errors.push(`unexpected ${request.method} ${request.url}`);
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const metadata = (body.client_metadata ?? {}) as Record<string, unknown>;
      const thread = JSON.stringify(metadata.thread_id ?? metadata.session_id ?? null);
      rootThread ??= thread;
      const subagent = metadata["x-openai-subagent"] !== undefined || thread !== rootThread;
      const number = (perThread.get(thread) ?? 0) + 1;
      perThread.set(thread, number);
      const entry: CapturedRequest = { body, call: number, subagent };
      captured.push(entry);
      if (subagent) markSubagentSeen();
      const scripted = scenario.respond(entry, state);
      if (scripted.after) {
        await Promise.race([scripted.after(), new Promise((resolve) => setTimeout(resolve, timeoutMs / 2))]);
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse(`resp_${captured.length}`, scripted.items, scripted.usage));
    })().catch((error: unknown) => {
      errors.push(String(error));
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "pic.png"), Buffer.from(PNG_BASE64, "base64"));
    const blocked = "http://127.0.0.1:9";
    const environment = {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TMPDIR: root,
      HTTPS_PROXY: blocked,
      HTTP_PROXY: blocked,
      ALL_PROXY: blocked,
      NO_PROXY: "127.0.0.1,localhost",
    };
    const options = codexSdkOptions({
      proxyBaseUrl: `http://127.0.0.1:${port}`,
      capability: "record-capability-not-a-secret",
      developerInstructions: WORKER_SECURITY_INSTRUCTIONS,
      environment,
      disabledSkills: [...CODEX_BUILTIN_SKILLS],
    });
    const client = new Codex({ ...options, config: { ...options.config, ...scenario.config } });
    const thread = client.startThread({
      model: scenario.model,
      sandboxMode: "danger-full-access",
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    const streamed = await thread.runStreamed(RECORD_PROMPT, {
      ...(scenario.outputSchema ? { outputSchema: CODING_OUTPUT_JSON_SCHEMA } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    for await (const event of streamed.events) {
      if (event.type === "turn.failed") errors.push(`turn.failed: ${event.error.message}`);
      if (event.type === "error") errors.push(`error: ${event.message}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return { captured, errors };
}

/** Drives every scenario and returns the fixture entries, normalized. Throws
 *  when a scenario did not produce a request it is meant to record. */
export async function recordCodexRequests(
  options: { scenarios?: CodexRecordScenario[]; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<RecordedCodexRequest[]> {
  const recorded: RecordedCodexRequest[] = [];
  const roots: string[] = [];
  const cleanup: string[] = [];
  try {
    for (const scenario of options.scenarios ?? CODEX_RECORD_SCENARIOS) {
      const root = await mkdtemp(join(tmpdir(), "wardby-codex-record-"));
      cleanup.push(root);
      roots.push(root, await realpath(root));
      const { captured, errors } = await runScenario(scenario, root, options.timeoutMs ?? 90_000);
      options.log?.(`${scenario.name}: ${captured.length} request(s)${errors.length ? `; ${errors.join("; ")}` : ""}`);
      for (const { scenario: label, match } of scenario.record) {
        const hit = captured.find(match);
        if (!hit) {
          throw new Error(
            `Codex recording scenario "${scenario.name}" made no request for "${label}" ` +
              `(${captured.length} captured${errors.length ? `; ${errors.join("; ")}` : ""})`,
          );
        }
        recorded.push({ scenario: label, body: hit.body });
      }
    }
  } finally {
    for (const root of cleanup) await rm(root, { recursive: true, force: true });
  }
  return normalizeRecordedRequests(recorded, roots);
}
