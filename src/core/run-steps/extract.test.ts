import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AnthropicStreamSteps,
  MAX_RESULTS_PER_REQUEST,
  OpenAiStreamSteps,
  resultsFromRequest,
  statusFromOutput,
  stepsFromJson,
  streamStepExtractor,
  type StreamStepExtractor,
} from "./extract.js";
import { MAX_STEP_TEXT_CHARS } from "./types.js";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const frame = (type: string, body: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}`;
function feed(extractor: StreamStepExtractor, sse: string) {
  for (const part of sse.split("\n\n")) if (part) extractor.consume(part);
  return extractor.take();
}

describe("AnthropicStreamSteps", () => {
  it("emits a Claude Code reply's text and its command as a Bash step, and skips thinking", async () => {
    const extractor = new AnthropicStreamSteps();
    expect(feed(extractor, await fixture("anthropic-run-command-stream.txt"))).toEqual([
      { kind: "said", callId: "said:msg_steps_1:1", text: "I'll run the test suite.", truncated: false },
      { kind: "tool", callId: "toolu_steps_1", tool: "Bash", text: "npm test", truncated: false },
    ]);
    expect(extractor.take()).toEqual([]);
  });

  it("buffers at most 16 KiB of a block's input and still finds the command", () => {
    const extractor = new AnthropicStreamSteps();
    const input = `{"command": "echo ${"x".repeat(40_000)}"}`;
    extractor.consume(
      frame("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "mcp__wardby_tools__run_command", input: {} },
      }),
    );
    for (let at = 0; at < input.length; at += 1000) {
      extractor.consume(
        frame("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: input.slice(at, at + 1000) },
        }),
      );
    }
    extractor.consume(frame("content_block_stop", { index: 0 }));
    const [step] = extractor.take();
    expect(step).toMatchObject({ kind: "tool", callId: "t1", tool: "Bash", truncated: true });
    expect(step.text.startsWith("echo xxx")).toBe(true);
    expect(step.text.length).toBeLessThanOrEqual(MAX_STEP_TEXT_CHARS);
  });

  it.each([
    "",
    "data: {not json",
    'data: {"type":"content_block_delta","index":9,"delta":{}}',
    'data: {"type":"content_block_start","index":"x"}',
    "data: [DONE]",
    "event: x\ndata: []",
    ": a comment",
  ])("ignores %j without throwing", (input) => {
    const extractor = new AnthropicStreamSteps();
    expect(() => extractor.consume(input)).not.toThrow();
    expect(extractor.take()).toEqual([]);
  });
});

describe("OpenAiStreamSteps", () => {
  it("emits Codex's message, exec_command calls (cmd as a string and as argv) and code-mode exec", async () => {
    expect(feed(new OpenAiStreamSteps(), await fixture("codex-responses-stream.txt"))).toEqual([
      { kind: "said", callId: "said:msg_steps_1", text: "Running the tests now.", truncated: false },
      { kind: "tool", callId: "call_steps_1", tool: "exec_command", text: "npm test", truncated: false },
      { kind: "tool", callId: "call_steps_2", tool: "exec_command", text: "npm run lint", truncated: false },
      { kind: "tool", callId: "call_steps_3", tool: "exec", text: "git status --short", truncated: false },
    ]);
  });

  it("names a worker MCP call by its tool, and ignores frames it can't read", () => {
    const extractor = new OpenAiStreamSteps();
    extractor.consume(
      frame("response.output_item.done", {
        item: {
          type: "function_call",
          call_id: "m1",
          name: "echo",
          namespace: "mcp__wardby_mcp",
          arguments: '{"text":"hi"}',
        },
      }),
    );
    extractor.consume("event: response.output_item.done\ndata: {broken");
    expect(extractor.take()).toEqual([{ kind: "tool", callId: "m1", tool: "mcp:echo", text: "hi", truncated: false }]);
  });

  it("marks a code-mode input cut where later lines are dropped", () => {
    const extractor = new OpenAiStreamSteps();
    extractor.consume(
      frame("response.output_item.done", {
        item: { type: "custom_tool_call", call_id: "c1", name: "exec", input: "const a = 1;\nconst b = 2;" },
      }),
    );
    expect(extractor.take()).toEqual([
      { kind: "tool", callId: "c1", tool: "exec", text: "const a = 1;", truncated: true },
    ]);
  });

  it("keeps at most 64 blocks open and names a message without an id uniquely", () => {
    const extractor = new AnthropicStreamSteps();
    for (let index = 0; index < 70; index++) {
      extractor.consume(frame("content_block_start", { index, content_block: { type: "text", text: "hi" } }));
      extractor.consume(frame("content_block_stop", { index }));
    }
    for (let index = 0; index < 70; index++) {
      extractor.consume(
        frame("content_block_start", { index: 100 + index, content_block: { type: "text", text: "hi" } }),
      );
    }
    for (let index = 0; index < 70; index++) extractor.consume(frame("content_block_stop", { index: 100 + index }));
    expect(extractor.take()).toHaveLength(70 + 64);
    const first = new AnthropicStreamSteps();
    const second = new AnthropicStreamSteps();
    for (const e of [first, second]) {
      e.consume(frame("content_block_start", { index: 0, content_block: { type: "text", text: "hi" } }));
      e.consume(frame("content_block_stop", { index: 0 }));
    }
    expect(first.take()[0].callId).not.toBe(second.take()[0].callId);
  });

  it("marks the reply's last text cut when the stream stops at max_tokens or ends without message_stop", async () => {
    const stream = await fixture("anthropic-run-command-stream.txt");
    const whole = new AnthropicStreamSteps();
    for (const part of stream.split("\n\n")) if (part) whole.consume(part);
    expect(whole.finish().map((s) => s.truncated)).toEqual([false, false]);

    const capped = new AnthropicStreamSteps();
    capped.consume(frame("message_start", { message: { id: "m1" } }));
    capped.consume(frame("content_block_start", { index: 0, content_block: { type: "text", text: "First." } }));
    capped.consume(frame("content_block_stop", { index: 0 }));
    capped.consume(frame("content_block_start", { index: 1, content_block: { type: "text", text: "Half a sen" } }));
    capped.consume(frame("content_block_stop", { index: 1 }));
    capped.consume(frame("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } }));
    capped.consume(frame("message_stop", {}));
    expect(capped.finish()).toEqual([
      { kind: "said", callId: "said:m1:0", text: "First.", truncated: false },
      { kind: "said", callId: "said:m1:1", text: "Half a sen", truncated: true },
    ]);

    const cut = new AnthropicStreamSteps();
    cut.consume(frame("message_start", { message: { id: "m2" } }));
    cut.consume(frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    cut.consume(frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Still writ" } }));
    cut.consume(
      frame("content_block_start", {
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
      }),
    );
    // The open text is kept as cut; the open tool call never ran, so it is no step.
    expect(cut.take()).toEqual([]);
    expect(cut.finish()).toEqual([{ kind: "said", callId: "said:m2:0", text: "Still writ", truncated: true }]);
    expect(cut.finish()).toEqual([]);

    // Text that names a terminal event is still text.
    const named = new AnthropicStreamSteps();
    named.consume(frame("message_start", { message: { id: "m3" } }));
    named.consume(frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    named.consume(frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "a message_stop" } }));
    named.consume(frame("content_block_stop", { index: 0 }));
    expect(named.finish()).toEqual([{ kind: "said", callId: "said:m3:0", text: "a message_stop", truncated: true }]);
  });

  it("marks Codex's last message cut when the response is incomplete or never completes", async () => {
    const stream = await fixture("codex-responses-stream.txt");
    const whole = new OpenAiStreamSteps();
    for (const part of stream.split("\n\n")) if (part) whole.consume(part);
    expect(whole.finish().every((s) => !s.truncated)).toBe(true);

    const message = (id: string, text: string, status = "completed") =>
      frame("response.output_item.done", {
        item: { id, type: "message", role: "assistant", status, content: [{ type: "output_text", text }] },
      });
    const incomplete = new OpenAiStreamSteps();
    incomplete.consume(message("m1", "Half a sen", "incomplete"));
    incomplete.consume(
      frame("response.incomplete", {
        response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
      }),
    );
    expect(incomplete.finish()).toEqual([{ kind: "said", callId: "said:m1", text: "Half a sen", truncated: true }]);

    const cut = new OpenAiStreamSteps();
    cut.consume(message("m2", "Done. response.completed"));
    expect(cut.finish()).toEqual([
      { kind: "said", callId: "said:m2", text: "Done. response.completed", truncated: true },
    ]);
  });

  it("is what streamStepExtractor builds for each protocol", () => {
    expect(streamStepExtractor("openai-responses")).toBeInstanceOf(OpenAiStreamSteps);
    expect(streamStepExtractor("anthropic-messages")).toBeInstanceOf(AnthropicStreamSteps);
  });
});

describe("stepsFromJson", () => {
  it("reads whole replies of both protocols", async () => {
    expect(
      stepsFromJson("anthropic-messages", JSON.parse(await fixture("anthropic-run-command-response.json"))),
    ).toEqual([
      { kind: "said", callId: "said:msg_steps_2:0", text: "Checking the build.", truncated: false },
      { kind: "tool", callId: "toolu_steps_2", tool: "Bash", text: "npm run build", truncated: false },
    ]);
    expect(
      stepsFromJson("openai-responses", {
        output: [
          { type: "reasoning", summary: [] },
          { type: "function_call", call_id: "c9", name: "exec_command", arguments: '{"cmd":"make"}' },
        ],
      }),
    ).toEqual([{ kind: "tool", callId: "c9", tool: "exec_command", text: "make", truncated: false }]);
    expect(stepsFromJson("openai-responses", "not an object")).toEqual([]);
    expect(
      stepsFromJson("anthropic-messages", {
        id: "m",
        content: [{ type: "tool_use", id: "t", name: "apply_patch", input: { input: "line1\nline2" } }],
      }),
    ).toEqual([{ kind: "tool", callId: "t", tool: "apply_patch", text: "line1", truncated: true }]);
  });
});

describe("stepsFromJson cut replies", () => {
  it("marks the last text cut at max_tokens or an incomplete response", () => {
    expect(
      stepsFromJson("anthropic-messages", {
        id: "m",
        stop_reason: "max_tokens",
        content: [
          { type: "text", text: "One." },
          { type: "text", text: "Two" },
        ],
      }).map((s) => s.truncated),
    ).toEqual([false, true]);
    expect(
      stepsFromJson("openai-responses", {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text: "Half" }] }],
      }),
    ).toEqual([{ kind: "said", callId: "said:m", text: "Half", truncated: true }]);
    expect(
      stepsFromJson("anthropic-messages", {
        id: "m",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Ok." }],
      }),
    ).toEqual([{ kind: "said", callId: "said:m:0", text: "Ok.", truncated: false }]);
  });
});

describe("statusFromOutput", () => {
  it.each<[string, boolean, string]>([
    ["exit_code=0\nsrc\n", false, "ok"],
    ["exit_code=2\nlint failed\n", true, "exit 2"],
    ["Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 1\nOutput:\n", false, "exit 1"],
    ["Exit code: 127\n", false, "exit 127"],
    ["Error: boom", true, "error"],
    ["Script completed\nWall time 0.0 seconds\n", false, "ok"],
    ["exit_code=4000\n", false, "error"],
    [`${"\n".repeat(9)}exit_code=3`, false, "ok"],
    ["Output:\nScript error in my log\n", false, "ok"],
    ["Script failed\nWall time 0.1 seconds\n", false, "error"],
    ["Script terminated\nWall time 9.0 seconds\n", false, "error"],
    ["Script error: ReferenceError: x is not defined\n", false, "error"],
  ])("%j (is_error %s) -> %s", (head, isError, status) => {
    expect(statusFromOutput(head, isError)).toBe(status);
  });
});

describe("resultsFromRequest", () => {
  it("reads only the newest Anthropic user message's results", async () => {
    const body = JSON.parse(await fixture("anthropic-tool-result-request.json"));
    const expected = [
      { callId: "toolu_a", status: "ok" },
      { callId: "toolu_b", status: "exit 2" },
    ];
    expect(resultsFromRequest("anthropic-messages", body)).toEqual(expected);
    // An effort-only system message after it changes nothing.
    body.messages.push({ role: "system", content: [], output_config: { effort: "high" } });
    expect(resultsFromRequest("anthropic-messages", body)).toEqual(expected);
    body.messages.push({ role: "assistant", content: [{ type: "text", text: "x" }] });
    expect(resultsFromRequest("anthropic-messages", body)).toEqual([]);
  });

  it("reads Codex's outputs of the newest turn only", async () => {
    const { body } = JSON.parse(await fixture("codex-tool-output-request.json"));
    expect(resultsFromRequest("openai-responses", body)).toEqual([
      { callId: "call_steps_1", status: "exit 1" },
      { callId: "call_steps_2", status: "ok" },
      { callId: "call_steps_3", status: "ok" },
    ]);
  });

  it("reads results after the last assistant message too, and none from before it", () => {
    const results = resultsFromRequest("openai-responses", {
      input: [
        { type: "function_call_output", call_id: "old", output: "Process exited with code 1" },
        { type: "message", role: "assistant", content: [] },
        { type: "custom_tool_call_output", call_id: "new", output: "Script failed\n" },
        { type: "message", role: "user", content: [] },
      ],
    });
    expect(results).toEqual([{ callId: "new", status: "error" }]);
  });

  it("reads every result of an interleaved Codex turn (calls and outputs alternate)", () => {
    const call = (id: string) => ({ type: "function_call", call_id: id, name: "exec_command", arguments: "{}" });
    const out = (id: string, output: string) => ({ type: "function_call_output", call_id: id, output });
    const user = { type: "message", role: "user", content: [] };
    const interleaved = [
      { type: "message", role: "developer", content: [] },
      user,
      out("older", "Process exited with code 9"),
      { type: "reasoning", summary: [] },
      call("c1"),
      out("c1", "Process exited with code 3"),
      call("c2"),
      out("c2", "Process exited with code 0"),
    ];
    const expected = [
      { callId: "c1", status: "exit 3" },
      { callId: "c2", status: "ok" },
    ];
    expect(resultsFromRequest("openai-responses", { input: interleaved })).toEqual(expected);
    expect(resultsFromRequest("openai-responses", { input: [...interleaved, user, user] })).toEqual(expected);
  });

  it("reads Anthropic results from every user message after the last assistant message", () => {
    const user = (content: unknown[]) => ({ role: "user", content });
    const result = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });
    const body = {
      messages: [
        user([result("old", "exit_code=1")]),
        { role: "assistant", content: [] },
        user([result("a", "exit_code=1")]),
        { role: "system", content: [] },
        user([{ type: "text", text: "go" }, result("b", "exit_code=0")]),
        user([{ type: "text", text: "go" }]),
      ],
    };
    expect(resultsFromRequest("anthropic-messages", body)).toEqual([
      { callId: "a", status: "exit 1" },
      { callId: "b", status: "ok" },
    ]);
  });

  it("reads at most the newest 64 results, and nothing from a body it can't read", () => {
    const input = Array.from({ length: 100 }, (_, n) => ({
      type: "function_call_output",
      call_id: `c${n}`,
      output: "ok",
    }));
    const results = resultsFromRequest("openai-responses", { input });
    expect(results).toHaveLength(MAX_RESULTS_PER_REQUEST);
    expect(results[results.length - 1].callId).toBe("c99");
    expect(resultsFromRequest("openai-responses", { input: "hello" })).toEqual([]);
    expect(resultsFromRequest("anthropic-messages", null)).toEqual([]);
  });
});
