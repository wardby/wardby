import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLogLineFilter } from "../../core/logger.js";
import { SeenIds } from "../../core/run-steps/seen.js";
import type { StreamStepExtractor } from "../../core/run-steps/extract.js";
import type { RunStepsLevel } from "../../core/run-steps/config.js";
import type { RunStepBatch, RunStepSubmitter } from "../../core/run-steps/types.js";
import type { ModelPricing } from "../llm/pricing-core.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CLAUDE_CODE_ANTHROPIC_BETAS, CodingProxy, type ProxyResponseSink } from "./proxy.js";
import { RunStepForwarder } from "./run-step-forwarder.js";
import { logProxyAudit, startCodingProxyServer } from "./server.js";
import type { ProxyAuditEvent, ProxyLedger, ProxyProtocol } from "./types.js";

// Trace level for this file, so a log line below info is captured by the no-logging tests.
vi.hoisted(() => {
  process.env.LOG_LEVEL = "trace";
});

/** Faults the tests inject into the real extractors (passed through otherwise). */
const faults = vi.hoisted(() => ({
  stepsFromJson: false,
  resultsFromRequest: false,
  resultsCalls: 0,
}));
vi.mock("../../core/run-steps/extract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/run-steps/extract.js")>();
  return {
    ...actual,
    stepsFromJson: (...args: Parameters<typeof actual.stepsFromJson>) => {
      if (faults.stepsFromJson) throw new Error("extractor bug");
      return actual.stepsFromJson(...args);
    },
    resultsFromRequest: (...args: Parameters<typeof actual.resultsFromRequest>) => {
      faults.resultsCalls += 1;
      if (faults.resultsFromRequest) throw new Error("extractor bug");
      return actual.resultsFromRequest(...args);
    },
  };
});

const NOW = new Date("2026-11-07T12:00:00.000Z");
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2,
  outputPerMTok: 4,
};
// Fake values only: never a real credential.
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const FAKE_TOKEN = "ghp_FAKEfakeFAKEfake0123456789abcd";
const FAKE_SAID = "wbFake-Said-Value-c40e";
const stepsFixture = (name: string) =>
  readFile(new URL(`../../core/run-steps/fixtures/${name}`, import.meta.url), "utf8");

afterEach(() => {
  faults.stepsFromJson = false;
  faults.resultsFromRequest = false;
  faults.resultsCalls = 0;
  vi.restoreAllMocks();
});

