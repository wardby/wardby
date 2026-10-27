/**
 * Release invariant 1: metering under faults. A reply whose stream breaks before its final usage
 * is settled at an estimate, and that estimate must hold up wherever the break lands:
 *
 * - the settled output is at least what was relayed before the cut (ceil(bytes / 3)), unless the
 *   upstream had already reported its own running count (Anthropic message_delta);
 * - the settled cost never exceeds the request's worst case (its ceiling, else its hold);
 * - an unknown output (nothing relayed, nothing reported) settles at the run's median completed
 *   reply, or at no output when there is none yet (#371's rule, kept by #425); the input is still
 *   booked, so the estimate is never $0.
 *
 * Matrix: protocol (Anthropic Messages, OpenAI Responses) x every delta kind that is generated
 * output (and one that is not) x every event boundary x run history (none, one completed reply),
 * plus a cut inside a frame. Streams are generated from a fixed seed. The native gateway's
 * streamModel gets the same cuts over its provider events. Each case also sweeps the upstream
 * credential: it must reach no response, ledger row, audit event or log line.
 */
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryProxyLedger } from "../providers/coding-proxy/memory-ledger.js";
import { relayedOutputTokens } from "../providers/coding-proxy/interrupted.js";
import {
  CLAUDE_CODE_ANTHROPIC_BETAS,
  CodingProxy,
  type CreatedCodingProxySession,
  type ProxyResponseSink,
} from "../providers/coding-proxy/proxy.js";
import type { ProxyAuditEvent, ProxyProtocol, ProxyRequest } from "../providers/coding-proxy/types.js";
import type { ModelPricing } from "../providers/llm/pricing-core.js";
import type { LlmProvider, LlmStreamEvent } from "../providers/llm/types.js";
import { streamModel } from "../native-worker/gateway-server.js";
import { forAll, type Rng } from "./seeded.test-support.js";
import { secretSweep, type SecretSweep } from "./secret-sweep.test-support.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2,
  outputPerMTok: 4,
};
/** Within a rounding step of the ledger's 6-decimal arithmetic. */
const EPSILON = 1e-9;

let sweep: SecretSweep | undefined;
afterEach(() => {
  sweep?.dispose();
  sweep = undefined;
});

class Sink implements ProxyResponseSink {
  chunks: Buffer[] = [];
  start() {}
  write(chunk: Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
  }
  end() {}
  destroy() {}
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

const frame = (data: Record<string, unknown>) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;

/** One generated reply: its SSE frames, and for each frame the output bytes it relays. */
interface Reply {
  frames: string[];
  outputBytes: number[];
  /** Index of the frame carrying the upstream's own running output count (Anthropic message_delta). */
  reportedAt?: number;
  reportedTokens?: number;
  /** Anthropic message_start's placeholder output count (0 or 1). */
  startOutputTokens?: number;
}

const ANTHROPIC_DELTAS = ["text_delta", "input_json_delta", "thinking_delta", "signature_delta"] as const;
const OPENAI_DELTAS = [
  "response.output_text.delta",
  "response.refusal.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
] as const;

function words(r: Rng, min: number, max: number): string {
  // Multi-byte characters too: the estimate counts UTF-8 bytes.
  return r.string(r.int(min, max), 'abcdefghij klmnopqrstuvwxyz{}":,é漢');
}

function anthropicReply(r: Rng, kinds: readonly (typeof ANTHROPIC_DELTAS)[number][]): Reply {
  const frames: string[] = [];
  const outputBytes: number[] = [];
  const push = (data: Record<string, unknown>, bytes = 0) => {
    frames.push(frame(data));
    outputBytes.push(bytes);
  };
  const startOutputTokens = r.pick([0, 1]);
  push({
    type: "message_start",
    message: {
      usage: {
        input_tokens: r.int(10, 5_000),
        cache_read_input_tokens: r.int(0, 20_000),
        cache_creation_input_tokens: r.int(0, 2_000),
        // A placeholder, not a running count.
        output_tokens: startOutputTokens,
      },
    },
  });
  push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const kind of kinds) {
    const text = words(r, 1, 400);
    if (kind === "text_delta")
      push({ type: "content_block_delta", index: 0, delta: { type: kind, text } }, Buffer.byteLength(text));
    else if (kind === "input_json_delta")
      push(
        { type: "content_block_delta", index: 0, delta: { type: kind, partial_json: text } },
        Buffer.byteLength(text),
      );
    else if (kind === "thinking_delta")
      push({ type: "content_block_delta", index: 0, delta: { type: kind, thinking: text } }, Buffer.byteLength(text));
    // A signature is not generated output.
    else push({ type: "content_block_delta", index: 0, delta: { type: kind, signature: text } }, 0);
  }
  push({ type: "content_block_stop", index: 0 });
  const reportedTokens = r.int(1, 3_000);
  push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: reportedTokens } });
  const reportedAt = frames.length - 1;
  push({ type: "message_stop" });
  return { frames, outputBytes, reportedAt, reportedTokens, startOutputTokens };
}

