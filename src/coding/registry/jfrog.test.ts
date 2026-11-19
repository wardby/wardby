import { describe, expect, it } from "vitest";
import {
  JfrogConfigError,
  jfrogNpmRegistry,
  jfrogPypiIndex,
  loadJfrogCredentials,
  loadJfrogRegistryConfig,
} from "./jfrog.js";

const URL_SETTING = "https://example.jfrog.io/acme";

function config(env: Record<string, string>) {
  return loadJfrogRegistryConfig(env);
}

describe("loadJfrogRegistryConfig", () => {
  it("is undefined with nothing set", () => {
    expect(config({})).toBeUndefined();
    expect(jfrogNpmRegistry(undefined)).toBeUndefined();
    expect(jfrogPypiIndex(undefined)).toBeUndefined();
  });

  it("derives the npm and PyPI upstreams from the base URL and repo keys", () => {
    const loaded = config({
      REGISTRY_JFROG_URL: `${URL_SETTING}/`,
      REGISTRY_JFROG_NPM_REPO: "npm-local",
      REGISTRY_JFROG_NPM_SCOPES: "@acme, @tools,@acme",
      REGISTRY_JFROG_PYPI_REPO: "pypi",
    });
    expect(loaded?.host).toBe("example.jfrog.io");
    expect(jfrogNpmRegistry(loaded)).toEqual({
      baseUrl: "https://example.jfrog.io/acme/api/npm/npm-local/",
      scopes: ["@acme", "@tools"],
    });
    expect(jfrogPypiIndex(loaded)).toBe("https://example.jfrog.io/acme/api/pypi/pypi/simple/");
  });

  it("trusts the PyPI repository only when asked", () => {
    const base = { REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_PYPI_REPO: "pypi" };
    expect(config(base)?.pypi?.trustAll).toBe(false);
    expect(config({ ...base, REGISTRY_JFROG_PYPI_TRUST_ALL: "true" })?.pypi?.trustAll).toBe(true);
    expect(config({ ...base, REGISTRY_JFROG_PYPI_TRUST_ALL: "false" })?.pypi?.trustAll).toBe(false);
  });

  it.each([
    ["a non-boolean value", { REGISTRY_JFROG_PYPI_REPO: "pypi", REGISTRY_JFROG_PYPI_TRUST_ALL: "yes" }],
    [
      "trust-all without a PyPI repo",
      { REGISTRY_JFROG_NPM_REPO: "npm", REGISTRY_JFROG_NPM_SCOPES: "@a", REGISTRY_JFROG_PYPI_TRUST_ALL: "true" },
    ],
  ])("rejects trust-all with %s", (_label, env) => {
    expect(() => config({ REGISTRY_JFROG_URL: URL_SETTING, ...env })).toThrow(JfrogConfigError);
  });

  it("allows PyPI alone, without npm scopes", () => {
    const loaded = config({ REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_PYPI_REPO: "pypi" });
    expect(jfrogNpmRegistry(loaded)).toBeUndefined();
    expect(jfrogPypiIndex(loaded)).toBeDefined();
  });

  it.each([
    ["a repo without a URL", { REGISTRY_JFROG_NPM_REPO: "npm-local", REGISTRY_JFROG_NPM_SCOPES: "@acme" }],
    ["a URL without a repo", { REGISTRY_JFROG_URL: URL_SETTING }],
    ["an npm repo without scopes", { REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_NPM_REPO: "npm-local" }],
    [
      "scopes without an npm repo",
      { REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_PYPI_REPO: "pypi", REGISTRY_JFROG_NPM_SCOPES: "@acme" },
    ],
    ["a plain-http URL", { REGISTRY_JFROG_URL: "http://example.jfrog.io/acme", REGISTRY_JFROG_PYPI_REPO: "pypi" }],
    [
      "a URL with credentials",
      { REGISTRY_JFROG_URL: "https://user:pw@example.jfrog.io/acme", REGISTRY_JFROG_PYPI_REPO: "pypi" },
    ],
    ["a URL with a query", { REGISTRY_JFROG_URL: `${URL_SETTING}?x=1`, REGISTRY_JFROG_PYPI_REPO: "pypi" }],
    ["a repo key that is a path", { REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_PYPI_REPO: "a/b" }],
    ["a repo key that is a URL", { REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_PYPI_REPO: "https://x/pypi" }],
    [
      "a scope without the at sign",
      { REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_NPM_REPO: "npm-local", REGISTRY_JFROG_NPM_SCOPES: "acme" },
    ],
  ])("refuses %s", (_label, env) => {
    expect(() => config(env)).toThrow(JfrogConfigError);
  });
});

describe("loadJfrogCredentials", () => {
  const jfrog = config({ REGISTRY_JFROG_URL: URL_SETTING, REGISTRY_JFROG_PYPI_REPO: "pypi" });

  it("resolves env references into a Basic header for the JFrog host only", () => {
    const credentials = loadJfrogCredentials(jfrog, {
      REGISTRY_UPSTREAM_USERNAME: "env:JFROG_USER",
      REGISTRY_UPSTREAM_PASSWORD: "env:JFROG_PASS",
      JFROG_USER: "svc",
      JFROG_PASS: "s3cret",
    });
    expect(credentials).toEqual({
      host: "example.jfrog.io",
      authorization: `Basic ${Buffer.from("svc:s3cret").toString("base64")}`,
    });
  });

  it("is undefined with nothing configured", () => {
    expect(loadJfrogCredentials(undefined, {})).toBeUndefined();
  });

  it("requires credentials once a repo is configured (no anonymous access)", () => {
    expect(() => loadJfrogCredentials(jfrog, {})).toThrow(JfrogConfigError);
  });

  it("refuses credentials with no repo configured", () => {
    expect(() =>
      loadJfrogCredentials(undefined, { REGISTRY_UPSTREAM_USERNAME: "env:A", REGISTRY_UPSTREAM_PASSWORD: "env:B" }),
    ).toThrow(JfrogConfigError);
  });

  it("refuses a literal value, and a reference to an unset variable, without echoing either", () => {
    const literal = () =>
      loadJfrogCredentials(jfrog, { REGISTRY_UPSTREAM_USERNAME: "svc", REGISTRY_UPSTREAM_PASSWORD: "hunter2" });
    expect(literal).toThrow(JfrogConfigError);
    expect(literal).not.toThrow(/hunter2/);
    expect(() =>
      loadJfrogCredentials(jfrog, {
        REGISTRY_UPSTREAM_USERNAME: "env:MISSING",
        REGISTRY_UPSTREAM_PASSWORD: "env:MISSING",
      }),
    ).toThrow(/MISSING/);
  });
});
