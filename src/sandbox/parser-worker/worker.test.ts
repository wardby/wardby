import { describe, expect, it } from "vitest";
import { parseCsvPayload, parseHtmlPayload, parseXmlPayload } from "./worker.js";
import { HTML_LINKS_LIMIT } from "../limits.js";

describe("parseHtmlPayload", () => {
  it("extracts title, visible text, and links", () => {
    const result = parseHtmlPayload(
      '<html><head><title>Hi</title></head><body><p>Hello</p><a href="/a">A</a></body></html>',
    );
    expect(result.title).toBe("Hi");
    expect(result.text).toContain("Hello");
    expect(result.links).toEqual([{ href: "/a", text: "A" }]);
  });

  it("throws html_link_limit past HTML_LINKS_LIMIT anchors", () => {
    const html = '<a href="/">x</a>'.repeat(HTML_LINKS_LIMIT + 1);
    expect(() => parseHtmlPayload(html)).toThrow("html_link_limit");
  });
});

describe("parseCsvPayload", () => {
  it("parses headered CSV into row objects", () => {
    const result = parseCsvPayload("a,b\n1,2", true);
    expect(result.data).toEqual([{ a: "1", b: "2" }]);
  });

  it("parses headerless CSV into row arrays", () => {
    const result = parseCsvPayload("1,2", false);
    expect(result.data).toEqual([["1", "2"]]);
  });
});

describe("parseXmlPayload", () => {
  it("parses simple XML into a plain object", () => {
    expect(parseXmlPayload("<x>hi</x>", null)).toEqual({ x: "hi" });
  });

  it("never resolves entities even if xmlOptions doesn't say so — processEntities is force-disabled", () => {
    const result = parseXmlPayload("<x>&amp;</x>", null) as { x: string };
    expect(result.x).not.toBe("&");
  });
});
