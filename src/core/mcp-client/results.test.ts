import { describe, expect, it } from "vitest";
import { MCP_RESULT_MAX_CHARS, toolResultText } from "./results.js";

describe("toolResultText", () => {
  it("joins text parts with a newline", () => {
    const result = {
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    };
    expect(toolResultText(result)).toEqual({ text: "one\ntwo", isError: false });
  });

  it("uses structuredContent when there is no text", () => {
    expect(toolResultText({ content: [], structuredContent: { n: 1 } }).text).toBe('{"n":1}');
  });

  it("notes omitted non-text parts", () => {
    const result = {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "xx", mimeType: "image/png" },
      ],
    };
    expect(toolResultText(result).text).toBe("a\n[image omitted]");
  });

  it("wraps an error result", () => {
    const result = { isError: true, content: [{ type: "text", text: "boom" }] };
    const out = toolResultText(result);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.text)).toEqual({ error: "mcp_server_error", message: "boom" });
  });

  it("reports an unreadable result", () => {
    expect(toolResultText("nope").isError).toBe(true);
    expect(JSON.parse(toolResultText("nope").text)).toEqual({
      error: "mcp_server_error",
      message: "The MCP server returned an unreadable result.",
    });
    expect(JSON.parse(toolResultText(null).text).error).toBe("mcp_server_error");
  });

  it("truncates long text with a note", () => {
    const { text } = toolResultText({ content: [{ type: "text", text: "x".repeat(150_000) }] });
    expect(text.startsWith("x".repeat(MCP_RESULT_MAX_CHARS))).toBe(true);
    expect(text.endsWith("\n[truncated: 50000 characters omitted]")).toBe(true);
  });

  const FAKE = "fake-secret-value-0123456789";
  const redact = (t: string) => t.split(FAKE).join("[REDACTED]");

  it("redacts before truncating, so a secret across the cap leaves no prefix", () => {
    const pad = "x".repeat(MCP_RESULT_MAX_CHARS - 10);
    const raw = { content: [{ type: "text", text: `${pad}${FAKE} after` }] };
    const unredacted = toolResultText(raw).text;
    expect(unredacted).toContain(FAKE.slice(0, 10));
    const { text, isError } = toolResultText(raw, redact);
    expect(isError).toBe(false);
    expect(text).not.toContain(FAKE.slice(0, 10));
    expect(text.startsWith(`${pad}[REDACTED]`)).toBe(true);
    expect(text).toMatch(/\[truncated: \d+ characters omitted\]$/);
  });

  it("redacts before truncating on the error path too", () => {
    const pad = "x".repeat(MCP_RESULT_MAX_CHARS - 10);
    const { text, isError } = toolResultText(
      { isError: true, content: [{ type: "text", text: `${pad}${FAKE} after` }] },
      redact,
    );
    expect(isError).toBe(true);
    const message = (JSON.parse(text) as { message: string }).message;
    expect(message).not.toContain(FAKE.slice(0, 10));
    expect(message.startsWith(`${pad}[REDACTED]`)).toBe(true);
  });
});
