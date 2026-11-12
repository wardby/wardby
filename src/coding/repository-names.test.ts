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
  it("repairs a short name as the migration does, so it always matches the format", () => {
    expect(defaultRepositoryName("acme/_private")).toBe("private");
    expect(defaultRepositoryName("local:/srv/My Repo!")).toBe("my-repo-");
    expect(defaultRepositoryName("acme/" + "x".repeat(70))).toBe("x".repeat(59));
    expect(defaultRepositoryName("local:/")).toBe("repo");
    expect(isCodingRepositoryName(defaultRepositoryName("acme/_private"))).toBe(true);
  });
  it("leaves the reserved name to be refused, never suffixing it", () => {
    expect(defaultRepositoryName("acme/Workspace")).toBe("workspace");
    expect(isCodingRepositoryName("workspace")).toBe(false);
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
