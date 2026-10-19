import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { estimateReservationUsd } from "./metering.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import {
  MAX_COMMAND_TIMEOUT_MS,
  CodingProxy,
  CodingProxyError,
  CLAUDE_CODE_ANTHROPIC_BETAS,
  PROXY_DEFAULT_MAX_OUTPUT_TOKENS,
  capabilityHash,
  type CreatedCodingProxySession,
  type ProxyResponseSink,
} from "./proxy.js";
import { MAX_TIMEOUT_MS as TOOL_RUNNER_MAX_TIMEOUT_MS } from "../../claude-tool-runner/command.mjs";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import type { ModelPricing } from "../llm/pricing-core.js";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";
import type { LlmEffort } from "../llm/types.js";
import type { ProxyAuditEvent, ProxyModelTerms, ProxyProtocol } from "./types.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2,
  outputPerMTok: 4,
};
const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 1 },
};

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function requestBody(stream = false): string {
  return JSON.stringify({ model: "test-model", input: "hello", max_output_tokens: 10, stream });
}

function completedSse(usage: unknown = USAGE): string {
  return (
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage } })}\n\n` +
    "data: [DONE]\n\n"
  );
}

class TestSink implements ProxyResponseSink {
  status?: number;
  headers?: Record<string, string>;
  chunks: Buffer[] = [];
  ended = false;
  destroyed = false;
  constructor(private readonly disconnectAfterWrites = Number.POSITIVE_INFINITY) {}
  start(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
  }
  write(chunk: Uint8Array) {
    if (this.chunks.length >= this.disconnectAfterWrites) throw new Error("client_disconnected");
    this.chunks.push(Buffer.from(chunk));
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

interface Harness {
  proxy: CodingProxy;
  ledger: MemoryProxyLedger;
  session: CreatedCodingProxySession;
  fetch: ReturnType<typeof vi.fn>;
  events: ProxyAuditEvent[];
}

async function harness(
  overrides: {
    budgetUsd?: number;
    deadlineAt?: Date;
    fetch?: typeof globalThis.fetch;
    ledger?: MemoryProxyLedger;
    now?: () => Date;
    price?: () => ModelPricing;
    credentials?: { resolve(reference: string): Promise<string> };
    protocol?: ProxyProtocol;
    allowedModels?: string[];
    terms?: ProxyModelTerms;
  } = {},
): Promise<Harness> {
  const ledger = overrides.ledger ?? new MemoryProxyLedger({ now: overrides.now ?? (() => NOW) });
  const events: ProxyAuditEvent[] = [];
  const fetchImpl: typeof globalThis.fetch =
    overrides.fetch ?? (async () => Response.json({ id: "resp", usage: USAGE }, { status: 200 }));
  const fetch = vi.fn(fetchImpl);
  // An explicit `price` (even undefined, meaning "the shipped-catalog fallback") wins;
  // otherwise the test price stands in for the fallback only on a session without terms.
  const pricing = "price" in overrides ? overrides.price : overrides.terms ? undefined : () => PRICE;
  const proxy = new CodingProxy({
    ledger,
    credentials: overrides.credentials ?? { resolve: async () => "UPSTREAM_SECRET" },
    fetch,
    now: overrides.now ?? (() => NOW),
    pricing,
    pricingVersion: pricing ? "test-v1" : undefined,
    audit: (event) => events.push(event),
  });
  const session = await proxy.createSession({
    runId: `run-${Math.random()}`,
    credentialRef: overrides.protocol === "anthropic-messages" ? "anthropic/project-a" : "openai/project-a",
    protocol: overrides.protocol ?? "openai-responses",
    allowedModels: overrides.allowedModels ?? [
      overrides.protocol === "anthropic-messages" ? "claude-sonnet-5" : "test-model",
    ],
    deadlineAt: overrides.deadlineAt ?? new Date(NOW.getTime() + 60_000),
    budgetUsd: overrides.budgetUsd ?? 1,
    terms: overrides.terms,
  });
  return { proxy, ledger, session, fetch, events };
}

async function execute(h: Harness, key: string, sink = new TestSink(), body = requestBody()): Promise<TestSink> {
  await h.proxy.execute(
    {
      bearer: h.session.capability,
      protocol: h.session.protocol,
      rawBody: body,
      requestKey: key,
      anthropicBeta: h.session.protocol === "anthropic-messages" ? CLAUDE_CODE_ANTHROPIC_BETAS.join(",") : undefined,
    },
    sink,
  );
  return sink;
}

function reservedRequestId(events: ProxyAuditEvent[]): string {
  return events.find((event) => event.type === "request.reserved")!.requestId!;
}

describe("CodingProxy", () => {
  it("injects only the resolved upstream credential and persists authoritative usage before responding", async () => {
    const response = JSON.parse(await fixture("openai-responses-response.json"));
    const h = await harness({ fetch: async () => Response.json(response) });
    const sink = await execute(h, "request-1", new TestSink(), await fixture("openai-responses-request.json"));

    expect(sink.status).toBe(200);
    expect(sink.ended).toBe(true);
    const init = h.fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer UPSTREAM_SECRET");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "test-model", store: false, background: false });
    expect(init.body).not.toContain(h.session.capability);
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request).toMatchObject({
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, cacheWriteTokens: 3, reasoningTokens: 1 },
    });
    expect(JSON.stringify(h.events)).not.toContain("UPSTREAM_SECRET");
    expect(JSON.stringify(h.events)).not.toContain("hello");
  });

  it("adds a budgeted output ceiling when the Codex SDK omits max_output_tokens", async () => {
    const h = await harness();
    const body = JSON.stringify({ model: "test-model", input: "hello", stream: false });

    await execute(h, "codex-sdk-request", new TestSink(), body);

    const init = h.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      max_output_tokens: PROXY_DEFAULT_MAX_OUTPUT_TOKENS,
      store: false,
      background: false,
    });
    expect(h.events.find((event) => event.type === "request.reserved")?.reservationUsd).toBeGreaterThan(0);
  });

  it("stores the hash of a registry-only token derived from each new capability", async () => {
    const h = await harness();
    const session = await h.ledger.findSessionByCapabilityHash(capabilityHash(h.session.capability));
    expect(session?.registryTokenHash).toBe(capabilityHash(deriveRegistryToken(h.session.capability)));
  });

  it("rejects invalid capabilities and models without resolving credentials or calling upstream", async () => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ credentials: { resolve } });
    await expect(
      h.proxy.execute(
        { bearer: "wrong", protocol: "openai-responses", rawBody: requestBody(), requestKey: "a" },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    const other = JSON.stringify({ model: "other", input: "x", max_output_tokens: 10, stream: false });
    await expect(
      h.proxy.execute(
        { bearer: h.session.capability, protocol: "openai-responses", rawBody: other, requestKey: "b" },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fails session creation closed for an unknown model", async () => {
    const proxy = new CodingProxy({
      ledger: new MemoryProxyLedger(),
      credentials: { resolve: async () => "secret" },
      pricing: () => {
        throw new Error("unknown");
      },
    });
    await expect(
      proxy.createSession({
        runId: "run",
        credentialRef: "ref",
        protocol: "openai-responses",
        allowedModels: ["unknown"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
      }),
    ).rejects.toThrow("unknown");
  });

  it("refuses when a reservation lands exactly on the remaining budget", async () => {
    const raw = requestBody();
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const exactBudget = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    const h = await harness({ budgetUsd: exactBudget });
    await expect(execute(h, "boundary")).rejects.toMatchObject({ status: 429, code: "wardby_budget_exhausted" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("records the first budget refusal on the session", async () => {
    const raw = requestBody();
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const exactBudget = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    let now = NOW;
    const h = await harness({ budgetUsd: exactBudget, now: () => now });
    const hash = capabilityHash(h.session.capability);
    expect((await h.ledger.findSessionByCapabilityHash(hash))?.budgetExhaustedAt ?? null).toBeNull();
    await expect(execute(h, "first")).rejects.toMatchObject({ code: "wardby_budget_exhausted" });
    now = new Date(NOW.getTime() + 1_000);
    await expect(execute(h, "second")).rejects.toMatchObject({ code: "wardby_budget_exhausted" });
    expect((await h.ledger.findSessionByCapabilityHash(hash))?.budgetExhaustedAt).toEqual(NOW);
  });

  it("tells the executor whether a session was refused for budget", async () => {
    const raw = requestBody();
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const h = await harness({ budgetUsd: estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE) });
    expect(await h.proxy.budgetExhausted(h.session.id)).toBe(false);
    await expect(execute(h, "first")).rejects.toMatchObject({ code: "wardby_budget_exhausted" });
    expect(await h.proxy.budgetExhausted(h.session.id)).toBe(true);
    expect(await h.proxy.budgetExhausted("no-such-session")).toBe(false);
  });

  it("serializes concurrent reservations so only one request can consume the remaining budget", async () => {
    const raw = requestBody();
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const one = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    let releaseFetch!: () => void;
    const wait = new Promise<void>((resolve) => (releaseFetch = resolve));
    const h = await harness({
      budgetUsd: one * 2,
      fetch: async () => {
        await wait;
        return Response.json({ usage: USAGE });
      },
    });
    const first = execute(h, "race-a");
    const second = execute(h, "race-b");
    await expect(second).rejects.toMatchObject({ status: 429 });
    releaseFetch();
    await first;
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send a completed request upstream twice on retry", async () => {
    const h = await harness();
    await execute(h, "same-key");
    await expect(execute(h, "same-key")).rejects.toMatchObject({ status: 409, code: "duplicate_completed" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 503])("releases a known non-billed HTTP %i response reservation", async (status) => {
    let calls = 0;
    const h = await harness({
      fetch: async () => {
        calls += 1;
        return calls === 1 ? Response.json({ secret: "PROVIDER_DETAIL" }, { status }) : Response.json({ usage: USAGE });
      },
    });
    const first = await execute(h, `failure-${status}`);
    expect(first.status).toBe(status);
    expect(first.text()).not.toContain("PROVIDER_DETAIL");
    await execute(h, `recovery-${status}`);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("continues draining and accounts for a stream after the client disconnects", async () => {
    const h = await harness({
      fetch: async () => new Response(completedSse(), { headers: { "content-type": "text/event-stream" } }),
    });
    await execute(h, "disconnect", new TestSink(0), requestBody(true));
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("completed");
    expect(h.events.some((event) => event.type === "response.completed")).toBe(true);
  });

  it("settles a truncated stream at an estimate and keeps it uncertain", async () => {
    const raw = requestBody(true);
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const one = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    let call = 0;
    const h = await harness({
      budgetUsd: one * 2,
      fetch: async () => {
        call += 1;
        if (call === 1)
          return new Response(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',
          );
        return new Response(completedSse(USAGE), { headers: { "content-type": "text/event-stream" } });
      },
    });
    await expect(execute(h, "truncated", new TestSink(), raw)).rejects.toMatchObject({ status: 502 });
    const request = (await h.ledger.getRequest(reservedRequestId(h.events)))!;
    expect(request.status).toBe("uncertain");
    expect(request.costEstimated).toBe(true);
    await expect(execute(h, "after-truncated", new TestSink(), raw)).resolves.toBeDefined();
  });

  it("uses the reservation's pricing snapshot if registry rates change in flight", async () => {
    let current = { ...PRICE };
    const h = await harness({
      price: () => current,
      fetch: async () => {
        current = { ...PRICE, inputPerMTok: 10_000, outputPerMTok: 10_000 };
        return Response.json({ usage: USAGE });
      },
    });
    await execute(h, "price-snapshot");
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request?.pricing.inputPerMTok).toBe(PRICE.inputPerMTok);
    expect(request?.actualCostUsd).toBe((8 * 1 + 2 * 0.1 + 3 * 2 + 5 * 4) / 1_000_000);
  });

  it("preserves duplicate and uncertain state across a proxy restart", async () => {
    const ledger = new MemoryProxyLedger();
    const first = await harness({ ledger });
    await execute(first, "durable");
    const secondFetch = vi.fn(async () => Response.json({ usage: USAGE }));
    const restarted = new CodingProxy({
      ledger,
      credentials: { resolve: async () => "secret" },
      fetch: secondFetch,
      now: () => NOW,
      pricing: () => PRICE,
    });
    await expect(
      restarted.execute(
        {
          bearer: first.session.capability,
          protocol: "openai-responses",
          rawBody: requestBody(),
          requestKey: "durable",
        },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("rejects expired and cancelled sessions before calling upstream", async () => {
    let current = NOW;
    const h = await harness({ now: () => current });
    current = new Date(NOW.getTime() + 120_000);
    await expect(execute(h, "expired")).rejects.toMatchObject({ status: 403, code: "session_expired" });
    current = NOW;
    await h.proxy.cancelSession(h.session.id);
    await expect(execute(h, "cancelled")).rejects.toMatchObject({ status: 403, code: "session_cancelled" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight provider request when its session is cancelled", async () => {
    const h = await harness({
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });
    const pending = execute(h, "cancel-in-flight");
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    await h.proxy.cancelSession(h.session.id);
    await expect(pending).rejects.toMatchObject({ status: 502, code: "upstream_aborted" });
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("uncertain");
  });

  it("forwards an upstream failure without usage, holds the reservation, and records the upstream's error code", async () => {
    const frame =
      'event: response.failed\ndata: {"type":"response.failed","response":{"usage":null,"error":{"code":"insufficient_quota","message":"private text"}}}';
    const h = await harness({
      fetch: async () => new Response(`${frame}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    const sink = await execute(h, "failed-terminal", new TestSink(), requestBody(true));
    // The client sees the upstream's own failure event and a cleanly ended stream, not a cut connection.
    expect(sink.destroyed).toBe(false);
    expect(sink.ended).toBe(true);
    expect(sink.text()).toContain("response.failed");
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("uncertain");
    const uncertain = h.events.find((event) => event.type === "request.uncertain");
    expect(uncertain).toMatchObject({ reason: "upstream_failed:insufficient_quota", contentType: "text/event-stream" });
    expect(JSON.stringify(h.events)).not.toContain("private text");
  });

  it("audits an upstream failure followed by a malformed frame as uncertain exactly once", async () => {
    const failed =
      'event: response.failed\ndata: {"type":"response.failed","response":{"usage":null,"error":{"code":"server_error"}}}';
    const malformed = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":null}}';
    const h = await harness({
      fetch: async () =>
        new Response(`${failed}\n\n${malformed}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(execute(h, "failed-then-malformed", new TestSink(), requestBody(true))).rejects.toBeInstanceOf(
      CodingProxyError,
    );
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("uncertain");
    const uncertain = h.events.filter((event) => event.type === "request.uncertain");
    expect(uncertain).toEqual([expect.objectContaining({ reason: "upstream_failed:server_error" })]);
  });

  it("records the first relayed upstream failure's code on the session, for the executor", async () => {
    const failing = (code: string) =>
      new Response(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { code, message: "private text" } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    const codes = ["project_spend_limit_exceeded", "rate_limit_exceeded"];
    const h = await harness({ fetch: async () => failing(codes.shift()!) });
    const hash = capabilityHash(h.session.capability);
    expect(await h.proxy.upstreamFailure(h.session.id)).toBeNull();
    await execute(h, "first-failure", new TestSink(), requestBody(true));
    await execute(h, "second-failure", new TestSink(), requestBody(true));
    expect(await h.proxy.upstreamFailure(h.session.id)).toBe("project_spend_limit_exceeded");
    expect((await h.ledger.findSessionByCapabilityHash(hash))?.upstreamFailure).toBe("project_spend_limit_exceeded");
    expect(await h.proxy.upstreamFailure("no-such-session")).toBeNull();
  });

  it("records a rejected upstream's error code, or its status when the body names none", async () => {
    const quota = await harness({
      fetch: async () =>
        Response.json({ error: { code: "insufficient_quota", message: "private text" } }, { status: 429 }),
    });
    const sink = await execute(quota, "rejected-quota");
    expect(sink.status).toBe(429);
    expect(sink.text()).not.toContain("private text");
    expect(await quota.proxy.upstreamFailure(quota.session.id)).toBe("insufficient_quota");

    const outage = await harness({ fetch: async () => new Response("<html>bad gateway</html>", { status: 503 }) });
    await execute(outage, "rejected-outage");
    expect(await outage.proxy.upstreamFailure(outage.session.id)).toBe("http_503");

    const unsafe = await harness({
      fetch: async () => Response.json({ error: { code: "has spaces in it", type: "no good!" } }, { status: 400 }),
    });
    await execute(unsafe, "rejected-unsafe");
    expect(await unsafe.proxy.upstreamFailure(unsafe.session.id)).toBe("http_400");
  });

  it("still rejects a terminal event whose usage is malformed, recording why", async () => {
    const h = await harness({
      fetch: async () =>
        new Response('event: response.completed\ndata: {"type":"response.completed","response":{"usage":null}}\n\n'),
    });
    await expect(execute(h, "malformed-terminal", new TestSink(), requestBody(true))).rejects.toBeInstanceOf(
      CodingProxyError,
    );
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("uncertain");
    expect(h.events.find((event) => event.type === "request.uncertain")).toMatchObject({
      reason: "terminal_usage_missing",
    });
  });

  it("records why a stream was cut, with the upstream's content type and encoding", async () => {
    const h = await harness({
      fetch: async () =>
        new Response('event: response.output_text.delta\ndata: {"delta":"x"}\n\n', {
          headers: { "content-type": "text/event-stream", "content-encoding": "zstd" },
        }),
    });
    await expect(execute(h, "cut", new TestSink(), requestBody(true))).rejects.toMatchObject({ status: 502 });
    expect(h.events.find((event) => event.type === "request.uncertain")).toMatchObject({
      reason: "terminal_usage_missing",
      contentType: "text/event-stream",
      contentEncoding: "zstd",
    });
  });

  it("asks the upstream for an uncompressed response", async () => {
    const h = await harness();
    await execute(h, "identity");
    const init = h.fetch.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("accept-encoding")).toBe("identity");
  });
});

describe("model terms from the session", () => {
  const sonnet = shippedCatalog().require("claude-sonnet-5");
  const haiku = shippedCatalog().require("claude-haiku-4-5");
  const anthropicResponse = async () => {
    const response = JSON.parse(await fixture("anthropic-message-response.json"));
    return async () => Response.json(response);
  };
  const anthropicBody = async (model: string, name = "anthropic-sdk-request.json") => {
    const body = JSON.parse(await fixture(name));
    body.stream = false;
    body.model = model;
    return JSON.stringify(body);
  };

  it("prices from the session's stored entry and tags requests with its version", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      allowedModels: ["claude-sonnet-5"],
      fetch: await anthropicResponse(),
      terms: { version: "2026-10-04T00:00:00.000Z", entry: { ...entryOf(sonnet), outputPerMTok: 99 } },
      price: () => {
        throw new Error("the fallback must not be consulted when the session has terms");
      },
    });
    await execute(h, "terms-priced", new TestSink(), await anthropicBody("claude-sonnet-5"));
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request?.pricing).toEqual({
      version: "2026-10-04T00:00:00.000Z",
      encoding: sonnet.encoding,
      inputPerMTok: sonnet.inputPerMTok,
      outputPerMTok: 99,
      cachedInputPerMTok: sonnet.cachedInputPerMTok,
      cacheWritePerMTok: sonnet.cacheWritePerMTok,
    });
  });

  it("takes manual thinking from the stored entry, not a hardcoded model list", async () => {
    // An added model with manual thinking: before the catalog only claude-haiku-4-5 could send budget_tokens.
    const added = { ...entryOf(haiku), modelId: "claude-added-manual" };
    const h = await harness({
      protocol: "anthropic-messages",
      allowedModels: ["claude-added-manual"],
      fetch: await anthropicResponse(),
      terms: { version: "v", entry: added },
    });
    await execute(
      h,
      "terms-manual",
      new TestSink(),
      await anthropicBody("claude-added-manual", "anthropic-sdk-request-haiku-4-5.json"),
    );
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(forwarded.thinking).toEqual({ type: "enabled", budget_tokens: 4095 });
  });

  it("refuses adaptive thinking for a manual-thinking entry", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      allowedModels: ["claude-haiku-4-5"],
      terms: { version: "v", entry: entryOf(haiku) },
    });
    await expect(
      execute(h, "terms-adaptive", new TestSink(), await anthropicBody("claude-haiku-4-5")),
    ).rejects.toMatchObject({ status: 400, code: "unsupported_anthropic_feature" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("refuses manual thinking for an adaptive entry, even on a model id the shipped catalog calls manual", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      allowedModels: ["claude-haiku-4-5"],
      terms: { version: "v", entry: { ...entryOf(haiku), thinkingMode: "adaptive" } },
    });
    await expect(
      execute(
        h,
        "terms-adaptive-only",
        new TestSink(),
        await anthropicBody("claude-haiku-4-5", "anthropic-sdk-request-haiku-4-5.json"),
      ),
    ).rejects.toMatchObject({ status: 400, code: "unsupported_anthropic_feature" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  describe("effort levels come from the session's catalog entry", () => {
    const opus = {
      ...entryOf(sonnet),
      modelId: "claude-opus-5-5",
      efforts: ["low", "medium", "high", "xhigh", "max"] as const,
    };
    const withEffort = async (model: string, effort: unknown) => {
      const body = JSON.parse(await anthropicBody(model));
      body.output_config = { effort };
      return JSON.stringify(body);
    };
    const run = (h: Awaited<ReturnType<typeof harness>>, key: string, body: string, beta: string) =>
      h.proxy.execute(
        {
          bearer: h.session.capability,
          protocol: "anthropic-messages",
          rawBody: body,
          requestKey: key,
          anthropicBeta: beta,
        },
        new TestSink(),
      );

    it("forwards the effort level a model defaults to when its entry accepts it (Opus 5.5 sends medium)", async () => {
      const h = await harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-opus-5-5"],
        terms: { version: "v", entry: { ...opus, efforts: [...opus.efforts] } },
        fetch: await anthropicResponse(),
      });
      const beta = [...CLAUDE_CODE_ANTHROPIC_BETAS, "per-turn-control-2026-07-01"].join(",");
      await run(h, "opus-medium", await withEffort("claude-opus-5-5", "medium"), beta);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      const init = h.fetch.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(init.body as string).output_config).toEqual({ effort: "medium" });
      expect(new Headers(init.headers).get("anthropic-beta")?.split(",")).toContain("per-turn-control-2026-07-01");
    });

    it("forwards the request the pinned Agent SDK sends for Opus 5.5, with its real beta header", async () => {
      const h = await harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-opus-5-5"],
        terms: { version: "v", entry: { ...opus, efforts: [...opus.efforts] } },
        fetch: await anthropicResponse(),
      });
      const body = JSON.parse(await fixture("anthropic-sdk-request-opus-5-5.json"));
      body.stream = false;
      // Exactly what Claude Code 2.1.286 sent for this model (compatibility.test.mjs pins the same set).
      const beta =
        "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,effort-2025-11-24";
      await run(h, "opus-captured", JSON.stringify(body), beta);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(forwarded.model).toBe("claude-opus-5-5");
      expect(forwarded.output_config).toEqual({ effort: "medium" });
      expect(forwarded.thinking).toEqual({ type: "adaptive" });
    });

    it.each(["low", "xhigh", "max"])("forwards %s when the entry lists it", async (effort) => {
      const h = await harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-opus-5-5"],
        terms: { version: "v", entry: { ...opus, efforts: [...opus.efforts] } },
        fetch: await anthropicResponse(),
      });
      await run(
        h,
        `opus-${effort}`,
        await withEffort("claude-opus-5-5", effort),
        CLAUDE_CODE_ANTHROPIC_BETAS.join(","),
      );
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["a level the entry does not list", ["high"], "medium"],
      ["any level when the entry lists none", [], "high"],
      ["an unknown level", ["low", "medium", "high", "xhigh", "max"], "ultra"],
      ["a non-string level", ["high"], 3],
    ])("refuses %s before calling upstream", async (_label, efforts, effort) => {
      const h = await harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-opus-5-5"],
        terms: {
          version: "v",
          entry: { ...opus, efforts: efforts as LlmEffort[] },
        },
        fetch: await anthropicResponse(),
      });
      await expect(
        run(
          h,
          `opus-refused-${String(effort)}`,
          await withEffort("claude-opus-5-5", effort),
          CLAUDE_CODE_ANTHROPIC_BETAS.join(","),
        ),
      ).rejects.toMatchObject({ status: 400, code: "unsupported_anthropic_feature" });
      expect(h.fetch).not.toHaveBeenCalled();
    });

    describe("per-turn effort (an effort-only system message)", () => {
      const CAPTURED_BETA = [...CLAUDE_CODE_ANTHROPIC_BETAS, "per-turn-control-2026-07-01"].join(",");
      const capturedWith = async (edit: (body: { messages: Array<Record<string, unknown>> }) => void) => {
        const body = JSON.parse(await fixture("anthropic-sdk-request-opus-5-5.json"));
        body.stream = false;
        edit(body);
        return JSON.stringify(body);
      };
      const opusHarness = async (efforts: LlmEffort[] = [...opus.efforts]) =>
        harness({
          protocol: "anthropic-messages",
          allowedModels: ["claude-opus-5-5"],
          terms: { version: "v", entry: { ...opus, efforts } },
          fetch: await anthropicResponse(),
        });
      const effortMessage = (body: { messages: Array<Record<string, unknown>> }) =>
        body.messages.find((m) => m.role === "system" && m.output_config)!;

      it.each([
        [
          "without the per-turn-control beta",
          CLAUDE_CODE_ANTHROPIC_BETAS.join(","),
          () => {},
          "anthropic_beta_required",
        ],
        [
          "with text alongside the effort",
          CAPTURED_BETA,
          (b: { messages: Array<Record<string, unknown>> }) =>
            (effortMessage(b).content = [{ type: "text", text: "x" }]),
          "unsupported_anthropic_feature",
        ],
        [
          "at a level the entry does not list",
          CAPTURED_BETA,
          (b: { messages: Array<Record<string, unknown>> }) => (effortMessage(b).output_config = { effort: "ultra" }),
          "unsupported_anthropic_feature",
        ],
        [
          "with another output_config field",
          CAPTURED_BETA,
          (b: { messages: Array<Record<string, unknown>> }) =>
            (effortMessage(b).output_config = { effort: "medium", format: { type: "json_schema" } }),
          "unsupported_anthropic_feature",
        ],
        [
          "on a user message",
          CAPTURED_BETA,
          (b: { messages: Array<Record<string, unknown>> }) => (b.messages[0].output_config = { effort: "medium" }),
          "unsupported_anthropic_feature",
        ],
      ])("refuses it %s before calling upstream", async (_label, beta, edit, code) => {
        const h = await opusHarness();
        await expect(run(h, `per-turn-${_label}`, await capturedWith(edit), beta)).rejects.toMatchObject({
          status: 400,
          code,
        });
        expect(h.fetch).not.toHaveBeenCalled();
      });

      it("refuses it without the mid-conversation-system beta", async () => {
        const h = await opusHarness();
        const beta = [...CLAUDE_CODE_ANTHROPIC_BETAS, "per-turn-control-2026-07-01"]
          .filter((b) => b !== "mid-conversation-system-2026-04-07")
          .join(",");
        await expect(run(h, "per-turn-no-midconv", await capturedWith(() => {}), beta)).rejects.toMatchObject({
          status: 400,
          code: "anthropic_beta_required",
        });
        expect(h.fetch).not.toHaveBeenCalled();
      });

      it("refuses it for a manual-thinking model", async () => {
        const h = await harness({
          protocol: "anthropic-messages",
          allowedModels: ["claude-opus-5-5"],
          terms: { version: "v", entry: { ...opus, efforts: [...opus.efforts], thinkingMode: "manual" } },
          fetch: await anthropicResponse(),
        });
        const body = await capturedWith((b) => {
          delete (b as Record<string, unknown>).output_config;
          delete (b as Record<string, unknown>).thinking;
        });
        await expect(run(h, "per-turn-manual", body, CAPTURED_BETA)).rejects.toMatchObject({
          status: 400,
          code: "unsupported_anthropic_feature",
        });
        expect(h.fetch).not.toHaveBeenCalled();
      });
    });

    it("still refuses a beta header outside the reviewed set", async () => {
      const h = await harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-opus-5-5"],
        terms: { version: "v", entry: { ...opus, efforts: [...opus.efforts] } },
        fetch: await anthropicResponse(),
      });
      const beta = [...CLAUDE_CODE_ANTHROPIC_BETAS, "afk-mode-2026-01-31"].join(",");
      await expect(
        run(h, "opus-unknown-beta", await withEffort("claude-opus-5-5", "medium"), beta),
      ).rejects.toMatchObject({
        status: 400,
        code: "invalid_anthropic_beta",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    });
  });

  it("refuses a session whose terms are for a different model", async () => {
    await expect(
      harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-5"],
        terms: { version: "v", entry: entryOf(haiku) },
      }),
    ).rejects.toThrow(/invalid_proxy_model_terms/);
  });

  it("refuses terms whose provider does not serve the session's protocol", async () => {
    await expect(
      harness({
        protocol: "openai-responses",
        allowedModels: ["claude-sonnet-5"],
        terms: { version: "v", entry: entryOf(sonnet) },
      }),
    ).rejects.toThrow(/invalid_proxy_model_terms/);
  });

  it("refuses terms the ledger cannot read back (the in-memory ledger validates like the database one)", async () => {
    await expect(
      harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-5"],
        terms: { version: "v", entry: { ...entryOf(sonnet), cachedInputPerMTok: -1 } },
      }),
    ).rejects.toThrow(/invalid_proxy_session_terms/);
    await expect(
      harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-5"],
        terms: { version: "", entry: entryOf(sonnet) },
      }),
    ).rejects.toThrow(/invalid_proxy_session_terms/);
  });

  it("refuses terms on a session that allows more than one model", async () => {
    await expect(
      harness({
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-5", "claude-haiku-4-5"],
        terms: { version: "v", entry: entryOf(sonnet) },
      }),
    ).rejects.toThrow(/invalid_proxy_model_terms/);
  });

  it("falls back to the shipped catalog for a session with no terms (created before the catalog)", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      allowedModels: ["claude-sonnet-5"],
      fetch: await anthropicResponse(),
      price: undefined,
    });
    await execute(h, "no-terms", new TestSink(), await anthropicBody("claude-sonnet-5"));
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request?.pricing).toMatchObject({ version: "shipped:2026-10-08", outputPerMTok: sonnet.outputPerMTok });
  });

  it("refuses a no-terms session for a model the shipped catalog lacks or files under the other protocol", async () => {
    await expect(
      harness({ protocol: "anthropic-messages", allowedModels: ["claude-not-shipped"], price: undefined }),
    ).rejects.toThrow();
    await expect(
      harness({ protocol: "openai-responses", allowedModels: ["claude-sonnet-5"], price: undefined }),
    ).rejects.toThrow(/unknown_model/);
  });
});

describe("CodingProxy Anthropic Messages", () => {
  describe("Claude Haiku 4.5 (manual extended thinking, no effort)", () => {
    const haiku = () => harness({ protocol: "anthropic-messages", allowedModels: ["claude-haiku-4-5"] });
    const haikuBody = async (edit: (body: Record<string, unknown>) => void = () => {}) => {
      const body = JSON.parse(await fixture("anthropic-sdk-request-haiku-4-5.json"));
      body.stream = false;
      edit(body);
      return JSON.stringify(body);
    };

    it("forwards the request the pinned Agent SDK sends for Haiku 4.5", async () => {
      const h = await haiku();
      await execute(h, "haiku-captured", new TestSink(), await haikuBody());
      expect(h.fetch).toHaveBeenCalledTimes(1);
      const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(forwarded.model).toBe("claude-haiku-4-5");
      expect(forwarded.thinking).toEqual({ type: "enabled", budget_tokens: 4095 });
      expect(forwarded).not.toHaveProperty("output_config");
    });

    it("forwards the worker's default 32000 max_tokens with a 31999-token thinking budget", async () => {
      const h = await haiku();
      const body = await haikuBody((b) => {
        b.max_tokens = 32_000;
        b.thinking = { type: "enabled", budget_tokens: 31_999 };
      });
      await execute(h, "haiku-32k", new TestSink(), body);
      expect(h.fetch).toHaveBeenCalledTimes(1);
      const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(forwarded.max_tokens).toBe(32_000);
      expect(forwarded.thinking).toEqual({ type: "enabled", budget_tokens: 31_999 });
    });

    it.each([
      ["adaptive thinking", (b: Record<string, unknown>) => (b.thinking = { type: "adaptive" })],
      ["an effort level", (b: Record<string, unknown>) => (b.output_config = { effort: "high" })],
      [
        "a budget at max_tokens",
        (b: Record<string, unknown>) => (b.thinking = { type: "enabled", budget_tokens: 4096 }),
      ],
      ["a budget under 1024", (b: Record<string, unknown>) => (b.thinking = { type: "enabled", budget_tokens: 1023 })],
      [
        "a fractional budget",
        (b: Record<string, unknown>) => (b.thinking = { type: "enabled", budget_tokens: 2048.5 }),
      ],
      [
        "an unknown thinking field",
        (b: Record<string, unknown>) => (b.thinking = { type: "enabled", budget_tokens: 2048, display: "summarized" }),
      ],
    ])("refuses Haiku 4.5 with %s before calling upstream", async (_label, edit) => {
      const h = await haiku();
      await expect(execute(h, "haiku-refused", new TestSink(), await haikuBody(edit))).rejects.toMatchObject({
        status: 400,
        code: "unsupported_anthropic_feature",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it("forwards an adaptive-thinking request at the worker's default 32000 max_tokens", async () => {
      const h = await harness({ protocol: "anthropic-messages" });
      const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
      body.stream = false;
      body.max_tokens = 32_000;
      await execute(h, "sonnet-32k", new TestSink(), JSON.stringify(body));
      expect(h.fetch).toHaveBeenCalledTimes(1);
      const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(forwarded.max_tokens).toBe(32_000);
    });

    it("still refuses manual thinking for a model that only takes adaptive thinking", async () => {
      const h = await harness({ protocol: "anthropic-messages" });
      const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
      body.stream = false;
      body.thinking = { type: "enabled", budget_tokens: 2048 };
      await expect(execute(h, "sonnet-manual", new TestSink(), JSON.stringify(body))).rejects.toMatchObject({
        status: 400,
        code: "unsupported_anthropic_feature",
      });
      expect(h.fetch).not.toHaveBeenCalled();
    });
  });

  it("forwards only the reviewed SDK envelope and strips client metadata", async () => {
    const response = JSON.parse(await fixture("anthropic-message-response.json"));
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => Response.json(response),
    });
    const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
    body.stream = false;

    await execute(h, "anthropic-json", new TestSink(), JSON.stringify(body));

    expect(h.fetch.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages?beta=true");
    const init = h.fetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("UPSTREAM_SECRET");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")?.split(",")).toEqual(CLAUDE_CODE_ANTHROPIC_BETAS);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("idempotency-key")).toBeNull();
    const forwarded = JSON.parse(init.body as string);
    expect(forwarded).not.toHaveProperty("metadata");
    expect(forwarded.messages).toContainEqual(expect.objectContaining({ role: "system" }));
    expect(forwarded.system).toHaveLength(2);
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request).toMatchObject({
      status: "completed",
      usage: {
        inputTokens: 125,
        outputTokens: 2,
        cachedInputTokens: 25,
        cacheWriteTokens: 10,
        reasoningTokens: 0,
      },
    });
  });

  it("requires the pinned beta contract for beta-gated SDK fields before credential resolution", async () => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ protocol: "anthropic-messages", credentials: { resolve } });

    await expect(
      h.proxy.execute(
        {
          bearer: h.session.capability,
          protocol: h.session.protocol,
          rawBody: await fixture("anthropic-sdk-request.json"),
          requestKey: "missing-beta",
        },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 400, code: "anthropic_beta_required" });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("preserves Claude Code's bounded second-turn system string", async () => {
    const response = JSON.parse(await fixture("anthropic-message-response.json"));
    const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
    body.stream = false;
    body.messages[1].content = "<system-reminder>Today's date is 2026-09-12.</system-reminder>";
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => Response.json(response),
    });

    await execute(h, "anthropic-system-string", new TestSink(), JSON.stringify(body));

    const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(forwarded.messages[1]).toEqual(body.messages[1]);
  });

  it.each([
    ["unknown", "claude-code-20250219,unreviewed-beta-2099-01-01"],
    ["duplicate", "claude-code-20250219,claude-code-20250219"],
    ["empty", "claude-code-20250219,"],
  ])("rejects an %s beta header before credential resolution", async (_name, anthropicBeta) => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ protocol: "anthropic-messages", credentials: { resolve } });
    const body = JSON.stringify({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 2,
      stream: false,
    });

    await expect(
      h.proxy.execute(
        {
          bearer: h.session.capability,
          protocol: h.session.protocol,
          rawBody: body,
          requestKey: `invalid-beta-${_name}`,
          anthropicBeta,
        },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 400, code: "invalid_anthropic_beta" });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("accounts for split authoritative usage in a complete message stream", async () => {
    const stream = await fixture("anthropic-message-stream.txt");
    const body = await fixture("anthropic-sdk-request.json");
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });

    await execute(h, "anthropic-stream", new TestSink(), body);

    expect(await h.ledger.getRequest(reservedRequestId(h.events))).toMatchObject({
      status: "completed",
      usage: { inputTokens: 125, outputTokens: 2, cachedInputTokens: 25, cacheWriteTokens: 10 },
    });
  });

  it("forwards only Wardby's bounded local command tool and matching tool-result blocks", async () => {
    const response = JSON.parse(await fixture("anthropic-message-response.json"));
    const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
    body.stream = false;
    body.tools = [
      {
        name: "StructuredOutput",
        description: "Return the final structured result.",
        input_schema: {
          type: "object",
          properties: { outcome: { type: "string" } },
          required: ["outcome"],
          additionalProperties: false,
        },
      },
      {
        name: "mcp__wardby_tools__run_command",
        description: "Run one bounded shell command in the isolated repository workspace.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", minLength: 1, maxLength: 8_192 },
            timeout_ms: { type: "integer", minimum: 1_000, maximum: 60_000 },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    ];
    body.messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_wardby_command",
            name: "mcp__wardby_tools__run_command",
            input: { command: "git status --short", timeout_ms: 1_000 },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_wardby_command",
            content: [{ type: "text", text: "exit_code=0\n" }],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    );
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => Response.json(response),
    });

    await execute(h, "wardby-command-tool", new TestSink(), JSON.stringify(body));

    const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(forwarded.tools).toHaveLength(2);
    expect(forwarded.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_wardby_command",
      cache_control: { type: "ephemeral" },
    });
  });

  describe("run_command timeouts", () => {
    const replaying = async (timeoutMs: number) => {
      const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
      body.stream = false;
      body.messages.push(
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_wardby_timeout",
              name: "mcp__wardby_tools__run_command",
              input: { command: "python -m pytest -q", timeout_ms: timeoutMs },
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_wardby_timeout", content: "exit_code=0\n", is_error: false },
          ],
        },
      );
      return JSON.stringify(body);
    };

    it("accepts the longest timeout the tool runner offers the model", async () => {
      expect(MAX_COMMAND_TIMEOUT_MS).toBe(TOOL_RUNNER_MAX_TIMEOUT_MS);
      const h = await harness({
        protocol: "anthropic-messages",
        fetch: async () => Response.json(JSON.parse(await fixture("anthropic-message-response.json"))),
      });
      await execute(h, "command-max-timeout", new TestSink(), await replaying(TOOL_RUNNER_MAX_TIMEOUT_MS));
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it("refuses a timeout past the tool runner's own limit", async () => {
      const h = await harness({ protocol: "anthropic-messages" });
      await expect(
        execute(h, "command-over-timeout", new TestSink(), await replaying(TOOL_RUNNER_MAX_TIMEOUT_MS + 1)),
      ).rejects.toMatchObject({ status: 400, code: "unsupported_anthropic_feature" });
      expect(h.fetch).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["non-empty tools", { tools: [{ name: "shell" }] }, "tools_not_allowed"],
    ["server-side MCP", { mcp_servers: [] }, "unsupported_anthropic_feature"],
    [
      "oversized command input",
      {
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_oversized",
                name: "mcp__wardby_tools__run_command",
                input: { command: "x".repeat(16 * 1024 + 1) },
              },
            ],
          },
        ],
      },
      "unsupported_anthropic_feature",
    ],
    [
      "unsafe cache policy",
      { system: [{ type: "text", text: "x", cache_control: { type: "forever" } }] },
      "unsupported_anthropic_feature",
    ],
    ["unreviewed effort", { output_config: { effort: "ultra" } }, "unsupported_anthropic_feature"],
  ])("rejects %s before credential resolution", async (_name, change, code) => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ protocol: "anthropic-messages", credentials: { resolve } });
    const body = { ...JSON.parse(await fixture("anthropic-sdk-request.json")), ...change };

    await expect(execute(h, `reject-${_name}`, new TestSink(), JSON.stringify(body))).rejects.toMatchObject({ code });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["anthropic-messages", "openai-responses"],
    ["openai-responses", "anthropic-messages"],
  ] as const)("rejects a %s capability on the %s route", async (sessionProtocol, routeProtocol) => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ protocol: sessionProtocol, credentials: { resolve } });

    await expect(
      h.proxy.execute(
        { bearer: h.session.capability, protocol: routeProtocol, rawBody: "not-even-json", requestKey: "confused" },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 403, code: "protocol_mismatch" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("holds the reservation when a successful response has no authoritative usage", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => Response.json({ type: "message", content: [] }),
    });
    const body = JSON.parse(await fixture("anthropic-sdk-request.json"));
    body.stream = false;

    await expect(execute(h, "anthropic-no-usage", new TestSink(), JSON.stringify(body))).rejects.toMatchObject({
      status: 502,
    });
    expect(await h.ledger.getRequest(reservedRequestId(h.events))).toMatchObject({ status: "uncertain" });
  });

  it("records a rejected Anthropic request's error type for the executor", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () =>
        Response.json({ type: "error", error: { type: "rate_limit_error", message: "private text" } }, { status: 429 }),
    });
    const sink = await execute(h, "anthropic-429", new TestSink(), await fixture("anthropic-sdk-request.json"));
    expect(sink.status).toBe(429);
    expect(sink.text()).not.toContain("private text");
    expect(await h.proxy.upstreamFailure(h.session.id)).toBe("rate_limit_error");
  });

  it("records an Anthropic stream's error event for the executor", async () => {
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () =>
        new Response(
          `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "private text" } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    await execute(h, "anthropic-overloaded", new TestSink(), await fixture("anthropic-sdk-request.json"));
    expect(await h.proxy.upstreamFailure(h.session.id)).toBe("overloaded_error");
  });
});

