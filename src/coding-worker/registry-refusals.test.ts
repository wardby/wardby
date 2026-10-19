import { describe, expect, it, vi } from "vitest";
import { withPackageRefusals } from "../claude-tool-runner/command.mjs";
import { pypiAdapter } from "../coding/registry/pypi.js";
import { formatRefusals, recentRefusals, registryAccess } from "./registry-refusals.mjs";

const TOKEN = "rrg_FAKE_registry_token_for_tests";
const env = pypiAdapter.workerConfig({
  registryUrl: "http://wardby-proxy:8787/registry/pypi/",
  token: TOKEN,
  cacheDir: "/workspace/.cache/pypi",
}).env;

describe("registry refusals for clients that don't print why", () => {
  it("finds the proxy's registry and token in the worker's PIP_INDEX_URL, and nothing else", () => {
    expect(registryAccess(env)).toEqual({ base: "http://wardby-proxy:8787/registry/", token: TOKEN });
    expect(registryAccess({})).toBeUndefined();
    expect(registryAccess({ PIP_INDEX_URL: "https://pypi.org/simple/" })).toBeUndefined();
    expect(registryAccess({ PIP_INDEX_URL: "http://wardby:x@elsewhere:1/other/simple/" })).toBeUndefined();
    expect(registryAccess({ PIP_INDEX_URL: "not a url" })).toBeUndefined();
  });

  it("asks the proxy, with the token only in the header, and keeps only well-formed rows", async () => {
    const calls: { url: string; authorization: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, authorization: init.headers.authorization });
      return Response.json({
        refusals: [
          { ecosystem: "pypi", name: "requests", code: "wardby_package_not_allowed", hint: "Ask the owner." },
          { ecosystem: "pypi", name: 7, code: "x" },
          { ecosystem: "pypi", name: "docopt", version: "0.6.2", code: "wardby_file_not_allowed" },
        ],
      });
    });
    const since = new Date("2026-10-18T12:00:00.000Z");
    const rows = await recentRefusals(registryAccess(env), since, fetchImpl as unknown as typeof fetch);
    expect(calls).toEqual([
      {
        url: "http://wardby-proxy:8787/registry/-/refusals?since=2026-10-18T12%3A00%3A00.000Z",
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(formatRefusals(rows)).toEqual([
      "wardby: pypi package requests was refused by the package registry (wardby_package_not_allowed): Ask the owner.",
      "wardby: pypi package docopt 0.6.2 was refused by the package registry (wardby_file_not_allowed).",
    ]);
  });

  it("answers nothing, never throws, on a failure or without a registry", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(recentRefusals(registryAccess(env), undefined, failing)).resolves.toEqual([]);
    const denied = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(recentRefusals(registryAccess(env), undefined, denied)).resolves.toEqual([]);
    await expect(recentRefusals(undefined, undefined)).resolves.toEqual([]);
  });

  it("removes control characters from names the run's own requests chose", () => {
    expect(formatRefusals([{ ecosystem: "pypi", name: "evil\n\u001b[2Jname", code: "wardby_bad_request" }])).toEqual([
      "wardby: pypi package evil [2Jname was refused by the package registry (wardby_bad_request).",
    ]);
  });

  it("adds the refusals to a failed command's output, from just before it started, and leaves a success alone", async () => {
    const lookup = vi.fn(async () => [{ ecosystem: "pypi", name: "requests", code: "wardby_package_not_allowed" }]);
    const startedAt = Date.parse("2026-10-18T12:00:10.000Z");
    const failed = await withPackageRefusals(
      { code: 1, output: "ERROR: No matching distribution" },
      env,
      startedAt,
      lookup,
    );
    expect(failed).toEqual({
      code: 1,
      output:
        "ERROR: No matching distribution\nwardby: pypi package requests was refused by the package registry (wardby_package_not_allowed).\n",
    });
    expect(lookup).toHaveBeenCalledWith(
      { base: "http://wardby-proxy:8787/registry/", token: TOKEN },
      new Date("2026-10-18T12:00:08.000Z"),
    );
    const ok = { code: 0, output: "fine" };
    await expect(withPackageRefusals(ok, env, startedAt, lookup)).resolves.toBe(ok);
    expect(lookup).toHaveBeenCalledTimes(1);
    const none = { code: 2, output: "boom" };
    await expect(withPackageRefusals(none, env, startedAt, async () => [])).resolves.toBe(none);
  });
});
