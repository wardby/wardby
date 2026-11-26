import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GeminiStreamReader } from "./stream.js";
import { geminiRunEnd, jsonOutputResult } from "./failure.js";

function recorded(scenario: string) {
  const dir = new URL("./fixtures/stream/", import.meta.url);
  const meta = JSON.parse(readFileSync(new URL(`${scenario}.json`, dir), "utf8")) as {
    exit: number;
    stderrTail: string;
  };
  const reader = new GeminiStreamReader("run_rec");
  for (const line of readFileSync(new URL(`${scenario}.jsonl`, dir), "utf8").split("\n")) reader.line(line);
  return geminiRunEnd({ code: meta.exit, signal: null }, reader.result, meta.stderrTail);
}

describe("geminiRunEnd on recorded exits", () => {
  it.each([
    ["success-tools", { kind: "ok" }],
    ["budget-limit0", { kind: "budget_exhausted" }],
    ["rate-limited", { kind: "failed", code: "coding_stream_rate_limited" }],
    ["e400", { kind: "failed", code: "coding_stream_upstream_error" }],
    ["e401", { kind: "failed", code: "coding_stream_proxy_denied" }],
    ["e403", { kind: "failed", code: "coding_stream_proxy_denied" }],
    ["e404", { kind: "failed", code: "coding_stream_upstream_error" }],
    ["e500", { kind: "failed", code: "coding_stream_upstream_error" }],
    ["e503", { kind: "failed", code: "coding_stream_upstream_error" }],
    ["turn-limit", { kind: "failed", code: "coding_turn_limit" }],
    ["bad-settings", { kind: "failed", code: "worker_agent_cli_incompatible" }],
    ["unknown-flag", { kind: "failed", code: "worker_agent_cli_incompatible" }],
    ["helper-refused", { kind: "failed", code: "coding_stream_proxy_denied" }],
  ])("%s", (scenario, end) => {
    expect(recorded(scenario)).toEqual(end);
  });
});

describe("geminiRunEnd rules", () => {
  const error = (message: string, type = "Error") => ({ status: "error" as const, error: { type, message } });
  it("prefers the budget refusal over any exit code", () => {
    expect(
      geminiRunEnd({ code: 1, signal: null }, error("[API Error: wardby_budget_exhausted (limit: 0)]"), ""),
    ).toEqual({ kind: "budget_exhausted" });
    expect(
      geminiRunEnd({ code: 173, signal: null }, undefined, "[API Error: wardby_budget_exhausted (limit: 0)]"),
    ).toEqual({ kind: "budget_exhausted" });
  });
  it("tells a provider quota from a rate limit on 173", () => {
    expect(
      geminiRunEnd({ code: 173, signal: null }, error("[API Error: You exceeded your current quota]"), ""),
    ).toEqual({ kind: "failed", code: "coding_stream_quota_exceeded" });
  });
  it("maps the fatal configuration exits and a signal", () => {
    for (const code of [41, 42, 52, 55]) {
      expect(geminiRunEnd({ code, signal: null }, undefined, "")).toEqual({
        kind: "failed",
        code: "worker_agent_cli_incompatible",
      });
    }
    expect(geminiRunEnd({ code: null, signal: "SIGKILL" }, undefined, "")).toEqual({
      kind: "failed",
      code: "coding_stream_agent_exited",
    });
    expect(
      geminiRunEnd(
        { code: 1, signal: null },
        error("[API Error: fetch failed: connect ECONNREFUSED 10.0.0.1:8787]"),
        "",
      ),
    ).toEqual({ kind: "failed", code: "coding_stream_proxy_unreachable" });
    expect(geminiRunEnd({ code: 1, signal: null }, undefined, "TypeError: x is not a function")).toEqual({
      kind: "failed",
      code: "coding_stream_agent_exited",
    });
    expect(geminiRunEnd({ code: 0, signal: null }, undefined, "")).toEqual({ kind: "ok" });
  });
  it("reads --output-format json", () => {
    expect(
      jsonOutputResult(readFileSync(new URL("./fixtures/stream/repair-json.jsonl", import.meta.url), "utf8")).response,
    ).toContain('"runId"');
    expect(jsonOutputResult("not json")).toEqual({});
  });

  it("returns only fixed codes, never the CLI's message or stderr", () => {
    const secret = "fake-secret-value-123";
    for (const code of [0, 1, 41, 53, 144, 145, 173, 244, 99, null]) {
      for (const message of [`[API Error: ${secret}]`, `${secret} 403`, secret]) {
        const end = geminiRunEnd(
          { code, signal: code === null ? "SIGTERM" : null },
          error(message, secret),
          `Unknown arguments: ${secret}`,
        );
        expect(JSON.stringify(end)).not.toContain(secret);
      }
    }
  });
});
