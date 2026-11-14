import { describe, expect, it } from "vitest";
import { LineTail, findWorkerDiagnostic, parseWorkerDiagnosticLine, redactExact } from "./diagnostics.js";

const REGISTRY_TOKEN = "rrg_fake_registry_token_0000001";

describe("LineTail", () => {
  it("keeps the last complete lines within the line and byte bounds", () => {
    const tail = new LineTail(3, 1024);
    tail.push("one\ntwo\nthr");
    tail.push("ee\nfour\nfive");
    // An unfinished line is not kept until the stream ends.
    expect(tail.lines()).toEqual(["two", "three", "four"]);
    tail.end();
    expect(tail.lines()).toEqual(["three", "four", "five"]);
  });

  it("drops the oldest lines to stay within the byte bound", () => {
    const tail = new LineTail(100, 12);
    tail.push("aaaa\nbbbb\ncccc\n");
    expect(tail.lines()).toEqual(["bbbb", "cccc"]);
    expect(tail.text().length).toBeLessThanOrEqual(12);
  });

  it("replaces a line longer than the byte bound with a fixed marker, never a piece of it", () => {
    const tail = new LineTail(10, 32);
    tail.push(`before\n${"x".repeat(10)}${REGISTRY_TOKEN}`);
    tail.push(`${"y".repeat(40)}\nafter\n`);
    expect(tail.lines()).toEqual(["before", "[line omitted]", "after"]);
    expect(tail.text()).not.toContain("rrg_");
  });

  it("applies the transform to each complete line before it is kept", () => {
    const tail = new LineTail(10, 1024, (line) => redactExact(line, [REGISTRY_TOKEN]));
    // A value split across two chunks is still redacted: lines are only transformed once complete.
    tail.push(`token=${REGISTRY_TOKEN.slice(0, 8)}`);
    tail.push(`${REGISTRY_TOKEN.slice(8)} done\n`);
    expect(tail.text()).toBe("token=[redacted] done");
  });
});

describe("redactExact", () => {
  it("replaces every exact value, longest first", () => {
    expect(redactExact("a rrp_placeholder_x b placeholder c", ["placeholder", "rrp_placeholder_x"])).toBe(
      "a [redacted] b [redacted] c",
    );
    expect(redactExact("nothing here", ["", "zzz"])).toBe("nothing here");
  });
});

describe("findWorkerDiagnostic", () => {
  it("picks the last line that is a safe diagnostic and ignores unsafe or garbage lines", () => {
    expect(
      findWorkerDiagnostic([
        '{"error":"coding_stream_failed"}',
        '{"error":"coding_turn_limit"}',
        "a log line",
        '{"error":"provider said sk-SECRET"}',
        "{not json",
      ]),
    ).toEqual({ diagnostic: "coding_turn_limit" });
    expect(findWorkerDiagnostic(['{"error":"coding_output_invalid","issues":["summary:too_big"]}'])).toEqual({
      diagnostic: "coding_output_invalid",
      diagnosticIssues: ["summary:too_big"],
    });
    expect(findWorkerDiagnostic(["nothing", '{"issues":["a:b"]}'])).toBeUndefined();
  });

  it("drops an issues list with any unsafe entry", () => {
    expect(parseWorkerDiagnosticLine('{"error":"coding_output_invalid","issues":["ok:fine","sk-SECRET"]}')).toEqual({
      diagnostic: "coding_output_invalid",
    });
  });
});
