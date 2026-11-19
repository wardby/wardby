import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoetryRunner } from "./session.js";
import { prepareWorkspacePypiLockfiles, restoreWorkspacePypiLockfiles, SNAPSHOT_PATH } from "./session.js";
import { readFileSync } from "node:fs";
import { collectUvProxyReferences, restoreUvLockFromOrigins } from "./uv-lockfile.js";

const REGISTRY = "http://wardby-proxy:8787/registry/pypi/";
const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/lockfiles/${name}`, import.meta.url), "utf8");

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "wardby-pypi-session-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workspace, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(workspace, path, ".."), { recursive: true });
  await writeFile(join(workspace, path), content);
}
const read = (path: string): Promise<string> => readFile(join(workspace, path), "utf8");

/** A fake `poetry lock`: rewrites the lock's legacy URLs to whatever the swapped pyproject now names. */
const fakePoetry: PoetryRunner = async ({ projectDir }) => {
  const proxied = (await readFile(join(projectDir, "pyproject.toml"), "utf8")).match(
    /url = "(http:\/\/wardby[^"]*)"/,
  )?.[1];
  const lock = await readFile(join(projectDir, "poetry.lock"), "utf8");
  await writeFile(
    join(projectDir, "poetry.lock"),
    lock
      .replace(/(type = "legacy"\nurl = ")[^"]*(")/g, `$1${proxied}$2`)
      .replace(/content-hash = "0+"/, 'content-hash = "1111"'),
  );
  return { ok: true, stderrTail: "" };
};

const prepare = (run: PoetryRunner = fakePoetry) =>
  prepareWorkspacePypiLockfiles({ workspace, registryUrl: REGISTRY, token: "tok", env: { A: "1" }, run });
/** The real registry the fake proxy answers with (a private index: hosted and mirrored files alike). */
const REAL = "https://registry.example.test/api/pypi/pypi";
const TOKEN = "rrg_secret_token_value";

/** The addresses a proxy would know for every file of the fixture lock, as `<name>/<filename>` -> URL. */
const knownFiles = (): Record<string, string> =>
  Object.fromEntries(
    collectUvProxyReferences(fixture("uv-proxied.lock"), REGISTRY).files.map(({ name, filename }) => [
      `${name}/${filename}`,
      `${REAL}/${name}/${filename}`,
    ]),
  );

/** A fake of the proxy's origins route: answers from `known`, `error` for anything else, and records what it was asked. */
function fakeOrigins(known: Record<string, string> = knownFiles(), status = 200) {
  const calls: { url: string; authorization: string | null; files: { name: string; filename: string }[] }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const files = (JSON.parse(init?.body as string) as { files: { name: string; filename: string }[] }).files;
    calls.push({ url: url as string, authorization: headers.get("authorization"), files });
    if (status !== 200) return new Response(JSON.stringify({ error: "wardby_upstream_error: down" }), { status });
    return Response.json({
      index: `${REAL}/simple`,
      files: files.map((file) => {
        const address = known[`${file.name}/${file.filename}`];
        return address ? { ...file, url: address } : { ...file, error: "wardby_origin_not_allowed" };
      }),
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const restore = (fetchImpl: typeof fetch = fakeOrigins().fetch) =>
  restoreWorkspacePypiLockfiles({ workspace, registryUrl: REGISTRY, token: TOKEN, fetch: fetchImpl });
/** The fixture lock as it reads once every proxy URL is replaced with the address the fake proxy gives. */
const resolvedFixture = (): string =>
  restoreUvLockFromOrigins(fixture("uv-proxied.lock"), REGISTRY, {
    index: `${REAL}/simple`,
    files: new Map(
      collectUvProxyReferences(fixture("uv-proxied.lock"), REGISTRY).files.map((file) => [
        file.url,
        `${REAL}/${file.name}/${file.filename}`,
      ]),
    ),
  }).content;

describe("uv projects", () => {
  it("rewrites uv.lock, snapshots it privately and restores it exactly", async () => {
    await put("uv.lock", fixture("uv.lock"));
    const result = await prepare();
    expect(result).toEqual({ env: {}, prepared: ["uv.lock"], warnings: [] });
    expect(await read("uv.lock")).toBe(fixture("uv-proxied.lock"));
    expect((await stat(join(workspace, SNAPSHOT_PATH))).mode & 0o777).toBe(0o600);
    expect(await restore()).toEqual({ restored: ["uv.lock"], warnings: [], unresolved: [] });
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  it("is idempotent: a second prepare changes nothing and keeps the snapshot", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await prepare();
    const snapshot = await read(SNAPSHOT_PATH);
    expect((await prepare()).prepared).toEqual(["uv.lock"]);
    expect(await read(SNAPSHOT_PATH)).toBe(snapshot);
    await restore();
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  it("handles nested projects and skips dependency folders, .git and symlinks", async () => {
    await put("services/api/uv.lock", fixture("uv.lock"));
    await put("node_modules/x/uv.lock", fixture("uv.lock"));
    await put(".git/uv.lock", fixture("uv.lock"));
    await put("real/uv.lock", fixture("uv.lock"));
    await symlink(join(workspace, "real/uv.lock"), join(workspace, "link.lock"));
    await symlink(join(workspace, "real/uv.lock"), join(workspace, "uv.lock"));
    expect((await prepare()).prepared).toEqual(["real/uv.lock", "services/api/uv.lock"]);
    expect(await read("node_modules/x/uv.lock")).toBe(fixture("uv.lock"));
    expect(await read(".git/uv.lock")).toBe(fixture("uv.lock"));
    expect(await restore()).toMatchObject({ restored: ["real/uv.lock", "services/api/uv.lock"] });
  });

  it("keeps the file mode", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await chmod(join(workspace, "uv.lock"), 0o640);
    await prepare();
    expect((await stat(join(workspace, "uv.lock"))).mode & 0o777).toBe(0o640);
  });

  it("reports nothing unresolved when the agent left the lock as prepared", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await prepare();
    expect((await restore()).unresolved).toEqual([]);
  });

  it("puts uv.lock back when the snapshot cannot be saved, so restore never needs it", async () => {
    await put("uv.lock", fixture("uv.lock"));
    // A file where the snapshot's directory belongs: the save fails after the rewrite.
    await put(".cache", "not a directory");
    const result = await prepare();
    expect(result).toEqual({
      env: {},
      prepared: [],
      warnings: ["pypi lockfiles: preparing the workspace failed; files left as found"],
    });
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  it("keeps the previous snapshot when a later prepare cannot save its own", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await prepare();
    const snapshot = await read(SNAPSHOT_PATH);
    await put("sub/uv.lock", fixture("uv.lock"));
    // The temporary file's name is taken by a directory, so the new snapshot cannot be written.
    await mkdir(join(workspace, `${SNAPSHOT_PATH}.tmp`), { recursive: true });
    expect((await prepare()).prepared).toEqual([]);
    expect(await read("sub/uv.lock")).toBe(fixture("uv.lock"));
    expect(await read(SNAPSHOT_PATH)).toBe(snapshot);
    expect(await read("uv.lock")).toBe(fixture("uv-proxied.lock"));
    await rm(join(workspace, `${SNAPSHOT_PATH}.tmp`), { recursive: true });
    expect(await restore()).toMatchObject({ restored: ["uv.lock"], unresolved: [] });
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  it("ignores files that are not uv locks and writes no snapshot when nothing changed", async () => {
    await put("uv.lock", '[[package]]\nname = "x"\n');
    expect(await prepare()).toEqual({ env: {}, prepared: [], warnings: [] });
    await expect(stat(join(workspace, SNAPSHOT_PATH))).rejects.toThrow();
  });

  it("restores an untouched lock exactly from the snapshot, without asking the proxy", async () => {
    await put("uv.lock", fixture("uv.lock"));
    await prepare();
    const proxy = fakeOrigins();
    expect(await restore(proxy.fetch)).toEqual({ restored: ["uv.lock"], warnings: [], unresolved: [] });
    expect(proxy.calls).toEqual([]);
    expect(await read("uv.lock")).toBe(fixture("uv.lock"));
  });

  describe("a lock the agent changed, or whose snapshot is gone", () => {
    const added = [
      "",
      "[[package]]",
      'name = "fresh-logging"',
      'version = "2.3.21"',
      `source = { registry = "${REGISTRY}simple" }`,
      `wheels = [`,
      `    { url = "${REGISTRY}files/fresh-logging/fresh_logging-2.3.21-py3-none-any.whl", hash = "sha256:cc", size = 10 },`,
      `]`,
      "",
    ].join("\n");
    const privateFile = {
      "fresh-logging/fresh_logging-2.3.21-py3-none-any.whl": `${REAL}/fresh_logging/2.3.21/fresh_logging-2.3.21-py3-none-any.whl`,
    };

    it("(a) with the snapshot deleted, still gives every package, a private one included, its real address", async () => {
      await put("uv.lock", fixture("uv.lock"));
      await prepare();
      // What `rm -rf .cache` in the agent's shell does.
      await rm(join(workspace, ".cache"), { recursive: true, force: true });
      const proxy = fakeOrigins({ ...knownFiles(), ...privateFile });
      await writeFile(join(workspace, "uv.lock"), (await read("uv.lock")) + added);
      const result = await restore(proxy.fetch);
      expect(result).toEqual({ restored: ["uv.lock"], warnings: [], unresolved: [] });
      const lock = await read("uv.lock");
      expect(lock).not.toContain("wardby-proxy");
      expect(lock).not.toContain("pythonhosted");
      expect(lock).toContain(privateFile["fresh-logging/fresh_logging-2.3.21-py3-none-any.whl"]);
      expect(lock).toContain(`source = { registry = "${REAL}/simple" }`);
      expect(lock).toContain(`${REAL}/requests/requests-2.32.3-py3-none-any.whl`);
    });

    it("answers a rewritten lock the agent left as it was, once the snapshot is deleted", async () => {
      await put("uv.lock", fixture("uv.lock"));
      await prepare();
      await rm(join(workspace, ".cache"), { recursive: true, force: true });
      expect(await restore()).toEqual({ restored: ["uv.lock"], warnings: [], unresolved: [] });
      expect(await read("uv.lock")).toBe(resolvedFixture());
    });

    it("(b) gives a package the original lock never named (an upgrade or a new one) its real address, with the snapshot intact", async () => {
      await put("uv.lock", fixture("uv.lock"));
      await prepare();
      await writeFile(join(workspace, "uv.lock"), (await read("uv.lock")) + added);
      const proxy = fakeOrigins({ ...knownFiles(), ...privateFile });
      const result = await restore(proxy.fetch);
      expect(result.unresolved).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(await read("uv.lock")).toContain(privateFile["fresh-logging/fresh_logging-2.3.21-py3-none-any.whl"]);
      expect(await read("uv.lock")).not.toContain("wardby-proxy");
    });

    it("asks with the run's token as a bearer header, once per file, at the origins route", async () => {
      await put("uv.lock", fixture("uv-proxied.lock"));
      const proxy = fakeOrigins();
      await restore(proxy.fetch);
      expect(proxy.calls).toHaveLength(1);
      expect(proxy.calls[0].url).toBe(`${REGISTRY}-/origins`);
      expect(proxy.calls[0].authorization).toBe(`Bearer ${TOKEN}`);
      expect(proxy.calls[0].files).toHaveLength(6);
    });

    it("(c) reports the lock unresolved, with the proxy's code and no secret, when the proxy cannot answer for a file", async () => {
      await put("uv.lock", fixture("uv.lock"));
      await prepare();
      await rm(join(workspace, ".cache"), { recursive: true, force: true });
      await writeFile(join(workspace, "uv.lock"), (await read("uv.lock")) + added);
      // The proxy knows the original files but not the new private one.
      const result = await restore(fakeOrigins().fetch);
      expect(result.unresolved).toEqual(["uv.lock"]);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          "uv.lock: 1 entries still name the proxy (wardby_origin_not_allowed x1; projects: fresh-logging)",
        ),
      ]);
      // The rest were restored; the one unanswered keeps its proxy URL, never a guessed public one.
      const lock = await read("uv.lock");
      expect(lock).toContain(`${REGISTRY}files/fresh-logging/fresh_logging-2.3.21-py3-none-any.whl`);
      expect(lock).not.toContain("files.pythonhosted.org");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it.each([
      ["an unreachable proxy", () => Promise.reject(new Error(`connect failed ${TOKEN}`)), "wardby_origin_unreachable"],
      ["a proxy error", fakeOrigins(undefined, 502).fetch, "wardby_upstream_error"],
      ["a proxy that refuses the token", fakeOrigins(undefined, 401).fetch, "wardby_upstream_error"],
      [
        "an old proxy without the route",
        async () => new Response("not found", { status: 404 }),
        "wardby_origin_unreachable",
      ],
      ["an unreadable answer", async () => new Response("<html>"), "wardby_origin_bad_answer"],
    ])("(c) fails closed with %s, and never leaves the lock half guessed", async (_label, fetchImpl, code) => {
      await put("uv.lock", fixture("uv-proxied.lock"));
      const result = await restore(fetchImpl);
      expect(result.unresolved).toEqual(["uv.lock"]);
      expect(result.warnings[0]).toContain(code);
      expect(await read("uv.lock")).toBe(fixture("uv-proxied.lock"));
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("falls back to the snapshot's recorded original for an entry the proxy cannot answer, and only for those", async () => {
      await put("uv.lock", fixture("uv.lock"));
      await prepare();
      await writeFile(join(workspace, "uv.lock"), `${await read("uv.lock")}\n# touched by the agent\n`);
      const known = knownFiles();
      delete known["requests/requests-2.32.3-py3-none-any.whl"];
      const result = await restore(fakeOrigins(known).fetch);
      expect(result.unresolved).toEqual([]);
      // The unanswered file is the one the original lock named; the answered ones come from the proxy.
      expect(await read("uv.lock")).toContain(
        "https://files.pythonhosted.org/packages/f9/9b/requests-2.32.3-py3-none-any.whl",
      );
      expect(await read("uv.lock")).toContain(`${REAL}/typing-extensions/typing_extensions-4.12.2-py3-none-any.whl`);
    });

    it("leaves a changed lock with no proxy URLs alone, and never asks the proxy", async () => {
      await put("uv.lock", fixture("uv.lock"));
      await prepare();
      await writeFile(join(workspace, "uv.lock"), fixture("uv.lock") + "\n# edited\n");
      const proxy = fakeOrigins();
      expect(await restore(proxy.fetch)).toEqual({ restored: [], warnings: [], unresolved: [] });
      expect(proxy.calls).toEqual([]);
    });

    it("restores each lock of a workspace with several, one request set per lock", async () => {
      await put("a/uv.lock", fixture("uv-proxied.lock"));
      await put("b/uv.lock", fixture("uv-proxied.lock"));
      const result = await restore();
      expect(result).toEqual({ restored: ["a/uv.lock", "b/uv.lock"], warnings: [], unresolved: [] });
      expect(await read("a/uv.lock")).toBe(resolvedFixture());
      expect(await read("b/uv.lock")).toBe(resolvedFixture());
    });
  });
});

