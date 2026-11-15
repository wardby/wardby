import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectExclusions } from "../coding/collect-exclude.js";
import { deriveRegistryToken } from "../coding/registry/token.js";
import { capabilityHash } from "../providers/coding-proxy/capability-hash.js";
import { MemoryRelayStore } from "../providers/coding-proxy/substrate/memory-relay-store.js";
import { createSubstrateRoutes } from "../providers/coding-proxy/substrate/routes.js";
import type { ProxySession } from "../providers/coding-proxy/types.js";
import { codexWorkerSetup } from "../providers/jobs/codex-worker-setup.js";
import { BLOB, REPO_BLOB, substrateRunToken } from "../providers/jobs/substrate/names.js";
import type { JobSpec } from "../providers/jobs/types.js";
import { LocalBlobStore } from "../providers/storage/local.js";
import { run as runCodex, spawnCodexWorker, type CodexHandle } from "./codex.js";
import { INJECTED_MCP_TOKEN_PLACEHOLDER, PLACEHOLDER_CAPABILITY, WARM_ROUNDS_ENV } from "./constants.js";
import { DEFAULT_POLICY } from "./http.js";
import type { WorkerHandle } from "./worker-run.js";

const exec = promisify(execFile);
const FAKE_CAP = "rrp_fake_capability_value_000001";
const REGISTRY_TOKEN = deriveRegistryToken(FAKE_CAP);
const TOKEN = substrateRunToken("run-codex-1");
const FAST = { ...DEFAULT_POLICY, baseMs: 5, maxMs: 20, retryAfterCapMs: 20 };
const RELAY = /\/(channels|events)(\/|\?|$)/;

const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-codex-1",
  provider: "codex",
  image: `registry.example/wardby-substrate-codex@sha256:${"a".repeat(64)}`,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};

