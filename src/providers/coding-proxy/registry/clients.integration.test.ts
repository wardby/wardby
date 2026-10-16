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
 * The pip case is skipped (via `it.skipIf`) when `pip` is not on PATH, the
 * pnpm and yarn classic cases when those are not, and the yarn Berry case
 * when corepack has no yarn 2+ release cached (it would otherwise download
 * one through the test registry, which serves only the fixtures).
 */
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import type { PackageAllowlist } from "../../../coding/registry/allowlist.js";
import { BUILTIN_COLLECT_EXCLUDE_NAMES } from "../../../coding/collect-exclude.js";
import { REGISTRY_ADAPTERS } from "../../../coding/registry/adapters.js";
import { normalizeRegistryLockfiles } from "../../../coding/registry/lockfiles.js";
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

const has = (command: string) => {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const hasPip = has("pip");
const hasPnpm = has("pnpm");
const hasYarn = has("yarn");
/** corepack's cache on this machine, and a yarn 2+ release in it. */
const COREPACK_CACHE = process.env.COREPACK_HOME ?? join(homedir(), ".cache", "node", "corepack");

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
  /** Whether any graph walk ran for the run (its walk state exists). */
  walked: () => boolean;
}

/** Starts a real coding-proxy HTTP server backed by a real RegistryService,
 *  routing every upstream request through `routes` (keyed by exact URL)
 *  instead of the real npm/PyPI hosts. */
