/**
 * Real-client integration test for the coding package registry: starts a
 * real coding-proxy HTTP server with a real RegistryService (over
 * MemoryRegistryStore, so no database is needed) whose `upstream` serves
 * the committed npm/PyPI fixtures — cloned and adjusted so the one version
 * each client actually installs points at a package.json-only .tgz / a
 * minimal .whl this file builds and hashes itself, instead of the real
 * npmjs.org/pypi.org — then drives the real `npm` (and, when available,
 * `pip`) binaries against it exactly as a sandboxed worker would.
 *
 * Skipped by default: it spawns real package-manager binaries and would
 * make the default `npm test` run depend on what's installed on the
 * machine. Run it explicitly with:
 *
 *   RUN_CLIENT_INTEGRATION=1 npx vitest run src/providers/coding-proxy/registry/clients.integration.test.ts
 *
 * The pip case is skipped (via `it.skipIf`) when `pip` is not on PATH.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import { REGISTRY_ADAPTERS } from "../../../coding/registry/adapters.js";
import { npmAdapter } from "../../../coding/registry/npm.js";
import { pypiAdapter } from "../../../coding/registry/pypi.js";
import type { UpstreamFetch } from "../../../coding/registry/types.js";
import { MemoryProxyLedger } from "../memory-ledger.js";
import { capabilityHash, CodingProxy } from "../proxy.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../server.js";
import { OsvAudit } from "./audit.js";
import { RegistryService } from "./service.js";
import { MemoryRegistryStore, type RegistryRunContext } from "./store.js";

const RUN = process.env.RUN_CLIENT_INTEGRATION === "1";

const hasPip = (() => {
  try {
    execFileSync("pip", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A tiny package.json-only .tgz, built the same way npm's own tarballs are
 *  laid out (a single "package/" root). */
async function npmTarball(pkg: { name: string; version: string }): Promise<Buffer> {
  const pack = tar.pack();
  const body = JSON.stringify(pkg);
  await new Promise<void>((resolve, reject) =>
    pack.entry({ name: "package/package.json" }, body, (err) => (err ? reject(err) : resolve())),
  );
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack as unknown as Readable) chunks.push(chunk as Buffer);
  return gzipSync(Buffer.concat(chunks));
}

/** A minimal but structurally valid wheel: a top-level module plus the
 *  three .dist-info files pip needs to install it (METADATA, WHEEL,
 *  RECORD), with zero Requires-Dist so installing it needs nothing else. */
function pypiWheel(name: string, version: string): Buffer {
  const distInfo = `${name}-${version}.dist-info`;
  const record = [
    `${name}/__init__.py,,`,
    `${distInfo}/METADATA,,`,
    `${distInfo}/WHEEL,,`,
    `${distInfo}/RECORD,,`,
  ].join("\n");
  const files: Record<string, Uint8Array> = {
    [`${name}/__init__.py`]: strToU8(`__version__ = ${JSON.stringify(version)}\n`),
    [`${distInfo}/METADATA`]: strToU8(`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`),
    [`${distInfo}/WHEEL`]: strToU8(
      "Wheel-Version: 1.0\nGenerator: wardby-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    ),
    [`${distInfo}/RECORD`]: strToU8(`${record}\n`),
  };
  return Buffer.from(zipSync(files, { level: 0 }));
}

/** Reserves a free localhost port synchronously ahead of constructing
 *  RegistryService, whose `proxyBase` (baked into every download URL it
 *  hands back to the client) must already know the port the real HTTP
 *  server will bind to. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

interface TestRegistry {
  server: CodingProxyServerHandle;
  store: MemoryRegistryStore;
  token: string;
  registryUrl: (ecosystem: string) => string;
}

/** Starts a real coding-proxy HTTP server backed by a real RegistryService,
 *  routing every upstream request through `routes` (keyed by exact URL)
 *  instead of the real npm/PyPI hosts. */
async function startTestRegistry(
  allowlist: PackageAllowlist,
  routes: Map<string, () => Response>,
): Promise<TestRegistry> {
  const port = await freePort();
  const store = new MemoryRegistryStore();
  const token = `rrg_test_${Math.random().toString(36).slice(2)}`;
  const context: RegistryRunContext = {
    runId: "client-integration-run",
    deadlineAt: new Date(Date.now() + 5 * 60_000),
    allowlist,
    policy: {},
  };
  store.contexts.set(capabilityHash(token), context);

  const upstream: UpstreamFetch = async (url) => {
    const handler = routes.get(url);
    if (!handler) throw new Error(`clients.integration.test: no fake upstream route registered for ${url}`);
    return handler();
  };
  const registry = new RegistryService({
    adapters: REGISTRY_ADAPTERS,
    store,
    audit: new OsvAudit({ fetch: async () => Response.json({ vulns: [] }), failOpen: true }),
    upstream,
    proxyBase: `http://127.0.0.1:${port}/registry/`,
    limits: { maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxFiles: 100, idleTimeoutMs: 30_000 },
  });
  const proxy = new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "UNUSED" } });
  const server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port, registry });
  return { server, store, token, registryUrl: (ecosystem) => `http://127.0.0.1:${port}/registry/${ecosystem}/` };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn().catch(() => undefined)));
});