class TestSink implements ProxyResponseSink {
  chunks: Buffer[] = [];
  ended = false;
  start() {}
  write(chunk: Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
  }
  end() {
    this.ended = true;
  }
  destroy() {}
  text() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/** Records every argument the proxy hands its ledger (the proxy's only database path). */
function recordingLedger(ledger: ProxyLedger, calls: unknown[]): ProxyLedger {
  return new Proxy(ledger, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function harness(
  protocol: ProxyProtocol,
  upstream: () => Response,
  opts: {
    steps?: RunStepSubmitter | null;
    createStepExtractor?: (protocol: ProxyProtocol) => StreamStepExtractor;
    deadlineMs?: number;
    runStepsLevel?: RunStepsLevel | null;
    runStepsCeiling?: RunStepsLevel;
    audit?: (event: ProxyAuditEvent) => void;
  } = {},
) {
  const events: ProxyAuditEvent[] = [];
  const ledgerCalls: unknown[] = [];
  const submitted: { capability: string; runId: string; batch: RunStepBatch }[] = [];
  const steps =
    opts.steps === null
      ? undefined
      : (opts.steps ?? {
          submit: (capability: string, runId: string, batch: RunStepBatch) =>
            void submitted.push({ capability, runId, batch }),
        });
  const proxy = new CodingProxy({
    ledger: recordingLedger(new MemoryProxyLedger({ now: () => NOW }), ledgerCalls),
    credentials: { resolve: async () => "UPSTREAM_SECRET" },
    fetch: vi.fn(async () => upstream()),
    now: () => NOW,
    pricing: () => PRICE,
    pricingVersion: "test-v1",
    audit: (event) => {
      events.push(event);
      opts.audit?.(event);
    },
    ...(opts.runStepsCeiling ? { runStepsCeiling: opts.runStepsCeiling } : {}),
    ...(steps ? { steps } : {}),
    ...(opts.createStepExtractor ? { createStepExtractor: opts.createStepExtractor } : {}),
  });
  const session = await proxy.createSession({
    runId: "run-steps-1",
    credentialRef: protocol === "anthropic-messages" ? "anthropic/project-a" : "openai/project-a",
    protocol,
    allowedModels: [protocol === "anthropic-messages" ? "claude-sonnet-5" : "test-model"],
    deadlineAt: new Date(NOW.getTime() + (opts.deadlineMs ?? 60_000)),
    budgetUsd: 1,
    ...(opts.runStepsLevel ? { runStepsLevel: opts.runStepsLevel } : {}),
  });
  const execute = async (rawBody: string, requestKey: string) => {
    const sink = new TestSink();
    await proxy.execute(
      {
        bearer: session.capability,
        protocol,
        rawBody,
        requestKey,
        anthropicBeta: protocol === "anthropic-messages" ? CLAUDE_CODE_ANTHROPIC_BETAS.join(",") : undefined,
      },
      sink,
    );
    return sink;
  };
  const stepBatches = () => submitted.filter((s) => s.batch.steps.length > 0);
  const resultBatches = () => submitted.filter((s) => s.batch.results.length > 0);
  return { proxy, events, ledgerCalls, submitted, session, execute, stepBatches, resultBatches };
}

const sse = (text: string) => () => new Response(text, { headers: { "content-type": "text/event-stream" } });
const anthropicFrame = (type: string, body: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;

function anthropicToolStream(said: string, command: string): string {
  const frame = anthropicFrame;
  return (
    frame("message_start", {
      message: {
        id: "msg_x",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-5",
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }) +
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: said } }) +
    frame("content_block_stop", { index: 0 }) +
    frame("content_block_start", {
      index: 1,
      content_block: { type: "tool_use", id: "toolu_x", name: "mcp__wardby_tools__run_command", input: {} },
    }) +
    frame("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) },
    }) +
    frame("content_block_stop", { index: 1 }) +
    frame("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) +
    frame("message_stop", {})
  );
}

describe("CodingProxy run steps", () => {
  it("relays a Claude Code stream byte for byte and hands its steps over with the run capability", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const h = await harness("anthropic-messages", sse(stream));
    const sink = await h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1");
    expect(sink.text()).toBe(stream);
    expect(sink.ended).toBe(true);
    expect(h.stepBatches()).toEqual([
      {
        capability: h.session.capability,
        runId: "run-steps-1",
        batch: {
          steps: [
            { kind: "said", callId: "said:msg_steps_1:1", text: "I'll run the test suite.", truncated: false },
            { kind: "tool", callId: "toolu_steps_1", tool: "Bash", text: "npm test", truncated: false },
          ],
          results: [],
        },
      },
    ]);
  });

  it("hands over the newest turn's results once per call id, though every request resends them", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const body = await stepsFixture("anthropic-tool-result-request.json");
    const h = await harness("anthropic-messages", sse(stream));
    await h.execute(body, "k1");
    await h.execute(body, "k2");
    expect(h.resultBatches().map((s) => s.batch.results)).toEqual([
      [
        { callId: "toolu_a", status: "ok" },
        { callId: "toolu_b", status: "exit 2" },
      ],
    ]);
    expect(h.resultBatches()[0].capability).toBe(h.session.capability);
  });

  it("relays a Codex stream byte for byte and hands over its steps and results", async () => {
    const stream = await stepsFixture("codex-responses-stream.txt");
    const { body } = JSON.parse(await stepsFixture("codex-tool-output-request.json"));
    const h = await harness("openai-responses", sse(stream));
    const sink = await h.execute(JSON.stringify(body), "k1");
    expect(sink.text()).toBe(stream);
    expect(h.stepBatches()[0].batch.steps.map((s) => (s.kind === "tool" ? `${s.tool}: ${s.text}` : s.text))).toEqual([
      "Running the tests now.",
      "Bash: npm test",
      "Bash: npm run lint",
      "exec: git status --short",
    ]);
    expect(h.stepBatches()[0].batch.steps.every((s) => !s.truncated)).toBe(true);
    expect(h.resultBatches()[0].batch.results).toEqual([
      { callId: "call_steps_1", status: "exit 1" },
      { callId: "call_steps_2", status: "ok" },
      { callId: "call_steps_3", status: "ok" },
    ]);
  });

  it("hands over a whole (non-stream) reply's steps", async () => {
    const reply = JSON.parse(await stepsFixture("anthropic-run-command-response.json"));
    const request = JSON.parse(await stepsFixture("anthropic-tool-result-request.json"));
    request.stream = false;
    const h = await harness("anthropic-messages", () => Response.json(reply));
    await h.execute(JSON.stringify(request), "k1");
    expect(h.stepBatches()[0].batch.steps.map((s) => s.callId)).toEqual(["said:msg_steps_2:0", "toolu_steps_2"]);
  });

  it("keeps relaying byte for byte when the stream extractor throws", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const throwing: StreamStepExtractor = {
      consume() {
        throw new Error("extractor bug");
      },
      take() {
        throw new Error("extractor bug");
      },
      finish() {
        throw new Error("extractor bug");
      },
    };
    const h = await harness("anthropic-messages", sse(stream), { createStepExtractor: () => throwing });
    const sink = await h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1");
    expect(sink.text()).toBe(stream);
    expect(sink.ended).toBe(true);
    expect(h.events.some((e) => e.type === "response.completed")).toBe(true);
    expect(h.stepBatches()).toEqual([]);
  });

