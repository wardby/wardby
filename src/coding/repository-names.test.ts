import { describe, expect, it } from "vitest";
import { defaultRepositoryName } from "./repository-names.js";
import { isCodingRepositoryName } from "./protocol.js";

describe("defaultRepositoryName", () => {
  it("is the lower-cased short name of a GitHub repository", () => {
    expect(defaultRepositoryName("Upstream-Org/Upstream.JS")).toBe("upstream.js");
  });
  it("is the folder name of a local repository", () => {
    expect(defaultRepositoryName("local:/srv/repos/My-Fork")).toBe("my-fork");
  });
  it("never adds a suffix and never repairs a bad name", () => {
    expect(defaultRepositoryName("acme/_private")).toBe("_private");
    expect(isCodingRepositoryName("_private")).toBe(false);
  });
});

describe("isCodingRepositoryName", () => {
  it.each(["web", "web.js", "a", "a-b_c.d", "x".repeat(63)])("accepts %s", (name) => {
    expect(isCodingRepositoryName(name)).toBe(true);
  });
  it.each(["", "Web", "-web", ".web", "x".repeat(64), "a/b", "workspace", "a b"])("refuses %s", (name) => {
    expect(isCodingRepositoryName(name)).toBe(false);
  });
});
