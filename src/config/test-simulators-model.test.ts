/**
 * The model seams under WARDBY_TEST_SIMULATORS, against a real loopback server that answers from
 * the simulator's scripted model and records every request header: the native Anthropic and
 * OpenAI clients and the coding proxy's upstream all reach it, stream the scripted turn, and send
 * no provider key (fake keys are planted to prove it). Bedrock is refused.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { ScriptedModel } from "../../tools/wardby-sim/src/model/script.js";
import { startConfiguredCodingProxy } from "../providers/coding-proxy/runtime.js";
import type { CodingProxyServerHandle } from "../providers/coding-proxy/server.js";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../providers/jobs/docker-isolation.js";
import { AnthropicLlmProvider } from "../providers/llm/anthropic.js";
import { BedrockClaudeLlmProvider } from "../providers/llm/bedrock.js";
import { OpenAiLlmProvider } from "../providers/llm/openai.js";
import type { LlmStreamEvent } from "../providers/llm/types.js";

const OPENAI_KEY = "sk-proj-FAKEfakeFAKEfake0123456789abcdef";
const ANTHROPIC_KEY = "sk-ant-api03-FAKEfakeFAKEfake0123456789";

let server: Server;
let base: string;
const seen: { path: string; headers: IncomingHttpHeaders; body: string }[] = [];
const model = new ScriptedModel();

beforeAll(async () => {
  model.load([
    {
      agent: "native-openai",
      protocol: "openai-responses",
      match: "[sim:openai]",
      turns: [
        {
          items: [
            {
              type: "message",
              id: "m1",
              role: "assistant",
              content: [{ type: "output_text", text: "hello from the script", annotations: [] }],
            },
          ],
        },
      ],
    },
    {
      agent: "native-anthropic",
      protocol: "anthropic-messages",
      match: "[sim:anthropic]",
      turns: [{ content: [{ type: "text", text: "hello from the script" }] }],
    },
  ]);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      const protocol = (req.url ?? "").startsWith("/model/openai/") ? "openai-responses" : "anthropic-messages";
      const stream = model.answer(protocol, body);
      if (stream === null) res.writeHead(501).end();
      else res.writeHead(200, { "content-type": "text/event-stream" }).end(stream);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function stubSwitch(): void {
  for (const name of [
    "WARDBY_SLACK_BOT_TOKEN",
    "WARDBY_JIRA_API_TOKEN",
    "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "WARDBY_HOSTNAME",
    "MCP_CANONICAL_URI",
    "WARDBY_LOAD_TEST",
    "WARDBY_CODING_PROXY_MOCK_UPSTREAM",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("WARDBY_TEST_SIMULATORS", "1");
  vi.stubEnv("WARDBY_SIM_BASE_URL", base);
}

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function noKeys(): void {
  const all = JSON.stringify(seen);
  expect(all).not.toContain(OPENAI_KEY);
  expect(all).not.toContain(ANTHROPIC_KEY);
  for (const request of seen) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
  }
}

describe("native model clients under WARDBY_TEST_SIMULATORS", () => {
  it("Anthropic: streams the scripted turn from the simulator, sending no key", async () => {
    stubSwitch();
    seen.length = 0;
    const events = await collect(
      new AnthropicLlmProvider(ANTHROPIC_KEY).stream({
        model: "claude-sonnet-5",
        messages: [{ role: "user", content: "[sim:anthropic] hi" }],
      }),
    );
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("hello from the script");
    expect(seen.map((r) => r.path)).toEqual(["/model/anthropic/v1/messages"]);
    noKeys();
  });

  it("OpenAI: streams the scripted turn from the simulator, sending no key", async () => {
    stubSwitch();
    seen.length = 0;
    const events = await collect(
      new OpenAiLlmProvider(OPENAI_KEY).stream({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "[sim:openai] hi" }],
      }),
    );
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("hello from the script");
    expect(seen.map((r) => r.path)).toEqual(["/model/openai/v1/responses"]);
    noKeys();
  });

  it("off: the clients keep the providers' own endpoints", () => {
    const anthropic = new AnthropicLlmProvider(ANTHROPIC_KEY) as unknown as { client: { baseURL: string } };
    const openai = new OpenAiLlmProvider(OPENAI_KEY) as unknown as { client: { baseURL: string } };
    expect(anthropic.client.baseURL).toBe("https://api.anthropic.com");
    expect(openai.client.baseURL).toBe("https://api.openai.com/v1");
  });

  it("Bedrock is refused under the switch, and a refused switch fails each client closed", () => {
    stubSwitch();
    expect(() => new BedrockClaudeLlmProvider("us-east-1")).toThrow("test_simulators_refused:bedrock_not_simulated");
    vi.stubEnv("WARDBY_SIM_BASE_URL", "http://models.example.com");
    expect(() => new AnthropicLlmProvider(ANTHROPIC_KEY)).toThrow("test_simulators_refused:base_host_not_local");
    expect(() => new OpenAiLlmProvider(OPENAI_KEY)).toThrow("test_simulators_refused:base_host_not_local");
  });
});

describe("the coding proxy's model upstream under WARDBY_TEST_SIMULATORS", () => {
  it("goes to the scripted model for both protocols, with the injected credential dropped", async () => {
    const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
    const startServer = vi.fn(async () => handle);
    await startConfiguredCodingProxy({
      db: {} as PrismaClient,
      env: {
        WARDBY_TEST_SIMULATORS: "1",
        WARDBY_SIM_BASE_URL: base,
        OPENAI_API_KEY: OPENAI_KEY,
        ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      },
      startServer,
      startDenyPort: async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }),
    });
    const proxy = (startServer.mock.calls as unknown as [{ fetchImpl: typeof fetch }][])[0][0];
    seen.length = 0;
    const openai = await proxy.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-terra", input: "[sim:openai]" }),
    });
    const anthropic = await proxy.fetchImpl("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "[sim:anthropic]" }] }),
    });
    expect([openai.status, anthropic.status]).toEqual([200, 200]);
    expect(seen.map((r) => r.path)).toEqual(["/model/openai/v1/responses", "/model/anthropic/v1/messages?beta=true"]);
    noKeys();
    await expect(proxy.fetchImpl("https://api.openai.com/v1/chat/completions", { method: "POST" })).rejects.toThrow(
      "proxy_egress_blocked",
    );
  });

  it("is refused together with the load-test mock upstream", async () => {
    await expect(
      startConfiguredCodingProxy({
        db: {} as PrismaClient,
        env: {
          WARDBY_TEST_SIMULATORS: "1",
          WARDBY_SIM_BASE_URL: base,
          WARDBY_LOAD_TEST: "1",
          WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1",
        },
        startServer: vi.fn(),
        startDenyPort: vi.fn(),
      }),
    ).rejects.toThrow("test_simulators_refused:model_mock_conflict");
  });
});