interface CodexFixture {
  scenario: string;
  body: Record<string, unknown>;
}

// Recorded from the Codex version the worker image pins (npm run codex:rerecord).
const codexFixtures = async (): Promise<CodexFixture[]> => {
  const worker = JSON.parse(await readFile(new URL("../../coding-worker/package.json", import.meta.url), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const pinned = worker.dependencies["@openai/codex-sdk"];
  return JSON.parse(await fixture(`codex-${pinned}-responses-requests.json`)) as CodexFixture[];
};

const INLINE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function codexBody(change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "test-model",
    input: [
      { type: "message", id: "msg_1", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { type: "message", id: "msg_2", role: "user", content: [{ type: "input_text", text: "task" }] },
    ],
    tools: [
      {
        type: "function",
        name: "exec_command",
        description: "Runs a command",
        strict: false,
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", context: "all_turns" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "01a0df85-39f7-7e02-9eb9-8bf291a02304",
    text: { verbosity: "low" },
    client_metadata: { session_id: "01a0df85-39f7-7e02-9eb9-8bf291a02304" },
    ...change,
  };
}

function withInput(...items: unknown[]): Record<string, unknown> {
  const body = codexBody();
  return { ...body, input: [...(body.input as unknown[]), ...items] };
}

describe("CodingProxy OpenAI Responses allowlist", () => {
  it("forwards every recorded request of the pinned Codex CLI unchanged apart from the proxy's own fields", async () => {
    const fixtures = await codexFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const [index, { scenario, body }] of fixtures.entries()) {
      const h = await harness({ fetch: async () => new Response(completedSse(), { status: 200 }) });
      const request = { ...body, model: "test-model" };

      await execute(h, `codex-fixture-${index}`, new TestSink(), JSON.stringify(request));

      expect(h.fetch, scenario).toHaveBeenCalledTimes(1);
      const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
      expect(forwarded, scenario).toEqual({
        ...request,
        max_output_tokens: PROXY_DEFAULT_MAX_OUTPUT_TOKENS,
        store: false,
        background: false,
      });
    }
  });

  it("covers both the responses-lite and the classic tool layouts and every Codex item type", async () => {
    const fixtures = await codexFixtures();
    const itemTypes = new Set<string>();
    const toolTypes = new Set<string>();
    for (const { body } of fixtures) {
      for (const item of body.input as Record<string, unknown>[]) {
        itemTypes.add(String(item.type));
        const tools = item.type === "additional_tools" ? (item.tools as Record<string, unknown>[]) : [];
        for (const tool of [...tools, ...((body.tools as Record<string, unknown>[] | undefined) ?? [])]) {
          toolTypes.add(String(tool.type));
          for (const nested of (tool.tools as Record<string, unknown>[] | undefined) ?? []) {
            toolTypes.add(String(nested.type));
          }
        }
      }
    }
    expect([...itemTypes].sort()).toEqual([
      "additional_tools",
      "agent_message",
      "custom_tool_call",
      "custom_tool_call_output",
      "function_call",
      "function_call_output",
      "message",
      "reasoning",
    ]);
    expect([...toolTypes].sort()).toEqual(["custom", "function", "namespace"]);
  });

  it("forwards a minimal request, an inline data: image in a tool output, and service_tier default", async () => {
    for (const [key, body] of Object.entries({
      minimal: { model: "test-model", input: "hello", stream: true },
      image: withInput(
        { type: "function_call", call_id: "call_1", name: "view_image", arguments: '{"path":"a.png"}' },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: INLINE_PNG, detail: "high" }],
        },
      ),
      tier: codexBody({ service_tier: "default" }),
    })) {
      const h = await harness({ fetch: async () => new Response(completedSse(), { status: 200 }) });
      await execute(h, `allowed-${key}`, new TestSink(), JSON.stringify(body));
      expect(h.fetch, key).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["stored prompt", { prompt: { id: "pmpt_attacker" } }, "openai_request_key_not_allowed:prompt"],
    ["previous response", { previous_response_id: "resp_1" }, "openai_request_key_not_allowed:previous_response_id"],
    ["conversation", { conversation: "conv_1" }, "openai_request_key_not_allowed:conversation"],
    ["request metadata", { metadata: { a: "b" } }, "openai_request_key_not_allowed:metadata"],
    ["unknown key", { safety_identifier: "x" }, "openai_request_key_not_allowed:safety_identifier"],
    ["odd key name", { "we!rd key": 1 }, "openai_request_key_not_allowed:other"],
    ["priority tier", { service_tier: "priority" }, "service_tier_not_allowed"],
    ["flex tier", { service_tier: "flex" }, "service_tier_not_allowed"],
    ["auto tier (defers to the project's tier)", { service_tier: "auto" }, "service_tier_not_allowed"],
    ["background", { background: true }, "background_not_allowed"],
    ["web search tool", { tools: [{ type: "web_search" }] }, "openai_tool_not_allowed:web_search"],
    [
      "remote MCP tool",
      { tools: [{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" }] },
      "openai_tool_not_allowed:mcp",
    ],
    [
      "code interpreter",
      { tools: [{ type: "code_interpreter", container: { type: "auto" } }] },
      "openai_tool_not_allowed:code_interpreter",
    ],
    ["image generation", { tools: [{ type: "image_generation" }] }, "openai_tool_not_allowed:image_generation"],
    [
      "file search",
      { tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] },
      "openai_tool_not_allowed:file_search",
    ],
    ["local shell", { tools: [{ type: "local_shell" }] }, "openai_tool_not_allowed:local_shell"],
    [
      "hosted tool inside a namespace",
      { tools: [{ type: "namespace", name: "ns", description: "", tools: [{ type: "web_search" }] }] },
      "openai_tool_not_allowed:web_search",
    ],
    [
      "nested namespace",
      {
        tools: [
          {
            type: "namespace",
            name: "ns",
            description: "",
            tools: [{ type: "namespace", name: "inner", description: "", tools: [] }],
          },
        ],
      },
      "openai_tool_not_allowed:namespace",
    ],
    [
      "function tool with an extra key",
      { tools: [{ type: "function", name: "f", parameters: {}, server_url: "https://attacker.example" }] },
      "invalid_openai_tool",
    ],
    ["invalid tool name", { tools: [{ type: "function", name: "bad name", parameters: {} }] }, "invalid_openai_tool"],
    ["hosted tool choice", { tool_choice: { type: "web_search" } }, "openai_tool_choice_not_allowed"],
    [
      "extra include",
      { include: ["reasoning.encrypted_content", "web_search_call.action.sources"] },
      "openai_include_not_allowed",
    ],
    ["unknown reasoning effort", { reasoning: { effort: "unbounded" } }, "openai_reasoning_not_allowed"],
    [
      "unknown reasoning key",
      { reasoning: { effort: "low", generate_summary: "auto" } },
      "openai_reasoning_not_allowed",
    ],
    ["text format json_object", { text: { format: { type: "json_object" } } }, "openai_text_not_allowed"],
    ["client metadata object value", { client_metadata: { session_id: { b: 1 } } }, "invalid_openai_request"],
    [
      "unknown client metadata key",
      { client_metadata: { session_id: "s", "x-openai-priority": "1" } },
      "openai_client_metadata_key_not_allowed:x-openai-priority",
    ],
  ])("rejects %s before credential resolution", async (_name, change, code) => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ credentials: { resolve } });

    await expect(
      execute(h, `openai-reject-${_name}`, new TestSink(), JSON.stringify(codexBody(change))),
    ).rejects.toMatchObject({ status: 400, code });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "remote image URL in a user message",
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "https://attacker.example/x.png?d=secret" }],
      },
      "openai_remote_input_not_allowed",
    ],
    [
      "image file_id",
      { type: "message", role: "user", content: [{ type: "input_image", file_id: "file_1" }] },
      "openai_remote_input_not_allowed",
    ],
    [
      "non-image data URL",
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:text/html;base64,PGgxPg==" }],
      },
      "openai_remote_input_not_allowed",
    ],
    [
      "remote image in a tool output",
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: "https://attacker.example/x.png" }],
      },
      "openai_remote_input_not_allowed",
    ],
    [
      "remote image in a custom tool output",
      {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [{ type: "input_image", image_url: "http://attacker.example/x.png" }],
      },
      "openai_remote_input_not_allowed",
    ],
    [
      "input_file with a URL",
      { type: "message", role: "user", content: [{ type: "input_file", file_url: "https://attacker.example/a.pdf" }] },
      "openai_input_not_allowed:input_file",
    ],
    [
      "input_file with inline data",
      { type: "message", role: "user", content: [{ type: "input_file", filename: "a.pdf", file_data: "JVBERi0=" }] },
      "openai_input_not_allowed:input_file",
    ],
    [
      "input_audio",
      { type: "message", role: "user", content: [{ type: "input_audio", input_audio: { data: "", format: "wav" } }] },
      "openai_input_not_allowed:input_audio",
    ],
    ["item_reference", { type: "item_reference", id: "msg_1" }, "openai_input_not_allowed:item_reference"],
    [
      "web search call replay",
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "x" } },
      "openai_input_not_allowed:web_search_call",
    ],
    [
      "mcp approval response",
      { type: "mcp_approval_response", approval_request_id: "a", approve: true },
      "openai_input_not_allowed:mcp_approval_response",
    ],
    ["compaction item", { type: "compaction", encrypted_content: "x" }, "openai_input_not_allowed:compaction"],
    [
      "local shell call",
      { type: "local_shell_call", call_id: "c", status: "completed", action: { type: "exec", command: ["ls"] } },
      "openai_input_not_allowed:local_shell_call",
    ],
    [
      "hosted tool smuggled through additional_tools",
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" }],
      },
      "openai_tool_not_allowed:mcp",
    ],
    [
      "extra key on a function call",
      { type: "function_call", call_id: "c", name: "f", arguments: "{}", server_url: "https://attacker.example" },
      "invalid_openai_request",
    ],
    [
      "output_text annotations",
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "x", annotations: [{ type: "url_citation", url: "https://a" }] }],
      },
      "invalid_openai_request",
    ],
    [
      "an image in an assistant message",
      { type: "message", role: "assistant", content: [{ type: "input_image", image_url: INLINE_PNG }] },
      "openai_input_not_allowed:input_image",
    ],
  ])("rejects an input item carrying %s", async (_name, item, code) => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ credentials: { resolve } });

    await expect(
      execute(h, `openai-reject-input-${_name}`, new TestSink(), JSON.stringify(withInput(item))),
    ).rejects.toMatchObject({ status: 400, code });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("records an allowlist refusal against the run in the audit log", async () => {
    const h = await harness();
    const body = codexBody({ tools: [{ type: "mcp", server_label: "x", server_url: "https://attacker.example/mcp" }] });

    await expect(execute(h, "audited-refusal", new TestSink(), JSON.stringify(body))).rejects.toMatchObject({
      code: "openai_tool_not_allowed:mcp",
    });
    expect(h.events).toContainEqual({
      type: "request.rejected",
      runId: h.session.runId,
      status: 400,
      reason: "openai_tool_not_allowed:mcp",
    });
    expect(JSON.stringify(h.events)).not.toContain("attacker.example");
  });

  it("refuses JSON nested too deeply to re-encode with a 400, not an internal error", async () => {
    const resolve = vi.fn(async () => "secret");
    const h = await harness({ credentials: { resolve } });
    const depth = 200_000;
    const parameters = `{"type":"object","x":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const tools = `[{"type":"function","name":"f","parameters":${parameters}}]`;
    const raw = JSON.stringify(codexBody({ tools: "__TOOLS__" })).replace('"__TOOLS__"', tools);

    await expect(execute(h, "deeply-nested", new TestSink(), raw)).rejects.toMatchObject({
      status: 400,
      code: "request_nesting_too_deep",
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("interrupted replies settle at an estimate", () => {
  it("does not refuse the #323 run: two interrupted replies, little spent", async () => {
    // Hold per request is fixed by body size; budget fits ~2.5 holds. As in #323, a
    // completed reply comes first, then two cut streams: they used to keep 2 holds,
    // so the next request was refused. Now each is priced from the completed
    // reply's input plus the relayed output.
    const raw = requestBody(true);
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const hold = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    let call = 0;
    const h = await harness({
      budgetUsd: hold * 2.5,
      fetch: async () => {
        call += 1;
        if (call === 2 || call === 3)
          return new Response(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n',
          );
        return new Response(completedSse(USAGE), { headers: { "content-type": "text/event-stream" } });
      },
    });
    await expect(execute(h, "first", new TestSink(), raw)).resolves.toBeDefined();
    await expect(execute(h, "cut-1", new TestSink(), raw)).rejects.toMatchObject({ status: 502 });
    await expect(execute(h, "cut-2", new TestSink(), raw)).rejects.toMatchObject({ status: 502 });
    await expect(execute(h, "next", new TestSink(), raw)).resolves.toBeDefined();
    const cut = h.events.filter((e) => e.type === "request.uncertain");
    expect(cut).toHaveLength(2);
    for (const e of cut) expect(e.estimatedCostUsd).toBeLessThan(hold);
  });

  it("prices an Anthropic reply cut after message_start from the usage it read", async () => {
    const stream = (await fixture("anthropic-message-stream.txt")).split("event: message_delta")[0];
    const body = await fixture("anthropic-sdk-request.json");
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(execute(h, "anthropic-cut", new TestSink(), body)).rejects.toMatchObject({ status: 502 });
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request).toMatchObject({
      status: "uncertain",
      costEstimated: true,
      usage: { inputTokens: 125, cachedInputTokens: 25, cacheWriteTokens: 10 },
    });
    expect(request!.actualCostUsd!).toBeLessThan(request!.reservationUsd);
  });

  it("prices an Anthropic reply cut before message_delta from the relayed text, tool input and thinking", async () => {
    // message_start's output_tokens is a placeholder (usually 1), not a running count.
    const frame = (data: unknown) => `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
    const delta = (delta: unknown) => frame({ type: "content_block_delta", index: 0, delta });
    const chunk = "a".repeat(300);
    const stream =
      frame({
        type: "message_start",
        message: {
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
        },
      }) +
      Array.from({ length: 4 }, () => delta({ type: "thinking_delta", thinking: chunk })).join("") +
      Array.from({ length: 3 }, () => delta({ type: "text_delta", text: chunk })).join("") +
      Array.from({ length: 3 }, () => delta({ type: "input_json_delta", partial_json: chunk })).join("");
    const h = await harness({
      protocol: "anthropic-messages",
      fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(
      execute(h, "anthropic-cut-floor", new TestSink(), await fixture("anthropic-sdk-request.json")),
    ).rejects.toMatchObject({ status: 502 });
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    // 10 deltas × 300 bytes = 3,000 bytes relayed: ceil(3000 / 3) = 1,000 output tokens.
    expect(request).toMatchObject({ status: "uncertain", costEstimated: true, usage: { outputTokens: 1_000 } });
    expect(request!.actualCostUsd!).toBeCloseTo((100 * 1 + 1_000 * 4) / 1e6, 12);
  });

  it("prices an OpenAI reply cut mid-stream from relayed function arguments and reasoning text", async () => {
    const frame = (type: string, delta: string) => `event: ${type}\ndata: ${JSON.stringify({ type, delta })}\n\n`;
    const chunk = "b".repeat(30);
    const stream =
      frame("response.reasoning_summary_text.delta", chunk) +
      frame("response.reasoning_text.delta", chunk) +
      frame("response.function_call_arguments.delta", chunk) +
      frame("response.output_text.delta", chunk);
    const h = await harness({
      budgetUsd: 10,
      fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(execute(h, "openai-cut-tools", new TestSink(), requestBody(true))).rejects.toMatchObject({
      status: 502,
    });
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    // 4 deltas × 30 bytes = 120 bytes relayed: 40 output tokens.
    expect(request).toMatchObject({ status: "uncertain", costEstimated: true, usage: { outputTokens: 40 } });
  });

  it("keeps refusing a retry of the same body with duplicate_uncertain", async () => {
    const raw = requestBody(true);
    const h = await harness({
      budgetUsd: 10,
      fetch: async () =>
        new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n'),
    });
    await expect(execute(h, "same", new TestSink(), raw)).rejects.toMatchObject({ status: 502 });
    await expect(execute(h, "same", new TestSink(), raw)).rejects.toMatchObject({ status: 409 });
    expect(h.events.at(-1)).toMatchObject({ type: "request.rejected", reason: "duplicate_uncertain" });
  });

  it("keeps the full hold when no estimate can be made, without breaking the relay", async () => {
    const ledger = new MemoryProxyLedger();
    ledger.settlementHints = async () => {
      throw new Error("ledger unavailable");
    };
    const h = await harness({
      ledger,
      fetch: async () =>
        new Response('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n'),
    });
    await expect(execute(h, "no-estimate", new TestSink(), requestBody(true))).rejects.toMatchObject({ status: 502 });
    const request = await h.ledger.getRequest(reservedRequestId(h.events));
    expect(request).toMatchObject({ status: "uncertain" });
    expect(request?.costEstimated).toBeFalsy();
    expect(request?.actualCostUsd).toBeUndefined();
    const uncertain = h.events.find((e) => e.type === "request.uncertain");
    expect(uncertain).toMatchObject({ reason: "terminal_usage_missing" });
    expect(uncertain).not.toHaveProperty("estimatedCostUsd");
  });

  it("still holds a request left reserved (a proxy crash mid-request) in full", async () => {
    const raw = requestBody(true);
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const hold = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    const h = await harness({
      budgetUsd: hold * 1.5,
      fetch: async () => new Response(completedSse(USAGE), { headers: { "content-type": "text/event-stream" } }),
    });
    const reserved = await h.ledger.reserve({
      id: "crashed",
      sessionId: h.session.id,
      requestKey: "crashed",
      requestFingerprint: "crashed",
      model: "test-model",
      reservationUsd: hold,
      pricing: { ...PRICE, version: "test-v1" },
      now: NOW,
    });
    expect(reserved.outcome).toBe("reserved");
    await expect(execute(h, "after-crash", new TestSink(), raw)).rejects.toMatchObject({ status: 429 });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("cache-aware holds", () => {
  // One conversation (codexBody's prompt_cache_key): a ~100 KB base that grows 2 KB per turn.
  const turnBody = (turn: number, maxOutput = 32_000) =>
    JSON.stringify({
      ...codexBody(),
      input: [
        ...(codexBody().input as unknown[]),
        { type: "message", id: "msg_base", role: "user", content: [{ type: "input_text", text: "b".repeat(100_000) }] },
        ...Array.from({ length: turn }, (_, i) => ({
          type: "message",
          id: `msg_t${i}`,
          role: "user",
          content: [{ type: "input_text", text: "x".repeat(2_000) }],
        })),
      ],
      stream: false,
      max_output_tokens: maxOutput,
    });
  // A realistic cached reply: ~30k prompt tokens growing 600/turn, all but 1.5k read from cache.
  const cachedUsage = (turn: number) => {
    const input = 30_000 + turn * 600;
    return { input_tokens: input, input_tokens_details: { cached_tokens: input - 1_500 }, output_tokens: 2_000 };
  };

  it("holds the second request of a conversation at the cache rate, and audits why", async () => {
    let turn = 0;
    const h = await harness({
      budgetUsd: 10,
      fetch: async () => Response.json({ id: "r", usage: cachedUsage(turn++) }),
    });
    await execute(h, "t0", new TestSink(), turnBody(0));
    await execute(h, "t1", new TestSink(), turnBody(1));
    const reserved = h.events.filter((e) => e.type === "request.reserved");
    expect(reserved[0]).toMatchObject({ reservationBasis: "full", holdFallback: "no_previous" });
    expect(reserved[1]).toMatchObject({ reservationBasis: "cached" });
    expect(reserved[1].reservationUsd!).toBeLessThan(reserved[1].ceilingUsd! / 2);
  });

  it("lets a long cached conversation run until only a cached hold no longer fits", async () => {
    let turn = 0;
    const h = await harness({
      budgetUsd: 1,
      fetch: async () => Response.json({ id: "r", usage: cachedUsage(turn++) }),
    });
    let refused: unknown;
    for (let t = 0; t < 200 && !refused; t++) {
      await execute(h, `t${t}`, new TestSink(), turnBody(t)).catch((error) => (refused = error));
    }
    expect(refused).toMatchObject({ status: 429 });
    const spent = h.events.filter((e) => e.type === "response.completed").reduce((sum, e) => sum + e.costUsd!, 0);
    const rejected = h.events.filter((e) => e.type === "request.rejected").at(-1)!;
    expect(rejected).toMatchObject({ reason: "budget_exhausted", reservationBasis: "cached" });
    // Refused only once the cached hold no longer fits, and later than the ceiling would have allowed.
    expect(spent + rejected.reservationUsd!).toBeGreaterThanOrEqual(1);
    expect(spent).toBeGreaterThan(1 - rejected.ceilingUsd!);
  });

  it("settles a reply costing more than its hold but not its ceiling, and audits the overshoot", async () => {
    let turn = 0;
    // Turn 1's cache misses: everything is fresh input, far above the cached hold, below the ceiling.
    const h = await harness({
      budgetUsd: 10,
      fetch: async () =>
        Response.json({
          id: "r",
          usage: turn++ === 0 ? cachedUsage(0) : { input_tokens: 31_000, output_tokens: 30_000 },
        }),
    });
    await execute(h, "t0", new TestSink(), turnBody(0));
    await expect(execute(h, "t1", new TestSink(), turnBody(1))).resolves.toBeDefined();
    const completed = h.events.filter((e) => e.type === "response.completed")[1];
    expect(completed).toMatchObject({ reason: "reservation_exceeded" });
    expect(completed.overshootUsd!).toBeGreaterThan(0);
    expect(completed.costUsd!).toBeLessThanOrEqual(
      h.events.filter((e) => e.type === "request.reserved")[1].ceilingUsd!,
    );
    // The next request falls back: the miss left less than half of the prompt cached.
    await execute(h, "t2", new TestSink(), turnBody(2));
    expect(h.events.filter((e) => e.type === "request.reserved")[2]).toMatchObject({
      reservationBasis: "full",
      holdFallback: "low_cache_share",
    });
  });

  it("still cancels the session when a reply costs more than its ceiling", async () => {
    const h = await harness({
      budgetUsd: 10,
      fetch: async () => Response.json({ id: "r", usage: { input_tokens: 10_000_000, output_tokens: 1 } }),
    });
    await expect(execute(h, "huge", new TestSink(), turnBody(0, 1_024))).rejects.toMatchObject({
      status: 502,
      code: "reservation_invariant_violated",
    });
  });

  it("records the refused hold's basis and ceiling on the session's refusal", async () => {
    let turn = 0;
    const h = await harness({
      budgetUsd: 0.3,
      fetch: async () => Response.json({ id: "r", usage: cachedUsage(turn++) }),
    });
    for (let t = 0; t < 200; t++) {
      const ok = await execute(h, `t${t}`, new TestSink(), turnBody(t)).then(
        () => true,
        () => false,
      );
      if (!ok) break;
    }
    expect(await h.ledger.budgetRefusal(h.session.id)).toMatchObject({
      refusedHoldBasis: expect.stringMatching(/^(cached|full)$/),
      refusedHoldCeilingUsd: expect.any(Number),
    });
  });

  it("falls back to the ceiling when the previous-reply lookup fails", async () => {
    const ledger = new MemoryProxyLedger({ now: () => NOW });
    ledger.previousReply = async () => {
      throw new Error("ledger unavailable");
    };
    const h = await harness({
      ledger,
      budgetUsd: 10,
      fetch: async () => Response.json({ id: "r", usage: cachedUsage(0) }),
    });
    await execute(h, "t0", new TestSink(), turnBody(0));
    expect(h.events.find((e) => e.type === "request.reserved")).toMatchObject({ reservationBasis: "full" });
  });
});
