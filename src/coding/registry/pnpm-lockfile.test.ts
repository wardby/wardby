import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizePnpmLockfile, parsePnpmLockfile } from "./pnpm-lockfile.js";
import { RegistryError } from "./types.js";

const PROXY = "http://wardby-proxy:8787/registry/npm/";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");
const parse = (body: string, maxEntries = 100) => parsePnpmLockfile(body, { maxEntries, proxyRegistryUrl: PROXY });

function failure(fn: () => unknown): [number, string] | string {
  try {
    fn();
  } catch (error) {
    return error instanceof RegistryError ? [error.status, error.code] : String(error);
  }
  return "no error";
}

// What the fixtures lock (written by pnpm 10 and pnpm 8 for the same
// package.json): debug -> ms, an alias string-width-cjs -> string-width and
// its three dependencies, and a scoped package.
const FIXTURE_VERSIONS = [
  "@sindresorhus/is@4.6.0",
  "ansi-regex@5.0.1",
  "debug@4.4.3",
  "emoji-regex@8.0.0",
  "is-fullwidth-code-point@3.0.0",
  "ms@2.1.3",
  "string-width@4.2.3",
  "strip-ansi@6.0.1",
];

describe("parsePnpmLockfile", () => {
  for (const [file, debugPath, aliasPath] of [
    ["pnpm-lock-v9.yaml", "debug@4.4.3", "string-width@4.2.3"],
    ["pnpm-lock-v6.yaml", "/debug@4.4.3", "/string-width@4.2.3"],
  ] as const) {
    it(`reads a real ${file}: registry entries with their integrity, and pnpm's own references`, () => {
      const parsed = parse(fixture(file));
      expect(parsed.integrity).toBeUndefined();
      expect(parsed.entries.map((entry) => `${entry.name}@${entry.version}`).sort()).toEqual(FIXTURE_VERSIONS);
      expect(parsed.entries.every((entry) => entry.kind === "registry")).toBe(true);
      expect(parsed.entries.find((entry) => entry.name === "ms")?.integrity).toBe(
        "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      );
      expect(parsed.resolve(debugPath, "ms")).toMatchObject({ name: "ms", version: "2.1.3" });
      expect(parsed.resolve(aliasPath, "strip-ansi")).toMatchObject({ name: "strip-ansi", version: "6.0.1" });
      expect(parsed.resolve(debugPath, "supports-color")).toBeUndefined();
      expect(parsed.projects).toEqual([
        {
          path: ".",
          dependencies: [
            { key: "@sindresorhus/is", name: "@sindresorhus/is", range: "^4.6.0" },
            { key: "debug", name: "debug", range: "^4.3.0" },
            { key: "string-width-cjs", name: "string-width", range: "^4.2.0" },
          ],
        },
      ]);
    });
  }

  const v9 = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      parent:
        specifier: ^1.0.0
        version: 1.0.0(react@18.2.0)

packages:

  parent@1.0.0:
    resolution: {integrity: sha512-parent}
    peerDependencies:
      react: '*'

  react@18.2.0:
    resolution: {integrity: sha512-react, tarball: ${PROXY}-/tarball/react/18.2.0}

  '@s/b@2.0.0':
    resolution: {integrity: sha512-b}

  git-dep@1.0.0:
    resolution: {commit: abc, repo: https://github.com/x/y.git, type: git}

  url-dep@1.0.0:
    resolution: {integrity: sha512-u, tarball: https://example.com/url-dep-1.0.0.tgz}

  local@file:../local:
    resolution: {directory: ../local, type: directory}

  weird@latest:
    resolution: {integrity: sha512-w}

snapshots:

  parent@1.0.0(react@18.2.0):
    dependencies:
      react: 18.2.0
      b-alias: '@s/b@2.0.0'
      local: file:../local
      sibling: link:../sibling
      git-dep: 1.0.0
    optionalDependencies:
      url-dep: 1.0.0

  react@18.2.0: {}

  '@s/b@2.0.0': {}

  git-dep@1.0.0: {}

  url-dep@1.0.0: {}

  local@file:../local: {}

  weird@latest: {}
`;

  it("classifies v9 entries: peers, aliases, proxy tarballs, local and non-registry sources", () => {
    const parsed = parse(v9);
    expect(Object.fromEntries(parsed.entries.map((entry) => [entry.path, entry.kind]))).toEqual({
      "parent@1.0.0(react@18.2.0)": "registry",
      "react@18.2.0": "registry",
      "@s/b@2.0.0": "registry",
      "git-dep@1.0.0": "unsupported",
      "url-dep@1.0.0": "unsupported",
      "weird@latest": "unsupported",
    });
    const from = "parent@1.0.0(react@18.2.0)";
    expect(parsed.resolve(from, "react")).toMatchObject({
      name: "react",
      version: "18.2.0",
      integrity: "sha512-react",
    });
    expect(parsed.resolve(from, "b-alias")).toMatchObject({ name: "@s/b", version: "2.0.0" });
    expect(parsed.resolve(from, "url-dep")).toMatchObject({ kind: "unsupported" });
    expect(parsed.resolve(from, "local")).toBeUndefined();
    expect(parsed.resolve(from, "sibling")).toBeUndefined();
    expect(parsed.resolve("nowhere", "react")).toBeUndefined();
  });

  it("refuses unsupported versions, too many entries, aliases and invalid YAML", () => {
    expect(
      failure(() => parse("lockfileVersion: 5.4\npackages:\n  /a/1.0.0:\n    resolution: {integrity: x}\n")),
    ).toEqual([400, "wardby_lockfile_unsupported"]);
    expect(failure(() => parse(v9, 3))).toEqual([413, "wardby_lockfile_too_large"]);
    // Far over the bound: refused before the YAML is parsed at all.
    const huge = `lockfileVersion: '9.0'\nsnapshots:\n${"  x@1.0.0: {}\n".repeat(50)}`;
    expect(failure(() => parse(huge, 5))).toEqual([413, "wardby_lockfile_too_large"]);
    const aliased = "lockfileVersion: '9.0'\nanchor: &a {x: 1}\nsnapshots:\n  a@1.0.0: *a\n";
    expect(failure(() => parse(aliased))).toEqual([400, "wardby_bad_request"]);
    expect(failure(() => parse("lockfileVersion: '9.0'\nsnapshots: [\n"))).toEqual([400, "wardby_bad_request"]);
  });

  it("resolves each importer's dependencies by the version it records", () => {
    const parsed = parse(`lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      a:
        specifier: ^1.0.0
        version: 1.0.0

  packages/web:
    dependencies:
      a-cjs:
        specifier: npm:a@^2.0.0
        version: a@2.0.0
      shared:
        specifier: workspace:*
        version: link:../shared

packages:

  a@1.0.0:
    resolution: {integrity: sha512-a1}

  a@2.0.0:
    resolution: {integrity: sha512-a2}

snapshots:

  a@1.0.0: {}

  a@2.0.0: {}
`);
    expect(parsed.resolve(".", "a")).toMatchObject({ name: "a", version: "1.0.0" });
    expect(parsed.resolve("packages/web", "a-cjs")).toMatchObject({ name: "a", version: "2.0.0" });
    expect(parsed.resolve("packages/web", "shared")).toBeUndefined();
  });

  it("never lets a key reach the object prototype", () => {
    const parsed = parse("lockfileVersion: '9.0'\nsnapshots:\n  __proto__@1.0.0: {}\n  constructor: {}\n");
    expect(parsed.entries.map((entry) => entry.kind)).toEqual(["unsupported", "unsupported"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("normalizePnpmLockfile", () => {
  it("drops a proxy tarball next to an integrity and rewrites one without, leaving everything else", () => {
    const before = [
      "packages:",
      "",
      "  react@18.2.0:",
      `    resolution: {integrity: sha512-r, tarball: ${PROXY}-/tarball/react/18.2.0}`,
      "",
      "  '@s/b@2.0.0':",
      `    resolution: {tarball: ${PROXY}-/tarball/%40s%2Fb/2.0.0}`,
      "",
      "  other@1.0.0:",
      "    resolution: {integrity: sha512-o, tarball: https://example.com/other-1.0.0.tgz}",
      "",
    ].join("\n");
    expect(normalizePnpmLockfile(before, PROXY)).toBe(
      [
        "packages:",
        "",
        "  react@18.2.0:",
        "    resolution: {integrity: sha512-r}",
        "",
        "  '@s/b@2.0.0':",
        "    resolution: {tarball: https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz}",
        "",
        "  other@1.0.0:",
        "    resolution: {integrity: sha512-o, tarball: https://example.com/other-1.0.0.tgz}",
        "",
      ].join("\n"),
    );
    const real = fixture("pnpm-lock-v9.yaml");
    expect(normalizePnpmLockfile(real, PROXY)).toBe(real);
  });
});
