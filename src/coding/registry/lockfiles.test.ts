import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeRegistryLockfiles } from "./lockfiles.js";

const PROXY_BASE = "http://wardby-proxy:8787";
const PROXIED = `"resolved": "${PROXY_BASE}/registry/npm/-/tarball/%40scope%2Fpkg/3.5.1"`;
const PUBLIC = '"resolved": "https://registry.npmjs.org/@scope/pkg/-/pkg-3.5.1.tgz"';

const lock = (resolved: string) =>
  `{\n  "packages": {\n    "node_modules/@scope/pkg": {\n      ${resolved}\n    }\n  }\n}\n`;

async function write(root: string, path: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content, { mode });
}

describe("normalizeRegistryLockfiles", () => {
  it("rewrites npm lockfiles at any depth, skipping dependency/cache folders and symlinks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-lockfiles-"));
    const outside = await mkdtemp(join(tmpdir(), "wardby-lockfiles-outside-"));
    await write(workspace, "package-lock.json", lock(PROXIED));
    await write(workspace, "web/package-lock.json", lock(PROXIED), 0o600);
    await write(workspace, "tools/cli/npm-shrinkwrap.json", lock(PROXIED));
    await write(workspace, "web/node_modules/dep/package-lock.json", lock(PROXIED));
    await write(workspace, ".cache/npm/package-lock.json", lock(PROXIED));
    await write(workspace, "web/notes.json", lock(PROXIED));
    await write(outside, "package-lock.json", lock(PROXIED));
    await mkdir(join(workspace, "linked"));
    await symlink(join(outside, "package-lock.json"), join(workspace, "linked/package-lock.json"));
    await symlink(outside, join(workspace, "linked-dir"));

    const rewritten = await normalizeRegistryLockfiles({ workspace, proxyBaseUrl: `${PROXY_BASE}/` });

    expect(rewritten).toEqual(["package-lock.json", "tools/cli/npm-shrinkwrap.json", "web/package-lock.json"]);
    for (const path of rewritten) expect(await readFile(join(workspace, path), "utf8")).toBe(lock(PUBLIC));
    expect((await stat(join(workspace, "web/package-lock.json"))).mode & 0o777).toBe(0o600);
    for (const path of ["web/node_modules/dep/package-lock.json", ".cache/npm/package-lock.json", "web/notes.json"]) {
      expect(await readFile(join(workspace, path), "utf8")).toBe(lock(PROXIED));
    }
    expect(await readFile(join(outside, "package-lock.json"), "utf8")).toBe(lock(PROXIED));
  });

  it("leaves lockfiles without proxy URLs alone", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-lockfiles-"));
    await write(workspace, "package-lock.json", lock(PUBLIC));
    expect(await normalizeRegistryLockfiles({ workspace, proxyBaseUrl: PROXY_BASE })).toEqual([]);
    expect(await readFile(join(workspace, "package-lock.json"), "utf8")).toBe(lock(PUBLIC));
  });

  it("rewrites pnpm and yarn lockfiles too, so a committed one never names the proxy", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-lockfiles-"));
    const npmBase = `${PROXY_BASE}/registry/npm/`;
    await write(
      workspace,
      "pnpm-lock.yaml",
      `packages:\n  a@1.0.0:\n    resolution: {integrity: sha512-a, tarball: ${npmBase}-/tarball/a/1.0.0}\n`,
    );
    await write(
      workspace,
      "web/yarn.lock",
      `# yarn lockfile v1\n\na@^1:\n  version "1.0.0"\n  resolved "${npmBase}-/tarball/a/1.0.0#abc"\n`,
    );
    const rewritten = await normalizeRegistryLockfiles({ workspace, proxyBaseUrl: PROXY_BASE });
    expect(rewritten).toEqual(["pnpm-lock.yaml", "web/yarn.lock"]);
    for (const path of rewritten) expect(await readFile(join(workspace, path), "utf8")).not.toContain(PROXY_BASE);
  });

  it("turns each client's lockfile written through the proxy back into what a public install writes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-lockfiles-"));
    const npmBase = `${PROXY_BASE}/registry/npm/`;
    const fixture = (name: string) => readFile(new URL(`./fixtures/lockfiles/${name}`, import.meta.url), "utf8");
    // What each client recorded through the proxy (seen with the real
    // clients in clients.integration.test.ts): pnpm a `tarball` on the
    // proxy's own route, yarn classic proxy `resolved` URLs, yarn Berry an
    // `__archiveUrl` naming the proxy.
    const pnpm = await fixture("pnpm-lock-v9.yaml");
    const pnpmProxied = pnpm.replace(
      /resolution: \{integrity: ([^}]+)\}\n(\s+engines: [^\n]+\n)?/,
      (match, integrity: string) =>
        match.replace(
          `{integrity: ${integrity}}`,
          `{integrity: ${integrity}, tarball: ${npmBase}-/tarball/%40sindresorhus%2Fis/4.6.0}`,
        ),
    );
    const classic = await fixture("yarn-v1.lock");
    const classicProxied = classic.replaceAll("https://registry.yarnpkg.com/", npmBase);
    const berry = await fixture("yarn-berry.lock");
    const berryProxied = berry.replace(
      'resolution: "debug@npm:4.4.3"',
      `resolution: "debug@npm:4.4.3::__archiveUrl=${encodeURIComponent(`${npmBase}-/tarball/debug/4.4.3`)}"`,
    );
    expect(pnpmProxied).not.toBe(pnpm);
    expect(berryProxied).not.toBe(berry);
    await write(workspace, "pnpm-lock.yaml", pnpmProxied);
    await write(workspace, "classic/yarn.lock", classicProxied);
    await write(workspace, "berry/yarn.lock", berryProxied);

    const rewritten = await normalizeRegistryLockfiles({ workspace, proxyBaseUrl: PROXY_BASE });

    expect(rewritten).toEqual(["berry/yarn.lock", "classic/yarn.lock", "pnpm-lock.yaml"]);
    expect(await readFile(join(workspace, "pnpm-lock.yaml"), "utf8")).toBe(pnpm);
    expect(await readFile(join(workspace, "classic/yarn.lock"), "utf8")).toBe(classic);
    expect(await readFile(join(workspace, "berry/yarn.lock"), "utf8")).toBe(berry);
    for (const path of rewritten) {
      const content = await readFile(join(workspace, path), "utf8");
      expect(content).not.toContain("wardby-proxy");
      expect(content).not.toContain("rrg_");
    }
  });
});