  it("keeps relaying when building an extractor throws, or its finish throws after a good stream", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const body = await stepsFixture("anthropic-tool-result-request.json");
    const failing = await harness("anthropic-messages", sse(stream), {
      createStepExtractor: () => {
        throw new Error("extractor bug");
      },
    });
    expect((await failing.execute(body, "k1")).text()).toBe(stream);
    expect(failing.events.some((e) => e.type === "response.completed")).toBe(true);
    const lateThrow = await harness("anthropic-messages", sse(stream), {
      createStepExtractor: () => ({
        consume() {},
        take: () => [],
        finish() {
          throw new Error("extractor bug");
        },
      }),
    });
    const sink = await lateThrow.execute(body, "k1");
    expect(sink.text()).toBe(stream);
    expect(sink.ended).toBe(true);
    expect(lateThrow.stepBatches()).toEqual([]);
  });

  it("relays a whole (non-stream) reply byte for byte when its extractor throws", async () => {
    const replyText = await stepsFixture("anthropic-run-command-response.json");
    const request = JSON.parse(await stepsFixture("anthropic-tool-result-request.json"));
    request.stream = false;
    faults.stepsFromJson = true;
    faults.resultsFromRequest = true;
    const h = await harness(
      "anthropic-messages",
      () => new Response(replyText, { headers: { "content-type": "application/json" } }),
    );
    const sink = await h.execute(JSON.stringify(request), "k1");
    expect(sink.text()).toBe(replyText);
    expect(sink.ended).toBe(true);
    expect(h.events.some((e) => e.type === "response.completed")).toBe(true);
    expect(h.submitted).toEqual([]);
  });

  it("completes the request when handing steps over throws", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const h = await harness("anthropic-messages", sse(stream), {
      steps: {
        submit() {
          throw new Error("queue bug");
        },
      },
    });
    const sink = await h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1");
    expect(sink.text()).toBe(stream);
    expect(h.events.some((e) => e.type === "response.completed")).toBe(true);
  });

  it("reads results only from a request the proxy accepted", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const request = JSON.parse(await stepsFixture("anthropic-tool-result-request.json"));
    request.unreviewed_field = true;
    const h = await harness("anthropic-messages", sse(stream));
    await expect(h.execute(JSON.stringify(request), "k1")).rejects.toThrow();
    expect(faults.resultsCalls).toBe(0);
    expect(h.submitted).toEqual([]);
  });

  it("marks the reply's last text cut when the stream stops at max_tokens", async () => {
    const stream = (await stepsFixture("anthropic-run-command-stream.txt")).replace(
      '"stop_reason":"tool_use"',
      '"stop_reason":"max_tokens"',
    );
    // The fixture's last block is the tool call: drop it so the cut reply ends in text.
    const cutText = stream
      .split("\n\n")
      .filter((frame) => !frame.includes('"index":2'))
      .join("\n\n");
    const h = await harness("anthropic-messages", sse(cutText));
    const sink = await h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1");
    expect(sink.text()).toBe(cutText);
    expect(h.stepBatches()[0].batch.steps).toEqual([
      { kind: "said", callId: "said:msg_steps_1:1", text: "I'll run the test suite.", truncated: true },
    ]);
  });

  it("hands over a cut stream's text as truncated, while the request still fails as before", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    // Cut inside the text block: no content_block_stop, no message_stop.
    const cut = stream.slice(0, stream.indexOf(" test suite.") + 1);
    const h = await harness("anthropic-messages", sse(cut));
    await expect(h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1")).rejects.toThrow();
    expect(h.stepBatches()[0].batch.steps).toEqual([
      { kind: "said", callId: "said:msg_steps_1:1", text: "I'll run the", truncated: true },
    ]);
  });

  it("marks Codex's last message cut when the response ends incomplete", async () => {
    const frame = (type: string, body: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
    const stream =
      frame("response.created", { response: { id: "r1", status: "in_progress" } }) +
      frame("response.output_item.done", {
        item: { id: "m1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Half a" }] },
      }) +
      frame("response.incomplete", {
        response: {
          id: "r1",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 },
        },
      });
    const { body } = JSON.parse(await stepsFixture("codex-tool-output-request.json"));
    const h = await harness("openai-responses", sse(stream));
    const sink = await h.execute(JSON.stringify(body), "k1");
    expect(sink.text()).toBe(stream);
    expect(h.stepBatches()[0].batch.steps).toEqual([
      { kind: "said", callId: "said:m1", text: "Half a", truncated: true },
    ]);
  });

  it("forgets a session's seen results when the session ends", async () => {
    const forget = vi.spyOn(SeenIds.prototype, "forget");
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const body = await stepsFixture("anthropic-tool-result-request.json");
    const cancelled = await harness("anthropic-messages", sse(stream));
    await cancelled.execute(body, "k1");
    await cancelled.proxy.cancelSession(cancelled.session.id);
    expect(forget).toHaveBeenCalledWith(cancelled.session.id);
    // A request after the end is refused, and forgets the session again (another proxy replica
    // may have ended it).
    forget.mockClear();
    await expect(cancelled.execute(body, "k2")).rejects.toThrow("session_cancelled");
    expect(forget).toHaveBeenCalledWith(cancelled.session.id);
  });

  it("hands step text over raw and keeps it, and the capability, out of audit events and the ledger", async () => {
    const said = `Using ${FAKE_SAID} with ${FAKE_TOKEN}.`;
    const command = `curl -H "Authorization: token ${FAKE_TOKEN}" https://example.test/${FAKE_SECRET}`;
    const h = await harness("anthropic-messages", sse(anthropicToolStream(said, command)));
    await h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1");
    const sent = JSON.stringify(h.submitted);
    // Raw: the control plane redacts by exact value before writing (the proxy holds no secret values).
    expect(sent).toContain(FAKE_SECRET);
    expect(sent).toContain(FAKE_TOKEN);
    expect(sent).toContain(FAKE_SAID);
    for (const record of [JSON.stringify(h.events), JSON.stringify(h.ledgerCalls)]) {
      for (const value of [FAKE_SECRET, FAKE_TOKEN, FAKE_SAID, h.session.capability]) {
        expect(record).not.toContain(value);
      }
    }
  });

  describe("output tails need the session and the proxy ceiling both at detail", () => {
    const cases = [
      ["summary", "detail", false],
      ["detail", "summary", false],
      [null, "detail", false],
      ["detail", "detail", true],
    ] as const;
    const toolStream = (command: string) => sse(anthropicToolStream("Running.", command));
    const anthropicRequest = async (output: string) => {
      const body = JSON.parse(await stepsFixture("anthropic-tool-result-request.json"));
      body.messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "c1", content: `${output}\nexit_code=1` }],
      });
      return JSON.stringify(body);
    };
    const responsesRequest = (output: string) =>
      JSON.stringify({
        model: "test-model",
        stream: true,
        max_output_tokens: 100,
        input: [{ type: "function_call_output", call_id: "c1", output: `${output}\nExit code: 1` }],
      });

    it.each(cases)(
      "Claude Code, session %s under proxy ceiling %s: output and input sent = %s",
      async (level, ceiling, sent) => {
        const h = await harness("anthropic-messages", toolStream("npm test"), {
          runStepsLevel: level,
          runStepsCeiling: ceiling,
        });
        await h.execute(await anthropicRequest(`secret ${FAKE_SECRET}`), "k1");
        const results = h.submitted.flatMap((s) => s.batch.results);
        expect(results[0]?.status).toBeDefined();
        expect(results.some((r) => "output" in r)).toBe(sent);
        const toolSteps = h.submitted.flatMap((s) => s.batch.steps).filter((s) => s.kind === "tool");
        expect(toolSteps).not.toHaveLength(0);
        expect(toolSteps.some((s) => "input" in s)).toBe(sent);
      },
    );

    it.each(cases)("Codex, session %s under proxy ceiling %s: output sent = %s", async (level, ceiling, sent) => {
      const h = await harness("openai-responses", sse(await stepsFixture("codex-responses-stream.txt")), {
        runStepsLevel: level,
        runStepsCeiling: ceiling,
      });
      await h.execute(responsesRequest(`secret ${FAKE_SECRET}`), "k1");
      const results = h.submitted.flatMap((s) => s.batch.results);
      expect(results[0]?.status).toBe("exit 1");
      expect(results.some((r) => "output" in r)).toBe(sent);
      const toolSteps = h.submitted.flatMap((s) => s.batch.steps).filter((s) => s.kind === "tool");
      expect(toolSteps).not.toHaveLength(0);
      expect(toolSteps.some((s) => "input" in s)).toBe(sent);
    });

    it.each(cases)(
      "a whole (non-stream) reply, session %s under proxy ceiling %s: input sent = %s",
      async (level, ceiling, sent) => {
        const reply = JSON.parse(await stepsFixture("anthropic-run-command-response.json"));
        const request = JSON.parse(await stepsFixture("anthropic-tool-result-request.json"));
        request.stream = false;
        const h = await harness("anthropic-messages", () => Response.json(reply), {
          runStepsLevel: level,
          runStepsCeiling: ceiling,
        });
        await h.execute(JSON.stringify(request), "k1");
        const toolSteps = h.stepBatches()[0].batch.steps.filter((s) => s.kind === "tool");
        expect(toolSteps.map((s) => s.callId)).toEqual(["toolu_steps_2"]);
        expect(toolSteps.some((s) => "input" in s)).toBe(sent);
      },
    );

    it.each(["anthropic-messages", "openai-responses"] as const)(
      "%s: a session at off extracts and submits nothing",
      async (protocol) => {
        const create = vi.fn();
        const h = await harness(
          protocol,
          protocol === "anthropic-messages"
            ? toolStream("npm test")
            : sse(await stepsFixture("codex-responses-stream.txt")),
          { runStepsLevel: "off", runStepsCeiling: "detail", createStepExtractor: create },
        );
        await h.execute(protocol === "anthropic-messages" ? await anthropicRequest("x") : responsesRequest("x"), "k1");
        expect(h.submitted).toHaveLength(0);
        expect(create).not.toHaveBeenCalled();
        expect(faults.resultsCalls).toBe(0);
      },
    );

    it("a proxy ceiling of off reads nothing, whatever the session says", async () => {
      const h = await harness("anthropic-messages", toolStream("npm test"), {
        runStepsLevel: "detail",
        runStepsCeiling: "off",
      });
      await h.execute(await anthropicRequest("x"), "k1");
      expect(h.submitted).toHaveLength(0);
    });

    it("never logs or audits a tool output", async () => {
      const audit = vi.fn();
      const h = await harness("anthropic-messages", toolStream("npm test"), {
        runStepsLevel: "detail",
        runStepsCeiling: "detail",
        audit,
      });
      await h.execute(await anthropicRequest(`x ${FAKE_SECRET}`), "k1");
      expect(JSON.stringify(h.submitted)).toContain(FAKE_SECRET);
      expect(JSON.stringify(audit.mock.calls)).not.toContain(FAKE_SECRET);
      expect(JSON.stringify(h.ledgerCalls)).not.toContain(FAKE_SECRET);
    });

    it.each(["anthropic-messages", "openai-responses"] as const)(
      "writes no tool input or output to any log line or console call at trace level (%s)",
      async (protocol) => {
        const lines: string[] = [];
        const consoleCalls: unknown[][] = [];
        for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
          vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
        }
        setLogLineFilter((line) => {
          lines.push(line);
          return "";
        });
        try {
          const audit = vi.fn((event: Parameters<typeof logProxyAudit>[0]) => logProxyAudit(event));
          const h =
            protocol === "anthropic-messages"
              ? await harness("anthropic-messages", toolStream(`echo ${FAKE_SECRET}`), {
                  runStepsLevel: "detail",
                  runStepsCeiling: "detail",
                  audit,
                })
              : await harness(
                  "openai-responses",
                  sse((await stepsFixture("codex-responses-stream.txt")).replaceAll("npm test", `echo ${FAKE_SECRET}`)),
                  { runStepsLevel: "detail", runStepsCeiling: "detail", audit },
                );
          await h.execute(
            protocol === "anthropic-messages"
              ? await anthropicRequest(`x ${FAKE_SECRET}`)
              : responsesRequest(`x ${FAKE_SECRET}`),
            "k1",
          );
          // Both fields reach the submitter, so the log check below is not vacuous.
          const tools = h.submitted.flatMap((s) => s.batch.steps).filter((s) => s.kind === "tool");
          expect(tools.some((s) => s.input?.includes(FAKE_SECRET))).toBe(true);
          expect(h.submitted.flatMap((s) => s.batch.results).some((r) => r.output?.includes(FAKE_SECRET))).toBe(true);
        } finally {
          setLogLineFilter((line) => line);
        }
        // Trace level (LOG_LEVEL is set for this file), so a debug or trace line would show here.
        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join("")).not.toContain(FAKE_SECRET);
        expect(JSON.stringify(consoleCalls)).not.toContain(FAKE_SECRET);
      },
    );
  });

  it("rejects an unknown run steps level when creating a session", async () => {
    const h = await harness("anthropic-messages", sse(""));
    await expect(
      h.proxy.createSession({
        runId: "run-x",
        credentialRef: "anthropic/project-a",
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-5"],
        deadlineAt: new Date(NOW.getTime() + 60_000),
        budgetUsd: 1,
        runStepsLevel: "bogus" as RunStepsLevel,
      }),
    ).rejects.toThrow("invalid_proxy_run_steps_level");
  });

  it("does no step work without a steps option", async () => {
    const stream = await stepsFixture("anthropic-run-command-stream.txt");
    const create = vi.fn();
    const h = await harness("anthropic-messages", sse(stream), { steps: null, createStepExtractor: create });
    const sink = await h.execute(await stepsFixture("anthropic-tool-result-request.json"), "k1");
    expect(sink.text()).toBe(stream);
    expect(create).not.toHaveBeenCalled();
    expect(faults.resultsCalls).toBe(0);
  });
});