/** As in bridge.integration.test.ts: on bsdtar (macOS), drop the GNU-only flags. */
async function tarForTests(dir: string): Promise<string> {
  const version = await exec("tar", ["--version"]).then(
    (r) => r.stdout,
    () => "",
  );
  if (version.includes("GNU tar")) return "tar";
  const shim = join(dir, "tar-shim.mjs");
  await writeFile(
    shim,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2).filter((a) => a !== "--anchored" && a !== "--no-anchored" && a !== "--delay-directory-restore" && a !== "--no-overwrite-dir");
process.exit(spawnSync("tar", args, { stdio: "inherit" }).status ?? 1);
`,
    { mode: 0o755 },
  );
  return shim;
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Recorded {
  method: string;
  path: string;
  apiKey: string | undefined;
  /** The request's Authorization header, as sent (a cache request's registry token). */
  authorization?: string;
  /** The request's headers, as received. */
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const readAll = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe("Codex bridge, end to end without Substrate", () => {
  let dir: string;
  let proxy: Server;
  let proxyUrl: string;
  let requests: Recorded[];
  let files: Map<string, Buffer>;
  /** Runs when a request arrives, before it is answered (the workspace checks). */
  let onRequest: ((method: string, path: string) => Promise<void> | void) | undefined;
  let logs: string[];
  let handle: CodexHandle | undefined;
  let workspace: string;
  /** Extra headers on the fake proxy's `input` answer (harness parameter): the MCP flag. */
  let inputHeaders: Record<string, string>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codex-bridge-it-"));
    workspace = join(dir, "workspace");
    requests = [];
    files = new Map();
    onRequest = undefined;
    logs = [];
    inputHeaders = {};
    proxy = createHttpServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://fake.invalid");
        const prefix = `/substrate/runs/${TOKEN}/`;
        const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
        const method = request.method ?? "";
        const key = request.headers["x-api-key"];
        const body = await readAll(request);
        const authorization = request.headers.authorization;
        requests.push({
          method,
          path,
          apiKey: typeof key === "string" ? key : undefined,
          ...(typeof authorization === "string" ? { authorization } : {}),
          headers: request.headers,
          body,
        });
        await onRequest?.(method, path);
        if (RELAY.test(`/${path}`)) return response.writeHead(404).end('{"error":"not_found"}');
        // The cache's seal is checked by its own key, as the proxy does (dependency-cache/service.ts):
        // the worker's registry token in Authorization, which the agent's egress rule leaves as sent
        // (it replaces only X-Api-Key and the MCP header). Any other credential is refused.
        if (method === "POST" && path === "/cache/npm/seal") {
          if (authorization !== `Bearer ${REGISTRY_TOKEN}`) return response.writeHead(401).end();
          return response.writeHead(200, { "content-type": "application/json" }).end('{"sealed":true}');
        }
        if (key !== PLACEHOLDER_CAPABILITY) return response.writeHead(401).end();
        // An extra repository's seed (`files` key `repos/<name>/seed`) and its upload, as the proxy routes them.
        if (method === "GET" && /^repos\/[^/]+\/seed$/.test(path)) {
          const file = files.get(path);
          return file ? response.writeHead(200).end(file) : response.writeHead(404).end();
        }
        if (method === "POST" && /^repos\/[^/]+\/workspace$/.test(path)) {
          return response.writeHead(200, { "content-type": "application/json" }).end("{}");
        }
        if (method === "GET" && ["tool-setup", "seed", "input"].includes(path)) {
          const file = files.get(path);
          if (!file) return response.writeHead(404).end();
          // As the proxy does for a one-actor run: the first input download deletes the setup.
          if (path === "input") files.delete("tool-setup");
          return response.writeHead(200, path === "input" ? inputHeaders : {}).end(file);
        }
        if (method === "POST" && ["result", "workspace", "workspace-failed", "exit", "diagnostics"].includes(path)) {
          return response.writeHead(200, { "content-type": "application/json" }).end("{}");
        }
        response.writeHead(404).end();
      })();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    // A read extra was made read-only: writable again, so the folder can be removed.
    await makeWritable(join(dir, "repos"));
    await rm(dir, { recursive: true, force: true });
  });

  const log = (event: string, fields: Record<string, string | number> = {}): void => {
    logs.push(JSON.stringify({ event, ...fields }));
  };

  /** The seed (with paths the default and the spec's exclusions name), the input and the setup. */
  async function stage(setup: string): Promise<void> {
    const seedDir = join(dir, "seed");
    await mkdir(join(seedDir, "src", "skipped"), { recursive: true });
    await writeFile(join(seedDir, "src", "hello.txt"), "hello from the seed\n");
    await writeFile(join(seedDir, "src", "skipped", "big.bin"), "excluded by path\n");
    await mkdir(join(seedDir, "node_modules"), { recursive: true });
    await writeFile(join(seedDir, "node_modules", "dep.js"), "skip me\n");
    await exec("tar", ["-c", "-C", seedDir, "-f", join(dir, "seed.tar"), "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    files.set("tool-setup", Buffer.from(setup));
    files.set("seed", await readFile(join(dir, "seed.tar")));
    files.set("input", Buffer.from(JSON.stringify({ task: "do the thing" })));
  }

  const names = async (name = `${TOKEN}-agent`): Promise<string> => {
    const metadata = join(dir, "meta");
    await mkdir(metadata, { recursive: true });
    await writeFile(join(metadata, "name"), `${name}\n`);
    return metadata;
  };

  const resultPath = (): string => join(dir, "out", "result.json");

  async function start(
    launchWorker: (env: NodeJS.ProcessEnv, secrets: () => readonly string[]) => WorkerHandle,
    metadataDir?: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ) {
    await mkdir(join(dir, "out"), { recursive: true });
    return runCodex({
      proxyUrl,
      env: { PATH: process.env.PATH, [WARM_ROUNDS_ENV]: "1", ...extraEnv },
      metadataDir: metadataDir ?? (await names()),
      workspace,
      reposRoot: join(dir, "repos"),
      tempRoot: dir,
      tarCommand: await tarForTests(dir),
      readyPort: 0,
      inputPath: join(dir, "in", "input.json"),
      resultPath: resultPath(),
      policy: FAST,
      log,
      launchWorker,
    });
  }

  const posted = (path: string): Recorded[] => requests.filter((r) => r.method === "POST" && r.path === path);
  const order = (): string[] => requests.map((r) => `${r.method} ${r.path}`);

  async function workspaceEntries(): Promise<string[]> {
    const tarPath = join(dir, "check.tar");
    await writeFile(tarPath, posted("workspace")[0].body);
    return (await exec("tar", ["-t", "-f", tarPath])).stdout.split("\n").filter(Boolean);
  }

  const forbidden = [FAKE_CAP, REGISTRY_TOKEN, JSON.stringify(REGISTRY_TOKEN).slice(1, -1)];

  /** A seed tar of `files` (paths relative to its root), built in `folder`. */
  async function tarOf(folder: string, contents: Record<string, string>): Promise<Buffer> {
    for (const [path, text] of Object.entries(contents)) {
      await mkdir(join(folder, path, ".."), { recursive: true });
      await writeFile(join(folder, path), text);
    }
    await exec("tar", ["-c", "-C", folder, "-f", `${folder}.tar`, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return readFile(`${folder}.tar`);
  }

  describe("extra repositories", () => {
    const repos = (...parts: string[]) => join(dir, "repos", ...parts);
    const extrasSetup = () =>
      codexWorkerSetup(spec, FAKE_CAP, {
        collectResultBundle: false,
        repositories: [
          { name: "extra-alpha", access: "write" },
          { name: "extra-beta", access: "read" },
        ],
      });
    const stageExtras = async (which: ("extra-alpha" | "extra-beta")[] = ["extra-alpha", "extra-beta"]) => {
      const contents = { "extra-alpha": { "a.txt": "alpha\n" }, "extra-beta": { "b.txt": "beta\n" } };
      for (const name of which) files.set(`repos/${name}/seed`, await tarOf(join(dir, `seed-${name}`), contents[name]));
    };

    it("seeds extras after the workspace and before the input, and uploads writable ones before the workspace", async () => {
      await stage(extrasSetup());
      await stageExtras();
      let workerEnv: NodeJS.ProcessEnv | undefined;
      let atLaunch: boolean[] | undefined;
      handle = await start((env) => {
        workerEnv = env;
        atLaunch = [existsSync(repos("extra-alpha", "a.txt")), existsSync(repos("extra-beta", "b.txt"))];
        return {
          exited: (async () => {
            await writeFile(repos("extra-alpha", "made.txt"), "made\n");
            await writeFile(resultPath(), JSON.stringify({ summary: "done" }));
            return 0;
          })(),
        };
      });
      expect(await handle.collected).toBe("ok");
      expect(order()).toEqual([
        "GET tool-setup",
        "GET seed",
        "GET repos/extra-alpha/seed",
        "GET repos/extra-beta/seed",
        "GET input",
        "POST result",
        "POST repos/extra-alpha/workspace",
        "POST workspace",
      ]);
      expect(atLaunch).toEqual([true, true]);
      expect(workerEnv).toMatchObject({
        WARDBY_RUN_CAPABILITY: PLACEHOLDER_CAPABILITY,
        WARDBY_CAPABILITY_HEADER: "x-api-key",
        WARDBY_REGISTRY_TOKEN: REGISTRY_TOKEN,
        WARDBY_PROXY_URL: proxyUrl,
      });
      if (process.getuid?.() !== 0) {
        expect(statSync(repos("extra-beta", "b.txt")).mode & 0o777).toBe(0o444);
        expect(statSync(repos("extra-beta")).mode & 0o777).toBe(0o555);
      }
      const tarPath = join(dir, "check-alpha.tar");
      await writeFile(tarPath, posted("repos/extra-alpha/workspace")[0].body);
      const entries = (await exec("tar", ["-t", "-f", tarPath])).stdout.split("\n").filter(Boolean);
      expect(entries).toEqual(expect.arrayContaining(["./a.txt", "./made.txt"]));
      for (const value of forbidden) expect(logs.join("\n")).not.toContain(value);
    });

    it("names protocol 1 on every extra-repository request", async () => {
      await stage(extrasSetup());
      await stageExtras();
      handle = await start(() => ({
        exited: (async () => {
          await writeFile(repos("extra-alpha", "made.txt"), "made\n");
          await writeFile(resultPath(), JSON.stringify({ summary: "done" }));
          return 0;
        })(),
      }));
      expect(await handle.collected).toBe("ok");
      expect(order()).toContain("POST repos/extra-alpha/workspace");
      for (const request of requests) expect(request.headers["x-wardby-bridge-protocol"]).toBe("1");
    });

    it("a failed extra seed fails the run before the worker starts", async () => {
      await stage(extrasSetup());
      await stageExtras(["extra-alpha"]);
      let launched = false;
      await expect(
        start(() => {
          launched = true;
          return { exited: Promise.resolve(0) };
        }),
      ).rejects.toMatchObject({ code: "substrate_bridge_seed_failed" });
      expect(launched).toBe(false);
      expect(order().slice(-2)).toEqual(["POST workspace-failed", "POST exit"]);
      expect(order()).not.toContain("GET input");
    });
  });

  it("fetches setup, seed and input in order, runs the worker in header mode, then uploads result and workspace", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    let workerEnv: NodeJS.ProcessEnv | undefined;
    let requestsAtLaunch = -1;
    handle = await start((env) => {
      workerEnv = env;
      requestsAtLaunch = requests.length;
      return {
        exited: (async () => {
          await writeFile(join(workspace, "made-by-worker.txt"), "the worker's change\n");
          await writeFile(resultPath(), JSON.stringify({ summary: "done" }));
          return 0;
        })(),
      };
    });
    expect(await handle.collected).toBe("ok");
    expect(await handle.workerExited).toBe(0);
    expect(order()).toEqual(["GET tool-setup", "GET seed", "GET input", "POST result", "POST workspace"]);
    // The registry token was in hand (setup read) before the input, and the worker started after it.
    expect(requestsAtLaunch).toBe(3);
    for (const request of requests) expect(request.apiKey).toBe(PLACEHOLDER_CAPABILITY);
    expect(requests.some((r) => RELAY.test(`/${r.path}`))).toBe(false);
    expect(workerEnv).toMatchObject({
      WARDBY_RUN_CAPABILITY: PLACEHOLDER_CAPABILITY,
      WARDBY_CAPABILITY_HEADER: "x-api-key",
      WARDBY_REGISTRY_TOKEN: REGISTRY_TOKEN,
      WARDBY_PROXY_URL: proxyUrl,
    });
    expect(JSON.stringify(workerEnv)).not.toContain(FAKE_CAP);
    expect(JSON.parse(posted("result")[0].body.toString())).toEqual({ summary: "done" });
    const entries = await workspaceEntries();
    expect(entries).toContain("./src/hello.txt");
    expect(entries).toContain("./made-by-worker.txt");
    // No warm rounds for Codex, whatever the template's env says.
    expect(requests.filter((r) => r.path.startsWith("input"))).toHaveLength(1);
    for (const value of forbidden) expect(logs.join("\n")).not.toContain(value);
  });

  it("names protocol 1 on every request", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    handle = await start(() => ({
      exited: (async () => {
        await writeFile(resultPath(), JSON.stringify({ summary: "done" }));
        return 0;
      })(),
    }));
    expect(await handle.collected).toBe("ok");
    expect(order()).toEqual(["GET tool-setup", "GET seed", "GET input", "POST result", "POST workspace"]);
    for (const request of requests) expect(request.headers["x-wardby-bridge-protocol"]).toBe("1");
  });

  it("names protocol 1 on every request of a failed run (diagnostics and exit)", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    handle = await start(() => {
      // A stderr line, so the bridge really posts a diagnostics tail.
      const stderr = new PassThrough();
      return {
        stderr,
        exited: (async () => {
          stderr.write("worker failed\n");
          stderr.end();
          return 3;
        })(),
      };
    });
    await handle.collected;
    expect(order()).toContain("POST diagnostics");
    expect(order()).toContain("POST exit");
    for (const request of requests) expect(request.headers["x-wardby-bridge-protocol"]).toBe("1");
  });

  it("passes a cache run's input and registry token through unchanged", async () => {
    await stage(codexWorkerSetup({ ...spec, dependencyCache: true }, FAKE_CAP, { collectResultBundle: false }));
    files.set("input", Buffer.from(JSON.stringify({ task: "do the thing", dependencyCache: true, diskMb: 2048 })));
    let workerInput: unknown;
    let sealStatus = 0;
    handle = await start((env) => ({
      exited: (async () => {
        workerInput = JSON.parse(await readFile(join(dir, "in", "input.json"), "utf8"));
        const sealed = await fetch(new URL("/cache/npm/seal", env.WARDBY_PROXY_URL), {
          method: "POST",
          headers: { authorization: `Bearer ${env.WARDBY_REGISTRY_TOKEN}` },
        });
        sealStatus = sealed.status;
        await sealed.arrayBuffer();
        await writeFile(resultPath(), JSON.stringify({ summary: "done" }));
        return 0;
      })(),
    }));
    expect(await handle.collected).toBe("ok");
    expect(await handle.workerExited).toBe(0);
    expect(workerInput).toEqual({ task: "do the thing", dependencyCache: true, diskMb: 2048 });
    expect(sealStatus).toBe(200);
    const seals = requests.filter((r) => r.method === "POST" && r.path === "/cache/npm/seal");
    expect(seals).toHaveLength(1);
    expect(seals[0].authorization).toBe(`Bearer ${REGISTRY_TOKEN}`);
    // The seal is the worker's own cache request, not a bridge request; every bridge request names protocol 1.
    for (const request of requests.filter((r) => !r.path.startsWith("/cache/"))) {
      expect(request.headers["x-wardby-bridge-protocol"]).toBe("1");
    }
    for (const value of forbidden) expect(logs.join("\n")).not.toContain(value);
  });

  it("on a failure posts a redacted diagnostics tail, then the exit report, then still the workspace", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    handle = await start(() => {
      const stderr = new PassThrough();
      return {
        stderr,
        exited: (async () => {
          stderr.write(`proxy said no to ${PLACEHOLDER_CAPABILITY}\n`);
          stderr.write(`npm used ${REGISTRY_TOKEN}\n`);
          stderr.write(`${JSON.stringify({ config: { token: REGISTRY_TOKEN } })}\n`);
          stderr.write('{"error":"worker_execution_failed"}\n');
          stderr.end();
          return 1;
        })(),
      };
    });
    expect(await handle.collected).toBe("ok");
    expect(order()).toEqual([
      "GET tool-setup",
      "GET seed",
      "GET input",
      "POST diagnostics",
      "POST exit",
      "POST workspace",
    ]);
    const tail = posted("diagnostics")[0].body.toString();
    expect(tail).toContain("[redacted]");
    expect(tail).toContain("proxy said no to [redacted]");
    expect(tail).toContain("npm used [redacted]");
    expect(tail).toContain('{"error":"worker_execution_failed"}');
    for (const value of [...forbidden, PLACEHOLDER_CAPABILITY]) expect(tail).not.toContain(value);
    expect(JSON.parse(posted("exit")[0].body.toString())).toEqual({ code: 1, diagnostic: "worker_execution_failed" });
    for (const value of [...forbidden, PLACEHOLDER_CAPABILITY]) expect(logs.join("\n")).not.toContain(value);
  });

  describe("MCP tools", () => {
    const launched = async (extraEnv: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> => {
      await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
      let workerEnv: NodeJS.ProcessEnv | undefined;
      handle = await start(
        (env) => {
          workerEnv = env;
          return { exited: writeFile(resultPath(), "{}").then(() => 0) };
        },
        undefined,
        extraEnv,
      );
      expect(await handle.collected).toBe("ok");
      return workerEnv!;
    };

    it("starts the worker in MCP header mode when the input answer has the flag", async () => {
      inputHeaders = { "x-wardby-mcp-tools": "1" };
      const env = await launched();
      expect(env.WARDBY_MCP_TOKEN).toBe("rmt_placeholder_injected_by_gateway");
      expect(env.WARDBY_MCP_TOKEN_HEADER).toBe("x-wardby-mcp-token");
      expect(env.WARDBY_CAPABILITY_HEADER).toBe("x-api-key");
    });

    it.each([
      ["no flag", {}],
      ["a flag other than 1", { "x-wardby-mcp-tools": "0" }],
    ])("with %s the worker gets neither variable, even a stale one the bridge's env held", async (_label, headers) => {
      inputHeaders = headers;
      const env = await launched({ WARDBY_MCP_TOKEN: "rmt_STALE_FAKE_NOT_REAL", WARDBY_MCP_TOKEN_HEADER: "x" });
      expect(env).not.toHaveProperty("WARDBY_MCP_TOKEN");
      expect(env).not.toHaveProperty("WARDBY_MCP_TOKEN_HEADER");
      expect(JSON.stringify(env)).not.toContain("rmt_STALE_FAKE_NOT_REAL");
    });

    it("redacts the MCP placeholder from the diagnostics tail and the passed-on output", async () => {
      inputHeaders = { "x-wardby-mcp-tools": "1" };
      await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
      const entry = join(dir, "mcp-worker.mjs");
      await writeFile(
        entry,
        `process.stderr.write("mcp header " + process.env.WARDBY_MCP_TOKEN + "\\n");\nsetTimeout(() => process.exit(1), 20);\n`,
      );
      let passedOn = "";
      const sink = { write: (text: string) => void (passedOn += text) };
      // The bridge's own secrets list, as its default launcher gets it.
      handle = await start((env, secrets) => spawnCodexWorker(env, secrets, entry, { stdout: sink, stderr: sink }));
      expect(await handle.collected).toBe("ok");
      const tail = posted("diagnostics")[0].body.toString();
      expect(tail).toContain("mcp header [redacted]");
      expect(tail).not.toContain(INJECTED_MCP_TOKEN_PLACEHOLDER);
      await waitFor(() => (passedOn.includes("mcp header") ? true : undefined));
      expect(passedOn).toContain("mcp header [redacted]");
      expect(passedOn).not.toContain(INJECTED_MCP_TOKEN_PLACEHOLDER);
      expect(logs.join("\n")).not.toContain(INJECTED_MCP_TOKEN_PLACEHOLDER);
    });
  });

  it("ends the worker's whole process group before the workspace is read", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    const fixture = join(dir, "worker-fixture.mjs");
    const pidFile = join(dir, "grandchild.pid");
    const late = join(workspace, "late.txt");
    // The grandchild ignores SIGTERM, so only the group's SIGKILL ends it.
    await writeFile(
      fixture,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const script = 'process.on("SIGTERM", () => {}); const fs = require("node:fs"); setInterval(() => fs.appendFileSync(${JSON.stringify(late)}, "x"), 5);';
const grandchild = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setTimeout(() => {
  writeFileSync(${JSON.stringify(resultPath())}, "{}");
  process.exit(0);
}, 150);
`,
    );
    let atWorkspace: { alive: boolean; size: number } | undefined;
    onRequest = async (method, path) => {
      if (method !== "POST" || path !== "workspace") return;
      const pid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      atWorkspace = { alive, size: (await stat(late)).size };
    };
    handle = await start((env) => {
      const child = spawn(process.execPath, [fixture], { env, detached: true, stdio: "ignore" });
      return {
        pid: child.pid,
        child,
        exited: new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? 1))),
      };
    });
    expect(await handle.collected).toBe("ok");
    expect(atWorkspace?.alive).toBe(false);
    const tarPath = join(dir, "check.tar");
    await writeFile(tarPath, posted("workspace")[0].body);
    const inTar = (await exec("tar", ["-x", "-O", "-f", tarPath, "./late.txt"])).stdout.length;
    expect(inTar).toBeGreaterThan(0);
    expect(inTar).toBeLessThanOrEqual(atWorkspace!.size);
    // Nothing writes to it any more.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await stat(late)).size).toBe(atWorkspace!.size);
  });

  it("leaves the setup's excluded names and paths out of the workspace", async () => {
    await stage(
      codexWorkerSetup({ ...spec, collectExclude: collectExclusions(["src/skipped"]) }, FAKE_CAP, {
        collectResultBundle: false,
      }),
    );
    handle = await start(() => ({
      exited: writeFile(resultPath(), "{}").then(() => 0),
    }));
    expect(await handle.collected).toBe("ok");
    const entries = await workspaceEntries();
    expect(entries).toContain("./src/hello.txt");
    expect(entries.some((entry) => entry.includes("node_modules"))).toBe(false);
    expect(entries.some((entry) => entry.includes("src/skipped"))).toBe(false);
  });

  /** A worker that leaves a root .git (history, objects, and optionally the result bundle) and exits 2. */
  const historyWorker = (bundle: "file" | "symlink") => (): WorkerHandle => ({
    exited: (async () => {
      await mkdir(join(workspace, ".git", "objects", "ab"), { recursive: true });
      await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(workspace, ".git", "objects", "ab", "cdef"), "a history object\n");
      await writeFile(join(dir, "outside.bundle"), "not the run's bundle\n");
      if (bundle === "file") await writeFile(join(workspace, ".git", "wardby-result.bundle"), "the result bundle\n");
      else await symlink(join(dir, "outside.bundle"), join(workspace, ".git", "wardby-result.bundle"));
      return 2;
    })(),
  });

  it("uploads only the result bundle from .git on a git-history run", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: true }));
    handle = await start(historyWorker("file"));
    expect(await handle.collected).toBe("ok");
    const entries = await workspaceEntries();
    expect(entries.filter((entry) => entry.includes(".git"))).toEqual(["./.git/wardby-result.bundle"]);
    expect(entries).toContain("./src/hello.txt");
  });

  it("fails the workspace on a symlinked result bundle, after the exit report", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: true }));
    handle = await start(historyWorker("symlink"));
    expect(await handle.collected).toBe("failed");
    expect(posted("workspace")).toHaveLength(0);
    expect(order().slice(-2)).toEqual(["POST exit", "POST workspace-failed"]);
    expect(logs.some((l) => l.includes("result_bundle_tampered"))).toBe(true);
  });

  for (const [what, setup] of [
    [
      "a registry token that is not rrg_-shaped",
      JSON.stringify({ schemaVersion: 1, registryToken: "rrg_short", collectExclude: collectExclusions([]) }),
    ],
    [
      "another schema version",
      JSON.stringify({
        ...JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false })),
        schemaVersion: 2,
      }),
    ],
    [
      "a collectResultBundle that is not true",
      JSON.stringify({
        ...JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false })),
        collectResultBundle: "yes",
      }),
    ],
    ["setup that is not JSON", `not json ${REGISTRY_TOKEN}`],
  ] as const) {
    it(`never launches the worker on ${what}, and fails the run`, async () => {
      await stage(setup);
      let launched = false;
      await expect(
        start(() => {
          launched = true;
          return { exited: Promise.resolve(0) };
        }),
      ).rejects.toMatchObject({ code: "substrate_bridge_setup_invalid" });
      expect(launched).toBe(false);
      expect(order()).toEqual(["GET tool-setup", "POST workspace-failed", "POST exit"]);
      expect(JSON.parse(posted("exit")[0].body.toString())).toEqual({ code: 1 });
      const logged = logs.join("\n");
      expect(logged).not.toContain(setup);
      for (const value of ["rrg_short", ...forbidden]) expect(logged).not.toContain(value);
    });
  }

  it("touches nothing on the network while its name is a golden actor's", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    const metadata = await names("d0275793-6b1a-4c1e-9f3e-0123456789ab");
    let readyPort: number | undefined;
    await mkdir(join(dir, "out"), { recursive: true });
    const started = runCodex({
      proxyUrl,
      metadataDir: metadata,
      workspace,
      tempRoot: dir,
      tarCommand: await tarForTests(dir),
      readyPort: 0,
      inputPath: join(dir, "in", "input.json"),
      resultPath: resultPath(),
      identityPollMs: 10,
      policy: FAST,
      log,
      onReady: (port) => {
        readyPort = port;
      },
      launchWorker: () => ({ exited: new Promise<number>(() => undefined) }),
    });
    const port = await waitFor(() => readyPort);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    await waitFor(() => (logs.some((l) => l.includes("substrate_bridge_waiting_for_identity")) ? true : undefined));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toEqual([]);
    await writeFile(join(metadata, "name"), `${TOKEN}-agent\n`);
    handle = await started;
    expect(handle.runToken).toBe(TOKEN);
    expect(order()).toEqual(["GET tool-setup", "GET seed", "GET input"]);
  });

  it("refuses a tool actor's name", async () => {
    await stage(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    await expect(start(() => ({ exited: Promise.resolve(0) }), await names(`${TOKEN}-tool`))).rejects.toMatchObject({
      code: "substrate_bridge_identity_invalid",
    });
    expect(requests).toEqual([]);
  });

  it("runs against the proxy's own routes for a one-actor run", async () => {
    // Swap the fake for the real routes, with this run single-shape.
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    // The run's row (the relay store's record of it) exists from launch, as with every Substrate run.
    const relay = new MemoryRelayStore();
    relay.register(TOKEN, 1 << 20);
    const routeLogs: unknown[] = [];
    const PINS: ProxySession["mcpTools"] = [
      {
        exposedName: "docs__search",
        toolName: "search",
        serverId: "server-1",
        serverName: "docs",
        definition: { description: "d", inputSchema: { type: "object" } },
      },
    ];
    const routes = createSubstrateRoutes({
      atespace: "wardby-runs",
      relay,
      blobs,
      ledger: {
        findSessionByCapabilityHash: async (hash) =>
          hash === capabilityHash(PLACEHOLDER_CAPABILITY)
            ? ({
                runId: "run-codex-1",
                deadlineAt: new Date(Date.now() + 60_000),
                status: "active",
                mcpTools: PINS,
              } as ProxySession)
            : null,
      },
      verifyActor: async () => ({ ok: false, code: "invalid" }),
      tokenForRun: substrateRunToken,
      runLayoutForToken: async () => ({ shape: "single", repositories: [{ name: "extra-alpha", access: "write" }] }),
      limits: { resultBytes: 1 << 20, transcriptBytes: 1 << 20, workspaceBytes: 1 << 24 },
      pollWaitMs: 200,
      log: { info: (...args) => void routeLogs.push(args), warn: (...args) => void routeLogs.push(args) },
    });
    proxy = createHttpServer((req, res) => void routes(req, res));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    // The run has one writable extra: its seed is staged, and its upload lands in its own blob.
    await stage(
      codexWorkerSetup(spec, FAKE_CAP, {
        collectResultBundle: false,
        repositories: [{ name: "extra-alpha", access: "write" }],
      }),
    );
    for (const [key, name] of [
      [BLOB.toolSetup(TOKEN), "tool-setup"],
      [BLOB.seed(TOKEN), "seed"],
      [BLOB.input(TOKEN), "input"],
    ] as const)
      await blobs.put(key, files.get(name)!);
    await blobs.put(REPO_BLOB.seed(TOKEN, "extra-alpha"), await tarOf(join(dir, "seed-alpha"), { "a.txt": "alpha\n" }));
    let workerEnv: NodeJS.ProcessEnv | undefined;
    handle = await start((env) => {
      workerEnv = env;
      return { exited: writeFile(resultPath(), '{"summary":"done"}').then(() => 0) };
    });
    expect(await handle.collected).toBe("ok");
    // The run's session has MCP tools: the real input answer turned header mode on.
    expect(workerEnv?.WARDBY_MCP_TOKEN).toBe(INJECTED_MCP_TOKEN_PLACEHOLDER);
    expect(workerEnv?.WARDBY_MCP_TOKEN_HEADER).toBe("x-wardby-mcp-token");
    expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
    expect((await blobs.get(BLOB.result(TOKEN))).toString()).toBe('{"summary":"done"}');
    expect(await blobs.head(BLOB.toolSetup(TOKEN))).toBeFalsy();
    expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeTruthy();
    expect(JSON.stringify(routeLogs)).not.toContain(REGISTRY_TOKEN);
  });
});

/** Makes every folder under `root` writable again (a read extra was made read-only); absent is fine. */
async function makeWritable(root: string): Promise<void> {
  const metadata = await lstat(root).catch(() => undefined);
  if (!metadata?.isDirectory()) return;
  await chmod(root, 0o755);
  for (const name of await readdir(root)) await makeWritable(join(root, name));
}
