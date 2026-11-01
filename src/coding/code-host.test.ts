import { describe, expect, it } from "vitest";
import { codeProviderOf, normalizeHostedRepository, pullRequestWebUrl } from "./code-host.js";

describe("codeProviderOf", () => {
  it("reads the provider from the repository's form", () => {
    expect(codeProviderOf("acme/api")).toBe("github");
    expect(codeProviderOf("local:/srv/repo")).toBe("local");
    expect(codeProviderOf("bitbucket:acme/api")).toBe("bitbucket");
  });

  it("does not take a URL scheme for a provider", () => {
    expect(codeProviderOf("https://github.com/acme/api")).toBe("github");
  });
});

describe("normalizeHostedRepository", () => {
  it("normalizes GitHub names as before", () => {
    expect(normalizeHostedRepository("Acme/API")).toBe("acme/api");
    expect(normalizeHostedRepository("https://github.com/Acme/API.git")).toBe("acme/api");
  });

  it("normalizes a hosted repository, keeping its prefix", () => {
    expect(normalizeHostedRepository("bitbucket:Acme/My_Repo")).toBe("bitbucket:acme/my_repo");
  });

  it.each([
    "local:/srv/repo",
    "github:acme/api",
    "local:acme/api",
    "https:acme/api",
    "http:acme/api",
    "ssh:acme/api",
    "git:acme/api",
    "file:acme/api",
    "bitbucket:acme/api.",
    "Bitbucket:acme/api",
    "bitbucket:acme",
    "bitbucket:acme/api/extra",
    "bitbucket:../api",
    "bitbucket:acme/..",
    "bitbucket:acme/a b",
    "bitbucket:acme/a\nb",
  ])("refuses %j", (value) => {
    expect(() => normalizeHostedRepository(value)).toThrow();
  });
});

describe("pullRequestWebUrl", () => {
  it("builds a GitHub link", () => {
    expect(pullRequestWebUrl("github", "acme/api", 12)).toBe("https://github.com/acme/api/pull/12");
  });

  it("has no link for any other provider", () => {
    expect(pullRequestWebUrl("local", "local:/srv/repo", 12)).toBeNull();
    expect(pullRequestWebUrl("bitbucket", "bitbucket:acme/api", 12)).toBeNull();
  });

  it("has no GitHub link for an id that is not a GitHub name", () => {
    expect(pullRequestWebUrl("github", "bitbucket:acme/api.", 12)).toBeNull();
  });
});