describe.skipIf(!RUN)("registry proxy with real npm and pip clients", () => {
  it("installs a real npm package end to end through the proxy", async () => {
    const npmFixture = new URL("../../../coding/registry/fixtures/npm-left-pad.json", import.meta.url);
    const npmDoc = JSON.parse(await readFile(npmFixture, "utf8"));
    const version = npmDoc.versions["1.3.0"];
    const tarballUrl: string = version.dist.tarball;
    const tarball = await npmTarball({ name: "left-pad", version: "1.3.0" });
    version.dist = {
      tarball: tarballUrl,
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    };
    delete version.dependencies;

    const routes = new Map<string, () => Response>([
      ["https://registry.npmjs.org/left-pad", () => Response.json(npmDoc)],
      [tarballUrl, () => new Response(tarball)],
    ]);
    const {
      server,
      store,
      token,
      registryUrl: registryUrlFor,
    } = await startTestRegistry({ npm: ["left-pad"] }, routes);
    cleanups.push(() => server.close());

    const cacheDir = await tmpDir("wardby-npm-cache-");
    const projectDir = await tmpDir("wardby-npm-proj-");
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    cleanups.push(() => rm(projectDir, { recursive: true, force: true }));

    const registryUrl = registryUrlFor("npm");
    const config = npmAdapter.workerConfig({ registryUrl, token, cacheDir });
    const npmrcPath = config.files[0].path;
    for (const file of config.files) await writeFile(file.path, file.content, { mode: file.mode });

    const result = await run(
      "npm",
      [
        "install",
        "left-pad",
        "--registry",
        registryUrl,
        "--userconfig",
        npmrcPath,
        "--cache",
        join(cacheDir, "cache"),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: projectDir, env: process.env },
    );
    expect(result.code, `npm stderr:\n${result.stderr}`).toBe(0);

    const installed = JSON.parse(await readFile(join(projectDir, "node_modules/left-pad/package.json"), "utf8"));
    expect(installed).toMatchObject({ name: "left-pad", version: "1.3.0" });

    const served = (await store.listFetches("client-integration-run")).filter((fetch) => fetch.outcome === "served");
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ ecosystem: "npm", name: "left-pad", version: "1.3.0" });
  });

  it("refuses a package not on the allowlist and surfaces the reason to npm", async () => {
    const { server, token, registryUrl: registryUrlFor } = await startTestRegistry({ npm: ["left-pad"] }, new Map());
    cleanups.push(() => server.close());

    const cacheDir = await tmpDir("wardby-npm-cache-denied-");
    const projectDir = await tmpDir("wardby-npm-proj-denied-");
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    cleanups.push(() => rm(projectDir, { recursive: true, force: true }));

    const registryUrl = registryUrlFor("npm");
    const config = npmAdapter.workerConfig({ registryUrl, token, cacheDir });
    const npmrcPath = config.files[0].path;
    for (const file of config.files) await writeFile(file.path, file.content, { mode: file.mode });

    const result = await run(
      "npm",
      [
        "install",
        "not-allowed-package",
        "--registry",
        registryUrl,
        "--userconfig",
        npmrcPath,
        "--cache",
        join(cacheDir, "cache"),
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: projectDir, env: process.env },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("wardby_package_not_allowed");
  });

  it.skipIf(!hasPip)("installs a real pip package end to end through the proxy", async () => {
    const pypiFixture = new URL("../../../coding/registry/fixtures/pypi-flask.json", import.meta.url);
    const pypiDoc = JSON.parse(await readFile(pypiFixture, "utf8"));
    const wheelEntry = pypiDoc.files.find(
      (file: { filename: string }) => file.filename === "flask-3.1.2-py3-none-any.whl",
    );
    const wheel = pypiWheel("flask", "3.1.2");
    wheelEntry.hashes = { sha256: createHash("sha256").update(wheel).digest("hex") };
    wheelEntry.size = wheel.byteLength;
    wheelEntry["core-metadata"] = false;
    delete wheelEntry["dist-info-metadata"];

    const routes = new Map<string, () => Response>([
      ["https://pypi.org/simple/flask/", () => Response.json(pypiDoc)],
      [wheelEntry.url, () => new Response(wheel)],
    ]);
    const { server, store, token, registryUrl: registryUrlFor } = await startTestRegistry({ pypi: ["flask"] }, routes);
    cleanups.push(() => server.close());

    const cacheDir = await tmpDir("wardby-pip-cache-");
    const targetDir = await tmpDir("wardby-pip-target-");
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    cleanups.push(() => rm(targetDir, { recursive: true, force: true }));

    const registryUrl = registryUrlFor("pypi");
    const config = pypiAdapter.workerConfig({ registryUrl, token, cacheDir });

    const result = await run("pip", ["install", "--target", targetDir, "flask"], {
      cwd: cacheDir,
      env: { ...process.env, ...config.env },
    });
    expect(result.code, `pip stderr:\n${result.stderr}`).toBe(0);

    const installed = await readFile(join(targetDir, "flask-3.1.2.dist-info", "METADATA"), "utf8");
    expect(installed).toContain("Name: flask");
    expect(installed).toContain("Version: 3.1.2");

    const served = (await store.listFetches("client-integration-run")).filter((fetch) => fetch.outcome === "served");
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ ecosystem: "pypi", name: "flask", version: "3.1.2" });
  });
});
