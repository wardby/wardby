import { describe, expect, it } from "vitest";
import { parseWorkerDiagnosticLine } from "../providers/jobs/docker.js";
import {
  MAX_DEBUG_TRACE_LINE_BYTES,
  MAX_DEBUG_TRACE_TOTAL_BYTES,
  createDebugTracer,
  describeError,
  redactSecrets,
  workerDebugTracer,
} from "./debug-trace.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import { holdsValueFragment } from "../sandbox/secret-fragments.test-support.js";

const CAPABILITY = `rrp_${"A".repeat(43)}`;

function capture(options: { maxLineBytes?: number; maxTotalBytes?: number; secrets?: string[] } = {}) {
  const lines: string[] = [];
  const tracer = createDebugTracer({
    runId: "run_123",
    secrets: options.secrets ?? [CAPABILITY],
    write: (line) => lines.push(line),
    now: () => 1_700_000_000_000,
    maxLineBytes: options.maxLineBytes,
    maxTotalBytes: options.maxTotalBytes,
  });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { tracer, lines, parsed };
}

describe("redactSecrets", () => {
  it("redacts the run capability, bearer tokens, OpenAI keys and GitHub tokens", () => {
    const text = [
      `capability ${CAPABILITY}`,
      "short capability rrp_abcdefghij0123456789",
      "Authorization: Bearer abc.def-ghi",
      "key sk-proj-0123456789abcdefghij",
      `app ${"ghs_" + "a".repeat(36)} oauth ${"gho_" + "b".repeat(36)} classic ${"ghp_" + "c".repeat(36)}`,
      `fine-grained github_pat_${"d".repeat(40)}`,
      `registry rrg_${"e".repeat(43)}`,
    ].join("\n");
    const redacted = redactSecrets(text);
    for (const secret of [
      CAPABILITY,
      "rrp_abcdefghij0123456789",
      "abc.def-ghi",
      "sk-proj-0123456789abcdefghij",
      "ghs_",
      "gho_",
      "ghp_",
      "github_pat_",
      "rrg_eeee",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts exact known secrets even without a recognizable shape", () => {
    expect(redactSecrets("token=opaque-value-123 done", ["opaque-value-123"])).toBe("token=[REDACTED] done");
  });

  it("ignores empty known secrets and leaves ordinary text alone", () => {
    expect(redactSecrets("exited with code 1: no such file", [""])).toBe("exited with code 1: no such file");
  });
});

describe("describeError", () => {
  it("keeps name, message, stack and the cause chain", () => {
    const root = new Error("socket hang up");
    const error = new Error("Codex Exec exited with code 1: boom", { cause: root });
    const described = describeError(error) as Record<string, unknown>;
    expect(described).toMatchObject({ name: "Error", message: "Codex Exec exited with code 1: boom" });
    expect(String(described.stack)).toContain("Codex Exec exited");
    expect(described.cause).toMatchObject({ message: "socket hang up" });
  });

  it("describes non-Error throws", () => {
    expect(describeError("plain")).toEqual({ value: "plain" });
  });
});

describe("createDebugTracer", () => {
  it("writes one JSON line per record under a single debugTrace key", () => {
    const { tracer, lines, parsed } = capture();
    tracer.record("event", { type: "turn.started" });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(parsed()[0]).toEqual({
      debugTrace: { runId: "run_123", at: 1_700_000_000_000, kind: "event", data: { type: "turn.started" } },
    });
  });

  it("redacts secrets inside nested data, including the known capability", () => {
    const { tracer, lines } = capture();
    tracer.record("stream_error", describeError(new Error(`exited with code 1: key=${CAPABILITY} Bearer tok_1234`)));
    expect(lines[0]).not.toContain(CAPABILITY);
    expect(lines[0]).not.toContain("tok_1234");
    expect(lines[0]).toContain("[REDACTED]");
  });

  it("can never produce a line the job launchers read as a worker diagnostic", () => {
    const { tracer, lines } = capture();
    tracer.record("event", { error: "coding_turn_failed", issues: ["tag:invalid_string"] });
    tracer.record("turn_failed", { error: { message: "coding_stream_failed" } });
    tracer.record("stream_error", "coding_stream_agent_exited");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object)).toEqual(["debugTrace"]);
      expect(parseWorkerDiagnosticLine(line.trimEnd())).toBeUndefined();
    }
  });

  it("caps a line and keeps it valid JSON", () => {
    const { tracer, lines, parsed } = capture({ maxLineBytes: 1024 });
    tracer.record("event", { text: `"quoted"\n`.repeat(2000) });
    expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(1024);
    const line = parsed()[0].debugTrace as Record<string, unknown>;
    expect(line.truncated).toBe(true);
    expect(typeof line.data).toBe("string");
  });

  it("redacts a secret before truncation can split it", () => {
    const { tracer, lines } = capture({ maxLineBytes: 512 });
    tracer.record("event", { text: `${"x".repeat(380)}${CAPABILITY}` });
    expect(lines[0]).not.toContain(CAPABILITY.slice(0, 12));
  });

  it("stops after the per-run total, saying so once", () => {
    const { tracer, lines, parsed } = capture({ maxLineBytes: 1024, maxTotalBytes: 4096 });
    for (let index = 0; index < 100; index += 1) tracer.record("event", { text: "y".repeat(900) });
    const total = lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    expect(total).toBeLessThanOrEqual(4096 + 1024);
    const kinds = parsed().map((line) => (line.debugTrace as { kind: string }).kind);
    expect(kinds.filter((kind) => kind === "limit_reached")).toHaveLength(1);
    expect(kinds.at(-1)).toBe("limit_reached");
  });

  it("defaults to 16 KiB lines and 2 MiB per run", () => {
    expect(MAX_DEBUG_TRACE_LINE_BYTES).toBe(16 * 1024);
    expect(MAX_DEBUG_TRACE_TOTAL_BYTES).toBe(2 * 1024 * 1024);
  });

  it("survives circular data", () => {
    const { tracer, parsed } = capture();
    const data: Record<string, unknown> = { type: "loop" };
    data.self = data;
    tracer.record("event", data);
    expect(parsed()[0]).toMatchObject({ debugTrace: { data: { type: "loop", self: "[Circular]" } } });
  });
});

