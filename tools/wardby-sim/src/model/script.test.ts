import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODING_OUTPUT_JSON_SCHEMA, WORKER_SECURITY_INSTRUCTIONS } from "../../../../src/coding-worker/driver.js";
import { createCodexSdkClient } from "../../../../src/coding-worker/sdk.js";
import { CODEX_BUILTIN_SKILLS } from "../../../../src/coding-worker/skills.js";
import { MemoryProxyLedger } from "../../../../src/providers/coding-proxy/memory-ledger.js";
import { CLAUDE_CODE_ANTHROPIC_BETAS, CodingProxy } from "../../../../src/providers/coding-proxy/proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../../../../src/providers/coding-proxy/server.js";
import type { ProxyAuditEvent } from "../../../../src/providers/coding-proxy/types.js";
import { fillTemplates, renderMessages, renderResponses, ScriptedModel, type TurnScript } from "./script.js";

const require = createRequire(import.meta.url);
const SCRIPTS = resolve(import.meta.dirname, "../../scripts/flow-g");
const loadScript = (name: string) => JSON.parse(readFileSync(join(SCRIPTS, name), "utf8")) as TurnScript;
const PRICE = {
  encoding: "o200k_base" as const,
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
  outputPerMTok: 5,
};

function events(sse: string): { event: string; data: any }[] {
  return sse
    .trim()
    .split("\n\n")
    .map((chunk) => {
      const [eventLine, dataLine] = chunk.split("\n");
      return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) };
    });
}

function codexInstalled(): boolean {
  try {
    require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
}

describe("scripted model", () => {
  it("renders OpenAI Responses and Anthropic Messages streams", () => {
    const responses = events(
      renderResponses({ items: [{ type: "message", id: "m", role: "assistant", content: [] }] }, "resp_1", "gpt-x"),
    );
    expect(
      responses
        .map((e) => e.event)
        .filter((e) => !e.startsWith("response.content_part") && !e.startsWith("response.output_text")),
    ).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
    expect(responses.at(-1)!.data.response.usage.input_tokens).toBe(1200);
    const messages = events(
      renderMessages(
        {
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } },
          ],
        },
        "msg_1",
        "claude-x",
      ),
    );
    expect(messages.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(JSON.parse(messages[5].data.delta.partial_json)).toEqual({ command: "ls" });
    expect(messages.at(-2)!.data.delta.stop_reason).toBe("tool_use");
  });

  it("fills runId and the last value of a field, escaped or not", () => {
    const body = JSON.stringify({
      input: `The final JSON runId must be run-7. ${JSON.stringify({ headSha: "a".repeat(40) })} then ${JSON.stringify({ headSha: "b".repeat(40), prNumber: 12 })}`,
    });
    expect(fillTemplates({ x: ["{{runId}}", "{{last:headSha}}", "{{lastNumber:prNumber}}"] }, body)).toEqual({
      x: ["run-7", "b".repeat(40), "12"],
    });
  });

  it("replays each agent's turns in order, repeats the last, and refuses an unscripted request", () => {
    const model = new ScriptedModel();
    model.load([loadScript("builder.codex.json"), loadScript("delivery.codex.json")]);
    const ask = (marker: string) =>
      model.answer(
        "openai-responses",
        JSON.stringify({ model: "m", input: `${marker} The final JSON runId must be r1.` }),
      );
    expect(ask("[flow-g:builder]")).toContain("custom_tool_call");
    expect(ask("[flow-g:delivery]")).toContain("delegate_to_builder");
    expect(ask("[flow-g:builder]")).toContain('\\"runId\\":\\"r1\\"');
    expect(ask("[flow-g:builder]")).toContain('\\"runId\\":\\"r1\\"');
    expect(ask("[flow-g:nobody]")).toBeNull();
    expect(model.answer("anthropic-messages", "[flow-g:builder]")).toBeNull();
    // A lead's request that carries its sub-agent's marker later on still belongs to the lead.
    expect(ask("[flow-g:delivery] then the delegation: [flow-g:builder] add a joke")).toContain("The builder opened");
    expect(model.served.map((s) => `${s.agent}:${s.turn}`)).toEqual([
      "builder:0",
      "delivery:0",
      "builder:1",
      "builder:1",
      "delivery:1",
    ]);
  });

  it("loads every Flow G script, its protocol matching its file name", () => {
    const files = readdirSync(SCRIPTS).sort();
    expect(files).toEqual([
      "builder.claude.json",
      "builder.codex.json",
      "delivery.claude.json",
      "delivery.codex.json",
      "reviewer.claude.json",
      "reviewer.codex.json",
    ]);
    for (const file of files) {
      const script = loadScript(file);
      const model = new ScriptedModel();
      model.load([script]);
      expect(script.protocol).toBe(file.includes(".codex.") ? "openai-responses" : "anthropic-messages");
      expect(script.agent).toBe(file.split(".")[0]);
      expect(script.match).toBe(`[flow-g:${script.agent}]`);
    }
  });
});