describe("CodingProxy run steps over HTTP", () => {
  it("writes no step text, body or capability to any proxy log line, even when delivery fails", async () => {
    const lines: string[] = [];
    setLogLineFilter((line) => {
      lines.push(line);
      return "";
    });
    try {
      const posted: string[] = [];
      const forwarder = new RunStepForwarder({
        url: "http://run-steps.test",
        // The control plane refuses: the forwarder logs its drop.
        fetchImpl: (async (_url: string, init: RequestInit) => {
          posted.push(init.body as string);
          return new Response(`echo ${init.body as string}`, { status: 500 });
        }) as unknown as typeof fetch,
      });
      const said = `Using ${FAKE_SAID}.`;
      const command = `echo ${FAKE_SECRET} ${FAKE_TOKEN}`;
      const proxy = new CodingProxy({
        ledger: new MemoryProxyLedger(),
        credentials: { resolve: async () => "UPSTREAM_SECRET" },
        fetch: vi.fn(async () => sse(anthropicToolStream(said, command))()),
        pricing: () => PRICE,
        audit: (event) => logProxyAudit(event),
        steps: forwarder,
      });
      const session = await proxy.createSession({
        runId: "run-steps-http",
        credentialRef: "anthropic/project-a",
        protocol: "anthropic-messages",
        allowedModels: ["claude-sonnet-5"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
      });
      const server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port: 0 });
      try {
        const body = await stepsFixture("anthropic-tool-result-request.json");
        const call = (requestBody: string) =>
          fetch(`http://127.0.0.1:${server.port}/v1/messages?beta=true`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": session.capability,
              "anthropic-beta": CLAUDE_CODE_ANTHROPIC_BETAS.join(","),
            },
            body: requestBody,
          });
        const ok = await call(body);
        expect(ok.status).toBe(200);
        await ok.text();
        // A refused request logs too: its body carries the fake values.
        const refused = await call(body.replace('"messages"', `"${FAKE_SECRET}": 1, "messages"`));
        expect(refused.status).toBe(400);
        await refused.text();
        await forwarder.flush();
      } finally {
        await server.close();
        await forwarder.close();
      }
      expect(posted.join("")).toContain(FAKE_SECRET);
      const logged = lines.join("");
      expect(logged).toContain("run_steps.forward_dropped");
      expect(logged).toContain("audit.response.completed");
      for (const value of [FAKE_SECRET, FAKE_TOKEN, FAKE_SAID, session.capability, "toolu_x", "curl", "echo "]) {
        expect(logged).not.toContain(value);
      }
    } finally {
      setLogLineFilter((line) => line);
    }
  });
});