describe("workerDebugTracer", () => {
  it("is off unless the input asks for a trace", () => {
    const write = () => undefined;
    expect(workerDebugTracer({ runId: "run_123" }, CAPABILITY, write)).toBeUndefined();
    expect(workerDebugTracer({ runId: "run_123", debugTrace: false }, CAPABILITY, write)).toBeUndefined();
    expect(workerDebugTracer({ runId: "run_123", debugTrace: true }, CAPABILITY, write)).toBeDefined();
  });

  it("caps the run at the input's debugTraceMaxMb, or the default without one", () => {
    const big = "x".repeat(15_000);
    const run = (debugTraceMaxMb?: number) => {
      const lines: string[] = [];
      const tracer = workerDebugTracer(
        { runId: "run_123", debugTrace: true, ...(debugTraceMaxMb ? { debugTraceMaxMb } : {}) },
        CAPABILITY,
        (line) => lines.push(line),
      );
      for (let i = 0; i < 400; i++) tracer!.record("event", { big });
      return lines;
    };
    const total = (lines: string[]) => lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    const oneMb = run(1);
    expect(JSON.parse(oneMb.at(-1)!)).toMatchObject({
      debugTrace: { kind: "limit_reached", data: { maxTotalBytes: 1024 * 1024 } },
    });
    expect(total(oneMb.slice(0, -1))).toBeLessThanOrEqual(1024 * 1024);
    const byDefault = run();
    expect(JSON.parse(byDefault.at(-1)!)).toMatchObject({
      debugTrace: { kind: "limit_reached", data: { maxTotalBytes: MAX_DEBUG_TRACE_TOTAL_BYTES } },
    });
    expect(run(8).some((line) => line.includes("limit_reached"))).toBe(false);
    // CPU-bound (~1.5 s alone): the 5 s default is too tight while the full suite runs in parallel.
  }, 15_000);

  it("redacts the capability and the registry token derived from it", () => {
    const lines: string[] = [];
    const tracer = workerDebugTracer({ runId: "run_123", debugTrace: true }, CAPABILITY, (line) => lines.push(line));
    const registryToken = deriveRegistryToken(CAPABILITY);
    tracer!.record("event", { a: CAPABILITY, b: `//proxy/registry/npm/:_authToken=${registryToken}` });
    expect(lines[0]).not.toContain(CAPABILITY);
    expect(lines[0]).not.toContain(registryToken.slice(4));
  });
});

describe("redactSecrets with a self-overlapping value", () => {
  it("masks every overlapping occurrence, leaving no fragment", () => {
    const value = "abcabcabc";
    const out = redactSecrets(`trace ${"abc".repeat(5)} end`, [value]);
    expect(holdsValueFragment(out, [value])).toBe(false);
    expect(out === "trace [REDACTED] end").toBe(true);
  });

  it("still redacts a value shorter than the sandbox redactor's minimum", () => {
    expect(redactSecrets("x abcd y", ["abcd"]) === "x [REDACTED] y").toBe(true);
  });
});