describe("poetry projects", () => {
  async function poetryProject(directory = ""): Promise<void> {
    await put(`${directory}pyproject.toml`, fixture("poetry-pyproject.toml"));
    await put(`${directory}poetry.lock`, fixture("poetry.lock"));
  }

  it("swaps sources, runs poetry lock, returns credentials and restores both files exactly", async () => {
    await poetryProject();
    const result = await prepare();
    expect(result.prepared).toEqual(["poetry.lock", "pyproject.toml"]);
    expect(result.env).toEqual({
      POETRY_HTTP_BASIC_CORP_USERNAME: "wardby",
      POETRY_HTTP_BASIC_CORP_PASSWORD: "tok",
      POETRY_HTTP_BASIC_PYPI_PUBLIC_USERNAME: "wardby",
      POETRY_HTTP_BASIC_PYPI_PUBLIC_PASSWORD: "tok",
    });
    expect(await read("pyproject.toml")).toContain(`${REGISTRY}simple/`);
    expect(await read("pyproject.toml")).not.toContain("jfrog");
    expect(await restore()).toEqual({ restored: ["poetry.lock", "pyproject.toml"], warnings: [], unresolved: [] });
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
    expect(await read("poetry.lock")).toBe(fixture("poetry.lock"));
  });

  it("passes the agent environment plus the credentials to poetry, in the project directory", async () => {
    await poetryProject("svc/");
    const seen: Parameters<PoetryRunner>[0][] = [];
    await prepare(async (options) => {
      seen.push(options);
      return fakePoetry(options);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].projectDir).toBe(join(workspace, "svc"));
    expect(seen[0].env).toMatchObject({ A: "1", POETRY_HTTP_BASIC_CORP_PASSWORD: "tok" });
  });

  it("hands poetry this process's UV_PYTHON_* so it can find a baked interpreter, and lets the agent environment win", async () => {
    vi.stubEnv("UV_PYTHON_INSTALL_DIR", "/opt/uv-python");
    vi.stubEnv("UV_PYTHON_DOWNLOADS", "never");
    await poetryProject();
    const seen: Parameters<PoetryRunner>[0][] = [];
    await prepareWorkspacePypiLockfiles({
      workspace,
      registryUrl: REGISTRY,
      token: "tok",
      env: { UV_PYTHON_DOWNLOADS: "manual" },
      run: async (options) => {
        seen.push(options);
        return fakePoetry(options);
      },
    });
    expect(seen[0].env).toMatchObject({ UV_PYTHON_INSTALL_DIR: "/opt/uv-python", UV_PYTHON_DOWNLOADS: "manual" });
  });

  it("reverts the pyproject swap when poetry lock fails, and reports why", async () => {
    await poetryProject();
    const result = await prepare(async () => ({ ok: false, reason: "failed", stderrTail: "no solution\nfound" }));
    expect(result).toMatchObject({ env: {}, prepared: [] });
    expect(result.warnings).toEqual([expect.stringContaining("pyproject.toml: poetry lock through the proxy failed")]);
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
    expect(await read("poetry.lock")).toBe(fixture("poetry.lock"));
    await expect(stat(join(workspace, SNAPSHOT_PATH))).rejects.toThrow();
  });

  it("skips quietly when poetry is not installed", async () => {
    await poetryProject();
    const result = await prepare(async () => ({ ok: false, reason: "poetry_not_installed", stderrTail: "" }));
    expect(result).toEqual({ env: {}, prepared: [], warnings: [] });
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
  });

  it("leaves a pyproject with no URL sources, or a lock without a Poetry pyproject, alone", async () => {
    await put("a/pyproject.toml", '[tool.poetry]\nname = "x"\n');
    await put("a/poetry.lock", fixture("poetry.lock"));
    await put("b/pyproject.toml", '[project]\nname = "x"\n');
    await put("b/poetry.lock", fixture("poetry.lock"));
    let calls = 0;
    expect(await prepare(async () => (calls++, { ok: true, stderrTail: "" }))).toMatchObject({ prepared: [] });
    expect(calls).toBe(0);
  });

  it("warns when the agent changed the lock", async () => {
    await poetryProject();
    await prepare();
    await writeFile(join(workspace, "poetry.lock"), `${await read("poetry.lock")}# edited\n`);
    const result = await restore();
    expect(result.restored).toEqual(["poetry.lock", "pyproject.toml"]);
    expect(result.warnings).toEqual([
      expect.stringContaining("poetry.lock: changed during the run; run `poetry lock`"),
    ]);
    expect(await read("pyproject.toml")).toBe(fixture("poetry-pyproject.toml"));
  });
});

