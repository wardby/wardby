import { describe, expect, it } from "vitest";
import { npmAdapter } from "./npm.js";
import { npmLockfiles } from "./npm-lockfile.js";

const PROXY = "http://wardby-proxy:8787/registry/npm/";

function lockfile(resolved: Record<string, string>): string {
  const packages = Object.fromEntries(
    Object.entries(resolved).map(([path, url]) => [path, { version: "1.0.0", resolved: url, integrity: "sha512-x" }]),
  );
  return `${JSON.stringify({ name: "web", lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

describe("npmLockfiles", () => {
  it("is the npm adapter's lockfile hook and names both npm lockfiles", () => {
    expect(npmAdapter.lockfiles).toBe(npmLockfiles);
    expect(npmLockfiles.names).toEqual(["package-lock.json", "npm-shrinkwrap.json"]);
  });

  it.each([
    [`${PROXY}-/tarball/left-pad/1.3.0`, "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"],
    [`${PROXY}-/tarball/JSONStream/1.3.5`, "https://registry.npmjs.org/JSONStream/-/JSONStream-1.3.5.tgz"],
    [
      `${PROXY}-/tarball/%40react-aria%2Flive-announcer/3.5.1`,
      "https://registry.npmjs.org/@react-aria/live-announcer/-/live-announcer-3.5.1.tgz",
    ],
    [`${PROXY}-/tarball/%40scope%2fpkg/2.0.0-beta.1`, "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0-beta.1.tgz"],
    [`${PROXY}left-pad/-/left-pad-1.3.0.tgz`, "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"],
    [`${PROXY}@scope/pkg/-/pkg-3.5.1.tgz`, "https://registry.npmjs.org/@scope/pkg/-/pkg-3.5.1.tgz"],
    [`${PROXY}@scope%2fpkg/-/pkg-3.5.1.tgz`, "https://registry.npmjs.org/@scope/pkg/-/pkg-3.5.1.tgz"],
    [`${PROXY}%40scope%2Fpkg/-/pkg-3.5.1.tgz`, "https://registry.npmjs.org/@scope/pkg/-/pkg-3.5.1.tgz"],
  ])("rewrites %s to the public registry", (proxied, canonical) => {
    const before = lockfile({ "node_modules/a": proxied });
    expect(npmLockfiles.normalize(before, PROXY)).toBe(before.replace(proxied, canonical));
  });

  it("leaves every URL outside the proxy's npm route untouched", () => {
    const untouched = [
      "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      "git+ssh://git@github.com/example/repo.git#0123456789abcdef0123456789abcdef01234567",
      "file:../shared",
      "http://wardby-proxy:8787/registry/pypi/-/tarball/left-pad/1.3.0",
      "http://other-host:8787/registry/npm/-/tarball/left-pad/1.3.0",
      // Proxy URLs that do not name a valid package and version are left alone.
      `${PROXY}-/tarball/left-pad/not-a-version`,
      `${PROXY}-/tarball/%E0%A4%A/1.0.0`,
      `${PROXY}left-pad/-/right-pad-1.3.0.tgz`,
      `${PROXY}left-pad`,
    ];
    const before = lockfile(Object.fromEntries(untouched.map((url, index) => [`node_modules/p${index}`, url])));
    expect(npmLockfiles.normalize(before, PROXY)).toBe(before);
  });

  it("only rewrites resolved values, preserving every other byte", () => {
    const proxied = `${PROXY}-/tarball/left-pad/1.3.0`;
    const before = [
      "{",
      '  "name": "web",',
      `  "description": "${proxied}",`,
      '  "lockfileVersion": 1,',
      '  "dependencies": {',
      '    "left-pad": {',
      '      "version": "1.3.0",',
      `      "resolved":  "${proxied}",`,
      '      "integrity": "sha512-x"',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const after = npmLockfiles.normalize(before, PROXY);
    expect(after).toBe(
      before.replace(
        `"resolved":  "${proxied}"`,
        '"resolved":  "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"',
      ),
    );
    expect(after).toContain(`"description": "${proxied}"`);
  });

  it("accepts a proxy base given without its trailing slash", () => {
    const before = lockfile({ "node_modules/a": `${PROXY}-/tarball/left-pad/1.3.0` });
    expect(npmLockfiles.normalize(before, PROXY.slice(0, -1))).toContain(
      '"resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz"',
    );
  });
});
