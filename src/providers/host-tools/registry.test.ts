import { describe, expect, it } from "vitest";
import { findCredential, RegisterHostProviderSchema } from "./registry.js";

const VALID = {
  provider: "bitbucket",
  gitHost: "bitbucket.org",
  apiHosts: ["api.bitbucket.org"],
  gitUsername: "x-token-auth",
  pullRequestUrlTemplate: "https://bitbucket.org/{repository}/pull-requests/{number}",
  repositoryApiPath: "/2.0/repositories/{repository}",
  webhook: {
    header: "X-Hub-Signature",
    algorithm: "sha256",
    deliveryHeader: "X-Request-UUID",
    eventHeader: "X-Event-Key",
    secret: "wh",
  },
  credentials: [{ repositories: "acme/*", secret: "bb" }],
  tools: { getPullRequest: "t" },
};
const parse = (patch: object) => RegisterHostProviderSchema.safeParse({ ...VALID, ...patch });

describe("RegisterHostProviderSchema", () => {
  it("accepts the documented shape", () => expect(parse({}).success).toBe(true));

  it.each([
    ["a reserved name", { provider: "github" }],
    ["constructor", { provider: "constructor" }],
    ["a URL as git host", { gitHost: "https://bitbucket.org" }],
    ["a wildcard API host", { apiHosts: ["*.bitbucket.org"] }],
    ["an IP API host", { apiHosts: ["10.0.0.1"] }],
    ["no API host", { apiHosts: [] }],
    ["a username naming the prompt", { gitUsername: "my-Username" }],
    ["a username with a space", { gitUsername: "a b" }],
    ["http template", { pullRequestUrlTemplate: "http://bitbucket.org/{repository}/pull/{number}" }],
    ["template on another host", { pullRequestUrlTemplate: "https://evil.example/{repository}/pull/{number}" }],
    ["template without number", { pullRequestUrlTemplate: "https://bitbucket.org/{repository}" }],
    ["template with an unknown field", { pullRequestUrlTemplate: "https://bitbucket.org/{repository}/{number}/{x}" }],
    ["API path without repository", { repositoryApiPath: "/2.0/repositories" }],
    ["relative API path", { repositoryApiPath: "2.0/{repository}" }],
    ["permission credential without its path", { permissionCredential: "p" }],
    ["permission path without its credential", { permissionApiPath: "/2.0/w/{workspace}/r/{repo}" }],
    ["a pattern across workspaces", { credentials: [{ repositories: "*/*", secret: "bb" }] }],
    ["a partial wildcard", { credentials: [{ repositories: "acme/web*", secret: "bb" }] }],
    [
      "a duplicate pattern",
      {
        credentials: [
          { repositories: "acme/*", secret: "a" },
          { repositories: "ACME/*", secret: "b" },
        ],
      },
    ],
    ["no credentials", { credentials: [] }],
    ["another algorithm", { webhook: { ...VALID.webhook, algorithm: "sha1" } }],
    ["an unknown field", { nope: true }],
  ])("refuses %s", (_label, patch) => {
    expect(parse(patch).success).toBe(false);
  });

  it("lower-cases a pattern, so it matches a normalized repository", () => {
    const parsed = RegisterHostProviderSchema.parse({
      ...VALID,
      credentials: [{ repositories: "ACME/Web", secret: "bb" }],
    });
    expect(parsed.credentials[0].repositories).toBe("acme/web");
  });
});

describe("findCredential", () => {
  const credentials = [
    { repositoryPattern: "acme/*", secretId: "wild" },
    { repositoryPattern: "acme/web", secretId: "exact" },
    { repositoryPattern: "other/*", secretId: "other" },
  ];
  it("prefers the exact pattern", () => expect(findCredential(credentials, "acme/web")?.secretId).toBe("exact"));
  it("falls back to the workspace", () => expect(findCredential(credentials, "acme/api")?.secretId).toBe("wild"));
  it("has none outside its patterns", () => expect(findCredential(credentials, "third/web")).toBeNull());
  it("doesn't let a wildcard cross a slash", () => expect(findCredential(credentials, "acme/a/b")).toBeNull());
});