describe("Flow G builder scripts through the real coding proxy", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task();
  });

  async function proxyWith(protocol: "openai-responses" | "anthropic-messages", model: string) {
    const scripted = new ScriptedModel();
    scripted.load([loadScript(protocol === "openai-responses" ? "builder.codex.json" : "builder.claude.json")]);
    const audit: ProxyAuditEvent[] = [];
    const ledger = new MemoryProxyLedger();
    const proxy = new CodingProxy({
      ledger,
      credentials: { resolve: async () => "UPSTREAM_SECRET_NOT_REAL" },
      pricing: () => PRICE,
      audit: (event) => audit.push(event),
      fetch: async (_input, init) => {
        const stream = scripted.answer(protocol, typeof init?.body === "string" ? init.body : "");
        return stream === null
          ? Response.json({ error: "unscripted" }, { status: 501 })
          : new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const session = await proxy.createSession({
      runId: "run-flowg",
      credentialRef: protocol === "openai-responses" ? "openai/flow-g" : "anthropic/flow-g",
      protocol,
      allowedModels: [model],
      deadlineAt: new Date(Date.now() + 120_000),
      budgetUsd: 10,
    });
    const rejected: string[] = [];
    const server: CodingProxyServerHandle = await startCodingProxyServer(proxy, {
      host: "127.0.0.1",
      port: 0,
      onRequest: (event) => {
        if (event.status >= 400) rejected.push(`${event.protocol}:${event.status}`);
      },
    });
    cleanup.push(() => server.close());
    return { scripted, audit, ledger, session, server, rejected };
  }

  it.skipIf(!codexInstalled())(
    "builder.codex: the pinned Codex CLI writes the file, runs the tests and answers the final JSON",
    async () => {
      const h = await proxyWith("openai-responses", "gpt-5.6-terra");
      const root = await mkdtemp(join(tmpdir(), "wardby-sim-flowg-codex-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      await mkdir(home, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({ name: "jokes", version: "1.0.0", scripts: { test: 'node -e "process.exit(0)"' } }),
      );
      const blocked = "http://127.0.0.1:9";
      const client = createCodexSdkClient({
        proxyBaseUrl: `http://127.0.0.1:${h.server.port}`,
        capability: h.session.capability,
        developerInstructions: WORKER_SECURITY_INSTRUCTIONS,
        environment: {
          HOME: home,
          LANG: "C.UTF-8",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: root,
          HTTPS_PROXY: blocked,
          HTTP_PROXY: blocked,
          ALL_PROXY: blocked,
          NO_PROXY: "127.0.0.1,localhost",
        },
        disabledSkills: [...CODEX_BUILTIN_SKILLS],
      });
      const thread = client.startThread({
        model: "gpt-5.6-terra",
        sandboxMode: "danger-full-access",
        workingDirectory: workspace,
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
      });
      const streamed = await thread.runStreamed(
        "[flow-g:builder] Add a joke. The final JSON runId must be run-flowg.",
        {
          outputSchema: CODING_OUTPUT_JSON_SCHEMA,
          signal: AbortSignal.timeout(90_000),
        },
      );
      const seen: { type: string; item?: { type: string; text?: string } }[] = [];
      for await (const event of streamed.events) seen.push(event);
      expect(h.rejected).toEqual([]);
      expect(seen.map((e) => e.type)).toContain("turn.completed");
      expect(await readFile(join(workspace, "jokes/flow-g.txt"), "utf8")).toBe("Knock knock. Who's there? Flow G.\n");
      const final = seen.filter((e) => e.item?.type === "agent_message").at(-1)?.item?.text ?? "";
      expect(JSON.parse(final)).toMatchObject({
        runId: "run-flowg",
        outcome: "changes_ready",
        tests: [{ command: "npm test", outcome: "passed" }],
      });
      expect(h.scripted.served.map((s) => s.turn)).toEqual([0, 1]);
    },
    120_000,
  );

  it("builder.claude: the proxy accepts, streams and meters every scripted turn", async () => {
    const h = await proxyWith("anthropic-messages", "claude-sonnet-5");
    // Loaded as a module (the proxy's allowlist fixture, shared so the two can't drift), not read as file data.
    const fixture = structuredClone(
      require("../../../../src/providers/coding-proxy/fixtures/anthropic-sdk-request.json"),
    ) as Record<string, unknown>;
    // Claude Code's own request shape (the proxy's allowlist fixture), with the agent's marker and run id in the prompt.
    const messages = structuredClone(fixture.messages) as { content: { type: string; text?: string }[] }[];
    messages[0].content[0].text = "[flow-g:builder] Add a joke. The final JSON runId must be run-flowg.";
    const body = { ...fixture, model: "claude-sonnet-5", stream: true, messages };
    const turns: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      // Each real turn's request differs (the conversation grows); the proxy refuses an exact repeat.
      messages[0].content[0].text = `[flow-g:builder] Add a joke (turn ${i}). The final JSON runId must be run-flowg.`;
      const response = await fetch(`http://127.0.0.1:${h.server.port}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": h.session.capability,
          "anthropic-beta": CLAUDE_CODE_ANTHROPIC_BETAS.join(","),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      turns.push(await response.text());
    }
    expect(h.rejected).toEqual([]);
    expect(turns[0]).toContain('"name":"mcp__wardby_tools__run_command"');
    expect(turns[1]).toContain('"name":"StructuredOutput"');
    expect(turns[1]).toContain('\\"runId\\":\\"run-flowg\\"');
    const completed = h.audit.filter((e) => e.type === "response.completed");
    expect(completed).toHaveLength(3);
  });
});
