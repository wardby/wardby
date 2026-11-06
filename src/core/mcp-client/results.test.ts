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
    expect(toolResultText(result)).toBe("one\ntwo");
  });

  it("uses structuredContent when there is no text", () => {
    expect(toolResultText({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
  });

  it("notes omitted non-text parts", () => {
    const result = {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "xx", mimeType: "image/png" },
      ],
    };
    expect(toolResultText(result)).toBe("a\n[image omitted]");
  });

  it("wraps an error result", () => {
    const result = { isError: true, content: [{ type: "text", text: "boom" }] };
    expect(JSON.parse(toolResultText(result))).toEqual({ error: "mcp_server_error", message: "boom" });
  });

  it("reports an unreadable result", () => {
    expect(JSON.parse(toolResultText("nope"))).toEqual({
      error: "mcp_server_error",
      message: "The MCP server returned an unreadable result.",
    });
    expect(JSON.parse(toolResultText(null)).error).toBe("mcp_server_error");
  });

  it("truncates long text with a note", () => {
    const text = toolResultText({ content: [{ type: "text", text: "x".repeat(150_000) }] });
    expect(text.startsWith("x".repeat(MCP_RESULT_MAX_CHARS))).toBe(true);
    expect(text.endsWith("\n[truncated: 50000 characters omitted]")).toBe(true);
  });
});
