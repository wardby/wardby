import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNpmClientLockfile } from "../../../coding/registry/npm-lockfile-formats.js";
import { RegistryError } from "../../../coding/registry/types.js";
import { parseLockfileOffThread, parseWorkerHeapMb } from "./lockfile-parse.js";
import { responseFor } from "./lockfile-parse-worker.js";

const PROXY = "http://wardby-proxy:8787/registry/npm/";
const OPTIONS = { maxEntries: 100, proxyRegistryUrl: PROXY };
const fixture = (name: string) =>
  readFileSync(new URL(`../../../coding/registry/fixtures/lockfiles/${name}`, import.meta.url), "utf8");

async function failure(promise: Promise<unknown>): Promise<[number, string] | string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof RegistryError ? [error.status, error.code] : String(error);
  }
  return "no error";
}

/** A lockfile far within the entry bound that YAML still takes seconds to
 *  read: one entry whose value is a ~20 MiB flow sequence. */
function slowLockfile(): string {
  return `lockfileVersion: '9.0'\nsnapshots:\n  a@1.0.0:\n    x: [${"aa, ".repeat(5_000_000)}a]\n`;
}

describe("parseLockfileOffThread", () => {
  for (const name of ["pnpm-lock-v9.yaml", "pnpm-lock-v6.yaml", "yarn-v1.lock", "yarn-berry.lock"]) {
    it(`gives the same entries and resolution as an in-process parse for ${name}`, async () => {
      const body = fixture(name);
      const direct = parseNpmClientLockfile(body, OPTIONS);
      const shipped = await parseLockfileOffThread("npm", body, OPTIONS, { timeoutMs: 10_000 });
      expect(shipped.entries).toEqual(direct.entries);
      expect(shipped.projects).toEqual(direct.projects);
      expect(shipped.integrity).toBe(direct.integrity);
      for (const entry of direct.entries) {
        for (const key of direct.dependencyKeys!(entry.path)) {
          expect(shipped.resolve(entry.path, key), `${entry.path} -> ${key}`).toEqual(direct.resolve(entry.path, key));
        }
      }
      // Each project's declared dependencies resolve too (package audit
      // mode labels those top-level), and at least one does in every format.
      let resolved = 0;
      for (const project of direct.projects) {
        for (const { key } of project.dependencies) {
          const entry = direct.resolve(project.path, key);
          if (entry) resolved += 1;
          expect(shipped.resolve(project.path, key), `${project.path} -> ${key}`).toEqual(entry);
        }
      }
      expect(resolved).toBeGreaterThan(0);
      expect(shipped.resolve("nowhere", "ms")).toBeUndefined();
    });
  }

  it("cuts a project's edges at the bound instead of refusing the lockfile", async () => {
    const declared = ["a", ...Array.from({ length: 2100 }, (_, at) => `dep-${at}`)]
      .map((name) => `      ${name}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`)
      .join("");
    const body = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${declared}\npackages:\n\n  a@1.0.0:\n    resolution: {integrity: sha512-a}\n\nsnapshots:\n\n  a@1.0.0: {}\n`;
    const shipped = await parseLockfileOffThread("npm", body, OPTIONS, { timeoutMs: 10_000 });
    expect(shipped.projects[0].dependencies).toHaveLength(2101);
    expect(shipped.resolve(".", "a")).toMatchObject({ name: "a", version: "1.0.0" });
  });

  it("passes the parser's refusals through with their status and code", async () => {
    expect(
      await failure(parseLockfileOffThread("npm", "lockfileVersion: 5.4\n", OPTIONS, { timeoutMs: 10_000 })),
    ).toEqual([400, "wardby_lockfile_unsupported"]);
    expect(
      await failure(
        parseLockfileOffThread(
          "npm",
          fixture("pnpm-lock-v9.yaml"),
          { ...OPTIONS, maxEntries: 2 },
          { timeoutMs: 10_000 },
        ),
      ),
    ).toEqual([413, "wardby_lockfile_too_large"]);
  });

  it("stops a slow parse at its time bound without blocking the event loop", async () => {
    const body = slowLockfile();
    let worstLag = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      const now = Date.now();
      worstLag = Math.max(worstLag, now - last - 10);
      last = now;
    }, 10);
    const started = Date.now();
    try {
      expect(await failure(parseLockfileOffThread("npm", body, OPTIONS, { timeoutMs: 500 }))).toEqual([
        503,
        "wardby_plan_incomplete",
      ]);
    } finally {
      clearInterval(ticker);
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(worstLag).toBeLessThan(200);
  }, 10_000);

  it("stops when the client goes away", async () => {
    const controller = new AbortController();
    const parse = parseLockfileOffThread("npm", slowLockfile(), OPTIONS, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    expect(await failure(parse)).toEqual([503, "wardby_plan_incomplete"]);
  }, 10_000);

  it("answers a reader that runs out of memory as a lockfile too large", async () => {
    expect(
      await failure(
        parseLockfileOffThread("npm", slowLockfile(), OPTIONS, { timeoutMs: 10_000, maxOldGenerationSizeMb: 64 }),
      ),
    ).toEqual([413, "wardby_lockfile_too_large"]);
  }, 15_000);

  it("fails a reader that can't load, or hits a bug, as an error with its cause, not as a refusal", async () => {
    const workers = new URL("./fixtures/parse-workers/", import.meta.url);
    for (const [file, cause] of [
      ["fails-to-load.mjs", "the worker module could not load"],
      ["unexpected.mjs", "TypeError: fixture parser bug"],
    ]) {
      const outcome = parseLockfileOffThread("npm", fixture("yarn-v1.lock"), OPTIONS, {
        timeoutMs: 10_000,
        workerUrl: new URL(file, workers),
      });
      await expect(outcome).rejects.toThrow(cause);
      await expect(outcome).rejects.not.toBeInstanceOf(RegistryError);
    }
  });

  it("reports a parser bug in the worker as unexpected, a refusal as a refusal", () => {
    expect(
      responseFor(() => {
        throw new TypeError("x is undefined");
      }),
    ).toEqual({ ok: false, unexpected: true, message: "TypeError: x is undefined" });
    expect(
      responseFor(() => {
        throw new RegistryError(400, "wardby_bad_request", "not YAML");
      }),
    ).toEqual({ ok: false, status: 400, code: "wardby_bad_request", message: "not YAML" });
  });

  it("bounds a reader's heap by the entry bound: 384 MiB at the default 5000, more for a raised bound", () => {
    // A realistic 5000-entry pnpm-lock.yaml (3.4 MiB) needs 129 to 160 MiB.
    expect(parseWorkerHeapMb(5000)).toBe(384);
    expect(parseWorkerHeapMb(100)).toBe(384);
    expect(parseWorkerHeapMb(20_000)).toBe(1536);
  });
});
