import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REGISTRY_ADAPTERS } from "../../../../src/coding/registry/adapters.js";
import { OsvAudit } from "../../../../src/providers/coding-proxy/registry/audit.js";
import { createSimServer, simRequest, type SimServer } from "../server.js";
import { sha256Hex, sha512Sri } from "./archive.js";
import { createNpmService } from "./npm.js";
import { createOsvService } from "./osv.js";
import { createPypiServices } from "./pypi.js";

const has = (bin: string, args = ["--version"]) => {
  try {
    execFileSync(bin, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

let sim: SimServer;
let base: string;
let work: string;
const script = async (steps: Record<string, unknown>[]) => {
  const response = await sim.dispatch(simRequest("POST", "/__sim/script", { steps }));
  const body = JSON.parse(String(response.body)) as { results: any[]; error?: string; message?: string };
  if (response.status !== 200) throw new Error(`${body.error} ${body.message ?? ""}`);
  return body.results;
};
const get = async (path: string, accept?: string) => {
  const response = await fetch(`${base}${path}`, accept ? { headers: { accept } } : {});
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    bytes: Buffer.from(await response.arrayBuffer()),
  };
};
const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(
      cmd,
      args,
      { cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env }, timeout: 120_000 },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, out: `${stdout}\n${stderr}` }),
    ),
  );

beforeEach(async () => {
  sim = createSimServer({ services: [createNpmService(), ...createPypiServices(), createOsvService()] });
  base = await sim.listen();
  work = mkdtempSync(join(tmpdir(), "wardby-sim-registry-"));
});
afterEach(async () => {
  await sim.close();
  rmSync(work, { recursive: true, force: true });
});

describe("npm sim", () => {
  beforeEach(async () => {
    await script([
      {
        action: "npm.package",
        name: "left-pad",
        versions: { "1.0.0": { published: "2024-01-01T00:00:00.000Z" }, "1.1.0": { deps: { "@acme/util": "^2.0.0" } } },
      },
      { action: "npm.package", name: "@acme/util", versions: { "2.0.0": {} } },
    ]);
  });

  it("serves a packument with times, dist-tags and the real tarball's integrity", async () => {
    const doc = JSON.parse((await get("/npm/left-pad")).bytes.toString());
    expect(doc["dist-tags"]).toEqual({ latest: "1.1.0" });
    expect(doc.time).toMatchObject({
      "1.0.0": "2024-01-01T00:00:00.000Z",
      "1.1.0": "2025-01-01T00:00:00.000Z",
      created: "2024-01-01T00:00:00.000Z",
    });
    const tarball = await get("/npm/left-pad/-/left-pad-1.1.0.tgz");
    expect(doc.versions["1.1.0"].dist).toMatchObject({
      integrity: sha512Sri(tarball.bytes),
      tarball: "https://registry.npmjs.org/left-pad/-/left-pad-1.1.0.tgz",
    });
    const scoped = JSON.parse((await get("/npm/@acme%2futil")).bytes.toString());
    expect(scoped.versions["2.0.0"].dist.tarball).toBe("https://registry.npmjs.org/@acme/util/-/util-2.0.0.tgz");
    expect((await get("/npm/@acme/util/-/util-2.0.0.tgz")).status).toBe(200);
    expect((await get("/npm/nope")).status).toBe(404);
    expect((await get("/npm/left-pad/9.9.9")).status).toBe(404);
  });

  it("deprecates, re-times and publishes mid-scenario", async () => {
    await script([
      { action: "npm.deprecate", name: "left-pad", version: "1.0.0", message: "use 1.1" },
      { action: "npm.set_time", name: "left-pad", version: "1.1.0", published: "2099-01-01T00:00:00.000Z" },
      { action: "npm.publish", name: "left-pad", version: "1.2.0" },
    ]);
    const doc = JSON.parse((await get("/npm/left-pad")).bytes.toString());
    expect(doc.versions["1.0.0"].deprecated).toBe("use 1.1");
    expect(doc.time["1.1.0"]).toBe("2099-01-01T00:00:00.000Z");
    expect(Date.parse(doc.time["1.2.0"])).toBeGreaterThan(Date.now() - 60_000);
  });

  for (const [client, args] of [
    ["npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"]],
    ["pnpm", ["install", "--ignore-scripts"]],
    ["yarn", ["install", "--ignore-scripts", "--non-interactive"]],
  ] as const) {
    it.skipIf(!has(client))(
      `${client} installs the real tarballs, integrity checked`,
      async () => {
        await script([{ action: "npm.self_tarballs", base }]);
        writeFileSync(
          join(work, "package.json"),
          JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "left-pad": "1.1.0" } }),
        );
        const registry = `${base}/npm/`;
        writeFileSync(join(work, ".npmrc"), `registry=${registry}\n`);
        writeFileSync(join(work, ".yarnrc"), `registry "${registry}"\n`);
        const result = await run(client, [...args, `--registry=${registry}`], work, {
          npm_config_registry: registry,
          npm_config_cache: join(work, ".cache"),
          npm_config_store_dir: join(work, ".store"),
          YARN_CACHE_FOLDER: join(work, ".yarn-cache"),
        });
        expect(result.code, result.out).toBe(0);
        expect(readFileSync(join(work, "node_modules/left-pad/package.json"), "utf8")).toContain('"version": "1.1.0"');
        // pnpm keeps transitive packages under node_modules/.pnpm.
        const util =
          client === "pnpm"
            ? "node_modules/.pnpm/@acme+util@2.0.0/node_modules/@acme/util/index.js"
            : "node_modules/@acme/util/index.js";
        expect(existsSync(join(work, util))).toBe(true);
      },
      180_000,
    );
  }
});

