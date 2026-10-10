// Runs the pinned Codex CLI (through @openai/codex-sdk, configured exactly as
// the worker configures it) against the real coding proxy, whose OpenAI
// Responses allowlist must accept every request Codex makes. The upstream is a
// scripted in-process fake: nothing leaves the machine. Codex's other egress is
// pointed at a closed local port. Skipped when the platform's Codex binary is
// not installed (npm installs only the host's optional dependency).
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryProxyLedger } from "../providers/coding-proxy/memory-ledger.js";
import { CodingProxy } from "../providers/coding-proxy/proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../providers/coding-proxy/server.js";
import type { ProxyAuditEvent } from "../providers/coding-proxy/types.js";
import { CODING_OUTPUT_JSON_SCHEMA, WORKER_SECURITY_INSTRUCTIONS } from "./driver.js";
import { recordCodexRequests } from "./codex-recorder.test-support.js";
import { createCodexSdkClient } from "./sdk.js";
import { CODEX_BUILTIN_SKILLS } from "./skills.js";

const require = createRequire(import.meta.url);
const RECORD = process.env.CODEX_RECORD === "1";
const FIXTURES = fileURLToPath(new URL("../providers/coding-proxy/fixtures/", import.meta.url));
const CODEX_FIXTURE = /^codex-(.+)-responses-requests\.json$/;

function pinnedCodexVersion(): string {
  return (require("./package.json") as { dependencies: Record<string, string> }).dependencies["@openai/codex-sdk"];
}

function codexBinaryInstalled(): boolean {
  try {
    require.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    return true;
  } catch {
    return false;
  }
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 15,
};
const PATCH = ["*** Begin Patch", "*** Add File: hello.txt", "+hello", "*** End Patch", ""].join("\n");

function sse(id: string, items: unknown[]): string {
  const events: unknown[] = [{ type: "response.created", response: { id } }];
  for (const item of items) events.push({ type: "response.output_item.done", item });
  events.push({ type: "response.completed", response: { id, usage: USAGE } });
  return events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const reasoning = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "plan" }],
  content: [{ type: "reasoning_text", text: "thinking" }],
  encrypted_content: "gAAAA-compatibility",
};
const commentary = {
  type: "message",
  id: "msg_commentary",
  role: "assistant",
  phase: "commentary",
  content: [{ type: "output_text", text: "Looking around.", annotations: [] }],
};

function finalMessage(id: string) {
  const text = JSON.stringify({
    schemaVersion: 1,
    runId: "run-compat",
    outcome: "changes_ready",
    summary: "Added hello.txt.",
    tag: null,
    tests: [],
  });
  return { type: "message", id, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
}

/** Scripted model turns. Responses-lite models (tools in an additional_tools
 *  input item) get a code-mode `exec` call; classic ones get direct function
 *  calls. Both exercise a shell command, an inline image and apply_patch. */
function scriptedTurn(call: number, body: Record<string, unknown>): string {
  const lite = body.tools === undefined;
  const id = `resp_${call}`;
  if (lite && call === 1) {
    const input = [
      'const r = await tools.exec_command({ cmd: "echo hi" });',
      "text(r.output);",
      'image(await tools.view_image({ path: "pixel.png" }));',
      `await tools.apply_patch(${JSON.stringify(PATCH)});`,
    ].join("\n");
    return sse(id, [
      reasoning,
      commentary,
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input },
    ]);
  }
  if (lite && call === 2) {
    return sse(id, [
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_2",
        namespace: "functions",
        name: "wait",
        arguments: JSON.stringify({ cell_id: "missing" }),
      },
    ]);
  }
  if (!lite && call === 1) {
    return sse(id, [
      reasoning,
      commentary,
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "view_image",
        arguments: JSON.stringify({ path: "pixel.png" }),
      },
    ]);
  }
  if (!lite && call === 2) {
    return sse(id, [
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call_2",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "echo hi" }),
      },
    ]);
  }
  return sse(id, [finalMessage(`msg_${call}`)]);
}

// Needs no Codex binary, so it runs everywhere: a Codex bump without a
// re-recorded request fixture fails here even where the rest is skipped.
describe.skipIf(RECORD)("pinned Codex version", () => {
  it("tests the Codex version the worker image pins", () => {
    const pinned = pinnedCodexVersion();
    const rootManifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const declared = rootManifest.devDependencies["@openai/codex-sdk"];
    const sdkManifest = join(dirname(fileURLToPath(import.meta.resolve("@openai/codex-sdk"))), "..", "package.json");
    const installedSdk = (JSON.parse(readFileSync(sdkManifest, "utf8")) as { version: string }).version;
    const installedCli = (require("@openai/codex/package.json") as { version: string }).version;
    // The recorded request fixture is named for the version it was captured from.
    const fixtures = readdirSync(FIXTURES)
      .map((name) => CODEX_FIXTURE.exec(name)?.[1])
      .filter((version): version is string => version !== undefined);
    const matches =
      declared === pinned && installedSdk === pinned && installedCli === pinned && fixtures.includes(pinned);
    const root = declared === installedSdk ? declared : `${declared} (installed ${installedSdk})`;
    expect(
      matches,
      `Codex SDK bump detected (${pinned} vs ${root}/${fixtures.join(",") || "no fixture"}). ` +
        'Run "npm run codex:rerecord" on this branch, review the request-shape diff it prints, and commit the new fixture.',
    ).toBe(true);
  });
});