describe("normalizeRegistryLockfiles for uv", () => {
  it("rewrites a uv.lock uv wrote through the proxy to PyPI's URLs, outside .venv", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-lockfiles-"));
    const pypiBase = `${PROXY_BASE}/registry/pypi/`;
    const written = [
      "[[package]]",
      'name = "six"',
      `source = { registry = "${pypiBase}simple/" }`,
      `wheels = [{ url = "${pypiBase}files/six/six-1.17.0-py2.py3-none-any.whl", hash = "sha256:47" }]`,
      "",
    ].join("\n");
    await write(workspace, "uv.lock", written);
    await write(workspace, ".venv/lib/uv.lock", written);
    expect(await normalizeRegistryLockfiles({ workspace, proxyBaseUrl: PROXY_BASE })).toEqual(["uv.lock"]);
    expect(await readFile(join(workspace, "uv.lock"), "utf8")).toBe(
      [
        "[[package]]",
        'name = "six"',
        'source = { registry = "https://pypi.org/simple" }',
        'wheels = [{ url = "https://files.pythonhosted.org/packages/py2.py3/s/six/six-1.17.0-py2.py3-none-any.whl", hash = "sha256:47" }]',
        "",
      ].join("\n"),
    );
    expect(await readFile(join(workspace, ".venv/lib/uv.lock"), "utf8")).toBe(written);
  });
});
