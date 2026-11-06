import { describe, expect, it } from "vitest";
import {
  assertServerName,
  diffSnapshots,
  exposedToolName,
  McpServerInputError,
  normaliseServerUrl,
  redactForServer,
} from "./mcp-servers.js";

describe("normaliseServerUrl", () => {
  it("accepts https and keeps the query", () => {
    expect(normaliseServerUrl("https://mcp.example.com/mcp?team=a")).toBe("https://mcp.example.com/mcp?team=a");
  });
  it.each([
    "http://mcp.example.com/mcp",
    "https://u:p@mcp.example.com/",
    "https://h.example.com/#frag",
    "https://h.example.com:8443/",
    "nope",
  ])("refuses %s", (raw) => {
    expect(() => normaliseServerUrl(raw)).toThrow(McpServerInputError);
  });
});

describe("assertServerName", () => {
  it("applies the name rule", () => {
    expect(() => assertServerName("datadog_1")).not.toThrow();
    for (const bad of ["", "Datadog", "-a", "a b", "a".repeat(33)])
      expect(() => assertServerName(bad)).toThrow(McpServerInputError);
  });
});

describe("exposedToolName", () => {
  it("maps other characters to _", () => {
    expect(exposedToolName("datadog", "search.logs")).toBe("datadog__search_logs");
  });
  it("refuses more than 64 characters", () => {
    expect(() => exposedToolName("datadog", "x".repeat(60))).toThrow(McpServerInputError);
  });
});

describe("diffSnapshots", () => {
  const t = (name: string, description = "d", inputSchema: Record<string, unknown> = { type: "object" }) => ({
    name,
    description,
    inputSchema,
  });
  it("reports added, removed and changed, independent of order", () => {
    const before = [t("a"), t("b"), t("c", "d", { type: "object", properties: { x: {}, y: {} } })];
    const after = [t("c", "d", { properties: { y: {}, x: {} }, type: "object" }), t("b", "new description"), t("d")];
    expect(diffSnapshots(before, after)).toEqual({ added: ["d"], removed: ["a"], changed: ["b"] });
    expect(diffSnapshots([t("a"), t("b")], [t("b"), t("a")])).toEqual({ added: [], removed: [], changed: [] });
  });
  it("treats a schema change as changed", () => {
    expect(diffSnapshots([t("a")], [t("a", "d", { type: "object", required: ["q"] })]).changed).toEqual(["a"]);
  });
});

describe("redactForServer", () => {
  it("removes a secret and its base64 form", () => {
    const secret = "sk-test-ABCDEF123456";
    const text = `key ${secret} and ${Buffer.from(secret).toString("base64")} and ${encodeURIComponent(secret)}`;
    const out = redactForServer(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(Buffer.from(secret).toString("base64"));
    expect(out).toContain("[REDACTED]");
  });
});
