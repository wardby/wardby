import { describe, expect, it } from "vitest";
import { resolvePlanLinks, rewriteLinksForBuilder } from "./links.js";

const set = [
  { id: "d1", path: "plan.md", kind: "document" as const },
  { id: "d2", path: "api.md", kind: "document" as const },
  { id: "d3", path: "screens/", kind: "design" as const },
];

describe("plan links", () => {
  it("resolves documents, designs and boards; leaves others as unresolved", () => {
    const md =
      "[api](api.md) [s](./screens/) [home](screens/boards/home.html) [x](missing.md) [web](https://example.com)";
    expect(resolvePlanLinks(md, "plan.md", set)).toEqual({
      links: [
        { href: "api.md", documentId: "d2" },
        { href: "./screens/", documentId: "d3" },
        { href: "screens/boards/home.html", documentId: "d3", board: "home" },
      ],
      unresolved: ["missing.md"],
    });
  });

  it("gives the builder the plan folder path instead", () => {
    expect(rewriteLinksForBuilder("See [api](api.md).", set)).toBe("See [api](/tmp/wardby-plan/api.md).");
  });

  it("skips absolute, anchor-only and escaping links, and resolves from the linking file's folder", () => {
    const md = "[a](/abs.md) [b](#top) [c](mailto:x@example.com) [d](../out.md) [e](api.md#section)";
    expect(resolvePlanLinks(md, "plan.md", set)).toEqual({
      links: [{ href: "api.md#section", documentId: "d2" }],
      unresolved: [],
    });
    const nested = [...set, { id: "d4", path: "docs/notes.md", kind: "document" as const }];
    expect(resolvePlanLinks("[up](../api.md)", "docs/notes.md", nested).links).toEqual([
      { href: "../api.md", documentId: "d2" },
    ]);
  });

  it("rewrites boards to their file and leaves other links as written", () => {
    expect(rewriteLinksForBuilder("[h](screens/boards/home.html) [x](missing.md) [w](https://e.com)", set)).toBe(
      "[h](/tmp/wardby-plan/screens/boards/home.html) [x](missing.md) [w](https://e.com)",
    );
  });
});
