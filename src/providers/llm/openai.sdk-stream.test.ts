/**
 * SDK-level contract for the OpenAI adapter: the REAL `openai` client (its
 * HTTP layer, retry loop, SSE parser and abort handling) pointed at a local
 * HTTP server that replays recorded Responses-API SSE bodies.
 *
 * The other OpenAI suites inject a duck-typed client that yields pre-parsed
 * events, so a parser or transport regression in the SDK itself would pass
 * them while the engine recorded $0 for a billed turn. This file is what
 * catches that across SDK upgrades: every usage/cost assertion below goes
 * through bytes on a socket, never through a fake.
 *
 * Fixture shapes follow the Responses streaming events the adapter reads
 * (`response.output_text.delta`, `response.output_item.done`,
 * `response.completed` / `response.incomplete` with `usage`, `response.failed`,
 * `error`). Usage numbers reuse the live gpt-5.6-luna cache fixture from
 * openai.responses.test.ts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { getGlobalDispatcher } from "undici";
import { NativeEngine } from "../../core/engine-native.js";
import { classifyProviderFailure } from "../../core/provider-wording.js";
import type { EngineRunContext } from "../engine/types.js";
import { OpenAiLlmProvider } from "./openai.js";
import { shippedCatalog } from "./catalog.js";
import type { CatalogEntry } from "./catalog-types.js";
import type { LlmRequest, LlmStreamEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Replay server
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  httpVersion: string;
}

type Handler = (req: IncomingMessage, res: ServerResponse, recorded: RecordedRequest) => void;

/** One handler per incoming request, in order; a request past the script is a 599 so it fails loudly. */
class ReplayServer {
  readonly requests: RecordedRequest[] = [];
  /** Responses whose underlying connection closed before the server ended them (client aborts). */
  abortedResponses = 0;
  private handlers: Handler[] = [];
  private server: Server | undefined;
  baseURL = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const recorded: RecordedRequest = {
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
          httpVersion: req.httpVersion,
        };
        this.requests.push(recorded);
        res.on("close", () => {
          if (!res.writableEnded) this.abortedResponses += 1;
        });
        const handler = this.handlers.shift();
        if (!handler) {
          res.writeHead(599, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unscripted request", type: "test", code: "unscripted" } }));
          return;
        }
        handler(req, res, recorded);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseURL = `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.abortedResponses = 0;
    this.handlers = [];
  }

  script(...handlers: Handler[]): void {
    this.handlers.push(...handlers);
  }
}

type SseEvent = { type: string } & Record<string, unknown>;

/** Serializes events exactly as the Responses API frames them: `event:` = type, `data:` = the JSON. */
function sseBody(events: SseEvent[]): string {
  return events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("");
}

interface SseHandlerOptions {
  gzip?: boolean;
  /** A pre-framed body to send instead of `sseBody(events)` (e.g. with \r\n line endings). */
  body?: string;
  /** Write the body in pieces of this many bytes, one event-loop turn apart, so frames, JSON and UTF-8 straddle reads. */
  chunkSize?: number;
}

function sseHandler(events: SseEvent[], options: SseHandlerOptions = {}): Handler {
  return (_req, res) => {
    const body = Buffer.from(options.body ?? sseBody(events));
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-request-id": "req_test",
    };
    if (options.gzip) {
      headers["content-encoding"] = "gzip";
      res.writeHead(200, headers);
      res.end(gzipSync(body));
      return;
    }
    res.writeHead(200, headers);
    const size = options.chunkSize;
    if (!size) {
      res.end(body);
      return;
    }
    res.socket?.setNoDelay(true);
    let offset = 0;
    const writeNext = (): void => {
      if (res.destroyed) return;
      const piece = body.subarray(offset, offset + size);
      offset += size;
      if (offset >= body.length) {
        res.end(piece);
        return;
      }
      res.write(piece);
      setImmediate(writeNext);
    };
    writeNext();
  };
}

function jsonErrorHandler(
  status: number,
  error: { message: string; type: string; code: string | null },
  headers: Record<string, string> = {},
): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_err", ...headers });
    res.end(JSON.stringify({ error: { ...error, param: null } }));
  };
}

// ---------------------------------------------------------------------------
// Recorded Responses-API event fixtures
// ---------------------------------------------------------------------------

const RESPONSE_ID = "resp_test";

function responseObject(status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RESPONSE_ID,
    object: "response",
    created_at: 1_760_000_000,
    status,
    model: "reasoner",
    output: [],
    error: null,
    incomplete_details: null,
    usage: null,
    ...extra,
  };
}

const created = (): SseEvent => ({ type: "response.created", response: responseObject("in_progress") });
const inProgress = (): SseEvent => ({ type: "response.in_progress", response: responseObject("in_progress") });
const textDelta = (delta: string): SseEvent => ({
  type: "response.output_text.delta",
  item_id: "msg_1",
  output_index: 0,
  content_index: 0,
  delta,
});

/** Live gpt-5.6-luna shape: cache read + write + reasoning, all subsets of their parents. */
const BILLED_USAGE = {
  input_tokens: 3510,
  input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 1500 },
  output_tokens: 205,
  output_tokens_details: { reasoning_tokens: 192 },
  total_tokens: 3715,
};
// fresh (3510 - 1500) = 2010 input, of which 2000 cached; 1500 cache writes; 205 output (reasoning inside).
// reasoner prices: input $2, cached $0.5, write $3, output $10 per MTok.
const BILLED_COST = ((2010 - 2000) * 2 + 2000 * 0.5 + 1500 * 3 + 205 * 10) / 1_000_000;

const completed = (usage: Record<string, unknown>): SseEvent => ({
  type: "response.completed",
  response: responseObject("completed", { usage }),
});
const incomplete = (reason: string, usage: Record<string, unknown>): SseEvent => ({
  type: "response.incomplete",
  response: responseObject("incomplete", { incomplete_details: { reason }, usage }),
});

const functionCallEvents = (callId: string, name: string, args: string): SseEvent[] => [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: "", status: "in_progress" },
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: `fc_${callId}`,
    output_index: 0,
    delta: args.slice(0, 5),
  },
  {
    type: "response.function_call_arguments.delta",
    item_id: `fc_${callId}`,
    output_index: 0,
    delta: args.slice(5),
  },
  {
    type: "response.function_call_arguments.done",
    item_id: `fc_${callId}`,
    output_index: 0,
    arguments: args,
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args, status: "completed" },
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A reasoning-model entry priced at round numbers so costs are exact. */
const reasoningEntry = (): CatalogEntry => ({
  ...shippedCatalog().require("gpt-4o-mini"),
  modelId: "reasoner",
  efforts: ["low", "high"],
  inputPerMTok: 2,
  cachedInputPerMTok: 0.5,
  cacheWritePerMTok: 3,
  outputPerMTok: 10,
});

const server = new ReplayServer();

function realClient(maxRetries = 0): OpenAI {
  return new OpenAI({ apiKey: "sk-test", baseURL: server.baseURL, maxRetries, timeout: 10_000 });
}

function provider(maxRetries = 0, entry: CatalogEntry = reasoningEntry()): OpenAiLlmProvider {
  return new OpenAiLlmProvider("", realClient(maxRetries)).withEntry(entry);
}

const REQUEST: LlmRequest = { model: "reasoner", messages: [{ role: "user", content: "hi" }] };

async function collect(llm: OpenAiLlmProvider, req: LlmRequest = REQUEST): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of llm.stream(req)) events.push(event);
  return events;
}

async function captureError(promise: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await promise;
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error("expected the call to throw");
}

function engineContext(llm: OpenAiLlmProvider, overrides: Partial<EngineRunContext["agent"]> = {}): EngineRunContext {
  return {
    agent: { systemPrompt: "You help.", model: "reasoner", budgetUsd: 100, maxTurns: 5, ...overrides },
    tools: [],
    providers: { llm },
    runSandboxTool: vi.fn(async () => '{"ok":true}'),
  };
}

beforeAll(async () => {
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

// ---------------------------------------------------------------------------
// Adapter through the real SDK
// ---------------------------------------------------------------------------

describe("OpenAI adapter through the real SDK: successful streams", () => {
  it("streams text deltas and prices response.completed usage incl. cached, cache-write and reasoning tokens", async () => {
    server.script(sseHandler([created(), inProgress(), textDelta("Hel"), textDelta("lo."), completed(BILLED_USAGE)]));

    const events = await collect(provider());

    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo." },
      {
        type: "done",
        stopReason: "stop",
        usage: {
          inputTokens: 2010,
          outputTokens: 205,
          cachedInputTokens: 2000,
          cacheWriteTokens: 1500,
          costUsd: expect.closeTo(BILLED_COST, 12),
        },
      },
    ]);

    // What actually went over the wire.
    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/responses");
    expect(request.headers.authorization).toBe("Bearer sk-test");
    expect(request.body).toMatchObject({
      model: "reasoner",
      stream: true,
      store: false,
      input: [{ role: "user", content: "hi" }],
    });
  });

  it("parses a function call from the done item (arguments streamed in fragments) and stops with tool_calls", async () => {
    server.script(
      sseHandler([
        created(),
        ...functionCallEvents("call_1", "get_weather", '{"city":"Boston"}'),
        completed(BILLED_USAGE),
      ]),
    );

    const events = await collect(provider());

    expect(events.filter((e) => e.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_1", name: "get_weather", argsJson: '{"city":"Boston"}' },
    ]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", stopReason: "tool_calls" });
    expect(done?.type === "done" && done.usage.costUsd).toBeCloseTo(BILLED_COST, 12);
  });

  it("decodes a gzip-encoded SSE body through the real fetch path", async () => {
    server.script(sseHandler([created(), textDelta("zipped"), completed(BILLED_USAGE)], { gzip: true }));

    const events = await collect(provider());

    expect(events[0]).toEqual({ type: "text", delta: "zipped" });
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { costUsd: expect.closeTo(BILLED_COST, 12) } });
  });

  it("reassembles frames split at arbitrary byte boundaries (7-byte reads, UTF-8, \\r\\n framing)", async () => {
    const CHUNK = 7;
    const events = [created(), textDelta("Hel"), textDelta("café ✓ naïve — 日本語"), completed(BILLED_USAGE)];
    // One event framed with \r\n line endings (allowed by the SSE spec), the rest with \n.
    const body = events
      .map((e, i) => {
        const frame = `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`;
        return i === 2 ? frame.replaceAll("\n", "\r\n") : frame;
      })
      .join("");
    // Keep the fixture honest: a multi-byte character and the usage JSON
    // both straddle a chunk boundary.
    const bytes = Buffer.from(body);
    const boundaries = Array.from({ length: Math.floor(bytes.length / CHUNK) }, (_, k) => (k + 1) * CHUNK);
    expect(boundaries.some((b) => b < bytes.length && (bytes[b] & 0xc0) === 0x80)).toBe(true);
    const usageStart = bytes.indexOf('"usage":{"input_tokens"');
    const usageEnd = bytes.indexOf("}", bytes.indexOf('"total_tokens"', usageStart));
    expect(boundaries.some((b) => b > usageStart && b <= usageEnd)).toBe(true);
    expect(body).toContain("\r\n\r\n");
    server.script(sseHandler([], { body, chunkSize: CHUNK }));

    const parsed = await collect(provider());

    expect(parsed).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "café ✓ naïve — 日本語" },
      {
        type: "done",
        stopReason: "stop",
        usage: {
          inputTokens: 2010,
          outputTokens: 205,
          cachedInputTokens: 2000,
          cacheWriteTokens: 1500,
          costUsd: expect.closeTo(BILLED_COST, 12),
        },
      },
    ]);
  });
});

describe("OpenAI adapter through the real SDK: response.incomplete is billed", () => {
  it("max_output_tokens: stopReason length, usage priced (never $0)", async () => {
    server.script(sseHandler([created(), textDelta("truncat"), incomplete("max_output_tokens", BILLED_USAGE)]));

    const done = (await collect(provider())).at(-1);

    expect(done).toMatchObject({ type: "done", stopReason: "length" });
    expect(done?.type === "done" && done.usage).toMatchObject({ inputTokens: 2010, outputTokens: 205 });
    expect(done?.type === "done" && done.usage.costUsd).toBeCloseTo(BILLED_COST, 12);
    expect(done?.type === "done" && done.usage.costUsd).toBeGreaterThan(0);
  });

  it("content_filter: stopReason stop, usage priced (never $0)", async () => {
    server.script(sseHandler([created(), textDelta("partial"), incomplete("content_filter", BILLED_USAGE)]));

    const done = (await collect(provider())).at(-1);

    expect(done).toMatchObject({ type: "done", stopReason: "stop" });
    expect(done?.type === "done" && done.usage.costUsd).toBeCloseTo(BILLED_COST, 12);
  });

  it("an incomplete function_call item is not emitted as a call to run", async () => {
    server.script(
      sseHandler([
        created(),
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc_x",
            call_id: "call_x",
            name: "t",
            arguments: '{"a":',
            status: "incomplete",
          },
        },
        incomplete("max_output_tokens", BILLED_USAGE),
      ]),
    );

    const events = await collect(provider());

    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "length" });
  });
});

describe("OpenAI adapter through the real SDK: in-stream failures", () => {
  it("response.failed throws the API's message", async () => {
    server.script(
      sseHandler([
        created(),
        textDelta("x"),
        {
          type: "response.failed",
          response: responseObject("failed", { error: { code: "server_error", message: "boom upstream" } }),
        },
      ]),
    );

    await expect(collect(provider())).rejects.toThrow("OpenAI response failed: boom upstream");
  });

  it("an `event: error` frame is thrown by the SDK as an APIError carrying the message", async () => {
    server.script(
      sseHandler([
        created(),
        {
          type: "error",
          code: "server_error",
          message: "The server had an error processing your request.",
          param: null,
        },
      ]),
    );

    const err = await captureError(collect(provider()));

    expect(err).toBeInstanceOf(OpenAI.APIError);
    expect(err.message).toBe("The server had an error processing your request.");
  });
});

// ---------------------------------------------------------------------------
// HTTP error statuses, retries, and how wardby classifies them
// ---------------------------------------------------------------------------

/**
 * Native runs record the thrown error's `message` as the run error
 * (engine-native.ts runOneTurn's catch); #137's provider-failure classes
 * (provider-wording.ts) are applied to coding runs from the proxy's relayed
 * code. These tests pin both halves of what an SDK upgrade could move: the
 * status/code the SDK error exposes, the message text native runs persist,
 * and that the same code lands in the class #137 would file it under.
 */
describe("OpenAI adapter through the real SDK: HTTP error statuses", () => {
  it("429 with retry-after is retried; the turn is counted once", async () => {
    server.script(
      jsonErrorHandler(
        429,
        { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" },
        { "retry-after": "0" },
      ),
      sseHandler([created(), textDelta("ok"), completed(BILLED_USAGE)]),
    );

    const events = await collect(provider(1));

    expect(server.requests).toHaveLength(2);
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { costUsd: expect.closeTo(BILLED_COST, 12) } });
  });

  it("429 rate_limit_exceeded, retries exhausted: RateLimitError, message persisted, classified rate_limited", async () => {
    server.script(
      jsonErrorHandler(
        429,
        { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" },
        { "retry-after": "0" },
      ),
    );

    const err = await captureError(collect(provider(0)));

    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect(err.status).toBe(429);
    expect(err.code).toBe("rate_limit_exceeded");
    expect(err.message).toBe("429 Rate limit reached for requests");
    expect(classifyProviderFailure(err.code as string)).toBe("rate_limited");
    expect(classifyProviderFailure(`http_${err.status as number}`)).toBe("rejected");
  });

  it("429 insufficient_quota: classified quota (only an operator can fix it)", async () => {
    server.script(
      jsonErrorHandler(429, {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      }),
    );

    const err = await captureError(collect(provider(0)));

    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
    expect(err.code).toBe("insufficient_quota");
    expect(classifyProviderFailure(err.code as string)).toBe("quota");
  });

  it("400 is never retried: BadRequestError, classified rejected", async () => {
    server.script(
      jsonErrorHandler(400, {
        message: "Unsupported parameter: 'temperature' is not supported with this model.",
        type: "invalid_request_error",
        code: "unsupported_parameter",
      }),
    );

    const err = await captureError(collect(provider(2)));

    expect(server.requests).toHaveLength(1);
    expect(err).toBeInstanceOf(OpenAI.BadRequestError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("400 Unsupported parameter: 'temperature' is not supported with this model.");
    expect(classifyProviderFailure(err.code as string)).toBe("rejected");
    expect(classifyProviderFailure(`http_${err.status as number}`)).toBe("rejected");
  });

  it("500 is retried, then InternalServerError, classified unavailable", async () => {
    const serverError = { message: "The server had an error while processing your request.", type: "server_error" };
    server.script(
      jsonErrorHandler(500, { ...serverError, code: "server_error" }, { "retry-after-ms": "1" }),
      jsonErrorHandler(500, { ...serverError, code: "server_error" }, { "retry-after-ms": "1" }),
    );

    const err = await captureError(collect(provider(1)));

    expect(server.requests).toHaveLength(2);
    expect(err).toBeInstanceOf(OpenAI.InternalServerError);
    expect(err.status).toBe(500);
    expect(err.message).toBe("500 The server had an error while processing your request.");
    expect(classifyProviderFailure(err.code as string)).toBe("unavailable");
    expect(classifyProviderFailure(`http_${err.status as number}`)).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// The engine on top of the real SDK
// ---------------------------------------------------------------------------

describe("NativeEngine over the real OpenAI SDK", () => {
  it("records the provider-reported usage and cost for a completed turn", async () => {
    server.script(sseHandler([created(), textDelta("All done."), completed(BILLED_USAGE)]));

    const result = await new NativeEngine().run(engineContext(provider()));

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("All done.");
    expect(result.usage).toEqual({
      tokensIn: 2010,
      tokensOut: 205,
      cachedInputTokens: 2000,
      cacheWriteTokens: 1500,
      costUsd: expect.closeTo(BILLED_COST, 12),
    });
  });

  it("accumulates usage across a tool-call turn and the final turn", async () => {
    server.script(
      sseHandler([created(), ...functionCallEvents("call_1", "lookup", '{"q":"x"}'), completed(BILLED_USAGE)]),
      sseHandler([created(), textDelta("Found it."), completed(BILLED_USAGE)]),
    );
    const ctx = engineContext(provider());

    const result = await new NativeEngine().run(ctx);

    expect(result.status).toBe("succeeded");
    expect(ctx.runSandboxTool).toHaveBeenCalledWith("lookup", '{"q":"x"}', "call_1");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1].body.input).toEqual(
      expect.arrayContaining([
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
        expect.objectContaining({ type: "function_call_output", call_id: "call_1" }),
      ]),
    );
    expect(result.usage.tokensIn).toBe(4020);
    expect(result.usage.costUsd).toBeCloseTo(2 * BILLED_COST, 12);
  });

  it("records a response.incomplete turn's real cost, never $0", async () => {
    server.script(sseHandler([created(), textDelta("Partial answer"), incomplete("max_output_tokens", BILLED_USAGE)]));

    const result = await new NativeEngine().run(engineContext(provider()));

    expect(result.usage.costUsd).toBeCloseTo(BILLED_COST, 12);
    expect(result.usage.costUsd).toBeGreaterThan(0);
    expect(result.usage.tokensOut).toBe(205);
  });

  it("fails the run with the SDK's message on an HTTP error (no billed tokens, so $0 is correct)", async () => {
    server.script(
      jsonErrorHandler(429, {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      }),
    );

    const result = await new NativeEngine().run(engineContext(provider(0)));

    expect(result.status).toBe("failed");
    expect(result.error).toBe("429 You exceeded your current quota, please check your plan and billing details.");
    expect(result.usage.costUsd).toBe(0);
  });

  it("a mid-stream budget cut aborts the real HTTP request, then records the cost of what streamed", async () => {
    // A server that would stream forever: one delta every 5 ms until the
    // client hangs up, and never a terminal event.
    let deltasWritten = 0;
    let closedAfter: number | undefined;
    const MAX_DELTAS = 4000;
    server.script((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseBody([created()]));
      const timer = setInterval(() => {
        if (deltasWritten >= MAX_DELTAS) {
          clearInterval(timer);
          res.end(sseBody([completed(BILLED_USAGE)]));
          return;
        }
        deltasWritten += 1;
        res.write(sseBody([textDelta(" word")]));
      }, 5);
      res.on("close", () => {
        clearInterval(timer);
        closedAfter ??= deltasWritten;
      });
    });
    // $1 per output token: the cut lands after ~20 one-token deltas.
    const entry: CatalogEntry = {
      ...reasoningEntry(),
      inputPerMTok: 0.001,
      cachedInputPerMTok: 0.0001,
      cacheWritePerMTok: 0.00125,
      outputPerMTok: 1_000_000,
    };

    const result = await new NativeEngine().run(engineContext(provider(0, entry), { budgetUsd: 20 }));

    expect(result.status).toBe("budget_exhausted");
    // The estimated cost of what streamed is recorded, not $0...
    expect(result.usage.tokensOut).toBeGreaterThanOrEqual(19);
    expect(result.usage.costUsd).toBeGreaterThanOrEqual(19);
    // ...and the request is really gone: the server sees its response cut
    // off long before it would have finished, and no wind-down call follows.
    await vi.waitFor(() => expect(closedAfter).toBeDefined(), { timeout: 3000 });
    expect(closedAfter).toBeLessThan(MAX_DELTAS / 4);
    expect(server.abortedResponses).toBe(1);
    expect(server.requests).toHaveLength(1);
  });

  it("an abort from the caller mid-stream stops the request at the socket", async () => {
    let closed = false;
    server.script((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseBody([created(), textDelta("first")]));
      const timer = setInterval(() => res.write(sseBody([textDelta(" more")])), 5);
      res.on("close", () => {
        clearInterval(timer);
        closed = true;
      });
    });
    const controller = new AbortController();
    const seen: LlmStreamEvent[] = [];

    for await (const event of provider().stream(REQUEST, controller.signal)) {
      seen.push(event);
      if (seen.length === 3) {
        controller.abort();
        break;
      }
    }

    expect(seen).toHaveLength(3);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000 });
    expect(server.abortedResponses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Transport: which dispatcher carries OpenAI traffic
// ---------------------------------------------------------------------------

/** Reads an undici Agent's module-private options (see http-runtime.test.ts for why). */
function allowsH2(dispatcher: unknown): unknown {
  if (dispatcher === null || typeof dispatcher !== "object") return undefined;
  const key = Object.getOwnPropertySymbols(dispatcher).find((symbol) => symbol.description === "options");
  const options = key ? (dispatcher as Record<symbol, unknown>)[key] : undefined;
  return options && typeof options === "object" ? (options as Record<string, unknown>).allowH2 : undefined;
}

describe("OpenAI SDK transport", () => {
  /**
   * openai@5+ dropped node-fetch/agentkeepalive for the built-in fetch, so
   * its requests now ride the process-global dispatcher that
   * src/core/http-runtime.ts pins to an h1-only undici Agent (installed for
   * tests by vitest.setup.ts). If that dispatcher were h2-capable, the
   * Dispatcher1Wrapper header loss would strip content-encoding and
   * retry-after from OpenAI responses — so assert the SDK really goes
   * through it, and that it is the h1-only one. The replay server is
   * cleartext HTTP/1.1, so h2 is never negotiated here whatever the
   * dispatcher allows: the gzip body below only proves decoding through the
   * real fetch path, and the `allowsH2 === false` assertion is the h2 guard.
   */
  it("sends OpenAI requests through wardby's h1-only global dispatcher", async () => {
    const dispatcher = getGlobalDispatcher();
    expect(allowsH2(dispatcher)).toBe(false);
    const dispatch = vi.spyOn(dispatcher, "dispatch");
    try {
      server.script(sseHandler([created(), textDelta("via dispatcher"), completed(BILLED_USAGE)], { gzip: true }));

      const events = await collect(provider());

      expect(events.at(-1)).toMatchObject({ type: "done", usage: { costUsd: expect.closeTo(BILLED_COST, 12) } });
      const origin = new URL(server.baseURL).origin;
      const calls = dispatch.mock.calls.filter(([options]) => String(options.origin) === origin);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toMatchObject({ method: "POST", path: "/v1/responses" });
      expect(server.requests[0].httpVersion).toBe("1.1");
    } finally {
      dispatch.mockRestore();
    }
  });
});