function openaiReply(r: Rng, kinds: readonly (typeof OPENAI_DELTAS)[number][]): Reply {
  const frames: string[] = [];
  const outputBytes: number[] = [];
  frames.push(frame({ type: "response.created", response: { id: "resp" } }));
  outputBytes.push(0);
  for (const kind of kinds) {
    const delta = words(r, 1, 400);
    frames.push(frame({ type: kind, delta }));
    outputBytes.push(Buffer.byteLength(delta));
  }
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 };
  frames.push(frame({ type: "response.completed", response: { usage } }));
  outputBytes.push(0);
  return { frames, outputBytes };
}

const anthropicBody = () =>
  readFile(new URL("../providers/coding-proxy/fixtures/anthropic-sdk-request.json", import.meta.url), "utf8");
const OPENAI_MAX_OUTPUT = 2_000;
/** A complete Anthropic stream: the reply a run with history completed before the cut. */
const ANTHROPIC_COMPLETE = await readFile(
  new URL("../providers/coding-proxy/fixtures/anthropic-message-stream.txt", import.meta.url),
  "utf8",
);
const openaiBody = () =>
  JSON.stringify({ model: "test-model", input: "hello", max_output_tokens: OPENAI_MAX_OUTPUT, stream: true });

async function proxyFor(protocol: ProxyProtocol, credential: string, respond: () => Response) {
  const ledger = new MemoryProxyLedger({ now: () => NOW });
  const events: ProxyAuditEvent[] = [];
  const proxy = new CodingProxy({
    ledger,
    credentials: { resolve: async () => credential },
    fetch: async () => respond(),
    now: () => NOW,
    pricing: () => PRICE,
    pricingVersion: "release-v1",
    audit: (event) => events.push(event),
  });
  const session: CreatedCodingProxySession = await proxy.createSession({
    runId: `run-${protocol}`,
    credentialRef: protocol === "anthropic-messages" ? "anthropic/project-a" : "openai/project-a",
    protocol,
    allowedModels: [protocol === "anthropic-messages" ? "claude-sonnet-5" : "test-model"],
    deadlineAt: new Date(NOW.getTime() + 60_000),
    budgetUsd: 1_000,
  });
  const execute = (key: string, body: string, sink = new Sink()) =>
    proxy
      .execute(
        {
          bearer: session.capability,
          protocol,
          rawBody: body,
          requestKey: key,
          anthropicBeta: protocol === "anthropic-messages" ? CLAUDE_CODE_ANTHROPIC_BETAS.join(",") : undefined,
        },
        sink,
      )
      .then(
        () => ({ sink, error: undefined as unknown }),
        (error: unknown) => ({ sink, error }),
      );
  return { ledger, events, execute };
}

const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

interface CutCase {
  protocol: ProxyProtocol;
  reply: Reply;
  /** Frames delivered whole before the cut. */
  delivered: number;
  /** Bytes of the next frame delivered as well (a cut inside a frame). */
  partialBytes: number;
  history: boolean;
}

/** Runs one cut and checks the settled request; returns it for the caller's own checks. */
async function runCut(c: CutCase): Promise<ProxyRequest | null> {
  sweep = secretSweep(c.delivered * 7919 + c.partialBytes);
  const credential = sweep.plant("upstream credential", c.protocol === "anthropic-messages" ? "api-key" : "password");
  const cutText =
    c.reply.frames.slice(0, c.delivered).join("") + (c.reply.frames[c.delivered] ?? "").slice(0, c.partialBytes);
  let call = 0;
  const complete =
    c.protocol === "anthropic-messages"
      ? () => sse(ANTHROPIC_COMPLETE)
      : () =>
          sse(
            frame({ type: "response.output_text.delta", delta: "ok" }) +
              frame({
                type: "response.completed",
                response: { usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } },
              }),
          );
  const { ledger, events, execute } = await proxyFor(c.protocol, credential, () => {
    call += 1;
    return c.history && call === 1 ? complete() : sse(cutText);
  });
  const body = c.protocol === "anthropic-messages" ? await anthropicBody() : openaiBody();
  if (c.history) {
    const first = await execute("history", body);
    expect(first.error).toBeUndefined();
    sweep.record("history response", first.sink.text());
  }
  const cut = await execute("cut", body);
  sweep.record("cut response", cut.sink.text());
  sweep.record("cut error", cut.error ?? "");
  sweep.record("audit events", events);
  const reservedId = events.filter((e) => e.type === "request.reserved").at(-1)?.requestId;
  const request = reservedId ? await ledger.getRequest(reservedId) : null;
  sweep.record("ledger row", request);
  sweep.assertClean();
  return request;
}

