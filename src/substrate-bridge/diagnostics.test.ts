import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_CAPABILITY, REDACTED } from "./constants.js";
import {
  LINE_OMITTED,
  LineTail,
  findWorkerDiagnostic,
  parseWorkerDiagnosticLine,
  pipeRedacted,
  redactExact,
} from "./diagnostics.js";

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

describe("pipeRedacted", () => {
  const capture = (): { write(text: string): void; text(): string } => {
    let text = "";
    return { write: (piece) => void (text += piece), text: () => text };
  };

  it("passes lines on redacted by exact value, a value split across chunks included", async () => {
    const stream = new PassThrough();
    const out = capture();
    const done = pipeRedacted(stream, out, () => [PLACEHOLDER_CAPABILITY, REGISTRY_TOKEN]);
    stream.write(`cap=${PLACEHOLDER_CAPABILITY} tok=${REGISTRY_TOKEN.slice(0, 9)}`);
    stream.write(`${REGISTRY_TOKEN.slice(9)} end\nplain line\r\n`);
    stream.end(`{"registryToken":"${REGISTRY_TOKEN}"}`);
    await done;
    expect(out.text()).toBe(`cap=${REDACTED} tok=${REDACTED} end\nplain line\n{"registryToken":"${REDACTED}"}\n`);
    expect(out.text()).not.toContain(REGISTRY_TOKEN);
    expect(out.text()).not.toContain(PLACEHOLDER_CAPABILITY);
  });

  it("reads the secret list for every line, so a value learned later is covered from then on", async () => {
    const stream = new PassThrough();
    const out = capture();
    const secrets: string[] = [];
    const done = pipeRedacted(stream, out, () => secrets);
    secrets.push(REGISTRY_TOKEN);
    stream.end(`${REGISTRY_TOKEN}\n`);
    await done;
    expect(out.text()).toBe(`${REDACTED}\n`);
  });

  it("writes an over-long line as the fixed marker, never a piece of it", async () => {
    const stream = new PassThrough();
    const out = capture();
    const done = pipeRedacted(stream, out, () => [REGISTRY_TOKEN], 32);
    stream.write(`${"x".repeat(20)}${REGISTRY_TOKEN.slice(0, 10)}`);
    stream.end(`${REGISTRY_TOKEN.slice(10)}\nshort\n`);
    await done;
    expect(out.text()).toBe(`${LINE_OMITTED}\nshort\n`);
  });

  it("decodes a multi-byte character split across chunks whole", async () => {
    const stream = new PassThrough();
    const out = capture();
    const done = pipeRedacted(stream, out, () => []);
    const bytes = Buffer.from("caf\u00e9\n");
    stream.write(bytes.subarray(0, 4));
    stream.end(bytes.subarray(4));
    await done;
    expect(out.text()).toBe("caf\u00e9\n");
  });
});
