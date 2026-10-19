import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pypiAdapter } from "../coding/registry/pypi.js";
import { normalizeUvLock } from "../coding/registry/pypi-plan.js";
import { planPythonLockfile } from "./pypi-plan.mjs";
import { registryAccess } from "./registry-refusals.mjs";
import { planTargets, proxyUrls, routeLock, unrouteLock } from "./uv-lock.mjs";

const TOKEN = "rrg_FAKE_registry_token_for_tests";
const env = pypiAdapter.workerConfig({
  registryUrl: "http://wardby-proxy:8787/registry/pypi/",
  token: TOKEN,
  cacheDir: "/workspace/.cache/pypi",
}).env;
const proxy = proxyUrls(env)!;

const LOCK = `version = 1
requires-python = ">=3.12"

[[package]]
name = "annotated-doc"
version = "0.0.5"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/5a/8e/38aa/annotated_doc-0.0.5.tar.gz", hash = "sha256:c7", size = 10758 }
wheels = [
    { url = "https://files.pythonhosted.org/packages/3e/30/e900/annotated_doc-0.0.5-py3-none-any.whl", hash = "sha256:11", size = 5302 },
]

[[package]]
name = "demo-app"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "annotated-doc" },
]
`;

describe("the uv shim's view of a command line", () => {
  it("finds the project lock for project commands, and requirement files for uv pip", () => {
    const root = mkdtempSync(join(tmpdir(), "uv-shim-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "pkg", "sub"), { recursive: true });
    writeFileSync(join(root, "uv.lock"), LOCK);
    const sub = join(root, "pkg", "sub");
    expect(planTargets(["sync", "--frozen"], sub)).toEqual({ lock: join(root, "uv.lock") });
    expect(planTargets(["--directory", root, "run", "pytest"], "/")).toEqual({ lock: join(root, "uv.lock") });
    expect(planTargets(["-q", "add", "six"], root)).toEqual({ lock: join(root, "uv.lock") });
    expect(planTargets(["pip", "install", "-r", "req.txt", "--requirement=dev.txt", "-rextra.txt"], root)).toEqual({
      requirements: [join(root, "req.txt"), join(root, "dev.txt"), join(root, "extra.txt")],
    });
    expect(planTargets(["pip", "sync", "locked.txt"], root)).toEqual({ requirements: [join(root, "locked.txt")] });
    expect(planTargets(["pip", "install", "requests"], root)).toEqual({ requirements: [] });
    expect(planTargets(["venv"], root)).toEqual({});
    expect(planTargets(["--version"], root)).toEqual({});
    // No lock yet: the one the command writes is put back to PyPI's URLs afterwards.
    const empty = mkdtempSync(join(tmpdir(), "uv-shim-"));
    mkdirSync(join(empty, ".git"));
    expect(planTargets(["lock"], empty)).toEqual({ lock: { missing: join(empty, "uv.lock") } });
  });

  it("reads the proxy's index without credentials from UV_DEFAULT_INDEX", () => {
    expect(proxy).toEqual({
      index: "http://wardby-proxy:8787/registry/pypi/simple/",
      files: "http://wardby-proxy:8787/registry/pypi/files/",
    });
    expect(JSON.stringify(proxy)).not.toContain(TOKEN);
    expect(proxyUrls({})).toBeUndefined();
    expect(proxyUrls({ UV_DEFAULT_INDEX: "https://pypi.org/elsewhere/" })).toBeUndefined();
  });
});

describe("routing a uv.lock through the proxy", () => {
  it("points the PyPI index and every file at the proxy, and puts them back exactly", () => {
    const routed = routeLock(LOCK, proxy);
    expect(routed.text).toContain('source = { registry = "http://wardby-proxy:8787/registry/pypi/simple/" }');
    expect(routed.text).toContain(
      '{ url = "http://wardby-proxy:8787/registry/pypi/files/annotated-doc/annotated_doc-0.0.5-py3-none-any.whl"',
    );
    expect(routed.text).toContain(
      'sdist = { url = "http://wardby-proxy:8787/registry/pypi/files/annotated-doc/annotated_doc-0.0.5.tar.gz"',
    );
    expect(routed.text).not.toContain("pythonhosted");
    expect(routed.text).not.toContain(TOKEN);
    expect(unrouteLock(routed.text, proxy, routed.originals)).toBe(LOCK);
  });

  it("maps a lock uv rewrote back to PyPI: known files to their URLs, new ones to PyPI's redirecting path", () => {
    const routed = routeLock(LOCK, proxy);
    const rewritten = `${routed.text}
[[package]]
name = "six"
version = "1.17.0"
source = { registry = "http://wardby-proxy:8787/registry/pypi/simple/" }
wheels = [
    { url = "http://wardby-proxy:8787/registry/pypi/files/six/six-1.17.0-py2.py3-none-any.whl", hash = "sha256:47" },
]
`;
    const restored = unrouteLock(rewritten, proxy, routed.originals);
    expect(restored.startsWith(LOCK)).toBe(true);
    expect(restored).toContain(
      '{ url = "https://files.pythonhosted.org/packages/py2.py3/s/six/six-1.17.0-py2.py3-none-any.whl", hash = "sha256:47" }',
    );
    expect(restored).not.toContain("wardby-proxy");
    // The collection backstop (pypiAdapter.lockfiles) agrees with the shim for files it doesn't know.
    expect(normalizeUvLock(rewritten, "http://wardby-proxy:8787/registry/pypi/")).toContain(
      "https://files.pythonhosted.org/packages/py2.py3/s/six/six-1.17.0-py2.py3-none-any.whl",
    );
  });
});

describe("planning a Python lockfile from the worker", () => {
  it("sends the file to the proxy with the token only in the header, and plans the same bytes once", async () => {
    const cache = mkdtempSync(join(tmpdir(), "pip-cache-"));
    const file = join(cache, "requirements.txt");
    writeFileSync(file, "fastapi==0.115.0\n");
    const calls: { url: string; authorization: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
      calls.push({ url, authorization: init.headers.authorization, body: init.body.toString() });
      return Response.json({
        approved: 3,
        refused: [{ name: "evil\u001b[2J", version: "1.0", code: "wardby_package_not_allowed", reason: "nope" }],
      });
    });
    const planEnv = { ...env, PIP_CACHE_DIR: cache };
    const lines = await planPythonLockfile(
      file,
      registryAccess(planEnv),
      planEnv,
      fetchImpl as unknown as typeof fetch,
    );
    expect(calls).toEqual([
      {
        url: "http://wardby-proxy:8787/registry/pypi/-/plan",
        authorization: `Bearer ${TOKEN}`,
        body: "fastapi==0.115.0\n",
      },
    ]);
    expect(lines[0]).toMatch(/^wardby: verified .*requirements\.txt: 3 approved, 1 refused$/);
    expect(lines[1]).toBe("wardby:   refused evil [2J@1.0: wardby_package_not_allowed (nope)");
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(join(cache, ".wardby-planned"), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      planPythonLockfile(file, registryAccess(planEnv), planEnv, fetchImpl as unknown as typeof fetch),
    ).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A changed file is planned again.
    writeFileSync(file, "fastapi==0.115.1\n");
    await planPythonLockfile(file, registryAccess(planEnv), planEnv, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a failed plan without the token, and doesn't remember it", async () => {
    const cache = mkdtempSync(join(tmpdir(), "pip-cache-"));
    const file = join(cache, "uv.lock");
    writeFileSync(file, LOCK);
    const planEnv = { ...env, PIP_CACHE_DIR: cache };
    const denied = (async () =>
      Response.json(
        { error: "wardby_plan_limit: this run has made its 20 lockfile plans" },
        { status: 429 },
      )) as unknown as typeof fetch;
    const lines = await planPythonLockfile(file, registryAccess(planEnv), planEnv, denied);
    expect(lines).toEqual([
      expect.stringMatching(/was not verified \(wardby_plan_limit: .*\); installing with the registry's usual checks$/),
    ]);
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await planPythonLockfile(file, registryAccess(planEnv), planEnv, failing))[0]).toContain("ECONNREFUSED");
    expect(await planPythonLockfile(file, undefined, planEnv)).toEqual([
      expect.stringContaining("no package registry is configured"),
    ]);
  });
});