function checkSettled(c: CutCase, request: ProxyRequest | null) {
  const relayedBytes = c.reply.outputBytes.slice(0, c.delivered).reduce((a, b) => a + b, 0);
  const relayed = relayedOutputTokens(relayedBytes);
  const reported = c.reply.reportedAt !== undefined && c.delivered > c.reply.reportedAt;
  expect(request, "the cut request has a ledger row").not.toBeNull();
  expect(request!.status).toBe("uncertain");
  expect(request!.costEstimated, "an estimate could be made").toBe(true);
  const output = request!.usage!.outputTokens;
  // 1. Never below what was relayed, unless the upstream reported its own count.
  if (reported) expect(output).toBe(c.reply.reportedTokens);
  else expect(output).toBeGreaterThanOrEqual(relayed);
  // 2. Never above the request's worst case.
  const worst = Math.max(request!.reservationUsd, request!.ceilingUsd ?? 0);
  expect(request!.actualCostUsd!).toBeLessThanOrEqual(worst + EPSILON);
  // 3. An unknown output (no relayed output, no reported count) settles at the run's median
  //    completed reply, or at no output with no run history (#371); the input is still booked.
  if (!reported && relayed === 0) {
    // message_start's placeholder count, once read, is a floor (#425), never the estimate itself.
    const floor = c.protocol === "anthropic-messages" && c.delivered >= 1 ? (c.reply.startOutputTokens ?? 0) : 0;
    if (c.history) expect(output).toBeGreaterThan(0);
    else expect(output).toBe(floor);
    expect(request!.actualCostUsd!).toBeGreaterThan(0);
  }
}

describe("metering under faults: the coding proxy", () => {
  it("Anthropic Messages: a cut at every event boundary and inside a frame, for every delta kind, with and without run history", async () => {
    let cases = 0;
    await forAll("metering.anthropic", 6, async (r) => {
      const kinds = r.shuffle([
        ...ANTHROPIC_DELTAS,
        ...Array.from({ length: r.int(0, 4) }, () => r.pick(ANTHROPIC_DELTAS)),
      ]);
      const reply = anthropicReply(r, kinds);
      // The last frame is message_stop: a stream that delivers it is complete, not cut.
      for (let delivered = 0; delivered < reply.frames.length; delivered++) {
        for (const history of [false, true]) {
          const partialBytes = r.bool(0.3) ? r.int(1, Math.max(1, reply.frames[delivered].length - 3)) : 0;
          const c: CutCase = { protocol: "anthropic-messages", reply, delivered, partialBytes, history };
          checkSettled(c, await runCut(c));
          cases += 1;
        }
      }
    });
    expect(cases).toBeGreaterThan(60);
  });

  it("OpenAI Responses: a cut at every event boundary and inside a frame, for every output delta kind, with and without run history", async () => {
    let cases = 0;
    await forAll("metering.openai", 6, async (r) => {
      const kinds = r.shuffle([...OPENAI_DELTAS, ...Array.from({ length: r.int(0, 4) }, () => r.pick(OPENAI_DELTAS))]);
      const reply = openaiReply(r, kinds);
      for (let delivered = 0; delivered < reply.frames.length; delivered++) {
        for (const history of [false, true]) {
          const partialBytes = r.bool(0.3) ? r.int(1, Math.max(1, reply.frames[delivered].length - 3)) : 0;
          const c: CutCase = { protocol: "openai-responses", reply, delivered, partialBytes, history };
          checkSettled(c, await runCut(c));
          cases += 1;
        }
      }
    });
    expect(cases).toBeGreaterThan(60);
  });
});

