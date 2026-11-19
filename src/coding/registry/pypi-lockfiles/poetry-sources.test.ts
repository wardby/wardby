import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isPoetryProject,
  poetryCredentialEnv,
  poetrySourceEnvName,
  restorePoetryLockUrls,
  restorePoetrySources,
  swapPoetrySources,
} from "./poetry-sources.js";

const INDEX = "http://wardby-proxy:8787/registry/pypi/simple/";
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/lockfiles/${name}`, import.meta.url), "utf8");

describe("swapPoetrySources", () => {
  it("swaps every source URL and records the originals in file order", () => {
    const before = fixture("poetry-pyproject.toml");
    const { content, sources } = swapPoetrySources(before, INDEX);
    expect(sources).toEqual([
      { name: "corp", url: "https://example.jfrog.io/acme/api/pypi/pypi/simple" },
      { name: "pypi-public", url: "https://pypi.org/simple/" },
    ]);
    expect(content).toBe(
      before
        .replace('"https://example.jfrog.io/acme/api/pypi/pypi/simple"', `"${INDEX}"`)
        .replace("'https://pypi.org/simple/'", `'${INDEX}'`),
    );
    // The trailing comment, the url-less implicit source and the rest are untouched.
    expect(content).toContain(`"${INDEX}" # primary index`);
    expect(content).toContain('name = "PyPI"\npriority = "explicit"');
  });

  it("round trips byte for byte", () => {
    const before = fixture("poetry-pyproject.toml");
    const { content, sources } = swapPoetrySources(before, INDEX);
    expect(restorePoetrySources(content, sources, INDEX)).toBe(before);
  });

  it("is idempotent and records nothing for a source already on the proxy", () => {
    const once = swapPoetrySources(fixture("poetry-pyproject.toml"), INDEX);
    const twice = swapPoetrySources(once.content, INDEX);
    expect(twice.content).toBe(once.content);
    expect(twice.sources).toEqual([]);
  });

  it("handles a url written before the name and odd source names", () => {
    const before = ["[[tool.poetry.source]]", 'url = "https://a.example/simple"', 'name = "My.Source"', ""].join("\n");
    const { content, sources } = swapPoetrySources(before, INDEX);
    expect(sources).toEqual([{ name: "My.Source", url: "https://a.example/simple" }]);
    expect(restorePoetrySources(content, sources, INDEX)).toBe(before);
  });

  it("leaves a pyproject without sources alone", () => {
    const before = '[tool.poetry]\nname = "x"\nurl = "https://example.com"\n';
    expect(swapPoetrySources(before, INDEX)).toEqual({ content: before, sources: [] });
  });
});

describe("restorePoetrySources", () => {
  it("leaves a URL the agent changed to something else alone", () => {
    const { sources } = swapPoetrySources(fixture("poetry-pyproject.toml"), INDEX);
    const edited = '[[tool.poetry.source]]\nname = "corp"\nurl = "https://other.example/simple"\n';
    expect(restorePoetrySources(edited, sources, INDEX)).toBe(edited);
  });
});

describe("restorePoetryLockUrls", () => {
  const sources = [
    { name: "corp", url: "https://example.jfrog.io/acme/api/pypi/pypi/simple" },
    { name: "pypi-public", url: "https://pypi.org/simple/" },
  ];

  it("restores legacy tables that point at the proxy, and only those", () => {
    const lock = fixture("poetry.lock");
    const proxied = lock
      .replace("https://example.jfrog.io/acme/api/pypi/pypi/simple", INDEX)
      .replace("https://pypi.org/simple/", INDEX);
    expect(restorePoetryLockUrls(proxied, sources, INDEX)).toBe(lock);
  });

  it("leaves git tables and unknown references alone", () => {
    const lock = fixture("poetry.lock");
    // `tool` is a git source that happens to share a reference name; `other` names an unknown one.
    expect(restorePoetryLockUrls(lock, sources, INDEX)).toBe(lock);
    const proxied = lock
      .replace("https://elsewhere.example/simple", INDEX)
      .replace("https://github.com/example/tool", INDEX);
    expect(restorePoetryLockUrls(proxied, sources, INDEX)).toBe(proxied);
  });
});

describe("poetrySourceEnvName", () => {
  it.each([
    ["corp", "CORP"],
    ["pypi-public", "PYPI_PUBLIC"],
    ["My.Source", "MY_SOURCE"],
    ["a b/c", "A_B_C"],
  ])("%s -> %s", (name, expected) => {
    expect(poetrySourceEnvName(name)).toBe(expected);
  });
});

describe("poetryCredentialEnv", () => {
  it("sets a username and password per source", () => {
    expect(poetryCredentialEnv([{ name: "pypi-public", url: "u" }], "tok")).toEqual({
      POETRY_HTTP_BASIC_PYPI_PUBLIC_USERNAME: "wardby",
      POETRY_HTTP_BASIC_PYPI_PUBLIC_PASSWORD: "tok",
    });
  });
});

describe("isPoetryProject", () => {
  it("recognises Poetry tables only", () => {
    expect(isPoetryProject(fixture("poetry-pyproject.toml"))).toBe(true);
    expect(isPoetryProject('[[tool.poetry.source]]\nname = "x"\n')).toBe(true);
    expect(isPoetryProject('[project]\nname = "x"\n[tool.uv]\n')).toBe(false);
  });
});
