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
});