describe("metering under faults: the native gateway", () => {
  const HOLD_INPUT_TOKENS = 100;
  type Ledger = Parameters<typeof streamModel>[1];
  type Ctx = Parameters<typeof streamModel>[0];

  function recordingLedger(median?: number) {
    const calls: Array<{ kind: string; usage?: { outputTokens: number; costUsd: number } }> = [];
    let reservationUsd = 0;
    const ledger = {
      reserve: async (input: { reservationUsd: number }) => {
        reservationUsd = input.reservationUsd;
        return { outcome: "reserved" as const };
      },
      complete: async (_s: string, _c: string, usage: { outputTokens: number; costUsd: number }) => {
        calls.push({ kind: "complete", usage });
      },
      release: async () => {
        calls.push({ kind: "release" });
      },
      markUncertain: async (_s: string, _c: string, usage?: { outputTokens: number; costUsd: number }) => {
        calls.push({ kind: "uncertain", usage });
      },
      medianOutputTokens: async () => median,
    };
    return { ledger: ledger as unknown as Ledger, calls, hold: () => reservationUsd };
  }

  function providerEvents(r: Rng): LlmStreamEvent[] {
    return Array.from({ length: r.int(1, 6) }, (): LlmStreamEvent =>
      r.bool()
        ? { type: "text", delta: words(r, 1, 300) }
        : { type: "tool_call", id: `t${r.int(1, 9)}`, name: "read", argsJson: JSON.stringify({ p: words(r, 1, 300) }) },
    );
  }

  function llmCutAfter(events: LlmStreamEvent[], cutAt: number, counting: boolean, started = true): LlmProvider {
    let counted = 0;
    return {
      countTokens: async (_model: string, messages: Array<{ content: unknown }>) => {
        counted += 1;
        if (counted === 1) return HOLD_INPUT_TOKENS;
        if (!counting) throw new Error("tokenizer unavailable");
        // A tokenizer that counts four bytes a token.
        const content = messages[0]?.content;
        return Math.ceil(Buffer.byteLength(typeof content === "string" ? content : JSON.stringify(content)) / 4);
      },
      priceUsd: (_model: string, usage: { inputTokens: number; outputTokens: number }) =>
        (usage.inputTokens * PRICE.inputPerMTok + usage.outputTokens * PRICE.outputPerMTok) / 1e6,
      async *stream(_req: unknown, _signal?: AbortSignal, hooks?: { onResponseStarted?: () => void }) {
        if (started) hooks?.onResponseStarted?.();
        for (const event of events.slice(0, cutAt)) yield event;
        throw new Error("upstream reset");
      },
    };
  }

  const ctxFor = (llm: LlmProvider) =>
    ({ session: { id: "sess" }, snapshot: { input: { agent: { model: "m" } } }, llm }) as unknown as Ctx;
  const params = { request: { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8_000 } };

  async function drain(events: AsyncIterable<LlmStreamEvent>) {
    try {
      for await (const _event of events) void _event;
    } catch {
      // The cut itself.
    }
  }

  it("a cut after any provider event settles at least the streamed output, never above the hold", async () => {
    let cases = 0;
    await forAll("metering.gateway", 25, async (r) => {
      const events = providerEvents(r);
      for (let cutAt = 1; cutAt <= events.length; cutAt++) {
        for (const counting of [true, false]) {
          const { ledger, calls, hold } = recordingLedger();
          await drain(streamModel(ctxFor(llmCutAfter(events, cutAt, counting)), ledger, `c${cases}`, params));
          const streamed = events
            .slice(0, cutAt)
            .map((e) => (e.type === "text" ? e.delta : e.type === "tool_call" ? e.name + e.argsJson : ""))
            .join("");
          const floor = counting
            ? Math.ceil(Buffer.byteLength(streamed) / 4)
            : relayedOutputTokens(Buffer.byteLength(streamed));
          expect(calls).toHaveLength(1);
          expect(calls[0].kind).toBe("uncertain");
          expect(calls[0].usage!.outputTokens).toBeGreaterThanOrEqual(floor);
          expect(calls[0].usage!.costUsd).toBeLessThanOrEqual(hold() + EPSILON);
          cases += 1;
        }
      }
    });
    expect(cases).toBeGreaterThan(100);
  });

  // Finding R1 is settled by #425 and the #371 rule: a call cut before its response started was
  // billed nothing and releases its hold; once started, an unknown output settles at the run's
  // median completed call, or at no output before the first one, and the input is still booked.
  it("a cut before the response started releases the hold: the provider billed nothing", async () => {
    const { ledger, calls } = recordingLedger();
    await drain(streamModel(ctxFor(llmCutAfter([], 0, true, false)), ledger, "c-unstarted", params));
    expect(calls).toEqual([{ kind: "release" }]);
  });

  it("a cut after the response started, before any event, books the input and no output with no history", async () => {
    const { ledger, calls, hold } = recordingLedger();
    await drain(streamModel(ctxFor(llmCutAfter([], 0, true)), ledger, "c-first", params));
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("uncertain");
    expect(calls[0].usage!.outputTokens).toBe(0);
    expect(calls[0].usage!.costUsd).toBeGreaterThan(0);
    expect(calls[0].usage!.costUsd).toBeLessThanOrEqual(hold() + EPSILON);
  });

  it("a cut after the response started, before any event, books the run's median output when there is one", async () => {
    const { ledger, calls, hold } = recordingLedger(700);
    await drain(streamModel(ctxFor(llmCutAfter([], 0, true)), ledger, "c-median", params));
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("uncertain");
    expect(calls[0].usage!.outputTokens).toBe(700);
    expect(calls[0].usage!.costUsd).toBeLessThanOrEqual(hold() + EPSILON);
  });
});
