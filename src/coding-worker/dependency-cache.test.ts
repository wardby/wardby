import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveLimit,
  checkConsistency,
  dependencyCacheBudget,
  dependencyCacheTimeLimit,
  DEFAULT_TIMEOUTS,
  MIN_BUDGET_BYTES,
  MIN_INSTALL_BUDGET_BYTES,
  MAX_PLAN_ATTEMPTS,
  MAX_PLAN_REQUESTS_PER_RUN,
  discoverProjects,
  extractArchive,
  prepareDependencies,
  prepareProject,
  readRegularFile,
  scanArchive,
  sealUploadWindow,
  verifyLinks,
  type DependencyCacheEvent,
  type PrepareDependenciesResult,
  type PrepareResult,
} from "./dependency-cache.mjs";

// ---------------------------------------------------------------- fixtures

const LOCKFILE = {
  name: "demo",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "demo", version: "1.0.0", dependencies: { alpha: "^1.0.0", beta: "^2.0.0" } },
    "node_modules/alpha": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
      integrity: "sha512-alpha100",
    },
    "node_modules/beta": {
      version: "2.0.0",
      resolved: "https://registry.npmjs.org/beta/-/beta-2.0.0.tgz",
      integrity: "sha512-beta200",
      bin: { beta: "bin.js" },
    },
    "node_modules/beta/node_modules/a-very-long-nested-package-name-that-pushes-the-path-beyond-one-hundred-bytes": {
      version: "3.1.4",
      integrity: "sha512-long314",
    },
    "node_modules/fsevents-like": {
      version: "1.0.0",
      integrity: "sha512-optional",
      optional: true,
      os: ["no-such-os"],
    },
  },
};

const LOCKFILE_V2 = {
  ...LOCKFILE,
  packages: {
    ...LOCKFILE.packages,
    "node_modules/alpha": {
      ...LOCKFILE.packages["node_modules/alpha"],
      version: "1.1.0",
      integrity: "sha512-alpha110",
    },
  },
};

/** The fake npm: writes the lockfile's (non-optional) packages, a
 *  package.json for each, a .bin symlink and npm's hidden lockfile, the way
 *  a real install would. FAKE_NPM_MODE: hang | fail | drift. Records argv. */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.WARDBY_NPM_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = process.env.FAKE_NPM_MODE || "";
if (process.argv[2] === "rebuild") {
  // WARDBY_NPM_TEST_REBUILD: fail | hang (writes node_modules/.late after 2 s unless killed)
  const rebuild = process.env.WARDBY_NPM_TEST_REBUILD || "";
  if (rebuild === "fail") process.exit(1);
  if (rebuild === "hang") {
    setTimeout(() => fs.writeFileSync("node_modules/.late", "x"), 2000);
    setInterval(() => {}, 1000);
    return;
  }
  fs.writeFileSync("node_modules/.rebuilt", "x");
  fs.writeFileSync("node_modules/.rebuild-env", JSON.stringify(Object.keys(process.env)));
  process.exit(0);
}
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") process.exit(1);
else {
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  if (process.argv[2] === "ci") fs.rmSync("node_modules", { recursive: true, force: true });
  const hidden = { name: lock.name, version: lock.version, lockfileVersion: lock.lockfileVersion, requires: true, packages: {} };
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "" || entry.optional) continue;
    const version = mode === "drift" && key === "node_modules/alpha" ? "9.9.9" : entry.version;
    fs.mkdirSync(key, { recursive: true });
    fs.writeFileSync(path.join(key, "package.json"), JSON.stringify({ name: key.split("node_modules/").pop(), version }));
    fs.writeFileSync(path.join(key, "index.js"), "module.exports = " + JSON.stringify(key) + ";\\n");
    hidden.packages[key] = { ...entry, version, resolved: "http://proxy/registry/npm/" + key };
  }
  fs.mkdirSync("node_modules/.bin", { recursive: true });
  try { fs.symlinkSync("../beta/index.js", "node_modules/.bin/beta"); } catch {}
  fs.writeFileSync("node_modules/.package-lock.json", JSON.stringify(hidden, null, 2));
  // npm's download cache, the way a real install fills it.
  if (process.env.npm_config_cache) {
    const content = path.join(process.env.npm_config_cache, "_cacache", "content-v2");
    fs.mkdirSync(content, { recursive: true });
    fs.writeFileSync(path.join(content, "tarball"), "cached tarball bytes");
  }
  // FAKE_NPM_BIG: bytes of incompressible data in one package (a large tree).
  if (process.env.FAKE_NPM_BIG) fs.writeFileSync("node_modules/beta/big.bin", require("node:crypto").randomBytes(Number(process.env.FAKE_NPM_BIG)));
  if (mode === "rewrite-lock") fs.writeFileSync("package-lock.json", "{}");
  if (mode === "lock-cache") fs.chmodSync(".cache", 0o500); // the archive can't be created there
}
`;

// ---------------------------------------------------------------- fake proxy

interface ProxyState {
  plans: string[];
  calls: string[];
  authorizations: (string | undefined)[];
  planAnswer: { status: number; body: unknown } | ((plan: string) => { status: number; body: unknown });
  lookupAnswer: (lock: string, project: string) => { status: number; body: unknown };
  /** The project= of every cache route, in order. */
  projects: string[];
  blobs: Map<string, Buffer>;
  shaOverride?: string;
  lengthOverride?: number;
  uploads: {
    body: Buffer;
    contentLength: string | undefined;
    scanVersion: string | undefined;
    entries: string | undefined;
    unpackedBytes: string | undefined;
  }[];
  sealed: boolean;
  hang?: string;
  /** Delays the plan answer (a slow proxy with a cold package-fact cache). */
  planDelayMs?: number;
  seals: number;
  sealStatus?: number;
}

let root: string;
let workspace: string;
let server: Server;
let base: string;
let state: ProxyState;
let env: Record<string, string>;
let npmLog: string;
let events: DependencyCacheEvent[];

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function startProxy(): Promise<void> {
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://proxy");
      const route = `${request.method} ${url.pathname}`;
      state.calls.push(route);
      state.authorizations.push(request.headers.authorization);
      const json = (status: number, body: unknown) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (state.hang && route.startsWith(state.hang)) return; // never answers
      if (route === "POST /registry/npm/-/plan") {
        const plan = (await readBody(request)).toString("utf8");
        state.plans.push(plan);
        if (state.planDelayMs) await new Promise((resolve) => setTimeout(resolve, state.planDelayMs));
        const answer = typeof state.planAnswer === "function" ? state.planAnswer(plan) : state.planAnswer;
        json(answer.status, answer.body);
        return;
      }
      if (route === "POST /cache/npm/seal") {
        state.seals += 1;
        if (state.sealStatus && state.sealStatus !== 200) {
          json(state.sealStatus, { error: "internal" });
          return;
        }
        state.sealed = true;
        json(200, { sealed: true });
        return;
      }
      if (state.sealed) {
        await readBody(request);
        json(409, { error: "sealed" });
        return;
      }
      const lock = url.searchParams.get("lock") ?? "";
      const project = url.searchParams.get("project") ?? "";
      state.projects.push(project);
      // The proxy's projectPath rule (key.ts parseProjectPath).
      const validProject =
        project === "." ||
        (project.split("/").length <= 3 &&
          project
            .split("/")
            .every((segment) => /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]{0,99}$/.test(segment) && segment !== "node_modules"));
      if (!validProject) {
        json(400, { error: "invalid_project" });
        return;
      }
      if (!state.plans.some((plan) => sha256(plan) === lock)) {
        json(409, { error: "plan_required" });
        return;
      }
      if (route === "GET /cache/npm/lookup") {
        const answer = state.lookupAnswer(lock, project);
        json(answer.status, answer.body);
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/cache/npm/blob/")) {
        const blob = state.blobs.get(url.pathname.slice("/cache/npm/blob/".length));
        if (!blob) return json(404, { error: "not_found" });
        response.writeHead(200, {
          "content-type": "application/gzip",
          "content-length": String(state.lengthOverride ?? blob.length),
          "x-wardby-sha256": state.shaOverride ?? sha256(blob),
        });
        response.end(state.lengthOverride && state.lengthOverride < blob.length ? undefined : blob);
        if (state.lengthOverride && state.lengthOverride > blob.length) response.destroy();
        return;
      }
      if (route === "PUT /cache/npm/blob") {
        const body = await readBody(request);
        state.uploads.push({
          body,
          contentLength: request.headers["content-length"],
          scanVersion: request.headers["x-wardby-archive-scan-version"] as string | undefined,
          entries: request.headers["x-wardby-archive-entries"] as string | undefined,
          unpackedBytes: request.headers["x-wardby-archive-unpacked-bytes"] as string | undefined,
        });
        json(201, { stored: true, sha256: sha256(body), sizeBytes: body.length });
        return;
      }
      json(404, { error: "not_found" });
    })();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wardby-depcache-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  state = {
    plans: [],
    calls: [],
    authorizations: [],
    planAnswer: { status: 200, body: { approved: 3, refused: [] } },
    lookupAnswer: () => ({ status: 200, body: { key: "k".repeat(64), hit: false, maxBytes: 64 * 1024 * 1024 } }),
    blobs: new Map(),
    projects: [],
    uploads: [],
    sealed: false,
    seals: 0,
  };
  await startProxy();
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  const registry = `${base}/registry/npm/`;
  const npmrc = join(root, "npmrc");
  await writeFile(npmrc, `//127.0.0.1:${port}/registry/npm/:_authToken=run-token\n`);
  const npmPath = join(root, "fake-npm");
  await writeFile(npmPath, FAKE_NPM);
  await chmod(npmPath, 0o755);
  npmLog = join(root, "npm.log");
  await writeFile(npmLog, "");
  env = {
    PATH: process.env.PATH ?? "",
    npm_config_registry: registry,
    npm_config_userconfig: npmrc,
    WARDBY_NPM_PLAN_REGISTRY: registry,
    WARDBY_NPM_TEST_LOG: npmLog,
  };
  events = [];
  await writeRepo(LOCKFILE);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function writeRepo(lockfile: object, packageJson: object = { name: "demo", version: "1.0.0" }) {
  await writeFile(join(workspace, "package.json"), JSON.stringify(packageJson));
  await writeFile(join(workspace, "package-lock.json"), JSON.stringify(lockfile, null, 2));
}

function prepareAll(
  options: Partial<Parameters<typeof prepareDependencies>[0]> = {},
): Promise<PrepareDependenciesResult> {
  return prepareDependencies({
    workspace,
    env,
    npmPath: join(root, "fake-npm"),
    log: (event, fields) => events.push({ event, ...fields }),
    ...options,
  });
}

/** For a repo with only the root project: its result, without `path` and `rebuild`. */
async function prepare(options: Partial<Parameters<typeof prepareDependencies>[0]> = {}): Promise<PrepareResult> {
  const { projects } = await prepareAll(options);
  expect(projects.map((project) => project.path)).toEqual(["."]);
  const { path: _path, rebuild: _rebuild, ...rest } = projects[0];
  return rest;
}