describe("restoreWorkspacePypiLockfiles", () => {
  it("does nothing without a snapshot", async () => {
    await put("uv.lock", fixture("uv.lock"));
    expect(await restore()).toEqual({ restored: [], warnings: [], unresolved: [] });
  });

  it("warns about a corrupt snapshot and still restores the uv.lock through the proxy", async () => {
    await put("uv.lock", fixture("uv-proxied.lock"));
    await put(SNAPSHOT_PATH, "{not json");
    const result = await restore();
    expect(result.restored).toEqual(["uv.lock"]);
    expect(result.unresolved).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("snapshot is unreadable")]);
    expect(await read("uv.lock")).toBe(resolvedFixture());
  });

  it("never writes outside the three lockfile names, whatever a tampered snapshot says", async () => {
    await put("notes.txt", "keep");
    await put(
      SNAPSHOT_PATH,
      JSON.stringify({
        schemaVersion: 1,
        files: [
          { path: "notes.txt", kind: "uv", original: "pwned", writtenSha256: "x" },
          { path: "../uv.lock", kind: "uv", original: "pwned", writtenSha256: "x" },
        ],
      }),
    );
    const result = await restore();
    expect(result.restored).toEqual([]);
    expect(await read("notes.txt")).toBe("keep");
  });
});