// CODEX_RECORD=1 (npm run codex:rerecord) records the pinned Codex CLI's
// requests into the fixture the proxy tests replay, instead of testing.
describe.runIf(RECORD)("record the pinned Codex CLI's Responses requests", () => {
  it("writes the request fixture for the pinned version", async () => {
    expect(codexBinaryInstalled(), "the host's Codex binary (@openai/codex-<platform>) is not installed").toBe(true);
    const requests = await recordCodexRequests({ log: (line) => process.stderr.write(`[codex-record] ${line}\n`) });
    const target = join(FIXTURES, `codex-${pinnedCodexVersion()}-responses-requests.json`);
    await writeFile(target, `${JSON.stringify(requests, null, 2)}\n`);
    process.stderr.write(`[codex-record] wrote ${requests.length} requests to ${target}\n`);
  }, 900_000);
});

describe.skipIf(RECORD || !codexBinaryInstalled())("pinned Codex CLI against the coding proxy allowlist", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) await task();
  });

  it.each(["gpt-5.6-terra", "gpt-4.1"])(
    "completes a tool-using turn with %s without a single rejected request",
    async (model) => {
      const forwarded: Record<string, unknown>[] = [];
      const audit: ProxyAuditEvent[] = [];
      const proxy = new CodingProxy({
        ledger: new MemoryProxyLedger(),
        credentials: { resolve: async () => "UPSTREAM_SECRET_NOT_REAL" },
        pricing: () => ({
          encoding: "o200k_base",
          inputPerMTok: 1,
          cachedInputPerMTok: 0.1,
          cacheWritePerMTok: 1,
          outputPerMTok: 1,
        }),
        audit: (event) => audit.push(event),
        fetch: async (_input, init) => {
          const body = JSON.parse(init?.body as string) as Record<string, unknown>;
          forwarded.push(body);
          return new Response(scriptedTurn(forwarded.length, body), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      const session = await proxy.createSession({
        runId: `codex-compat-${model}`,
        credentialRef: "openai/compatibility",
        protocol: "openai-responses",
        allowedModels: [model],
        deadlineAt: new Date(Date.now() + 120_000),
        budgetUsd: 10,
      });
      const rejected: string[] = [];
      let server: CodingProxyServerHandle | undefined = await startCodingProxyServer(proxy, {
        host: "127.0.0.1",
        port: 0,
        onRequest: (event) => {
          if (event.status >= 400) rejected.push(`${event.protocol}:${event.status}`);
        },
      });
      cleanup.push(async () => {
        await server?.close();
        server = undefined;
      });
      const root = await mkdtemp(join(tmpdir(), "wardby-codex-compat-"));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      await mkdir(home, { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "pixel.png"), Buffer.from(PNG_BASE64, "base64"));

      const blocked = "http://127.0.0.1:9";
      const client = createCodexSdkClient({
        proxyBaseUrl: `http://127.0.0.1:${server.port}`,
        capability: session.capability,
        developerInstructions: WORKER_SECURITY_INSTRUCTIONS,
        environment: {
          HOME: home,
          LANG: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TMPDIR: root,
          HTTPS_PROXY: blocked,
          HTTP_PROXY: blocked,
          ALL_PROXY: blocked,
          NO_PROXY: "127.0.0.1,localhost",
        },
        disabledSkills: [...CODEX_BUILTIN_SKILLS],
      });
      const thread = client.startThread({
        model,
        sandboxMode: "danger-full-access",
        workingDirectory: workspace,
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
      });
      const signal = AbortSignal.timeout(90_000);
      const streamed = await thread.runStreamed("Add hello.txt containing hello.", {
        outputSchema: CODING_OUTPUT_JSON_SCHEMA,
        signal,
      });
      const events: Array<{ type: string; item?: { type: string } }> = [];
      for await (const event of streamed.events) events.push(event);

      expect(rejected).toEqual([]);
      expect(audit.filter((event) => event.type === "request.rejected")).toEqual([]);
      expect(events.map((event) => event.type)).toContain("turn.completed");
      expect(events.map((event) => event.type)).not.toContain("turn.failed");
      expect(events.some((event) => event.item?.type === "command_execution")).toBe(true);
      expect(forwarded.length).toBeGreaterThanOrEqual(3);
      const itemTypes = new Set(
        forwarded.flatMap((body) => (body.input as Array<{ type: string }>).map((item) => item.type)),
      );
      expect(itemTypes).toContain(model === "gpt-4.1" ? "function_call_output" : "custom_tool_call_output");
      expect(JSON.stringify(forwarded)).toContain("data:image/png;base64,");
    },
    120_000,
  );
});