/** Writes a project (package.json + package-lock.json) in `dir`, relative to the workspace. */
async function writeProject(dir: string, lockfile: object, packageJson: object = { name: "demo", version: "1.0.0" }) {
  await mkdir(join(workspace, dir), { recursive: true });
  await writeFile(join(workspace, dir, "package.json"), JSON.stringify(packageJson));
  await writeFile(join(workspace, dir, "package-lock.json"), JSON.stringify(lockfile, null, 2));
}

/** Every file name under `dir`, recursively (links not followed). */
async function allNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    out.push(entry.name);
    if (entry.isDirectory()) out.push(...(await allNames(join(dir, entry.name))));
  }
  return out;
}

async function npmCalls(): Promise<string[][]> {
  return (await readFile(npmLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Builds a node_modules tree for `lockfile` the way the fake npm does, in
 *  `dir`, and archives it with the system tar. */
async function realTarSnapshot(lockfile: typeof LOCKFILE, extra?: (dir: string) => Promise<void>): Promise<Buffer> {
  const dir = await mkdtemp(join(root, "snap-"));
  await writeFile(join(dir, "package-lock.json"), JSON.stringify(lockfile));
  const install = spawnSync(join(root, "fake-npm"), ["ci"], {
    cwd: dir,
    env: { ...env, FAKE_NPM_MODE: "", WARDBY_NPM_TEST_LOG: join(dir, "npm.log") },
  });
  expect(install.status).toBe(0);
  if (extra) await extra(dir);
  const archive = join(dir, "out.tgz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", dir, "node_modules"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(tar.status).toBe(0);
  return readFile(archive);
}

// A minimal ustar writer, for archives no well-behaved tar would produce.
interface RawEntry {
  name: string;
  type?: string;
  body?: string;
  size?: number;
  link?: string;
}
function header(name: string, type: string, size: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(size.toString(8).padStart(11, "0") + "\0", 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write(link, 157, 100, "utf8");
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}
function rawTar(entries: RawEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const size = entry.size ?? body.length;
    parts.push(header(entry.name, entry.type ?? "0", size, entry.link));
    if (entry.size === undefined && body.length) {
      parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function hitWith(blob: Buffer, id = "a".repeat(64)) {
  state.blobs.set(id, blob);
  state.lookupAnswer = () => ({ status: 200, body: { key: id, hit: true, maxBytes: 64 * 1024 * 1024 } });
}

const COLD_INSTALL = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

/** A hit the module refused: it installs cold instead. Returns the reason it logged for the hit. */
async function prepareRefusedHit(options: Partial<Parameters<typeof prepareDependencies>[0]> = {}) {
  const result = await prepare(options);
  expect(result).toMatchObject({ result: "cold" });
  expect(result.reason).toBeUndefined();
  expect(await npmCalls()).toEqual([COLD_INSTALL]);
  expect(await exists(join(workspace, "node_modules/alpha/package.json"))).toBe(true);
  return events.find((event) => event.event === "hit_rejected")?.reason;
}

async function cacheLeftovers(): Promise<string[]> {
  return (await exists(join(workspace, ".cache"))) ? readdir(join(workspace, ".cache")) : [];
}

// ---------------------------------------------------------------- paths

describe("prepareDependencies", () => {
  it("hit: verifies, scans, extracts, checks consistency and installs nothing", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    const result = await prepare();
    expect(result).toMatchObject({ result: "hit", key: "a".repeat(64) });
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(typeof result.restoreMs).toBe("number");
    expect(await npmCalls()).toEqual([]);
    const pkg = JSON.parse(await readFile(join(workspace, "node_modules/alpha/package.json"), "utf8"));
    expect(pkg.version).toBe("1.0.0");
    expect(await readlink(join(workspace, "node_modules/.bin/beta"))).toBe("../beta/index.js");
    // The plan got the exact lockfile bytes; every cache route the same hash.
    const lockBytes = await readFile(join(workspace, "package-lock.json"));
    expect(state.plans).toEqual([lockBytes.toString("utf8")]);
    expect(state.authorizations.every((value) => value === "Bearer run-token")).toBe(true);
    expect(state.calls).toEqual([
      "POST /registry/npm/-/plan",
      "GET /cache/npm/lookup",
      `GET /cache/npm/blob/${"a".repeat(64)}`,
      "POST /cache/npm/seal",
    ]);
    expect(await cacheLeftovers()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("run-token");
  });

  it("hit: skips the duplicate scan only with manifest metadata bound to the archive digest", async () => {
    const blob = await realTarSnapshot(LOCKFILE);
    const archive = join(root, "validated.tgz");
    await writeFile(archive, blob);
    const validation = await scanArchive(archive, { budgetBytes: Number.MAX_SAFE_INTEGER });
    hitWith(blob);
    state.lookupAnswer = () => ({
      status: 200,
      body: {
        key: "a".repeat(64),
        hit: true,
        maxBytes: 64 * 1024 * 1024,
        manifest: {
          scanVersion: 1,
          sha256: sha256(blob),
          entries: validation.entries,
          unpackedBytes: validation.unpackedBytes,
        },
      },
    });
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(events.some((event) => event.event === "restore_phase" && event.stage === "scan")).toBe(false);
  });

  it("cold: npm ci through the shim, consistency, snapshot uploaded with content-length, then seal", async () => {
    const result = await prepare();
    expect(result).toMatchObject({ result: "cold" });
    expect(typeof result.installMs).toBe("number");
    expect(await npmCalls()).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0].contentLength).toBe(String(state.uploads[0].body.length));
    expect(state.uploads[0]).toMatchObject({
      scanVersion: "1",
      entries: expect.any(String),
      unpackedBytes: expect.any(String),
    });
    expect(result.sizeBytes).toBe(state.uploads[0].body.length);
    expect(state.calls.slice(-2)).toEqual(["PUT /cache/npm/blob", "POST /cache/npm/seal"]);
    expect(await exists(join(workspace, "node_modules/alpha/package.json"))).toBe(true);
    expect(await cacheLeftovers()).toEqual([]);

    // The uploaded snapshot (real tar, long nested path) restores as a hit.
    await rm(join(workspace, "node_modules"), { recursive: true });
    await writeFile(npmLog, "");
    state.sealed = false;
    hitWith(state.uploads[0].body);
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(await npmCalls()).toEqual([]);
  });

  it("nearest: restores the nearest snapshot, installs the delta without saving, snapshots", async () => {
    const nearest = await realTarSnapshot(LOCKFILE);
    await writeRepo(LOCKFILE_V2);
    state.blobs.set("b".repeat(64), nearest);
    state.lookupAnswer = () => ({
      status: 200,
      body: { key: "c".repeat(64), hit: false, nearest: { id: "b".repeat(64) }, maxBytes: 64 * 1024 * 1024 },
    });
    const result = await prepare();
    expect(result).toMatchObject({ result: "nearest", key: "c".repeat(64) });
    expect(typeof result.restoreMs).toBe("number");
    expect(typeof result.installMs).toBe("number");
    expect(await npmCalls()).toEqual([["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    const pkg = JSON.parse(await readFile(join(workspace, "node_modules/alpha/package.json"), "utf8"));
    expect(pkg.version).toBe("1.1.0");
    expect(state.uploads).toHaveLength(1);
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
  });

  it("nearest: puts back a lockfile the install rewrote", async () => {
    state.blobs.set("b".repeat(64), await realTarSnapshot(LOCKFILE));
    const committed = await readFile(join(workspace, "package-lock.json"));
    state.lookupAnswer = () => ({
      status: 200,
      body: { key: "c".repeat(64), hit: false, nearest: { id: "b".repeat(64) }, maxBytes: 64 * 1024 * 1024 },
    });
    env.FAKE_NPM_MODE = "rewrite-lock";
    const result = await prepare();
    expect(await readFile(join(workspace, "package-lock.json"))).toEqual(committed);
    expect(result).toMatchObject({ result: "nearest" });
  });

  it("refused: the plan refused a package; no lookup, no install, still sealed", async () => {
    state.planAnswer = {
      status: 200,
      body: { approved: 2, refused: [{ name: "beta", version: "2.0.0", code: "too_new", reason: "x" }] },
    };
    const result = await prepare();
    expect(result).toEqual({ result: "refused", reason: "plan_refused" });
    expect(state.calls).toEqual(["POST /registry/npm/-/plan", "POST /cache/npm/seal"]);
    expect(await npmCalls()).toEqual([]);
  });

  it.each([
    ["no_lockfile", async () => rm(join(workspace, "package-lock.json"))],
    ["lockfile_version", async () => writeRepo({ ...LOCKFILE, lockfileVersion: 1 })],
    ["workspaces", async () => writeRepo(LOCKFILE, { name: "demo", workspaces: ["packages/*"] })],
    ["shrinkwrap_present", async () => writeFile(join(workspace, "npm-shrinkwrap.json"), "{}")],
    ["node_modules_present", async () => mkdir(join(workspace, "node_modules"))],
    ["no_dependencies", async () => writeRepo({ ...LOCKFILE, packages: { "": {} } })],
  ])("skipped: %s, without planning, and still sealed", async (reason, setup) => {
    await setup();
    expect(await prepare()).toEqual({ result: "skipped", reason });
    expect(state.calls).toEqual(["POST /cache/npm/seal"]);
  });

  it("skipped: the plan failed", async () => {
    state.planAnswer = { status: 503, body: { error: "busy" } };
    expect(await prepare()).toEqual({ result: "skipped", reason: "plan_failed" });
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
  });

  it("skipped: the cache is off on the proxy (404)", async () => {
    state.lookupAnswer = () => ({ status: 404, body: { error: "not_found" } });
    expect(await prepare()).toEqual({ result: "skipped", reason: "cache_unavailable" });
    expect(await npmCalls()).toEqual([]);
  });

  it("skipped: no registry configuration means no plan and nothing to seal", async () => {
    delete env.WARDBY_NPM_PLAN_REGISTRY;
    expect(await prepare()).toEqual({ result: "skipped", reason: "no_registry" });
    expect(state.calls).toEqual([]);
  });

  it("skipped: the cold install failed; partial node_modules removed", async () => {
    env.FAKE_NPM_MODE = "fail";
    expect(await prepare()).toEqual({ result: "skipped", reason: "install_failed" });
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(state.uploads).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- integrity and safety

const CASE_FOLD_CHAIN: RawEntry[] = [
  { name: "node_modules/a/", type: "5" },
  { name: "node_modules/a/S", type: "2", link: ".." },
  { name: "node_modules/a/s/T", type: "2", link: ".." },
  { name: "node_modules/a/s/t/V", type: "2", link: ".." },
  { name: "node_modules/a/s/t/v/W", type: "2", link: ".." },
  { name: "node_modules/a/s/t/v/w/PWNED", body: "written outside\n" },
];

const MALICIOUS: [string, RawEntry[], string][] = [
  ["path traversal", [{ name: "node_modules/../../etc/evil", body: "x" }], "unsafe_archive"],
  ["absolute path", [{ name: "/tmp/evil", body: "x" }], "unsafe_archive"],
  ["outside node_modules", [{ name: "src/index.js", body: "x" }], "unsafe_archive"],
  ["escaping symlink", [{ name: "node_modules/x", type: "2", link: "../../outside" }], "unsafe_archive"],
  ["absolute symlink", [{ name: "node_modules/x", type: "2", link: "/etc/passwd" }], "unsafe_archive"],
  ["hardlink", [{ name: "node_modules/x", type: "1", link: "node_modules/y" }], "unsafe_archive"],
  ["char device", [{ name: "node_modules/x", type: "3" }], "unsafe_archive"],
  ["fifo", [{ name: "node_modules/x", type: "6" }], "unsafe_archive"],
  [
    "entry beneath a symlink",
    [
      { name: "node_modules/a", type: "2", link: "b" },
      { name: "node_modules/a/x", body: "x" },
    ],
    "unsafe_archive",
  ],
  [
    "duplicate entry",
    [
      { name: "node_modules/a", body: "x" },
      { name: "node_modules/a", type: "2", link: "b" },
    ],
    "unsafe_archive",
  ],
  ["size bomb", [{ name: "node_modules/big", size: 7 * 1024 * 1024 * 1024 }], "over_budget"],
  [
    "a link chain that escapes only through a linked folder",
    [
      { name: "node_modules/p/", type: "5" },
      { name: "node_modules/p/q", type: "2", link: ".." },
      { name: "node_modules/p/q/r", type: "2", link: "../.." },
    ],
    "unsafe_archive",
  ],
  [
    "a link whose target climbs back out after following another link",
    [
      { name: "node_modules/a/b/s", type: "2", link: "../.." },
      { name: "node_modules/t", type: "2", link: "a/b/s/../.." },
      { name: "node_modules/u", type: "2", link: "t/etc" },
    ],
    "unsafe_archive",
  ],
  // On a case-insensitive file system `a/s` is the link `a/S`, and each link
  // climbs one more level: PWNED would land beside the workspace's .cache.
  [
    "paths equal under case folding (a link chain on a case-insensitive file system)",
    CASE_FOLD_CHAIN,
    "unsafe_archive",
  ],
  [
    "paths equal under Unicode NFC normalization",
    [
      { name: "node_modules/caf\u00e9", body: "x" },
      { name: "node_modules/cafe\u0301", body: "y" },
    ],
    "unsafe_archive",
  ],
];
describe("untrusted archives", () => {
  it("rejects a sha256 mismatch, deletes the download and installs cold", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    state.shaOverride = "0".repeat(64);
    expect(await prepareRefusedHit()).toBe("sha_mismatch");
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("rejects a short download (content-length not met) and installs cold", async () => {
    const blob = await realTarSnapshot(LOCKFILE);
    hitWith(blob);
    state.lengthOverride = blob.length + 100;
    expect(["download_failed", "size_mismatch"]).toContain(await prepareRefusedHit());
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("installs cold when the hit's download fails (a row whose blob is gone)", async () => {
    state.lookupAnswer = () => ({ status: 200, body: { key: "a".repeat(64), hit: true, maxBytes: 64 * 1024 * 1024 } });
    expect(await prepareRefusedHit()).toBe("download_failed");
    expect(state.uploads).toHaveLength(1);
  });

  it("rejects a download larger than the lookup's maxBytes and installs cold", async () => {
    const blob = await realTarSnapshot(LOCKFILE);
    state.blobs.set("a".repeat(64), blob);
    state.lookupAnswer = () => ({ status: 200, body: { key: "a".repeat(64), hit: true, maxBytes: 10 } });
    expect(await prepareRefusedHit()).toBe("too_large");
  });

  it.each(MALICIOUS)("rejects %s before extracting anything, then installs cold", async (_label, entries, reason) => {
    hitWith(rawTar([{ name: "node_modules/", type: "5" }, ...entries]));
    if (reason === "over_budget") {
      // A hit too big for the run's disk: a cold install would write the same tree, so none is tried.
      expect(await prepare({ budgetBytes: 1024 * 1024 * 1024 })).toEqual({ result: "skipped", reason });
      expect(await npmCalls()).toEqual([]);
      expect(await exists(join(workspace, "node_modules"))).toBe(false);
    } else expect(await prepareRefusedHit({ budgetBytes: 1024 * 1024 * 1024 })).toBe(reason);
    expect(await exists(join(root, "outside"))).toBe(false);
    expect(await exists(join(workspace, "node_modules/evil"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it.each(MALICIOUS)("scanArchive alone rejects %s", async (_label, entries, reason) => {
    const archive = join(root, "bad.tgz");
    await writeFile(archive, rawTar([{ name: "node_modules/", type: "5" }, ...entries]));
    await expect(scanArchive(archive, { budgetBytes: 1024 * 1024 * 1024 })).rejects.toMatchObject({ reason });
  });

  it("rejects the case-folding link chain with nothing written outside the temp folder, on any file system", async () => {
    hitWith(rawTar([{ name: "node_modules/", type: "5" }, ...CASE_FOLD_CHAIN]));
    const before = (await readdir(workspace)).sort();
    expect(await prepareRefusedHit({ budgetBytes: 1024 * 1024 * 1024 })).toBe("unsafe_archive");
    expect(await allNames(root)).not.toContain("PWNED");
    expect((await readdir(workspace)).filter((name) => name !== ".cache" && name !== "node_modules").sort()).toEqual(
      before,
    );
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("extraction refuses to write through a folder that is a symlink, and opens files without following links", async () => {
    const destination = join(root, "dest");
    const outside = join(root, "elsewhere");
    await mkdir(destination);
    await mkdir(outside);
    await symlink(outside, join(destination, "node_modules")); // planted parent
    const archive = join(root, "plain.tgz");
    await writeFile(
      archive,
      rawTar([
        { name: "node_modules/", type: "5" },
        { name: "node_modules/x", body: "x" },
      ]),
    );
    await expect(extractArchive(archive, destination, { budgetBytes: 1024 * 1024 })).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
    expect(await readdir(outside)).toEqual([]);

    // A planted link one level down, reached by a file entry's parent.
    await rm(join(destination, "node_modules"));
    await mkdir(join(destination, "node_modules"));
    await symlink(outside, join(destination, "node_modules/p"));
    await writeFile(archive, rawTar([{ name: "node_modules/p/x", body: "x" }]));
    await expect(extractArchive(archive, destination, { budgetBytes: 1024 * 1024 })).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
    expect(await readdir(outside)).toEqual([]);

    // A planted link where a file goes: never followed, never replaced.
    await rm(join(destination, "node_modules/p"));
    await symlink(join(outside, "target"), join(destination, "node_modules/y"));
    await writeFile(archive, rawTar([{ name: "node_modules/y", body: "x" }]));
    await expect(extractArchive(archive, destination, { budgetBytes: 1024 * 1024 })).rejects.toBeDefined();
    expect(await readdir(outside)).toEqual([]);
  });

  it("a restore verifies the links it extracted: one changed before the check rejects the hit", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    const outside = join(root, "outside-link");
    await writeFile(outside, "x");
    const reason = await prepareRefusedHit({
      testHooks: {
        beforeVerifyLinks: async (temp) => {
          const link = join(temp, "node_modules/.bin/beta");
          expect(await readlink(link)).toBe("../beta/index.js");
          await rm(link);
          await symlink(outside, link);
        },
      },
    });
    expect(reason).toBe("unsafe_archive");
  });

  it("restores files over 1 MiB (streamed) and up to 1 MiB (buffered) byte for byte", async () => {
    const { randomBytes } = await import("node:crypto");
    const large = randomBytes(1024 * 1024 + 4097);
    const exact = randomBytes(1024 * 1024);
    hitWith(
      await realTarSnapshot(LOCKFILE, async (dir) => {
        await writeFile(join(dir, "node_modules/beta/large.bin"), large);
        await writeFile(join(dir, "node_modules/alpha/exact.bin"), exact);
        await writeFile(join(dir, "node_modules/alpha/empty.txt"), "");
      }),
    );
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect((await readFile(join(workspace, "node_modules/beta/large.bin"))).equals(large)).toBe(true);
    expect((await readFile(join(workspace, "node_modules/alpha/exact.bin"))).equals(exact)).toBe(true);
    expect(await readFile(join(workspace, "node_modules/alpha/empty.txt"), "utf8")).toBe("");
    expect(await readlink(join(workspace, "node_modules/.bin/beta"))).toBe("../beta/index.js");
  });

  it("extraction refuses a pre-existing symlink (live or dangling) where a folder entry goes", async () => {
    const destination = join(root, "dest-dir");
    const outside = join(root, "elsewhere-dir");
    await mkdir(join(destination, "node_modules"), { recursive: true });
    await mkdir(outside);
    const archive = join(root, "dir.tgz");
    await writeFile(
      archive,
      rawTar([
        { name: "node_modules/", type: "5" },
        { name: "node_modules/p/", type: "5" },
        { name: "node_modules/p/x", body: "x" },
      ]),
    );
    await symlink(outside, join(destination, "node_modules/p"));
    await expect(extractArchive(archive, destination, { budgetBytes: 1024 * 1024 })).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
    expect(await readdir(outside)).toEqual([]);
    await rm(join(destination, "node_modules/p"));
    await symlink(join(outside, "missing"), join(destination, "node_modules/p"));
    await expect(extractArchive(archive, destination, { budgetBytes: 1024 * 1024 })).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("extraction returns the links it made, and never writes over or beside an existing entry", async () => {
    const destination = join(root, "dest-links");
    await mkdir(destination);
    const archive = join(root, "links.tgz");
    await writeFile(
      archive,
      rawTar([
        { name: "node_modules/a/f", body: "x" },
        { name: "node_modules/.bin/a", type: "2", link: "../a/f" },
        { name: "node_modules/b", type: "2", link: "a" },
      ]),
    );
    const { links } = await extractArchive(archive, destination, { budgetBytes: 1024 * 1024 });
    expect(links).toEqual([join(destination, "node_modules/.bin/a"), join(destination, "node_modules/b")]);
    await expect(verifyLinks(destination, links)).resolves.toBeUndefined();

    // A file is only ever created (O_EXCL): a planted file where one goes is refused, never replaced,
    // so every written file is new and has a single link.
    const again = join(root, "dest-planted");
    await mkdir(join(again, "node_modules/a"), { recursive: true });
    await writeFile(join(again, "node_modules/a/f"), "planted");
    await expect(extractArchive(archive, again, { budgetBytes: 1024 * 1024 })).rejects.toBeDefined();
    expect(await readFile(join(again, "node_modules/a/f"), "utf8")).toBe("planted");
  });

  it("an archive of files only reports no links and writes each file with a single link", async () => {
    // Extraction refuses tar hard-link entries (see the table above) and creates every file with O_EXCL,
    // so verifyLinks only needs the links extraction reports.
    const destination = join(root, "dest-nolinks");
    await mkdir(destination);
    const archive = join(root, "files.tgz");
    await writeFile(archive, rawTar([{ name: "node_modules/a/f", body: "x" }]));
    const { links } = await extractArchive(archive, destination, { budgetBytes: 1024 * 1024 });
    expect(links).toEqual([]);
    const { stat } = await import("node:fs/promises");
    expect((await stat(join(destination, "node_modules/a/f"))).nlink).toBe(1);
  });

  it("verifyLinks refuses a listed path that is no longer a link", async () => {
    const tree = join(root, "tree-kinds");
    await mkdir(join(tree, "node_modules/a"), { recursive: true });
    await writeFile(join(tree, "node_modules/a/f"), "x");
    await expect(verifyLinks(tree, [join(tree, "node_modules/a/f")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
    await expect(verifyLinks(tree, [join(tree, "node_modules/missing")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
  });

  it("verifyLinks rejects a written tree with a link out of node_modules, even through a linked folder", async () => {
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules/p"), { recursive: true });
    await symlink("..", join(tree, "node_modules/p/q"));
    const links = [join(tree, "node_modules/p/q")];
    await expect(verifyLinks(tree, links)).resolves.toBeUndefined();
    await symlink("../..", join(tree, "node_modules/r")); // what p/q/r -> ../.. really is
    await expect(verifyLinks(tree, [...links, join(tree, "node_modules/r")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
    await symlink("/etc", join(tree, "node_modules/abs"));
    await expect(verifyLinks(tree, [...links, join(tree, "node_modules/abs")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
  });

  it("verifyLinks rejects a written link that escapes once the kernel follows the links before it", async () => {
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules/a/b"), { recursive: true });
    await symlink("../..", join(tree, "node_modules/a/b/s")); // -> node_modules: inside
    const links = [join(tree, "node_modules/a/b/s")];
    await expect(verifyLinks(tree, links)).resolves.toBeUndefined();
    await symlink("a/b/s/../..", join(tree, "node_modules/t")); // lexically node_modules/a; really tree's parent
    await expect(verifyLinks(tree, [...links, join(tree, "node_modules/t")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
  });

  it("verifyLinks resolves each link on disk: a target the text rule accepts still fails if it lands outside", async () => {
    // Extraction never makes a folder that is a link (safeDirectory), so this can't come from an archive;
    // it's the realpath check alone that refuses it.
    const tree = join(root, "tree-swapped");
    const outside = join(root, "outside-swapped");
    await mkdir(join(tree, "node_modules"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "y"), "x");
    await symlink("y", join(outside, "x"));
    await symlink(outside, join(tree, "node_modules/p"));
    await expect(verifyLinks(tree, [join(tree, "node_modules/p/x")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
  });

  it("verifyLinks allows a dangling link only when its target is plainly inside", async () => {
    const tree = join(root, "tree");
    await mkdir(join(tree, "node_modules/.bin"), { recursive: true });
    await symlink("../missing/cli.js", join(tree, "node_modules/.bin/tool"));
    const links = [join(tree, "node_modules/.bin/tool")];
    await expect(verifyLinks(tree, links)).resolves.toBeUndefined();
    await symlink("nothere/../.bin", join(tree, "node_modules/odd"));
    await expect(verifyLinks(tree, [...links, join(tree, "node_modules/odd")])).rejects.toMatchObject({
      reason: "unsafe_archive",
    });
  });

  it("scanArchive accepts a real tar snapshot and counts its bytes", async () => {
    const archive = join(root, "ok.tgz");
    await writeFile(archive, await realTarSnapshot(LOCKFILE));
    const scan = await scanArchive(archive, { budgetBytes: 1024 * 1024 });
    expect(scan.entries).toBeGreaterThan(5);
    expect(scan.unpackedBytes).toBeGreaterThan(0);
  });

  it("a snapshot whose tree links outside node_modules is never uploaded", async () => {
    await writeFile(join(workspace, "sibling.js"), "x");
    env.FAKE_NPM_MODE = "";
    // A file: dependency link the way npm writes one: node_modules/x -> ../sibling.js
    const npmPath = join(root, "fake-npm-link");
    await writeFile(
      npmPath,
      FAKE_NPM.replace(
        'fs.writeFileSync("node_modules/.package-lock.json"',
        'fs.symlinkSync("../sibling.js", "node_modules/linked"); fs.writeFileSync("node_modules/.package-lock.json"',
      ),
    );
    await chmod(npmPath, 0o755);
    const result = await prepare({ npmPath });
    expect(result.result).toBe("cold");
    expect(state.uploads).toHaveLength(0);
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "unsafe_archive")).toBe(true);
  });
});

// ---------------------------------------------------------------- archive manifest

/** The scan result the proxy returns as `manifest` for a snapshot uploaded with it. */
async function manifestFor(blob: Buffer) {
  const archive = join(root, `manifest-${randomUUID()}.tgz`);
  await writeFile(archive, blob);
  const { entries, unpackedBytes } = await scanArchive(archive, { budgetBytes: Number.MAX_SAFE_INTEGER });
  await rm(archive);
  return { scanVersion: 1, sha256: sha256(blob), entries, unpackedBytes };
}

function hitWithManifest(blob: Buffer, manifest: unknown, id = "a".repeat(64)) {
  state.blobs.set(id, blob);
  state.lookupAnswer = () => ({ status: 200, body: { key: id, hit: true, maxBytes: 64 * 1024 * 1024, manifest } });
}

/** The restore stages logged, in order. */
const restoreStages = () => events.filter((event) => event.event === "restore_phase").map((event) => event.stage);

describe("archive manifest (scan recorded at upload)", () => {
  it("logs each restore stage with its duration", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(restoreStages()).toEqual(["download", "scan", "extract", "verify_links", "check_consistency"]);
    for (const event of events.filter((entry) => entry.event === "restore_phase"))
      expect(typeof event.ms).toBe("number");
  });

  it("a lookup without a manifest (a legacy snapshot) runs the full scan", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(restoreStages()).toContain("scan");
  });

  it("refuses a manifest bound to another digest: download_failed, nothing scanned or extracted", async () => {
    const blob = await realTarSnapshot(LOCKFILE);
    hitWithManifest(blob, { ...(await manifestFor(blob)), sha256: "0".repeat(64) });
    expect(await prepareRefusedHit()).toBe("download_failed");
    // The refused hit's restore stopped at the download; the cold install's tree is the only one.
    expect(restoreStages()).toEqual(["download"]);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it.each([
    ["a wrong scanVersion", { scanVersion: 2 }],
    ["a sha256 that is not lowercase hex", { sha256: "Z".repeat(64) }],
    ["a short sha256", { sha256: "a".repeat(63) }],
    ["non-integer entries", { entries: 1.5 }],
    ["zero entries", { entries: 0 }],
    ["entries as a string", { entries: "3" }],
    ["negative unpackedBytes", { unpackedBytes: -1 }],
    ["non-integer unpackedBytes", { unpackedBytes: 0.5 }],
  ])("ignores a manifest with %s and runs the full scan", async (_label, change) => {
    const blob = await realTarSnapshot(LOCKFILE);
    hitWithManifest(blob, { ...(await manifestFor(blob)), ...change });
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(restoreStages()).toContain("scan");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "manifest"],
  ])("ignores a manifest that is %s and runs the full scan", async (_label, manifest) => {
    hitWithManifest(await realTarSnapshot(LOCKFILE), manifest);
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(restoreStages()).toContain("scan");
  });

  it("nearest: uses nearest.manifest when the digest matches (no second scan)", async () => {
    const nearest = await realTarSnapshot(LOCKFILE);
    await writeRepo(LOCKFILE_V2);
    state.blobs.set("b".repeat(64), nearest);
    const manifest = await manifestFor(nearest);
    state.lookupAnswer = () => ({
      status: 200,
      body: { key: "c".repeat(64), hit: false, nearest: { id: "b".repeat(64), manifest }, maxBytes: 64 * 1024 * 1024 },
    });
    expect(await prepare()).toMatchObject({ result: "nearest" });
    expect(restoreStages()).toEqual(["download", "extract", "verify_links"]);
  });

  it("a manifest understating unpackedBytes does not lift the bound: extraction still refuses over_budget", async () => {
    // Claims one small file; the archive holds a 7 GiB entry.
    const blob = rawTar([
      { name: "node_modules/", type: "5" },
      { name: "node_modules/big", size: 7 * 1024 * 1024 * 1024 },
    ]);
    hitWithManifest(blob, { scanVersion: 1, sha256: sha256(blob), entries: 2, unpackedBytes: 1 });
    expect(await prepare({ budgetBytes: 1024 * 1024 * 1024 })).toEqual({ result: "skipped", reason: "over_budget" });
    // The scan was skipped (the manifest was trusted), so extractArchive's budget refused it.
    expect(restoreStages()).toEqual(["download", "extract"]);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
  });
});

// ---------------------------------------------------------------- consistency

describe("consistency", () => {
  it("rejects a restored tree whose hidden lockfile disagrees, leaving nothing of it, and installs cold", async () => {
    hitWith(await realTarSnapshot(LOCKFILE_V2));
    expect(await prepareRefusedHit()).toBe("inconsistent");
    const alpha = JSON.parse(await readFile(join(workspace, "node_modules/alpha/package.json"), "utf8"));
    expect(alpha.version).toBe("1.0.0");
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("rejects a tree whose package.json differs from its hidden lockfile entry", async () => {
    hitWith(
      await realTarSnapshot(LOCKFILE, async (dir) => {
        await writeFile(
          join(dir, "node_modules/alpha/package.json"),
          JSON.stringify({ name: "alpha", version: "6.6.6" }),
        );
      }),
    );
    expect(await prepareRefusedHit()).toBe("inconsistent");
    const alpha = JSON.parse(await readFile(join(workspace, "node_modules/alpha/package.json"), "utf8"));
    expect(alpha.version).toBe("1.0.0");
  });

  it("a cold install that comes out inconsistent is kept but not snapshotted", async () => {
    env.FAKE_NPM_MODE = "drift";
    expect(await prepare()).toEqual({
      result: "cold",
      key: "k".repeat(64),
      reason: "inconsistent",
      installMs: expect.any(Number),
    });
    expect(state.uploads).toHaveLength(0);
  });

  it("checkConsistency rules: optional may be absent, resolved ignored, extras and integrity are not", async () => {
    const tree = join(root, "tree");
    const make = async (packages: Record<string, object>) => {
      await rm(tree, { recursive: true, force: true });
      for (const [key, entry] of Object.entries(packages)) {
        await mkdir(join(tree, key), { recursive: true });
        await writeFile(
          join(tree, key, "package.json"),
          JSON.stringify({ version: (entry as { version: string }).version }),
        );
      }
      await writeFile(join(tree, "node_modules/.package-lock.json"), JSON.stringify({ packages }));
    };
    const lock = LOCKFILE as unknown as { packages: Record<string, Record<string, unknown>> };
    const installed = Object.fromEntries(
      Object.entries(lock.packages).filter(([key, entry]) => key !== "" && !entry.optional),
    );
    await make(Object.fromEntries(Object.entries(installed).map(([k, v]) => [k, { ...v, resolved: "x" }])));
    expect(await checkConsistency(tree, lock)).toEqual({ ok: true });
    await make({ ...installed, "node_modules/extra": { version: "1.0.0" } });
    expect((await checkConsistency(tree, lock)).ok).toBe(false);
    await make({ ...installed, "node_modules/alpha": { version: "1.0.0", integrity: "sha512-other" } });
    expect((await checkConsistency(tree, lock)).ok).toBe(false);
    const { "node_modules/beta": _beta, ...missing } = installed;
    await make(missing);
    expect((await checkConsistency(tree, lock)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- seal and time bounds

describe("seal and timeouts", () => {
  it("never uploads once the session is sealed", async () => {
    const result = await prepareProject({
      workspace,
      projectPath: ".",
      env,
      npmPath: join(root, "fake-npm"),
      log: (event, fields) => events.push({ event, ...fields }),
      auth: { base: env.WARDBY_NPM_PLAN_REGISTRY, token: "run-token" },
      budget: { remaining: 1024 * 1024 * 1024 },
      timeouts: { ...DEFAULT_TIMEOUTS },
      signal: new AbortController().signal,
      session: { sealed: true, closed: false, children: new Set<number>() },
    });
    expect(result.result).toBe("cold");
    expect(state.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "sealed")).toBe(true);
  });

  it("a cancelled run stops the work promptly, still seals, and changes nothing afterwards", async () => {
    state.hang = "GET /cache/npm/lookup";
    const controller = new AbortController();
    const started = Date.now();
    const running = prepare({ signal: controller.signal, timeouts: { httpMs: 60_000, settleMs: 200 } });
    setTimeout(() => controller.abort(), 100);
    const result = await running;
    expect(result.result).toBe("skipped");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.seals).toBe(1);
  });

  it("an already-cancelled signal does no project work", async () => {
    const controller = new AbortController();
    controller.abort();
    await prepareAll({ signal: controller.signal, timeouts: { settleMs: 200 } });
    expect(state.calls.filter((call) => call !== "POST /cache/npm/seal")).toEqual([]);
  });

  it("sealUploadWindow seals on its own with the registry's token (a tool runner's first command)", async () => {
    expect(await sealUploadWindow({ env })).toEqual({ status: 200, confirmed: true });
    expect(state.calls).toEqual(["POST /cache/npm/seal"]);
    expect(state.authorizations.at(-1)).toBe("Bearer run-token");
    state.sealStatus = 500;
    expect(await sealUploadWindow({ env })).toEqual({ status: 500, confirmed: false });
  });

  it("retries a seal that failed with a 5xx, a few times within its timeout, but not a 4xx", async () => {
    state.sealStatus = 503;
    const answer = sealUploadWindow({ env, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    state.sealStatus = undefined; // the proxy recovers before the next attempt
    expect(await answer).toEqual({ status: 200, confirmed: true });
    expect(state.seals).toBe(2);

    state.seals = 0;
    state.sealStatus = 500;
    expect(await sealUploadWindow({ env, timeoutMs: 10_000 })).toEqual({ status: 500, confirmed: false });
    expect(state.seals).toBe(3);

    state.seals = 0;
    state.sealStatus = 401;
    expect(await sealUploadWindow({ env, timeoutMs: 10_000 })).toEqual({ status: 401, confirmed: false });
    expect(state.seals).toBe(1);

    // No pause that would outlast the timeout.
    state.seals = 0;
    state.sealStatus = 500;
    const started = Date.now();
    expect(await sealUploadWindow({ env, timeoutMs: 200 })).toEqual({ status: 500, confirmed: false });
    expect(state.seals).toBe(1);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("sealUploadWindow never throws: no registry, or a proxy that hangs", async () => {
    expect(await sealUploadWindow({ env: {} })).toEqual({ status: 0, confirmed: false });
    state.hang = "POST /cache/npm/seal";
    const started = Date.now();
    expect(await sealUploadWindow({ env, timeoutMs: 300 })).toEqual({ status: 0, confirmed: false });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("seals when a call hangs, bounded by the HTTP timeout", async () => {
    state.hang = "GET /cache/npm/lookup";
    const started = Date.now();
    expect(await prepare({ timeouts: { httpMs: 300 } })).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(state.seals).toBe(1);
  });

  it("kills a hung install at its timeout, cleans up, uploads nothing and seals", async () => {
    env.FAKE_NPM_MODE = "hang";
    const started = Date.now();
    expect(await prepare({ timeouts: { installMs: 400 } })).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(state.uploads).toHaveLength(0);
    expect(state.seals).toBe(1);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("the overall deadline aborts the work, seals, and nothing uploads after the seal", async () => {
    env.FAKE_NPM_MODE = "hang";
    expect(await prepare({ timeouts: { totalMs: 500 } })).toEqual({ result: "skipped", reason: "timeout" });
    expect(state.seals).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.calls.filter((call) => call.startsWith("PUT"))).toEqual([]);
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
  });

  it("never throws when the registry base is not a URL, and still answers skipped", async () => {
    const npmrc = join(root, "npmrc-bad");
    await writeFile(npmrc, "not a url/:_authToken=run-token\n");
    env.npm_config_registry = "not a url/";
    env.WARDBY_NPM_PLAN_REGISTRY = "not a url/";
    env.npm_config_userconfig = npmrc;
    await expect(prepare()).resolves.toMatchObject({ result: "skipped" });
  });

  it("after a deadline, a step that ignored it never puts node_modules in place, and its temps are removed", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    await mkdir(join(workspace, ".cache"));
    await writeFile(join(workspace, ".cache", "keep.txt"), "not ours");
    const started = Date.now();
    const result = await prepare({
      timeouts: { totalMs: 400, killGraceMs: 100, settleMs: 200 },
      testHooks: {
        beforeRename: () => new Promise((resolve) => setTimeout(resolve, Math.max(0, 1_500 - (Date.now() - started)))),
      },
    });
    expect(result).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_400);
    expect(state.seals).toBe(1);
    // Only this module's own temp paths go; nothing else in .cache is touched.
    expect(await cacheLeftovers()).toEqual(["keep.txt"]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await cacheLeftovers()).toEqual(["keep.txt"]);
  });

  it("seals even when the workspace .cache is not a directory", async () => {
    await symlink(root, join(workspace, ".cache"));
    expect(await prepare()).toEqual({ result: "skipped", reason: "cache_dir_unsafe" });
    expect(state.seals).toBe(1);
  });
});

// ---------------------------------------------------------------- several projects

describe("several npm projects in one repo", () => {
  const hitEverywhere = async () => hitWith(await realTarSnapshot(LOCKFILE));

  it("restores the root, app/ and server/ projects into their own folders, then seals once", async () => {
    await writeProject("app", LOCKFILE);
    await writeProject("server", LOCKFILE);
    await hitEverywhere();
    const { projects } = await prepareAll();
    expect(projects.map((project) => [project.path, project.result])).toEqual([
      [".", "hit"],
      ["app", "hit"],
      ["server", "hit"],
    ]);
    for (const dir of [".", "app", "server"])
      expect(await exists(join(workspace, dir, "node_modules/alpha/package.json"))).toBe(true);
    expect(new Set(state.projects)).toEqual(new Set([".", "app", "server"]));
    expect(state.seals).toBe(1);
    expect(state.calls.at(-1)).toBe("POST /cache/npm/seal");
    expect(state.calls.filter((call) => call === "POST /cache/npm/seal")).toHaveLength(1);
    expect(await npmCalls()).toEqual([]);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("takes at most four projects, root first then by path; the rest are too_many_projects", async () => {
    for (const dir of ["e", "b", "d", "a", "c"]) await writeProject(dir, LOCKFILE);
    await hitEverywhere();
    const { projects } = await prepareAll();
    expect(projects.map((project) => [project.path, project.result, project.reason])).toEqual([
      [".", "hit", undefined],
      ["a", "hit", undefined],
      ["b", "hit", undefined],
      ["c", "hit", undefined],
      ["d", "skipped", "too_many_projects"],
      ["e", "skipped", "too_many_projects"],
    ]);
    expect(await exists(join(workspace, "d/node_modules"))).toBe(false);
    expect(state.projects).not.toContain("d");
  });

  it("ignores lockfiles in node_modules, dot-folders, symlinked folders, odd names and below three levels", async () => {
    await writeProject("node_modules/x", LOCKFILE);
    await writeProject("app/node_modules/y", LOCKFILE);
    await writeProject(".hidden", LOCKFILE);
    await writeProject("has space", LOCKFILE);
    await writeProject("x/y/z", LOCKFILE);
    await writeProject("x/y/z/deep", LOCKFILE);
    await writeProject("app", LOCKFILE);
    await symlink(join(workspace, "app"), join(workspace, "linked"));
    await symlink(join(workspace, "app"), join(workspace, "x/linked"));
    expect(await discoverProjects(workspace)).toEqual(["."].concat(["app", "x/y/z"]));
  });

  it("discovers nothing but a missing root lockfile when the repo has no npm project", async () => {
    await rm(join(workspace, "package-lock.json"));
    expect((await prepareAll()).projects).toEqual([{ path: ".", result: "skipped", reason: "no_lockfile" }]);
  });

  it("a subfolder project works without a root project", async () => {
    await rm(join(workspace, "package-lock.json"));
    await writeProject("web/client", LOCKFILE);
    await hitEverywhere();
    const { projects } = await prepareAll();
    expect(projects.map((project) => [project.path, project.result])).toEqual([["web/client", "hit"]]);
    expect(await exists(join(workspace, "web/client/node_modules/alpha"))).toBe(true);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
  });

  it("skips projects inside another project's workspaces globs", async () => {
    await writeRepo(LOCKFILE, { name: "mono", workspaces: ["packages/*"] });
    await writeProject("packages/a", LOCKFILE);
    await writeProject("packages/a/inner", LOCKFILE);
    await writeProject("tools", LOCKFILE);
    await writeProject(
      "apps/web",
      { ...LOCKFILE, name: "apps" },
      { name: "apps", workspaces: { packages: ["./web/"] } },
    );
    await writeProject("apps/web/site", LOCKFILE);
    await hitEverywhere();
    const { projects } = await prepareAll();
    expect(projects.map((project) => [project.path, project.result, project.reason])).toEqual([
      [".", "skipped", "workspaces"],
      ["apps/web", "skipped", "workspaces"],
      ["apps/web/site", "hit", undefined],
      ["packages/a", "skipped", "workspace_member"],
      ["packages/a/inner", "skipped", "workspace_member"],
      ["tools", "hit", undefined],
    ]);
  });

  it("one project's refusal or failure never stops the others", async () => {
    await writeProject("app", { ...LOCKFILE, name: "refuse-me" });
    await writeProject("server", { ...LOCKFILE, name: "server" });
    await writeProject("tools", { ...LOCKFILE, name: "tools" });
    const good = await realTarSnapshot(LOCKFILE);
    state.blobs.set("a".repeat(64), good);
    state.blobs.set("e".repeat(64), rawTar([{ name: "node_modules/../evil", body: "x" }]));
    state.planAnswer = (plan) =>
      plan.includes('"refuse-me"')
        ? { status: 200, body: { approved: 1, refused: [{ name: "beta", version: "2.0.0", code: "too_new" }] } }
        : { status: 200, body: { approved: 3, refused: [] } };
    state.lookupAnswer = (_lock, project) => ({
      status: 200,
      body: { key: project === "server" ? "e".repeat(64) : "a".repeat(64), hit: true, maxBytes: 64 * 1024 * 1024 },
    });
    const { projects } = await prepareAll();
    expect(projects.map((project) => [project.path, project.result, project.reason])).toEqual([
      [".", "hit", undefined],
      ["app", "refused", "plan_refused"],
      ["server", "cold", undefined],
      ["tools", "hit", undefined],
    ]);
    expect(events).toContainEqual({ event: "hit_rejected", project: "server", reason: "unsafe_archive" });
    expect(await exists(join(workspace, "server/node_modules/evil"))).toBe(false);
    expect(await exists(join(workspace, "tools/node_modules/alpha"))).toBe(true);
    expect(state.seals).toBe(1);
  });

  it("shares the size budget: a restore is checked against what earlier restores left", async () => {
    await writeProject("app", LOCKFILE);
    const blob = await realTarSnapshot(LOCKFILE);
    const archive = join(root, "measure.tgz");
    await writeFile(archive, blob);
    const { unpackedBytes } = await scanArchive(archive, { budgetBytes: 1024 * 1024 * 1024 });
    hitWith(blob);
    const { projects } = await prepareAll({ budgetBytes: blob.length + Math.floor(unpackedBytes * 1.5) });
    expect(projects.map((project) => [project.path, project.result, project.reason])).toEqual([
      [".", "hit", undefined],
      ["app", "skipped", "over_budget"],
    ]);
    expect(await exists(join(workspace, "app/node_modules"))).toBe(false);
  });

  it("shares the size budget with what an install before it wrote", async () => {
    await writeProject("app", LOCKFILE);
    const blob = await realTarSnapshot(LOCKFILE);
    const archive = join(root, "measure.tgz");
    await writeFile(archive, blob);
    const { unpackedBytes } = await scanArchive(archive, { budgetBytes: 1024 * 1024 * 1024 });
    state.blobs.set("a".repeat(64), blob);
    state.lookupAnswer = (_lock, project) => ({
      status: 200,
      body: { key: "a".repeat(64), hit: project === "app", maxBytes: 64 * 1024 * 1024 },
    });
    const { projects } = await prepareAll({
      budgetBytes: blob.length + Math.floor(unpackedBytes * 1.5),
      minInstallBytes: 0,
    });
    expect(projects.map((project) => [project.path, project.result, project.reason])).toEqual([
      [".", "cold", undefined],
      ["app", "skipped", "over_budget"],
    ]);
  });

  it("the deadline reports unfinished projects as timeout and still seals once", async () => {
    await writeProject("app", LOCKFILE);
    env.FAKE_NPM_MODE = "hang";
    const { projects } = await prepareAll({ timeouts: { totalMs: 500, killGraceMs: 100 } });
    expect(projects).toEqual([
      { path: ".", result: "skipped", reason: "timeout" },
      { path: "app", result: "skipped", reason: "timeout" },
    ]);
    expect(state.seals).toBe(1);
  });
});

// ---------------------------------------------------------------- install scripts

describe("npm rebuild after the seal", () => {
  const SCRIPTED = {
    ...LOCKFILE,
    packages: {
      ...LOCKFILE.packages,
      "node_modules/beta": { ...LOCKFILE.packages["node_modules/beta"], hasInstallScript: true },
    },
  };

  it("runs npm rebuild after the seal for a project with install scripts; its output is never uploaded", async () => {
    await writeRepo(SCRIPTED);
    const { projects } = await prepareAll();
    expect(projects).toEqual([expect.objectContaining({ path: ".", result: "cold", rebuild: "ok" })]);
    expect(await npmCalls()).toEqual([["ci", "--ignore-scripts", "--no-audit", "--no-fund"], ["rebuild"]]);
    const order = events.map((entry) => entry.event);
    expect(order.indexOf("seal")).toBeLessThan(order.indexOf("rebuild"));
    expect(await exists(join(workspace, "node_modules/.rebuilt"))).toBe(true);
    // The snapshot went up before the rebuild ran.
    expect(state.uploads).toHaveLength(1);
    const uploaded = join(root, "uploaded.tgz");
    await writeFile(uploaded, state.uploads[0].body);
    const listing = spawnSync("tar", ["-tzf", uploaded], { encoding: "utf8" }).stdout;
    expect(listing).toContain("node_modules/alpha/package.json");
    expect(listing).not.toContain(".rebuilt");
  });

  it("rebuilds a restored hit too", async () => {
    await writeRepo(SCRIPTED);
    hitWith(await realTarSnapshot(SCRIPTED));
    const { projects } = await prepareAll();
    expect(projects).toEqual([expect.objectContaining({ result: "hit", rebuild: "ok" })]);
    expect(await npmCalls()).toEqual([["rebuild"]]);
  });

  it("skips the rebuild when no package has an install script, and for a skipped project", async () => {
    await writeProject("app", { ...LOCKFILE, name: "app" });
    state.lookupAnswer = (_lock, project) =>
      project === "app"
        ? { status: 404, body: { error: "not_found" } }
        : { status: 200, body: { key: "k".repeat(64), hit: false, maxBytes: 64 * 1024 * 1024 } };
    const { projects } = await prepareAll();
    expect(projects).toEqual([
      expect.objectContaining({ path: ".", result: "cold", rebuild: "skipped" }),
      { path: "app", result: "skipped", reason: "cache_unavailable" },
    ]);
    expect((await npmCalls()).map((argv) => argv[0])).toEqual(["ci"]);
  });

  it("a failed rebuild is recorded and changes nothing else", async () => {
    await writeRepo(SCRIPTED);
    env.WARDBY_NPM_TEST_REBUILD = "fail";
    const { projects } = await prepareAll();
    expect(projects).toEqual([expect.objectContaining({ result: "cold", rebuild: "failed" })]);
    expect(projects[0].reason).toBeUndefined();
    expect(await exists(join(workspace, "node_modules/alpha"))).toBe(true);
  });

  it("a hung rebuild is killed at its timeout and never writes afterwards", async () => {
    await writeRepo(SCRIPTED);
    env.WARDBY_NPM_TEST_REBUILD = "hang";
    const started = Date.now();
    const { projects } = await prepareAll({ timeouts: { rebuildMs: 300, killGraceMs: 100 } });
    expect(projects).toEqual([expect.objectContaining({ result: "cold", rebuild: "timeout" })]);
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await exists(join(workspace, "node_modules/.late"))).toBe(false);
  });

  it.each([
    ["answers 500", () => (state.sealStatus = 500)],
    ["hangs past its timeout", () => (state.hang = "POST /cache/npm/seal")],
  ])("never runs install scripts when the seal %s", async (_label, setup) => {
    await writeRepo(SCRIPTED);
    setup();
    const { projects } = await prepareAll({ timeouts: { httpMs: 1_000 } });
    expect(projects).toEqual([expect.objectContaining({ result: "cold", rebuild: "unsealed" })]);
    expect((await npmCalls()).map((argv) => argv[0])).toEqual(["ci"]);
    expect(await exists(join(workspace, "node_modules/.rebuilt"))).toBe(false);
    expect(events.some((entry) => entry.event === "rebuild_skipped" && entry.reason === "unsealed")).toBe(true);
  });

  it("gives the rebuild only registry settings, never the driver's other variables", async () => {
    await writeRepo(SCRIPTED);
    env.OPENAI_API_KEY = "sk-sentinel";
    env.WARDBY_RUN_CAPABILITY = "cap-sentinel";
    env.HOME = root;
    const { projects } = await prepareAll();
    expect(projects[0].rebuild).toBe("ok");
    const names = JSON.parse(await readFile(join(workspace, "node_modules/.rebuild-env"), "utf8")) as string[];
    expect(names).not.toContain("OPENAI_API_KEY");
    expect(names).not.toContain("WARDBY_RUN_CAPABILITY");
    expect(names).not.toContain("FAKE_NPM_MODE");
    expect(names).toEqual(expect.arrayContaining(["PATH", "HOME", "npm_config_registry", "WARDBY_NPM_PLAN_REGISTRY"]));
  });

  it("decides on the rebuild from the committed lockfile, before an install could rewrite it", async () => {
    await writeRepo(SCRIPTED);
    env.FAKE_NPM_MODE = "rewrite-lock"; // npm ci leaves package-lock.json as "{}"
    const { projects } = await prepareAll();
    expect(projects[0]).toMatchObject({ result: "cold", rebuild: "ok" });
  });

  it("counts only installed packages: an install script on the root or a link target needs no rebuild", async () => {
    await writeRepo({
      ...LOCKFILE,
      packages: {
        ...LOCKFILE.packages,
        "": { ...LOCKFILE.packages[""], hasInstallScript: true },
        "../linked": { version: "1.0.0", hasInstallScript: true },
      },
    });
    const { projects } = await prepareAll();
    expect(projects[0]).toMatchObject({ result: "cold", rebuild: "skipped" });
    expect((await npmCalls()).map((argv) => argv[0])).toEqual(["ci"]);
  });

  it("the overall deadline covers the rebuild: nothing changes the workspace after the module returns", async () => {
    await writeRepo(SCRIPTED);
    hitWith(await realTarSnapshot(SCRIPTED));
    env.WARDBY_NPM_TEST_REBUILD = "hang";
    const started = Date.now();
    const { projects } = await prepareAll({ timeouts: { totalMs: 1_000, killGraceMs: 100, settleMs: 300 } });
    expect(Date.now() - started).toBeLessThan(1_300 + 500);
    expect(projects).toEqual([expect.objectContaining({ result: "hit", rebuild: "timeout" })]);
    expect(state.seals).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(await exists(join(workspace, "node_modules/.late"))).toBe(false);
  });
});

// ---------------------------------------------------------------- fix round 1

describe("review fixes", () => {
  it("does not start an upload once the proxy's upload window has evidently passed", async () => {
    const { projects } = await prepareAll({ timeouts: { uploadWindowMs: 1, uploadMarginMs: 0 } });
    expect(projects[0]).toMatchObject({ result: "cold" });
    expect(projects[0].sizeBytes).toBeUndefined();
    expect(state.uploads).toHaveLength(0);
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "upload_window_passed")).toBe(
      true,
    );
  });

  it("uses the upload deadline a lookup reports, when it is sooner", async () => {
    state.lookupAnswer = () => ({
      status: 200,
      body: { key: "k".repeat(64), hit: false, maxBytes: 64 * 1024 * 1024, uploadExpiresInMs: 1_000 },
    });
    await prepareAll({ timeouts: { uploadMarginMs: 5_000 } });
    expect(state.uploads).toHaveLength(0);
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "upload_window_passed")).toBe(
      true,
    );
  });

  it("a workspaces glob it cannot interpret covers everything under its owner", async () => {
    await writeRepo(LOCKFILE, { name: "mono", workspaces: ["packages/{a,b}"] });
    await writeProject("tools", LOCKFILE);
    const { projects } = await prepareAll();
    expect(projects.map((project) => [project.path, project.reason])).toEqual([
      [".", "workspaces"],
      ["tools", "workspace_member"],
    ]);
  });

  it("never removes temps through a .cache that was swapped for a symlink", async () => {
    hitWith(await realTarSnapshot(LOCKFILE));
    const outside = join(root, "outside-cache");
    await mkdir(outside);
    const result = await prepareAll({
      testHooks: {
        beforeRename: async () => {
          const cache = join(workspace, ".cache");
          for (const name of await readdir(cache)) await mkdir(join(outside, name));
          await rename(cache, join(workspace, ".cache-moved"));
          await symlink(outside, cache);
        },
      },
    });
    expect(result.projects[0].result).toBe("skipped");
    expect((await readdir(outside)).length).toBeGreaterThan(0);
    expect((await readdir(outside)).every((name) => name.startsWith("dep-restore-"))).toBe(true);
  });

  it("a planning failure reports a top-level reason, not a made-up root project", async () => {
    const result = await prepareAll({
      testHooks: {
        beforeDiscovery: () => Promise.reject(new Error("boom")),
      },
    });
    expect(result).toEqual({ projects: [], reason: "internal_error" });
    expect(state.seals).toBe(1);
  });

  it("logs which rule refused an archive (case-fold duplicate), without path contents", async () => {
    hitWith(rawTar([{ name: "node_modules/", type: "5" }, ...CASE_FOLD_CHAIN]));
    await prepareAll({ budgetBytes: 1024 * 1024 * 1024 });
    const refused = events.find((entry) => entry.event === "archive_refused");
    expect(refused).toMatchObject({ rule: "case_fold_duplicate", pathLength: expect.any(Number) });
    expect(JSON.stringify(refused)).not.toContain("node_modules/a");
  });
});

// ---------------------------------------------------------------- disk use

describe("disk use", () => {
  const MiB = 1024 * 1024;
  const npmCacheDir = () => join(workspace, ".cache", "npm");
  const contentCache = () => join(npmCacheDir(), "_cacache");

  /** The npm cache folder the registry setup writes (npmrc inside it), with something else of npm's. */
  async function npmCacheLikeTheDriver() {
    await mkdir(npmCacheDir(), { recursive: true });
    await writeFile(join(npmCacheDir(), "npmrc"), "registry config\n");
    await mkdir(join(npmCacheDir(), "_logs"));
    await writeFile(join(npmCacheDir(), "_logs", "debug.log"), "x");
    env.npm_config_cache = npmCacheDir();
  }

  const nearestLookup = () =>
    (state.lookupAnswer = () => ({
      status: 200,
      body: { key: "c".repeat(64), hit: false, nearest: { id: "b".repeat(64) }, maxBytes: 64 * MiB },
    }));

  it("removes npm's content cache after a cold install, keeping the npmrc and the rest of npm's folder", async () => {
    await npmCacheLikeTheDriver();
    const result = await prepare();
    expect(result).toMatchObject({ result: "cold" });
    expect(await exists(contentCache())).toBe(false);
    expect(await readFile(join(npmCacheDir(), "npmrc"), "utf8")).toBe("registry config\n");
    expect(await exists(join(npmCacheDir(), "_logs", "debug.log"))).toBe(true);
    expect(state.uploads).toHaveLength(1);
    // Gone before the archive was built.
    const order = events.map((entry) => entry.event);
    expect(order.indexOf("npm_cache_cleared")).toBeGreaterThan(-1);
    expect(order.indexOf("npm_cache_cleared")).toBeLessThan(order.indexOf("snapshot"));
    expect(events).toContainEqual(expect.objectContaining({ event: "npm_cache_cleared", status: "removed" }));
  });

  it("removes npm's content cache after a nearest delta install too", async () => {
    await npmCacheLikeTheDriver();
    state.blobs.set("b".repeat(64), await realTarSnapshot(LOCKFILE));
    await writeRepo(LOCKFILE_V2);
    nearestLookup();
    expect(await prepare()).toMatchObject({ result: "nearest" });
    expect(await exists(contentCache())).toBe(false);
    expect(await exists(join(npmCacheDir(), "npmrc"))).toBe(true);
  });

  it("a cancel during the removal never deletes a _cacache after the module returned", async () => {
    await npmCacheLikeTheDriver();
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let hookRan = false;
    await prepareAll({
      signal: controller.signal,
      timeouts: { settleMs: 200 },
      testHooks: {
        beforeNpmCacheRemove: async () => {
          hookRan = true;
          controller.abort();
          await gate;
        },
      },
    });
    expect(hookRan).toBe(true);
    // Moved away in one step before the removal began.
    expect(await exists(contentCache())).toBe(false);
    // The agent's npm starts a new cache; the late removal must not touch it.
    await mkdir(join(contentCache(), "content-v2"), { recursive: true });
    await writeFile(join(contentCache(), "content-v2", "agent"), "x");
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await exists(join(contentCache(), "content-v2", "agent"))).toBe(true);
    expect(await exists(join(npmCacheDir(), "npmrc"))).toBe(true);
    expect(await cacheLeftovers()).toEqual(["npm"]); // the module's own temp is gone

    // A cancel just before the move: _cacache is left alone.
    await rm(join(workspace, "node_modules"), { recursive: true });
    await rm(contentCache(), { recursive: true });
    state.sealed = false;
    events = [];
    const late = new AbortController();
    await prepareAll({
      signal: late.signal,
      timeouts: { settleMs: 200 },
      testHooks: { beforeNpmCacheMove: async () => late.abort() },
    });
    expect(await exists(join(contentCache(), "content-v2", "tarball"))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: "npm_cache_cleared", status: "stopped" }));
  });

  it("removes nothing on a hit (npm never ran)", async () => {
    await npmCacheLikeTheDriver();
    await mkdir(contentCache());
    await writeFile(join(contentCache(), "keep"), "x");
    hitWith(await realTarSnapshot(LOCKFILE));
    expect(await prepare()).toMatchObject({ result: "hit" });
    expect(await exists(join(contentCache(), "keep"))).toBe(true);
    expect(events.some((entry) => entry.event === "npm_cache_cleared")).toBe(false);
  });

  it("never removes a content cache outside <workspace>/.cache, or one reached through a symlink", async () => {
    const outside = join(root, "npm-cache-outside");
    env.npm_config_cache = outside;
    expect(await prepare()).toMatchObject({ result: "cold" });
    expect(await exists(join(outside, "_cacache", "content-v2", "tarball"))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: "npm_cache_cleared", status: "outside_workspace" }));

    await rm(join(workspace, "node_modules"), { recursive: true });
    state.sealed = false;
    events = [];
    await mkdir(join(workspace, ".cache"), { recursive: true });
    await symlink(outside, join(workspace, ".cache", "npm"));
    env.npm_config_cache = join(workspace, ".cache", "npm");
    expect(await prepare()).toMatchObject({ result: "cold" });
    expect(await exists(join(outside, "_cacache", "content-v2", "tarball"))).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ event: "npm_cache_cleared", status: "unsafe" }));
  });

  it("skips the snapshot when the archive would not fit what is left; node_modules stays, the result stays cold", async () => {
    env.FAKE_NPM_BIG = String(2 * MiB);
    const result = await prepare({ budgetBytes: 2.4 * MiB, minInstallBytes: 0 });
    expect(result).toMatchObject({ result: "cold" });
    expect(result.reason).toBeUndefined();
    expect(result.sizeBytes).toBeUndefined();
    expect(state.uploads).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "snapshot_skipped", reason: "budget", stage: "estimate" }),
    );
    expect(await exists(join(workspace, "node_modules/beta/big.bin"))).toBe(true);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("aborts an archive that outgrows what is left mid-write, and leaves no partial file", async () => {
    env.FAKE_NPM_BIG = String(2 * MiB); // incompressible: the archive comes out ~3x the estimate
    let partial = 0;
    const result = await prepare({
      budgetBytes: 3.1 * MiB,
      minInstallBytes: 0,
      testHooks: {
        afterArchiveAborted: async (archive: string) => {
          partial = (await exists(archive)) ? 1 : 0;
        },
      },
    });
    expect(result).toMatchObject({ result: "cold" });
    expect(result.reason).toBeUndefined();
    expect(state.uploads).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "snapshot_skipped", reason: "budget", stage: "archive" }),
    );
    expect(partial).toBe(0);
    expect(await cacheLeftovers()).toEqual([]);
    expect(await exists(join(workspace, "node_modules/beta/big.bin"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("an archive that can't be written is snapshot_skipped tar_failed", async () => {
    env.FAKE_NPM_MODE = "lock-cache";
    try {
      const result = await prepare();
      expect(result).toMatchObject({ result: "cold" });
      expect(result.reason).toBeUndefined();
      expect(state.uploads).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({ event: "snapshot_skipped", reason: "tar_failed" }));
      expect(await exists(join(workspace, "node_modules/alpha/package.json"))).toBe(true);
    } finally {
      await chmod(join(workspace, ".cache"), 0o700);
    }
  });

  it("refuses a cold install below the floor: budget_too_small, no node_modules, still sealed", async () => {
    expect(MIN_INSTALL_BUDGET_BYTES).toBe(1024 * MiB);
    expect(await prepare({ budgetBytes: 512 * MiB })).toEqual({ result: "skipped", reason: "budget_too_small" });
    expect(await npmCalls()).toEqual([]);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
    expect(state.seals).toBe(1);
  });

  it("refuses a nearest too big to leave room for the delta, then a cold install of a tree that size", async () => {
    // A tree that compresses like a real one (the archive a fraction of the unpacked bytes).
    const blob = await realTarSnapshot(LOCKFILE, (dir) =>
      writeFile(join(dir, "node_modules/beta/pad.bin"), Buffer.alloc(2 * MiB, 7)),
    );
    const archive = join(root, "measure.tgz");
    await writeFile(archive, blob);
    const { unpackedBytes } = await scanArchive(archive, { budgetBytes: 1024 * MiB });
    state.blobs.set("b".repeat(64), blob);
    await writeRepo(LOCKFILE_V2);
    nearestLookup();
    const result = await prepare({ budgetBytes: blob.length + Math.floor(unpackedBytes * 1.2), minInstallBytes: 0 });
    expect(result).toEqual({ result: "skipped", reason: "budget_too_small" });
    expect(events).toContainEqual(expect.objectContaining({ event: "nearest_rejected", reason: "budget_too_small" }));
    expect(await npmCalls()).toEqual([]);
    expect(await exists(join(workspace, "node_modules"))).toBe(false);
    expect(await cacheLeftovers()).toEqual([]);
  });

  it("gives the plan request its own, longer timeout than the other calls", async () => {
    expect(DEFAULT_TIMEOUTS.planMs).toBe(600_000);
    expect(DEFAULT_TIMEOUTS.httpMs).toBe(120_000);
    state.planDelayMs = 400; // slower than every other call may take
    expect(await prepare({ timeouts: { httpMs: 200 } })).toMatchObject({ result: "cold" });

    await rm(join(workspace, "node_modules"), { recursive: true });
    state.sealed = false;
    expect(await prepare({ timeouts: { planMs: 200 } })).toEqual({ result: "skipped", reason: "timeout" });
  });

  const incomplete = {
    status: 503,
    body: { error: "wardby_plan_incomplete: the lockfile was not verified within 120 s; try again" },
  };

  it("retries a plan the proxy left incomplete (it resumes where it stopped) until it is approved", async () => {
    let answered = 0;
    state.planAnswer = () => (++answered <= 2 ? incomplete : { status: 200, body: { approved: 3, refused: [] } });
    expect(await prepare({ timeouts: { planRetryPauseMs: 20 } })).toMatchObject({ result: "cold" });
    expect(state.plans).toHaveLength(3);
    expect(new Set(state.plans).size).toBe(1); // the same lockfile bytes each time
    expect(events.filter((entry) => entry.event === "plan_incomplete")).toHaveLength(2);
    expect(DEFAULT_TIMEOUTS.planRetryPauseMs).toBe(2_000);
  });

  it("stops retrying an incomplete plan at planMs, skipped as timeout", async () => {
    state.planAnswer = incomplete;
    const started = Date.now();
    const result = await prepare({ timeouts: { planMs: 300, planRetryPauseMs: 50 } });
    expect(result).toEqual({ result: "skipped", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(state.plans.length).toBeGreaterThan(1);
    expect(await npmCalls()).toEqual([]);
    expect(state.seals).toBe(1);
  });

  it("sends at most MAX_PLAN_ATTEMPTS plans per project and MAX_PLAN_REQUESTS_PER_RUN per run", async () => {
    expect(MAX_PLAN_ATTEMPTS).toBe(5);
    expect(MAX_PLAN_REQUESTS_PER_RUN).toBe(8);
    await writeProject("app", { ...LOCKFILE, name: "app" });
    await writeProject("server", { ...LOCKFILE, name: "server" });
    state.planAnswer = incomplete;
    const { projects } = await prepareAll({ timeouts: { planRetryPauseMs: 5 } });
    expect(projects.map((project) => [project.path, project.result, project.reason])).toEqual([
      [".", "skipped", "timeout"],
      ["app", "skipped", "plan_failed"],
      ["server", "skipped", "plan_failed"],
    ]);
    expect(state.plans).toHaveLength(8); // 5 for the root, 3 for app, none for server
    expect(events.filter((entry) => entry.event === "plan_limit_reached")).toHaveLength(2);
    expect(state.seals).toBe(1);
  });

  it("does not retry any other plan failure", async () => {
    state.planAnswer = { status: 429, body: { error: "wardby_plan_limit: this run has made its 20 lockfile plans" } };
    expect(await prepare({ timeouts: { planRetryPauseMs: 20 } })).toEqual({ result: "skipped", reason: "plan_failed" });
    expect(state.plans).toHaveLength(1);
    state.plans = [];
    state.planAnswer = { status: 503, body: { error: "wardby_upstream_error: busy" } };
    expect(await prepare({ timeouts: { planRetryPauseMs: 20 } })).toEqual({ result: "skipped", reason: "plan_failed" });
    expect(state.plans).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- budget

describe("dependencyCacheTimeLimit", () => {
  it("is the module's bound, or half the time left before the deadline when sooner, never negative", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(dependencyCacheTimeLimit("2026-10-12T14:00:00Z", now)).toBe(DEFAULT_TIMEOUTS.totalMs);
    expect(dependencyCacheTimeLimit("2026-10-12T12:10:00Z", now)).toBe(5 * 60_000);
    expect(dependencyCacheTimeLimit(new Date(now + 60_000), now)).toBe(30_000);
    expect(dependencyCacheTimeLimit(now + 1_000, now)).toBe(500);
    expect(dependencyCacheTimeLimit("2026-10-12T11:00:00Z", now)).toBe(0);
    expect(dependencyCacheTimeLimit(undefined, now)).toBe(DEFAULT_TIMEOUTS.totalMs);
    expect(dependencyCacheTimeLimit("not a date", now)).toBe(DEFAULT_TIMEOUTS.totalMs);
  });
});

describe("dependencyCacheBudget", () => {
  const MiB = 1024 * 1024;

  it("is diskMb minus what the workspace already uses minus max(64 MiB, 5%)", async () => {
    await writeFile(join(workspace, "big.bin"), Buffer.alloc(3 * MiB, 1));
    const budget = await dependencyCacheBudget({ workspace, diskMb: 2048 });
    expect(budget.reason).toBeUndefined();
    expect(budget.usedBytes).toBeGreaterThanOrEqual(3 * MiB);
    expect(budget.budgetBytes).toBe(2048 * MiB - budget.usedBytes! - Math.floor(2048 * MiB * 0.05));
    const small = await dependencyCacheBudget({ workspace, diskMb: 512 });
    expect(small.budgetBytes).toBe(512 * MiB - small.usedBytes! - 64 * MiB);
  });

  it("skips a volume too small to be worth it", async () => {
    expect(await dependencyCacheBudget({ workspace, diskMb: 64 })).toMatchObject({ reason: "budget_too_small" });
    await writeFile(join(workspace, "big.bin"), Buffer.alloc(80 * MiB, 1));
    const full = await dependencyCacheBudget({ workspace, diskMb: 200 });
    expect(full).toMatchObject({ reason: "budget_too_small" });
    expect(MIN_BUDGET_BYTES).toBe(64 * MiB);
  });

  it("is budget_unknown without a disk size, past its entry or time bound, or for a missing workspace", async () => {
    expect(await dependencyCacheBudget({ workspace, diskMb: undefined })).toEqual({ reason: "budget_unknown" });
    expect(await dependencyCacheBudget({ workspace, diskMb: 0 })).toEqual({ reason: "budget_unknown" });
    for (let i = 0; i < 5; i += 1) await writeFile(join(workspace, `f${i}`), "x");
    expect(await dependencyCacheBudget({ workspace, diskMb: 2048, maxEntries: 3 })).toEqual({
      reason: "budget_unknown",
    });
    expect(await dependencyCacheBudget({ workspace, diskMb: 2048, timeoutMs: 0 })).toEqual({
      reason: "budget_unknown",
    });
    expect(await dependencyCacheBudget({ workspace: join(root, "absent"), diskMb: 2048 })).toEqual({
      reason: "budget_unknown",
    });
  });

  it("counts links as entries without following them", async () => {
    await writeFile(join(root, "outside.bin"), Buffer.alloc(8 * MiB, 1));
    await symlink(join(root, "outside.bin"), join(workspace, "link"));
    const budget = await dependencyCacheBudget({ workspace, diskMb: 2048 });
    expect(budget.usedBytes).toBeLessThan(1 * MiB);
  });
});

describe("readRegularFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "readregular-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a regular file as bytes or text", async () => {
    await writeFile(join(dir, "a.json"), '{"a":1}');
    expect((await readRegularFile(join(dir, "a.json"), 100)).toString()).toBe('{"a":1}');
    expect(await readRegularFile(join(dir, "a.json"), 7, "utf8")).toBe('{"a":1}');
  });

  it("refuses a symlink", async () => {
    await writeFile(join(dir, "real.json"), "{}");
    await symlink(join(dir, "real.json"), join(dir, "link.json"));
    await expect(readRegularFile(join(dir, "link.json"), 100)).rejects.toThrow();
  });

  it("refuses a file over the size cap", async () => {
    await writeFile(join(dir, "big.json"), "x".repeat(101));
    await expect(readRegularFile(join(dir, "big.json"), 100)).rejects.toThrow();
  });

  it("refuses a directory", async () => {
    await mkdir(join(dir, "sub"));
    await expect(readRegularFile(join(dir, "sub"), 100)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- packing limit

describe("snapshot packing limit", () => {
  const MiB = 1024 * 1024;
  const timeouts = { tarMs: 300_000, tarMsPerMiB: 500 };

  it("ships a per-MiB packing rate", () => {
    expect(DEFAULT_TIMEOUTS.tarMs).toBe(300_000);
    expect(DEFAULT_TIMEOUTS.tarMsPerMiB).toBe(500);
  });

  it("grows with the installed tree", () => {
    expect(archiveLimit(timeouts, 0, undefined)).toEqual({ limit: "pack", limitMs: 300_000 });
    expect(archiveLimit(timeouts, 10 * MiB, undefined)).toEqual({ limit: "pack", limitMs: 305_000 });
    expect(archiveLimit(timeouts, 800 * MiB, undefined)).toEqual({ limit: "pack", limitMs: 700_000 });
  });

  it("never runs past the upload deadline", () => {
    const now = 1_000_000;
    expect(archiveLimit(timeouts, 800 * MiB, now + 400_000, now)).toEqual({ limit: "upload_window", limitMs: 400_000 });
    expect(archiveLimit(timeouts, 800 * MiB, now + 900_000, now)).toEqual({ limit: "pack", limitMs: 700_000 });
    expect(archiveLimit(timeouts, 0, now - 5, now)).toEqual({ limit: "upload_window", limitMs: 0 });
  });

  it("a packing timeout logs the stage, bytes, estimate, elapsed time and the limit that fired", async () => {
    env.FAKE_NPM_BIG = String(8 * MiB);
    const result = await prepare({ timeouts: { tarMs: 1, tarMsPerMiB: 0 } });
    expect(result).toMatchObject({ result: "cold" });
    expect(state.uploads).toHaveLength(0);
    const skipped = events.find((entry) => entry.event === "snapshot_skipped");
    expect(skipped).toMatchObject({ reason: "timeout", stage: "archive", limit: "pack", limitMs: 1 });
    expect(skipped?.writtenBytes).toEqual(expect.any(Number));
    expect(skipped?.estimateBytes).toEqual(expect.any(Number));
    expect(skipped?.elapsedMs).toEqual(expect.any(Number));
    expect(await cacheLeftovers()).toEqual([]);
    expect(await exists(join(workspace, "node_modules/beta/big.bin"))).toBe(true);
  });

  it("does not pack when the upload window has already passed", async () => {
    const { projects } = await prepareAll({ timeouts: { uploadWindowMs: 1, uploadMarginMs: 0 } });
    expect(projects[0]).toMatchObject({ result: "cold" });
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "upload_window_passed")).toBe(
      true,
    );
    expect(events.some((entry) => entry.event === "snapshot_skipped" && entry.reason === "timeout")).toBe(false);
  });
});