describe("PyPI sim", () => {
  beforeEach(async () => {
    await script([
      {
        action: "pypi.project",
        name: "Sim_Requests",
        releases: {
          "2.0.0": {
            requires: ["sim-idna>=1.0", 'sim-extra-dep; extra == "socks"'],
            extras: ["socks"],
            uploaded: "2024-05-01T00:00:00Z",
          },
          "3.0.0": { uploaded: "2099-01-01T00:00:00Z" },
          "1.0.0": { sdistOnly: true },
        },
      },
      { action: "pypi.project", name: "sim-idna", releases: { "1.0": {} } },
    ]);
  });

  it("serves PEP 691 JSON or PEP 503 HTML by Accept, with normalized names and file sha256", async () => {
    const jsonIndex = await get("/pypi/simple/sim-requests/", "application/vnd.pypi.simple.v1+json");
    const doc = JSON.parse(jsonIndex.bytes.toString());
    expect(jsonIndex.type).toContain("application/vnd.pypi.simple.v1+json");
    expect(doc.meta["api-version"]).toBe("1.1");
    expect(doc.files.map((f: any) => f.filename)).toEqual([
      "Sim_Requests-2.0.0-py3-none-any.whl",
      "Sim_Requests-2.0.0.tar.gz",
      "Sim_Requests-3.0.0-py3-none-any.whl",
      "Sim_Requests-3.0.0.tar.gz",
      "Sim_Requests-1.0.0.tar.gz",
    ]);
    const wheel = await get(new URL(doc.files[0].url).pathname.replace("/packages", "/pypi-files/packages"));
    expect(doc.files[0].hashes.sha256).toBe(sha256Hex(wheel.bytes));
    const html = (await get("/pypi/simple/sim_requests/")).bytes.toString();
    expect(html).toContain(`#sha256=${sha256Hex(wheel.bytes)}`);
    const release = JSON.parse((await get("/pypi/pypi/Sim_Requests/2.0.0/json")).bytes.toString());
    expect(release.info.requires_dist).toContain('sim-extra-dep; extra == "socks"');
    expect(release.info.provides_extra).toEqual(["socks"]);
    expect((await get("/pypi-files/packages/ab/cd/nope.whl")).status).toBe(404);
  });

  it("escapes data-requires-python and file names in the PEP 503 HTML page", async () => {
    await script([
      {
        action: "pypi.project",
        name: "sim-quoted",
        releases: { "1.0": { requiresPython: '>=3.8" onmouseover="x' } },
      },
    ]);
    const html = (await get("/pypi/simple/sim-quoted/")).bytes.toString();
    expect(html).toContain('data-requires-python="&gt;=3.8&quot; onmouseover=&quot;x"');
    expect(html).not.toContain('" onmouseover="');
  });

  it.skipIf(!has("python3", ["-m", "pip", "--version"]))(
    "pip installs a real wheel and its dependency, hashes checked",
    async () => {
      await script([{ action: "pypi.self_files", base }]);
      const result = await run(
        "python3",
        [
          "-m",
          "pip",
          "install",
          "--no-cache-dir",
          "--disable-pip-version-check",
          "--target",
          join(work, "site"),
          "--index-url",
          `${base}/pypi/simple/`,
          "sim-requests==2.0.0",
        ],
        work,
        { PIP_CONFIG_FILE: "/dev/null" },
      );
      expect(result.code, result.out).toBe(0);
      // The wheel keeps the project's own spelling (Sim_Requests): exact case, since Linux filesystems are case-sensitive.
      expect(readFileSync(join(work, "site/Sim_Requests/__init__.py"), "utf8")).toContain('"2.0.0"');
      expect(existsSync(join(work, "site/sim_idna/__init__.py"))).toBe(true);
    },
    180_000,
  );
});

