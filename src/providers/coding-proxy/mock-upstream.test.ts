import { describe, expect, it } from "vitest";
import { DEFAULT_MOCK_UPSTREAM, createMockUpstream, extractRunId, mockUpstreamFromEnv } from "./mock-upstream.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, type ProxyResponseSink } from "./proxy.js";
import type { ModelPricing } from "../llm/pricing-core.js";

const RUN = "run_abc-123";
const body = JSON.stringify({
  model: "gpt-5.6-luna",
  stream: true,
  input: [
    { role: "user", content: [{ type: "input_text", text: `Task:\nx\n\nThe final JSON runId must be ${RUN}.` }] },
  ],
});
const noSleep = async () => {};

async function events(res: Response): Promise<Array<{ event: string; data: any }>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "null");
      return { event, data };
    });
}

describe("extractRunId", () => {
  it("reads the runId the worker prompt names", () => expect(extractRunId(body)).toBe(RUN));
  it("is null when absent", () => expect(extractRunId("{}")).toBeNull());
});

describe("createMockUpstream (openai-responses)", () => {
  it("streams one assistant message whose text is a no_changes result for the run", async () => {
    const fetch = createMockUpstream({}, noSleep);
    const res = await fetch("https://api.openai.com/v1/responses", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const evs = await events(res);
    expect(evs[0].event).toBe("response.created");
    const done = evs.find((e) => e.event === "response.completed")!;
    const text = done.data.response.output[0].content[0].text;
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      runId: RUN,
      outcome: "no_changes",
      tag: null,
      tests: [],
    });
    expect(done.data.response.usage).toMatchObject({ input_tokens: 1200, output_tokens: 80 });
  });

  it("waits latencyMs (plus jitter) before the first byte", async () => {
    const waits: number[] = [];
    const fetch = createMockUpstream({ latencyMs: 300, jitterMs: 0 }, async (ms) => void waits.push(ms));
    await (await fetch("https://api.openai.com/v1/responses", { method: "POST", body })).text();
    expect(waits).toEqual([300]);
  });

  it("refuses a request with no runId (400) instead of inventing one", async () => {
    const res = await createMockUpstream({}, noSleep)("https://api.openai.com/v1/responses", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("returns 501 for the Anthropic endpoint (Codex only, ruling R1)", async () => {
    const res = await createMockUpstream({}, noSleep)("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(501);
  });

  it("answers a Gemini host with 501, like Anthropic's (ruling R1)", async () => {
    const response = await createMockUpstream({}, noSleep)(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(501);
  });
});

// Minimum harness copied from proxy.test.ts (not exported there by design):
// a CodingProxy wired to a MemoryProxyLedger and audit-event capture, enough
// to run one real request/response cycle through the proxy's own metering.
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2,
  outputPerMTok: 4,
};

class TestSink implements ProxyResponseSink {
  status?: number;
  chunks: Buffer[] = [];
  ended = false;
  start(status: number) {
    this.status = status;
  }
  write(chunk: Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
  }
  end() {
    this.ended = true;
  }
  destroy() {}
}

describe("CodingProxy with createMockUpstream", () => {
  it("meters a streamed Responses run against the mock upstream as completed with its configured token counts", async () => {
    const ledger = new MemoryProxyLedger();
    const events: Array<{ type: string; requestId?: string }> = [];
    const proxy = new CodingProxy({
      ledger,
      credentials: { resolve: async () => "UPSTREAM_SECRET" },
      fetch: createMockUpstream({}, noSleep),
      pricing: () => PRICE,
      pricingVersion: "test-v1",
      audit: (event) => events.push(event),
    });
    const session = await proxy.createSession({
      runId: "run-mock-1",
      credentialRef: "openai/project-a",
      protocol: "openai-responses",
      allowedModels: ["test-model"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    });
    const rawBody = JSON.stringify({
      model: "test-model",
      stream: true,
      input: "Task:\nx\n\nThe final JSON runId must be run-mock-1.",
    });
    const sink = new TestSink();
    await proxy.execute({ bearer: session.capability, protocol: session.protocol, rawBody, requestKey: "k1" }, sink);

    expect(sink.status).toBe(200);
    const requestId = events.find((event) => event.type === "request.reserved")!.requestId!;
    const request = await ledger.getRequest(requestId);
    expect(request).toMatchObject({
      status: "completed",
      usage: { inputTokens: 1200, outputTokens: 80 },
    });
  });
});

describe("mockUpstreamFromEnv (guard)", () => {
  it("is off when neither variable is set", () => expect(mockUpstreamFromEnv({})).toBeNull());
  it.each([
    [{ WARDBY_LOAD_TEST: "1" }],
    [{ WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1" }],
    [{ WARDBY_LOAD_TEST: "true", WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1" }],
    [{ WARDBY_LOAD_TEST: "1", WARDBY_CODING_PROXY_MOCK_UPSTREAM: "yes" }],
    [{ WARDBY_LOAD_TEST: "", WARDBY_CODING_PROXY_MOCK_UPSTREAM: "" }],
    [{ WARDBY_LOAD_TEST: "0", WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1" }],
  ])("refuses a partial or malformed setting %j", (env) => {
    expect(() => mockUpstreamFromEnv(env)).toThrow(/^mock_upstream_guard:/);
  });
  it("is on only with both set to 1, reading latency and jitter", () => {
    expect(
      mockUpstreamFromEnv({
        WARDBY_LOAD_TEST: "1",
        WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1",
        WARDBY_LOAD_MOCK_LATENCY_MS: "250",
        WARDBY_LOAD_MOCK_JITTER_MS: "50",
      }),
    ).toMatchObject({ latencyMs: 250, jitterMs: 50 });
  });
  it("uses the default latency and jitter when unset", () => {
    expect(mockUpstreamFromEnv({ WARDBY_LOAD_TEST: "1", WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1" })).toEqual(
      DEFAULT_MOCK_UPSTREAM,
    );
  });
  it.each(["-1", "1.5", "abc", "1e400", "0x10", " 5", "1e3", "99999999999999999999"])(
    "rejects a non-integer or negative latency %s",
    (value) => {
      expect(() =>
        mockUpstreamFromEnv({
          WARDBY_LOAD_TEST: "1",
          WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1",
          WARDBY_LOAD_MOCK_LATENCY_MS: value,
        }),
      ).toThrow(/^mock_upstream_guard:/);
    },
  );
  it("rejects a malformed jitter", () => {
    expect(() =>
      mockUpstreamFromEnv({
        WARDBY_LOAD_TEST: "1",
        WARDBY_CODING_PROXY_MOCK_UPSTREAM: "1",
        WARDBY_LOAD_MOCK_JITTER_MS: "-5",
      }),
    ).toThrow(/^mock_upstream_guard:/);
  });
});
