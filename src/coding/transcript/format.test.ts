import { describe, expect, it } from "vitest";
import { formatTranscriptFile, parseTranscriptFile, type TranscriptHeader } from "./format.js";

const header: TranscriptHeader = {
  type: "wardby-transcript",
  version: 1,
  provider: "claude-code",
  sessionId: "s1",
  status: "ok",
};

describe("transcript file format", () => {
  it("round-trips header and body", () => {
    const lines = ['{"a":1}', '{"b":2}'];
    const parsed = parseTranscriptFile(formatTranscriptFile(header, lines));
    expect(parsed?.header).toEqual(header);
    expect(parsed?.body).toBe(lines.join("\n") + "\n");
  });
  it("round-trips a header with no lines", () => {
    expect(parseTranscriptFile(formatTranscriptFile(header, []))).toEqual({ header, body: "" });
  });
  it("rejects bad input", () => {
    expect(parseTranscriptFile("")).toBeNull();
    expect(parseTranscriptFile("not json\n{}")).toBeNull();
    expect(parseTranscriptFile(JSON.stringify({ ...header, type: "other" }) + "\n")).toBeNull();
    expect(parseTranscriptFile(JSON.stringify({ ...header, version: 2 }) + "\n")).toBeNull();
  });
});
