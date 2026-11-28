import { describe, expect, it } from "vitest";
import { linkDestination } from "./link-open.js";

const O = "http://wardby.test";

describe("linkDestination", () => {
  it("opens a Wardby page in this tab and other sites in a new one", () => {
    expect(linkDestination("/d/abc", null, O)).toEqual({ href: "/d/abc", newTab: false });
    expect(linkDestination("#top", null, O)).toEqual({ href: "#top", newTab: false });
    expect(linkDestination("http://wardby.test/d/abc", null, O)).toEqual({
      href: "http://wardby.test/d/abc",
      newTab: false,
    });
    expect(linkDestination("https://example.com/x", null, O)).toEqual({ href: "https://example.com/x", newTab: true });
    expect(linkDestination("mailto:a@b.c", null, O)).toEqual({ href: "mailto:a@b.c", newTab: true });
  });

  it("opens a plan link at its document's page", () => {
    const targets = new Map([["screens/", "/d/design1#board-home"]]);
    expect(linkDestination("screens/", targets, O)).toEqual({ href: "/d/design1#board-home", newTab: false });
  });

  it("opens nothing for other schemes, protocol-relative or unresolved relative links", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,x", "//evil.example/x", "api.md", "", "https://"]) {
      expect(linkDestination(href, null, O)).toBeNull();
    }
  });
});
