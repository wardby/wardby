import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectUvProxyReferences, isUvLock, restoreUvLockFromOrigins, rewriteUvLockToProxy } from "./uv-lockfile.js";

const PROXY = "http://wardby-proxy:8787/registry/pypi/";
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/lockfiles/${name}`, import.meta.url), "utf8");

/** A restore from what a snapshot recorded alone, as the session does for entries the proxy cannot answer. */
const restoreUvLock = (
  content: string,
  maps: { files: Record<string, string>; registries: Record<string, string> },
  registryUrl: string,
) => restoreUvLockFromOrigins(content, registryUrl, { files: new Map(), fallback: maps });

function pkg(lines: string[]): string {
  return ["version = 1", "", "[[package]]", ...lines, ""].join("\n");
}

describe("rewriteUvLockToProxy", () => {
  it("rewrites the fixture to the expected proxied lock", () => {
    expect(rewriteUvLockToProxy(fixture("uv.lock"), PROXY).content).toBe(fixture("uv-proxied.lock"));
  });

  it("round trips the fixture byte for byte", () => {
    const original = fixture("uv.lock");
    const { content, files, registries } = rewriteUvLockToProxy(original, PROXY);
    expect(restoreUvLock(content, { files, registries }, PROXY)).toEqual({ content: original, unresolved: [] });
  });

  it("maps both registries of a two-index lock to the proxy and restores each", () => {
    const { registries } = rewriteUvLockToProxy(fixture("uv.lock"), PROXY);
    expect(registries["acme-core@1.4.2"]).toBe("https://example.jfrog.io/acme/api/pypi/pypi/simple");
    expect(registries["requests@2.32.3"]).toBe("https://pypi.org/simple");
    // The inline source in acme-core's dependencies.
    expect(registries["typing-extensions@4.12.2"]).toBe("https://pypi.org/simple");
  });

  it("is idempotent and records nothing for URLs already under the proxy", () => {
    const once = rewriteUvLockToProxy(fixture("uv.lock"), PROXY);
    const twice = rewriteUvLockToProxy(once.content, PROXY);
    expect(twice.content).toBe(once.content);
    expect(twice.files).toEqual({});
    expect(twice.registries).toEqual({});
  });

  it("accepts a proxy base given without its trailing slash", () => {
    expect(rewriteUvLockToProxy(fixture("uv.lock"), PROXY.slice(0, -1)).content).toBe(fixture("uv-proxied.lock"));
  });

  it("changes only the matched URL values, preserving every other byte", () => {
    const before = pkg([
      'name = "left-pad"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.org/simple/" }',
      "wheels = [",
      '    {  url = "https://files.pythonhosted.org/p/left_pad-1.0.0-py3-none-any.whl?x=1#frag" ,   hash = "sha256:aa", size = 1 },',
      "]",
      "# https://files.pythonhosted.org/p/comment.whl",
    ]);
    const { content } = rewriteUvLockToProxy(before, PROXY);
    expect(content).toBe(
      before
        .replace('"https://pypi.org/simple/"', `"${PROXY}simple"`)
        .replace(
          "https://files.pythonhosted.org/p/left_pad-1.0.0-py3-none-any.whl?x=1#frag",
          `${PROXY}files/left-pad/left_pad-1.0.0-py3-none-any.whl`,
        ),
    );
  });

  it("rewrites a wheel URL as written by uv, dropping query and fragment from the file name", () => {
    const before = pkg([
      'name = "left-pad"',
      'version = "1.0.0"',
      'source = { registry = "https://pypi.org/simple" }',
      'wheels = [{ url = "https://files.pythonhosted.org/p/left_pad-1.0.0-py3-none-any.whl?x=1#frag", hash = "sha256:aa" }]',
    ]);
    const { content, files } = rewriteUvLockToProxy(before, PROXY);
    const proxied = `${PROXY}files/left-pad/left_pad-1.0.0-py3-none-any.whl`;
    expect(content).toContain(`wheels = [{ url = "${proxied}", hash = "sha256:aa" }]`);
    expect(files[proxied]).toBe("https://files.pythonhosted.org/p/left_pad-1.0.0-py3-none-any.whl?x=1#frag");
  });

  it("normalises the package name and percent-encodes the file name", () => {
    const before = pkg([
      'name = "Typing_Extensions"',
      'version = "1.0+local"',
      'source = { registry = "https://pypi.org/simple" }',
      'wheels = [{ url = "https://files.pythonhosted.org/p/typing_extensions-1.0%2Blocal-py3-none-any.whl" }]',
    ]);
    const { content } = rewriteUvLockToProxy(before, PROXY);
    expect(content).toContain(
      `{ url = "${PROXY}files/typing-extensions/typing_extensions-1.0%2Blocal-py3-none-any.whl" }`,
    );
  });

  it.each([
    ["git", 'source = { git = "https://github.com/example/tool?rev=abc#abc" }'],
    ["path", 'source = { path = "../lib" }'],
    ["editable", 'source = { editable = "../lib" }'],
    ["virtual", 'source = { virtual = "." }'],
    ["direct URL", 'source = { url = "https://example.com/tool-1.0-py3-none-any.whl" }'],
    ["file registry", 'source = { registry = "file:///srv/index" }'],
    ["relative registry", 'source = { registry = "../index" }'],
  ])("never touches a %s package", (_label, source) => {
    const before = pkg([
      'name = "tool"',
      'version = "1.0"',
      source,
      'wheels = [{ url = "https://example.com/tool-1.0-py3-none-any.whl", hash = "sha256:aa" }]',
    ]);
    const result = rewriteUvLockToProxy(before, PROXY);
    expect(result.content).toBe(before);
    expect(result.files).toEqual({});
    expect(result.registries).toEqual({});
  });

  it("ignores URLs under [package.metadata] and in comments", () => {
    const before = pkg([
      'name = "app"',
      'version = "0.1.0"',
      'source = { virtual = "." }',
      "",
      "[package.metadata]",
      'requires-dist = [{ name = "x", source = { registry = "https://pypi.org/simple" } }]',
      '# source = { registry = "https://pypi.org/simple" }',
    ]);
    expect(rewriteUvLockToProxy(before, PROXY).content).toBe(before);
  });

  it("rewrites an inline source in optional-dependencies", () => {
    const before = pkg([
      'name = "app"',
      'version = "0.1.0"',
      'source = { virtual = "." }',
      "",
      "[package.optional-dependencies]",
      'extra = [{ name = "x", version = "2.0", source = { registry = "https://pypi.org/simple" } }]',
    ]);
    const { content, registries } = rewriteUvLockToProxy(before, PROXY);
    expect(content).toContain(`source = { registry = "${PROXY}simple" } }]`);
    expect(registries["x@2.0"]).toBe("https://pypi.org/simple");
  });

  it("leaves a URL alone when two origins would map to the same proxy URL", () => {
    const wheel = (host: string) => `wheels = [{ url = "https://${host}/a/x-1.0-py3-none-any.whl" }]`;
    const before = [
      "version = 1",
      "",
      "[[package]]",
      'name = "x"',
      'version = "1.0"',
      'source = { registry = "https://a.example/simple" }',
      wheel("a.example"),
      "",
      "[[package]]",
      'name = "x"',
      'version = "1.0"',
      'source = { registry = "https://b.example/simple" }',
      wheel("b.example"),
      "",
    ].join("\n");
    const { content, registries, files } = rewriteUvLockToProxy(before, PROXY);
    expect(Object.keys(files)).toEqual([`${PROXY}files/x/x-1.0-py3-none-any.whl`]);
    expect(registries["x@1.0"]).toBe("https://a.example/simple");
    expect(content).toContain('source = { registry = "https://b.example/simple" }');
    expect(content).toContain('wheels = [{ url = "https://b.example/a/x-1.0-py3-none-any.whl" }]');
  });

  it("stays fast on a large lock", () => {
    const body = Array.from({ length: 2500 }, (_, i) =>
      [
        "[[package]]",
        `name = "pkg-${i}"`,
        `version = "1.${i}"`,
        'source = { registry = "https://pypi.org/simple" }',
        `sdist = { url = "https://files.pythonhosted.org/p/pkg_${i}-1.${i}.tar.gz", hash = "sha256:aa", size = 1 }`,
        "wheels = [",
        `    { url = "https://files.pythonhosted.org/p/pkg_${i}-1.${i}-py3-none-any.whl", hash = "sha256:bb", size = 1 },`,
        "]",
        "",
      ].join("\n"),
    ).join("\n");
    const original = `version = 1\n\n${body}`;
    expect(original.split("\n").length).toBeGreaterThan(20_000);
    const started = Date.now();
    const { content, files, registries } = rewriteUvLockToProxy(original, PROXY);
    expect(restoreUvLock(content, { files, registries }, PROXY).content).toBe(original);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("restoreUvLock", () => {
  it("restores what it can and reports a package the agent added", () => {
    const original = fixture("uv.lock");
    const { content, files, registries } = rewriteUvLockToProxy(original, PROXY);
    const added = [
      "",
      "[[package]]",
      'name = "idna"',
      'version = "3.7"',
      `source = { registry = "${PROXY}simple" }`,
      `wheels = [{ url = "${PROXY}files/idna/idna-3.7-py3-none-any.whl", hash = "sha256:cc" }]`,
      "",
    ].join("\n");
    const result = restoreUvLock(content + added, { files, registries }, PROXY);
    expect(result.content).toBe(original + added);
    expect(result.unresolved).toEqual(["idna@3.7", `${PROXY}files/idna/idna-3.7-py3-none-any.whl`]);
  });

  it("leaves a lock without proxy URLs untouched", () => {
    const original = fixture("uv.lock");
    expect(restoreUvLock(original, { files: {}, registries: {} }, PROXY)).toEqual({
      content: original,
      unresolved: [],
    });
  });
});

describe("collectUvProxyReferences and restoreUvLockFromOrigins", () => {
  const proxied = fixture("uv-proxied.lock");
  const REAL = "https://registry.example.test/api/pypi/pypi";
  const answers = (): Map<string, string> =>
    new Map(
      collectUvProxyReferences(proxied, PROXY).files.map((file) => [file.url, `${REAL}/${file.name}/${file.filename}`]),
    );

  it("lists each proxy file once with the project and file name the proxy knows, and notes the index", () => {
    const references = collectUvProxyReferences(proxied, PROXY);
    expect(references.registry).toBe(true);
    expect(references.files).toContainEqual({
      url: `${PROXY}files/acme-core/acme_core-1.4.2-py3-none-any.whl`,
      name: "acme-core",
      filename: "acme_core-1.4.2-py3-none-any.whl",
    });
    expect(references.files).toHaveLength(6);
    expect(collectUvProxyReferences(fixture("uv.lock"), PROXY)).toEqual({ files: [], registry: false });
  });

  it("decodes a percent-encoded file name and ignores a URL that is not <name>/<file>", () => {
    const lock = pkg([
      'name = "x"',
      'version = "1"',
      `source = { registry = "${PROXY}simple" }`,
      `wheels = [{ url = "${PROXY}files/x/x-1%2Blocal-py3-none-any.whl" }, { url = "${PROXY}files/x/y/z.whl" }]`,
    ]);
    expect(collectUvProxyReferences(lock, PROXY).files).toEqual([
      { url: `${PROXY}files/x/x-1%2Blocal-py3-none-any.whl`, name: "x", filename: "x-1+local-py3-none-any.whl" },
    ]);
  });

  it("writes the proxy's address for every file and the index it gave, with no snapshot", () => {
    const result = restoreUvLockFromOrigins(proxied, PROXY, { index: `${REAL}/simple`, files: answers() });
    expect(result.unresolved).toEqual([]);
    expect(result.content).not.toContain("wardby-proxy");
    expect(result.content).toContain(`source = { registry = "${REAL}/simple" }`);
    expect(result.content).toContain(
      `{ url = "${REAL}/acme-core/acme_core-1.4.2-py3-none-any.whl", hash = "sha256:2222222222222222222222222222222222222222222222222222222222222222", size = 900 }`,
    );
  });

  it("leaves what the proxy did not answer, and reports it", () => {
    const all = answers();
    all.delete(`${PROXY}files/requests/requests-2.32.3-py3-none-any.whl`);
    const result = restoreUvLockFromOrigins(proxied, PROXY, { index: `${REAL}/simple`, files: all });
    expect(result.unresolved).toEqual([`${PROXY}files/requests/requests-2.32.3-py3-none-any.whl`]);
    expect(result.content).toContain(`${PROXY}files/requests/requests-2.32.3-py3-none-any.whl`);
  });

  it("reports every index entry when the proxy gave no index and no snapshot knows it", () => {
    const result = restoreUvLockFromOrigins(proxied, PROXY, { files: answers() });
    expect(result.unresolved.sort()).toEqual(["acme-core@1.4.2", "requests@2.32.3", "typing-extensions@4.12.2"]);
  });

  it("falls back to a snapshot's recorded original only for what the proxy did not answer", () => {
    const original = fixture("uv.lock");
    const { content, files, registries } = rewriteUvLockToProxy(original, PROXY);
    const partial = answers();
    partial.delete(`${PROXY}files/typing-extensions/typing_extensions-4.12.2-py3-none-any.whl`);
    const result = restoreUvLockFromOrigins(content, PROXY, {
      index: `${REAL}/simple`,
      files: partial,
      fallback: { files, registries },
    });
    expect(result.unresolved).toEqual([]);
    expect(result.content).toContain(
      files[`${PROXY}files/typing-extensions/typing_extensions-4.12.2-py3-none-any.whl`],
    );
    expect(result.content).toContain(`${REAL}/requests/requests-2.32.3-py3-none-any.whl`);
  });
});

describe("isUvLock", () => {
  it("accepts a uv lock and rejects other TOML and lockfiles", () => {
    expect(isUvLock(fixture("uv.lock"))).toBe(true);
    expect(isUvLock('[[package]]\nname = "x"\nversion = "1"\n')).toBe(false);
    expect(isUvLock('# poetry\n[[package]]\nname = "x"\nversion = "1"\n')).toBe(false);
    expect(isUvLock("version = 1\n")).toBe(false);
  });
});
