import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { estimateReservationUsd } from "./metering.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import {
  CodingProxy,
  CodingProxyError,
  CLAUDE_CODE_ANTHROPIC_BETAS,
  PROXY_DEFAULT_MAX_OUTPUT_TOKENS,
  type CreatedCodingProxySession,
  type ProxyResponseSink,
} from "./proxy.js";
import type { ModelPricing } from "../llm/pricing.js";
import type { ProxyAuditEvent, ProxyProtocol } from "./types.js";

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
  } = {},
): Promise<Harness> {
  const ledger = overrides.ledger ?? new MemoryProxyLedger();
  const events: ProxyAuditEvent[] = [];
  const fetchImpl: typeof globalThis.fetch =
    overrides.fetch ?? (async () => Response.json({ id: "resp", usage: USAGE }, { status: 200 }));
  const fetch = vi.fn(fetchImpl);
  const proxy = new CodingProxy({
    ledger,
    credentials: overrides.credentials ?? { resolve: async () => "UPSTREAM_SECRET" },
    fetch,
    now: overrides.now ?? (() => NOW),
    pricing: overrides.price ?? (() => PRICE),
    pricingVersion: "test-v1",
    audit: (event) => events.push(event),
  });
  const session = await proxy.createSession({
    runId: `run-${Math.random()}`,
    credentialRef: overrides.protocol === "anthropic-messages" ? "anthropic/project-a" : "openai/project-a",
    protocol: overrides.protocol ?? "openai-responses",
    allowedModels: [overrides.protocol === "anthropic-messages" ? "claude-sonnet-5" : "test-model"],
    deadlineAt: overrides.deadlineAt ?? new Date(NOW.getTime() + 60_000),
    budgetUsd: overrides.budgetUsd ?? 1,
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
    await expect(execute(h, "boundary")).rejects.toMatchObject({ status: 429, code: "reevo_budget_exhausted" });
    expect(h.fetch).not.toHaveBeenCalled();
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

  it("retains an unresolved reservation after a truncated stream", async () => {
    const raw = requestBody(true);
    const normalized = JSON.stringify({ ...JSON.parse(raw), store: false, background: false });
    const one = estimateReservationUsd(Buffer.byteLength(normalized), 10, PRICE);
    const h = await harness({
      budgetUsd: one * 2,
      fetch: async () => new Response('event: response.output_text.delta\ndata: {"delta":"x"}\n\n'),
    });
    await expect(execute(h, "truncated", new TestSink(), raw)).rejects.toMatchObject({ status: 502 });
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("uncertain");
    await expect(execute(h, "after-truncated", new TestSink(), raw)).rejects.toMatchObject({ status: 429 });
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

  it("retains the reservation when terminal usage is absent or malformed", async () => {
    const h = await harness({
      fetch: async () =>
        new Response('event: response.failed\ndata: {"type":"response.failed","response":{"usage":null}}\n\n'),
    });
    await expect(execute(h, "failed-terminal", new TestSink(), requestBody(true))).rejects.toBeInstanceOf(
      CodingProxyError,
    );
    expect((await h.ledger.getRequest(reservedRequestId(h.events)))?.status).toBe("uncertain");
  });
});

describe("CodingProxy Anthropic Messages", () => {
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

  it("forwards only Reevo's bounded local command tool and matching tool-result blocks", async () => {
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
        name: "mcp__reevo_tools__run_command",
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
            id: "toolu_reevo_command",
            name: "mcp__reevo_tools__run_command",
            input: { command: "git status --short", timeout_ms: 1_000 },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_reevo_command",
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

    await execute(h, "reevo-command-tool", new TestSink(), JSON.stringify(body));

    const forwarded = JSON.parse((h.fetch.mock.calls[0][1] as RequestInit).body as string);
    expect(forwarded.tools).toHaveLength(2);
    expect(forwarded.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_reevo_command",
      cache_control: { type: "ephemeral" },
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
                name: "mcp__reevo_tools__run_command",
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
    ["unreviewed effort", { output_config: { effort: "max" } }, "unsupported_anthropic_feature"],
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
});