async function startTestRegistry(
  allowlist: PackageAllowlist,
  routes: Map<string, () => Response | Promise<Response>>,
  options: { graphTimeoutMs?: number } = {},
): Promise<TestRegistry> {
  const port = await freePort();
  const store = new MemoryRegistryStore();
  const token = `rrg_test_${Math.random().toString(36).slice(2)}`;
  const context: RegistryRunContext = {
    runId: "client-integration-run",
    deadlineAt: new Date(Date.now() + 5 * 60_000),
    allowlist,
    policy: {},
    repository: "owner/repo",
    cacheImage: null,
    dependencyCache: false,
    packageAudit: null,
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
    // No advisories: `/v1/query` answers no vulns, `/v1/querybatch` one
    // empty result per query. Fail closed, as in production.
    audit: new OsvAudit({
      fetch: async (url, init) =>
        url.endsWith("/querybatch")
          ? Response.json({
              results: (JSON.parse(init?.body ?? "{}") as { queries: unknown[] }).queries.map(() => ({})),
            })
          : Response.json({ vulns: [] }),
      failOpen: false,
    }),
    upstream,
    proxyBase: `http://127.0.0.1:${port}/registry/`,
    limits: { maxFileBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxFiles: 100, idleTimeoutMs: 30_000 },
    graphTimeoutMs: options.graphTimeoutMs,
  });
  const proxy = new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "UNUSED" } });
  const server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port, registry });
  const walked = () =>
    ((registry as unknown as { tallies: Map<string, { graphs?: Map<string, unknown> }> }).tallies.get(context.runId)
      ?.graphs?.size ?? 0) > 0;
  return {
    server,
    store,
    token,
    registryUrl: (ecosystem) => `http://127.0.0.1:${port}/registry/${ecosystem}/`,
    walked,
  };
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

  it("installs from a committed package-lock.json with npm ci (tarballs only, graph resolved on demand)", async () => {
    // The lockfile's `resolved` URLs point at registry.npmjs.org; npm's
    // default replace-registry-host rewrites them to the proxy's standard
    // `<name>/-/<unscoped>-<version>.tgz` path, and with a complete
    // lockfile npm requests no metadata at all. Only the root is
    // allowlisted, so the child's tarball is allowed only because the
    // proxy resolves the approved graph (root -> child) on demand.
    const fixtureDir = new URL("./fixtures/npm-lockfile/", import.meta.url);
    const lock = JSON.parse(await readFile(new URL("package-lock.json", fixtureDir), "utf8"));
    const routes = new Map<string, () => Response>();
    const published = "2020-01-01T00:00:00.000Z";
    for (const [key, entry] of Object.entries(lock.packages as Record<string, Record<string, unknown>>)) {
      if (!key) continue;
      const name = key.slice("node_modules/".length);
      const version = entry.version as string;
      const resolved = entry.resolved as string;
      const bytes = await readFile(new URL(`${name}-${version}.tgz`, fixtureDir));
      routes.set(resolved, () => new Response(bytes));
      routes.set(`https://registry.npmjs.org/${name}`, () =>
        Response.json({
          name,
          "dist-tags": { latest: version },
          time: { [version]: published },
          versions: {
            [version]: {
              name,
              version,
              dependencies: entry.dependencies,
              dist: { tarball: resolved, integrity: entry.integrity },
            },
          },
        }),
      );
    }
    const {
      server,
      store,
      token,
      registryUrl: registryUrlFor,
      walked,
    } = await startTestRegistry({ npm: ["wardby-lock-root"] }, routes);
    cleanups.push(() => server.close());

    const cacheDir = await tmpDir("wardby-npm-cache-lock-");
    const projectDir = await tmpDir("wardby-npm-proj-lock-");
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
    for (const file of ["package.json", "package-lock.json"])
      await writeFile(join(projectDir, file), await readFile(new URL(file, fixtureDir)));

    const registryUrl = registryUrlFor("npm");
    const config = npmAdapter.workerConfig({ registryUrl, token, cacheDir });
    const npmrcPath = config.files[0].path;
    for (const file of config.files) await writeFile(file.path, file.content, { mode: file.mode });

    const result = await run(
      "npm",
      [
        "ci",
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
      // The worker's own env (update notifier off), so npm makes no request
      // of its own and every refusal below would be the install's.
      { cwd: projectDir, env: { ...process.env, ...config.env } },
    );
    expect(result.code, `npm stderr:\n${result.stderr}`).toBe(0);

    for (const name of ["wardby-lock-root", "wardby-lock-child"]) {
      const installed = JSON.parse(await readFile(join(projectDir, "node_modules", name, "package.json"), "utf8"));
      expect(installed).toMatchObject({ name, version: "1.0.0" });
    }
    const fetches = await store.listFetches("client-integration-run");
    expect(fetches.filter((fetch) => fetch.outcome === "refused")).toEqual([]);
    expect(
      fetches
        .filter((fetch) => fetch.outcome === "served")
        .map((fetch) => fetch.name)
        .sort(),
    ).toEqual(["wardby-lock-child", "wardby-lock-root"]);
    expect(await store.isAllowedDependency("client-integration-run", "npm", "wardby-lock-child")).toBe(true);
    // Without a plan, the child's tarball was found by a graph walk.
    expect(walked()).toBe(true);
  });

  it("verifies a committed package-lock.json through the npm shim, then installs the approved versions without a walk", async () => {
    // The worker's npm is the driver image's shim (npm-shim.mjs, linked as
    // npm ahead of the real one on PATH): `npm ci` first sends the lockfile
    // to POST /-/plan, which checks every entry against the (fake) registry
    // and approves its exact versions (and their names as allowances), so
    // the tarball requests that follow are served from the approvals, with
    // no graph walk.
    const fixtureDir = new URL("./fixtures/npm-lockfile/", import.meta.url);
    const lock = JSON.parse(await readFile(new URL("package-lock.json", fixtureDir), "utf8"));
    const routes = new Map<string, () => Response>();
    const published = "2020-01-01T00:00:00.000Z";
    for (const [key, entry] of Object.entries(lock.packages as Record<string, Record<string, unknown>>)) {
      if (!key) continue;
      const name = key.slice("node_modules/".length);
      const version = entry.version as string;
      const resolved = entry.resolved as string;
      const bytes = await readFile(new URL(`${name}-${version}.tgz`, fixtureDir));
      const manifest = {
        name,
        version,
        dependencies: entry.dependencies,
        dist: { tarball: resolved, integrity: entry.integrity },
      };
      routes.set(resolved, () => new Response(bytes));
      routes.set(`https://registry.npmjs.org/${name}/${version}`, () => Response.json(manifest));
      routes.set(`https://registry.npmjs.org/${name}`, () =>
        Response.json({
          name,
          "dist-tags": { latest: version },
          versions: { [version]: manifest },
          time: { [version]: published },
        }),
      );
    }
    const {
      server,
      store,
      token,
      registryUrl: registryUrlFor,
      walked,
    } = await startTestRegistry({ npm: ["wardby-lock-root"] }, routes);
    cleanups.push(() => server.close());

    const cacheDir = await tmpDir("wardby-npm-cache-shim-");
    const projectDir = await tmpDir("wardby-npm-proj-shim-");
    const shimDir = await tmpDir("wardby-npm-shim-bin-");
    cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
    cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
    cleanups.push(() => rm(shimDir, { recursive: true, force: true }));
    for (const file of ["package.json", "package-lock.json"])
      await writeFile(join(projectDir, file), await readFile(new URL(file, fixtureDir)));
    // As Dockerfile.driver installs it.
    await copyFile(new URL("../../../coding-worker/npm-shim.mjs", import.meta.url), join(shimDir, "npm-shim.mjs"));
    await chmod(join(shimDir, "npm-shim.mjs"), 0o755);
    await symlink("npm-shim.mjs", join(shimDir, "npm"));

    const registryUrl = registryUrlFor("npm");
    const config = npmAdapter.workerConfig({ registryUrl, token, cacheDir });
    for (const file of config.files) await writeFile(file.path, file.content, { mode: file.mode });

    const result = await run(join(shimDir, "npm"), ["ci", "--cache", join(cacheDir, "cache")], {
      cwd: projectDir,
      env: { ...process.env, ...config.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
    });
    expect(result.code, `npm stderr:\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("wardby: verified package-lock.json: 2 approved, 0 refused");
    // Every setting the worker gives npm is one npm knows: no warning on every command.
    expect(result.stderr).not.toContain("Unknown env config");

    for (const name of ["wardby-lock-root", "wardby-lock-child"]) {
      const installed = JSON.parse(await readFile(join(projectDir, "node_modules", name, "package.json"), "utf8"));
      expect(installed).toMatchObject({ name, version: "1.0.0" });
    }
    expect([...store.approvals.values()].map((approval) => approval.name).sort()).toEqual([
      "wardby-lock-child",
      "wardby-lock-root",
    ]);
    const fetches = await store.listFetches("client-integration-run");
    expect(fetches.filter((fetch) => fetch.outcome === "refused")).toEqual([]);
    expect(
      fetches
        .filter((fetch) => fetch.outcome === "served")
        .map((fetch) => fetch.name)
        .sort(),
    ).toEqual(["wardby-lock-child", "wardby-lock-root"]);
    // No graph walk ran, and the only allowances are the plan's approved names.
    expect(walked()).toBe(false);
    expect([...store.allowances].map((key) => key.split("\0")[2]).sort()).toEqual([
      "wardby-lock-child",
      "wardby-lock-root",
    ]);
  });

  it("refuses a package not on the allowlist and surfaces the reason to npm", async () => {
    // npm asks for the name's metadata, which is refused at once: a
    // metadata request never walks the graph. The root is served anyway in
    // case npm reads it; its dependencies are dropped.
    const npmDoc = JSON.parse(
      await readFile(new URL("../../../coding/registry/fixtures/npm-left-pad.json", import.meta.url), "utf8"),
    );
    for (const version of Object.values(npmDoc.versions as Record<string, { dependencies?: unknown }>))
      delete version.dependencies;
    const {
      server,
      token,
      registryUrl: registryUrlFor,
    } = await startTestRegistry(
      { npm: ["left-pad"] },
      new Map([["https://registry.npmjs.org/left-pad", () => Response.json(npmDoc)]]),
    );
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

  it("real npm gets the final refusal for an unreached name at once, with no walk, and does not retry a 403", async () => {
    // The root's one dependency never answers: a graph walk would be cut
    // short. A metadata request never starts one, so npm gets the final
    // answer at once.
    const npmDoc = JSON.parse(
      await readFile(new URL("../../../coding/registry/fixtures/npm-left-pad.json", import.meta.url), "utf8"),
    );
    for (const version of Object.values(npmDoc.versions as Record<string, { dependencies?: unknown }>))
      version.dependencies = { "slow-dependency": "^1.0.0" };
    const {
      server,
      store,
      token,
      registryUrl: registryUrlFor,
    } = await startTestRegistry(
      { npm: ["left-pad"] },
      new Map<string, () => Response | Promise<Response>>([
        ["https://registry.npmjs.org/left-pad", () => Response.json(npmDoc)],
        ["https://registry.npmjs.org/slow-dependency", () => new Promise<Response>(() => {})],
      ]),
      { graphTimeoutMs: 200 },
    );
    cleanups.push(() => server.close());

    const cacheDir = await tmpDir("wardby-npm-cache-pending-");
    const projectDir = await tmpDir("wardby-npm-proj-pending-");
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
    expect(result.stderr).toContain("wardby_package_not_allowed:");
    expect(result.stderr).not.toContain("wardby_package_not_allowed_pending");
    expect(result.stderr).toContain("owner must allowlist it");
    // A 403 is final to npm: one request for the name, no retries.
    const refused = (await store.listFetches("client-integration-run")).filter(
      (fetch) => fetch.name === "not-allowed-package",
    );
    expect(refused).toMatchObject([{ outcome: "refused", reason: "wardby_package_not_allowed" }]);
    // No walk: nothing was recorded as an allowance.
    expect(store.allowances.size).toBe(0);
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

/** A cached yarn 2+ release corepack can run offline, if any. */
async function cachedBerry(): Promise<string | undefined> {
  const versions = await readdir(join(COREPACK_CACHE, "v1", "yarn")).catch(() => [] as string[]);
  return versions.find((version) => /^[2-9]\d*\.|^\d{2,}\./.test(version));
}

/** The fixture registry for the lockfile project (wardby-lock-root ->
 *  wardby-lock-child): packuments, version documents and tarballs. */
async function lockfileFixtureRoutes(): Promise<Map<string, () => Response>> {
  const fixtureDir = new URL("./fixtures/npm-lockfile/", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("package-lock.json", fixtureDir), "utf8"));
  const routes = new Map<string, () => Response>();
  const published = "2020-01-01T00:00:00.000Z";
  for (const [key, entry] of Object.entries(lock.packages as Record<string, Record<string, unknown>>)) {
    if (!key) continue;
    const name = key.slice("node_modules/".length);
    const version = entry.version as string;
    const resolved = entry.resolved as string;
    const bytes = await readFile(new URL(`${name}-${version}.tgz`, fixtureDir));
    const manifest = {
      name,
      version,
      dependencies: entry.dependencies,
      dist: { tarball: resolved, integrity: entry.integrity },
    };
    routes.set(resolved, () => new Response(bytes));
    routes.set(`https://registry.npmjs.org/${name}/${version}`, () => Response.json(manifest));
    routes.set(`https://registry.npmjs.org/${name}`, () =>
      Response.json({
        name,
        "dist-tags": { latest: version },
        versions: { [version]: manifest },
        time: { [version]: published },
      }),
    );
  }
  return routes;
}

/** The driver image's shim directory: npm-shim.mjs linked as npm, pnpm and yarn. */
async function shimDirectory(): Promise<string> {
  const shimDir = await tmpDir("wardby-shim-bin-");
  await copyFile(new URL("../../../coding-worker/npm-shim.mjs", import.meta.url), join(shimDir, "npm-shim.mjs"));
  await chmod(join(shimDir, "npm-shim.mjs"), 0o755);
  for (const name of ["npm", "pnpm", "yarn"]) await symlink("npm-shim.mjs", join(shimDir, name));
  return shimDir;
}

/** What would show the proxy in a collected file: its host and port, plain
 *  or percent-encoded (yarn writes locators encoded), and the run's token. */
function leakNeedles(registryUrl: string, token: string): string[] {
  const host = new URL(registryUrl).host;
  return [host, encodeURIComponent(host), token];
}

/** Every file the run would collect (collection skips node_modules, .cache
 *  and the other built-in names) whose name or content (gunzipped for a
 *  .gz) contains one of `needles`. */
async function collectedLeaks(root: string, needles: string[]): Promise<string[]> {
  const leaks: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!(BUILTIN_COLLECT_EXCLUDE_NAMES as readonly string[]).includes(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let content = await readFile(join(root, path));
      if (path.endsWith(".gz")) content = gunzipSync(content);
      const text = content.toString("latin1");
      if (needles.some((needle) => path.includes(needle) || text.includes(needle))) leaks.push(path);
    }
  };
  await walk("");
  return leaks;
}

describe.skipIf(!RUN)("pnpm and yarn through the shim: a resolving install, then a frozen one with no walk", () => {
  /**
   * One client's round trip, as a run would go: a resolving install
   * through the proxy (allowlist: the root only), the driver's lockfile
   * rewrite before collection (the committed lockfile must not name the
   * proxy), then, on a fresh run with empty caches, a frozen install from
   * that lockfile through the shim: the plan approves both packages, so
   * neither tarball needs a graph walk.
   */
  async function roundTrip(options: {
    lockfile: string;
    manifest?: Record<string, unknown>;
    resolve: string[];
    frozen: string[];
    command: string;
    env?: Record<string, string>;
    /** yarn Berry's Plug'n'Play linker: no node_modules folder. */
    pnp?: boolean;
    /** Lockfiles the collection rewrite is expected to change. */
    rewrittenAtCollection?: string[];
  }) {
    const shimDir = await shimDirectory();
    // Real paths (here and for the cache): yarn's PnP map records the
    // project's real location and its packages' relative to it.
    const projectDir = realpathSync(await tmpDir("wardby-client-proj-"));
    const home = await tmpDir("wardby-client-home-");
    cleanups.push(() => rm(shimDir, { recursive: true, force: true }));
    cleanups.push(() => rm(projectDir, { recursive: true, force: true }));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const fixtureDir = new URL("./fixtures/npm-lockfile/", import.meta.url);
    const manifest = {
      ...JSON.parse(await readFile(new URL("package.json", fixtureDir), "utf8")),
      ...options.manifest,
    };
    await writeFile(join(projectDir, "package.json"), JSON.stringify(manifest, null, 2));

    const phase = async (args: string[]) => {
      const registry = await startTestRegistry({ npm: ["wardby-lock-root"] }, await lockfileFixtureRoutes());
      cleanups.push(() => registry.server.close());
      const cacheDir = realpathSync(await tmpDir("wardby-client-cache-"));
      cleanups.push(() => rm(cacheDir, { recursive: true, force: true }));
      const registryUrl = registry.registryUrl("npm");
      const config = npmAdapter.workerConfig({ registryUrl, token: registry.token, cacheDir });
      for (const file of config.files) await writeFile(file.path, file.content, { mode: file.mode });
      const result = await run(join(shimDir, options.command), args, {
        cwd: projectDir,
        env: {
          ...process.env,
          ...config.env,
          HOME: home,
          ...options.env,
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        },
      });
      const output = `${options.command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(result.code, output).toBe(0);
      const fetches = await registry.store.listFetches("client-integration-run");
      // No refused request: no update check or telemetry reached the registry.
      expect(
        fetches.filter((fetch) => fetch.outcome === "refused"),
        output,
      ).toEqual([]);
      expect(
        [...new Set(fetches.filter((fetch) => fetch.outcome === "served").map((fetch) => fetch.name))].sort(),
        output,
      ).toEqual(["wardby-lock-child", "wardby-lock-root"]);
      return { ...registry, result, registryUrl };
    };

    const resolving = await phase(options.resolve);
    const lockfilePath = join(projectDir, options.lockfile);
    const rewritten = await normalizeRegistryLockfiles({
      workspace: projectDir,
      proxyBaseUrl: resolving.registryUrl.replace(/\/registry\/npm\/$/, ""),
    });
    // The proxy serves downloads at the registry's usual path, so only yarn
    // classic (which records every download URL) needs its lockfile rewritten.
    expect(rewritten).toEqual(options.rewrittenAtCollection ?? []);
    const committed = await readFile(lockfilePath, "utf8");
    // No file the run would collect names the proxy or carries the token:
    // the lockfile, and yarn's .pnp.cjs, install state and cache names too.
    expect(await collectedLeaks(projectDir, leakNeedles(resolving.registryUrl, resolving.token))).toEqual([]);

    for (const leftover of ["node_modules", ".yarn", ".pnp.cjs", ".pnp.loader.mjs"])
      await rm(join(projectDir, leftover), { recursive: true, force: true });
    const frozen = await phase(options.frozen);
    expect(frozen.result.stderr).toContain(`wardby: verified ${options.lockfile}: 2 approved, 0 refused`);
    expect(frozen.walked()).toBe(false);
    // Both packages are installed where Node (with yarn's PnP loader, for
    // PnP) finds them: the child from the root's own folder (pnpm installs
    // only the project's own dependencies at the top of node_modules).
    const resolveFrom = (from: string, request: string) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            ...(options.pnp ? ["--require", join(projectDir, ".pnp.cjs")] : []),
            "-e",
            `const path = require("module").createRequire(${JSON.stringify(from)}).resolve(${JSON.stringify(request)});` +
              "process.stdout.write(JSON.stringify({ path, manifest: require(path) }));",
          ],
          { cwd: projectDir, encoding: "utf8" },
        ),
      ) as { path: string; manifest: { name: string; version: string } };
    const root = resolveFrom(join(projectDir, "package.json"), "wardby-lock-root/package.json");
    expect(root.manifest).toMatchObject({ name: "wardby-lock-root", version: "1.0.0" });
    const child = resolveFrom(options.pnp ? root.path : realpathSync(root.path), "wardby-lock-child/package.json");
    expect(child.manifest).toMatchObject({ name: "wardby-lock-child", version: "1.0.0" });
    // The frozen install left the committed lockfile as it was.
    expect(await readFile(lockfilePath, "utf8")).toBe(committed);
    expect(await collectedLeaks(projectDir, leakNeedles(frozen.registryUrl, frozen.token))).toEqual([]);
    return { committed };
  }

  it.skipIf(!hasPnpm)("pnpm install --frozen-lockfile", async () => {
    await roundTrip({
      command: "pnpm",
      lockfile: "pnpm-lock.yaml",
      resolve: ["install"],
      frozen: ["install", "--frozen-lockfile"],
    });
  });

  it.skipIf(!hasYarn)("yarn install --frozen-lockfile (classic)", async () => {
    const { committed } = await roundTrip({
      command: "yarn",
      lockfile: "yarn.lock",
      resolve: ["install", "--non-interactive"],
      frozen: ["install", "--frozen-lockfile", "--non-interactive"],
      rewrittenAtCollection: ["yarn.lock"],
    });
    expect(committed).toContain('resolved "https://registry.yarnpkg.com/wardby-lock-root/-/wardby-lock-root-1.0.0.tgz');
  });

  it("yarn install --immutable (Berry, node-modules linker)", async (context) => {
    const berry = await cachedBerry();
    if (!berry) context.skip();
    await roundTrip({
      command: "yarn",
      lockfile: "yarn.lock",
      manifest: { packageManager: `yarn@${berry}` },
      resolve: ["install"],
      frozen: ["install", "--immutable"],
      env: { COREPACK_HOME: COREPACK_CACHE, YARN_NODE_LINKER: "node-modules" },
    });
  });

  it("yarn install --immutable (Berry, Plug'n'Play)", async (context) => {
    const berry = await cachedBerry();
    if (!berry) context.skip();
    await roundTrip({
      command: "yarn",
      lockfile: "yarn.lock",
      manifest: { packageManager: `yarn@${berry}` },
      resolve: ["install"],
      frozen: ["install", "--immutable"],
      // The cache in the project (as a zero-install repository commits it).
      env: { COREPACK_HOME: COREPACK_CACHE, YARN_NODE_LINKER: "pnp", YARN_ENABLE_GLOBAL_CACHE: "false" },
      pnp: true,
    });
  });
});