describe("OSV sim through wardby's own OSV audit", () => {
  it("answers query, querybatch and vulns; an outage is a fault", async () => {
    await script([
      {
        action: "osv.advisory",
        id: "GHSA-sim-0001",
        ecosystem: "npm",
        package: "left-pad",
        introduced: "0",
        fixed: "1.1.0",
        severity: "HIGH",
        summary: "bad pad",
      },
      { action: "osv.advisory", id: "MAL-2026-1", ecosystem: "PyPI", package: "evil", versions: ["0.1"] },
    ]);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/osv${path}`, { method: "POST", body: JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, json: response.ok ? JSON.parse(text) : text };
    };
    expect(
      (await post("/v1/query", { package: { name: "left-pad", ecosystem: "npm" }, version: "1.0.5" })).json.vulns[0].id,
    ).toBe("GHSA-sim-0001");
    expect(
      (await post("/v1/query", { package: { name: "left-pad", ecosystem: "npm" }, version: "1.1.0" })).json,
    ).toEqual({});
    const batch = await post("/v1/querybatch", {
      queries: [
        { package: { name: "left-pad", ecosystem: "npm" }, version: "1.0.0" },
        { package: { name: "evil", ecosystem: "PyPI" }, version: "0.1" },
        { package: { name: "fine", ecosystem: "npm" }, version: "1.0.0" },
      ],
    });
    expect(batch.json.results.map((r: any) => r.vulns?.[0]?.id ?? null)).toEqual(["GHSA-sim-0001", "MAL-2026-1", null]);
    expect((await fetch(`${base}/osv/v1/vulns/NOPE`)).status).toBe(404);

    // wardby's real audit, its OSV requests sent to the simulator.
    const fetchAdapter = (async (
      url: string,
      init: { accept?: string; method?: string; body?: string; signal?: AbortSignal } = {},
    ) =>
      fetch(url.replace("https://api.osv.dev", `${base}/osv`), {
        method: init.method ?? "GET",
        ...(init.body ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
        headers: {
          accept: init.accept ?? "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      })) as unknown as ConstructorParameters<typeof OsvAudit>[0]["fetch"];
    const npm = REGISTRY_ADAPTERS.get("npm")!;
    const index = await new OsvAudit({ fetch: fetchAdapter, failOpen: false }).audit(npm, "left-pad");
    expect(index.withheld("1.0.5")).toEqual(["GHSA-sim-0001"]);
    expect(index.withheld("1.1.0")).toEqual([]);

    await script([{ action: "osv.outage" }]);
    expect(
      (await post("/v1/query", { package: { name: "left-pad", ecosystem: "npm" }, version: "1.0.0" })).status,
    ).toBe(503);
    // Fail closed by default: the audit is unavailable.
    await expect(new OsvAudit({ fetch: fetchAdapter, failOpen: false }).audit(npm, "left-pad")).rejects.toThrow();
  });
});
