import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { npmAdapter } from "../../../coding/registry/npm.js";
import { pypiAdapter } from "../../../coding/registry/pypi.js";
import { inOsvRange, OsvAudit } from "./audit.js";

/** Trimmed real `POST /v1/query` responses from api.osv.dev (2026-09-25):
 *  `details` and `references` dropped, everything else as served. */
const fixture = async (file: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as {
    vulns: { id: string; affected: { versions?: string[] }[] }[];
  };

const osv = (body: unknown) => vi.fn(async () => Response.json(body));

describe("OsvAudit severity", () => {
  it("withholds HIGH and CRITICAL versions and reports the rest", async () => {
    const vulns = {
      vulns: [
        {
          id: "GHSA-high",
          affected: [{ package: { name: "left-pad", ecosystem: "npm" }, versions: ["1.0.0"] }],
          database_specific: { severity: "HIGH" },
        },
        {
          id: "GHSA-low",
          affected: [{ package: { name: "left-pad", ecosystem: "npm" }, versions: ["1.1.0"] }],
          database_specific: { severity: "LOW" },
        },
      ],
    };
    const fetch = osv(vulns);
    const index = await new OsvAudit({ fetch, failOpen: false }).audit(npmAdapter, "left-pad");
    expect(index.withheld("1.0.0")).toEqual(["GHSA-high"]);
    expect(index.withheld("1.1.0")).toEqual([]);
    expect(index.reported("1.1.0")).toEqual(["GHSA-low"]);
    expect(fetch).toHaveBeenCalledWith("https://api.osv.dev/v1/query", expect.objectContaining({ method: "POST" }));
  });

  it("caches per package for an hour", async () => {
    let now = 0;
    const fetch = osv({ vulns: [] });
    const audit = new OsvAudit({ fetch, failOpen: false, now: () => now });
    await audit.audit(npmAdapter, "a");
    await audit.audit(npmAdapter, "a");
    now += 3_600_001;
    await audit.audit(npmAdapter, "a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when OSV is unreachable, unless configured to fail open", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(new OsvAudit({ fetch, failOpen: false }).audit(npmAdapter, "a")).rejects.toMatchObject({
      status: 503,
      code: "wardby_audit_unavailable",
    });
    await expect(new OsvAudit({ fetch, failOpen: true }).audit(npmAdapter, "a")).resolves.toMatchObject({});
  });

  it("times out a stalled OSV request and fails closed", async () => {
    const fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error)),
        ),
    );
    await expect(new OsvAudit({ fetch, failOpen: false, timeoutMs: 20 }).audit(npmAdapter, "a")).rejects.toMatchObject({
      status: 503,
      code: "wardby_audit_unavailable",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.osv.dev/v1/query",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

describe("OsvAudit on real npm GHSA entries (SEMVER ranges only)", () => {
  it("has no enumerated versions for the npm package, only ranges", async () => {
    const { vulns } = await fixture("osv-npm-lodash.json");
    const lodash = vulns
      .flatMap((vuln) => vuln.affected)
      .filter((affected) => JSON.stringify(affected).includes('"pkg:npm/lodash"'));
    expect(lodash.length).toBeGreaterThan(0);
    expect(lodash.every((affected) => affected.versions === undefined)).toBe(true);
  });

  it("withholds lodash versions inside a HIGH/CRITICAL range and serves the fixed one", async () => {
    const audit = new OsvAudit({ fetch: osv(await fixture("osv-npm-lodash.json")), failOpen: false });
    const index = await audit.audit(npmAdapter, "lodash");
    // GHSA-35jh-r3h4-6jhm (HIGH): introduced "0", fixed 4.17.21.
    expect(index.withheld("0.1.0")).toContain("GHSA-35jh-r3h4-6jhm");
    expect(index.withheld("4.17.20")).toContain("GHSA-35jh-r3h4-6jhm");
    expect(index.withheld("4.17.21")).toEqual([]);
    // GHSA-p6mc-m468-83gw (HIGH): introduced 3.7.0, fixed 4.17.19.
    expect(index.withheld("3.7.0")).toContain("GHSA-p6mc-m468-83gw");
    expect(index.withheld("4.17.19")).not.toContain("GHSA-p6mc-m468-83gw");
    // GHSA-29mw-wpgm-hmr9 (MODERATE) is reported, not withheld.
    expect(index.reported("4.17.20")).toEqual(["GHSA-29mw-wpgm-hmr9"]);
  });

  it("does not leak another npm package's range onto the queried one (lodash.update is not lodash)", async () => {
    // GHSA-p6mc-m468-83gw also lists npm lodash.update (introduced "0",
    // last_affected 4.10.2). lodash itself is only affected from 3.7.0.
    const audit = new OsvAudit({ fetch: osv(await fixture("osv-npm-lodash.json")), failOpen: false });
    const index = await audit.audit(npmAdapter, "lodash");
    expect(index.withheld("3.6.0")).not.toContain("GHSA-p6mc-m468-83gw");
  });

  it("does not leak another ecosystem's entry: RubyGems lodash-rails versions never match an npm package", async () => {
    // GHSA-4xc9-xhrj-v574 lists npm lodash plus RubyGems lodash-rails with an
    // enumerated versions list. Asking about an npm package named
    // lodash-rails must ignore the RubyGems entry entirely.
    const audit = new OsvAudit({ fetch: osv(await fixture("osv-npm-lodash.json")), failOpen: false });
    const index = await audit.audit(npmAdapter, "lodash-rails");
    expect(index.withheld("4.17.10")).toEqual([]);
    expect(index.withheld("4.0.0")).toEqual([]);
  });

  it("treats last_affected as inclusive", async () => {
    // GHSA-p6mc-m468-83gw: npm lodash.update introduced "0", last_affected 4.10.2.
    const audit = new OsvAudit({ fetch: osv(await fixture("osv-npm-lodash.json")), failOpen: false });
    const index = await audit.audit(npmAdapter, "lodash.update");
    expect(index.withheld("4.10.2")).toContain("GHSA-p6mc-m468-83gw");
    expect(index.withheld("4.10.3")).not.toContain("GHSA-p6mc-m468-83gw");
  });
});

describe("OsvAudit on real PyPI entries", () => {
  it("evaluates ECOSYSTEM ranges with PEP 440 and PEP 503-normalized names, ignoring GIT ranges", async () => {
    const body = await fixture("osv-pypi-jinja2.json");
    // Drop the enumerated versions so only the ranges can match.
    for (const vuln of body.vulns) for (const affected of vuln.affected) delete affected.versions;
    const audit = new OsvAudit({ fetch: osv(body), failOpen: false });
    const index = await audit.audit(pypiAdapter, "Jinja2");
    // GHSA-462w-v97r-4m45 (HIGH): introduced "0", fixed 2.10.1.
    expect(index.withheld("2.10")).toEqual(["GHSA-462w-v97r-4m45"]);
    expect(index.withheld("2.10.0")).toEqual(["GHSA-462w-v97r-4m45"]); // non-canonical spelling
    expect(index.withheld("2.0rc1")).toEqual(["GHSA-462w-v97r-4m45"]);
    expect(index.withheld("2.10.1")).toEqual([]);
    // GHSA-gmj6-6f8f-6699 (MODERATE): introduced 3.0.0, fixed 3.1.5. PYSEC
    // entries carry no severity and are reported.
    expect(index.reported("3.1.4")).toContain("GHSA-gmj6-6f8f-6699");
    expect(index.reported("3.1.5")).not.toContain("GHSA-gmj6-6f8f-6699");
    expect(index.reported("2.7.2")).toContain("PYSEC-2014-82");
  });

  it("matches enumerated PyPI versions after PEP 440 normalization", async () => {
    const audit = new OsvAudit({ fetch: osv(await fixture("osv-pypi-jinja2.json")), failOpen: false });
    const index = await audit.audit(pypiAdapter, "jinja2");
    expect(index.withheld("2.9.6")).toEqual(["GHSA-462w-v97r-4m45"]);
    expect(index.withheld("2.9.6.0")).toEqual(["GHSA-462w-v97r-4m45"]);
  });
});

describe("inOsvRange", () => {
  const compare = (a: string, b: string) => npmAdapter.compareVersions(a, b);
  it("handles several introduced/fixed pairs in order", () => {
    const events = [{ introduced: "2.0.0" }, { fixed: "3.0.0" }, { introduced: "0" }, { fixed: "1.0.0" }];
    expect(inOsvRange("0.5.0", events, compare)).toBe(true);
    expect(inOsvRange("1.5.0", events, compare)).toBe(false);
    expect(inOsvRange("2.5.0", events, compare)).toBe(true);
    expect(inOsvRange("3.0.0", events, compare)).toBe(false);
  });

  it.each([
    ["fixed first", [{ introduced: "0" }, { fixed: "2.0.0" }, { introduced: "2.0.0" }, { fixed: "3.0.0" }]],
    ["introduced first", [{ introduced: "0" }, { introduced: "2.0.0" }, { fixed: "2.0.0" }, { fixed: "3.0.0" }]],
  ])("treats a fixed/introduced tie at one version as affected regardless of order (%s)", (_label, events) => {
    expect(inOsvRange("2.0.0", events, compare)).toBe(true);
    expect(inOsvRange("1.0.0", events, compare)).toBe(true);
    expect(inOsvRange("3.0.0", events, compare)).toBe(false);
  });

  it("fails closed on a version it cannot parse", () => {
    expect(inOsvRange("not-a-version", [{ introduced: "1.0.0" }, { fixed: "2.0.0" }], compare)).toBe(true);
  });
});

describe("OsvAudit cache bounds and single-flight", () => {
  it("shares one OSV query between concurrent audits of the same package", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async () => {
      await gate;
      return Response.json({ vulns: [] });
    });
    const audit = new OsvAudit({ fetch, failOpen: false });
    const both = Promise.all([audit.audit(npmAdapter, "a"), audit.audit(npmAdapter, "a")]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await both;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed query: the next audit queries again", async () => {
    let fail = true;
    const fetch = vi.fn(async () => (fail ? new Response("busy", { status: 429 }) : Response.json({ vulns: [] })));
    const audit = new OsvAudit({ fetch, failOpen: false });
    await expect(audit.audit(npmAdapter, "a")).rejects.toMatchObject({ code: "wardby_audit_unavailable" });
    fail = false;
    await expect(audit.audit(npmAdapter, "a")).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is a bounded LRU: the least recently used package is evicted first", async () => {
    const queried: string[] = [];
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      queried.push((JSON.parse(init?.body ?? "{}") as { package: { name: string } }).package.name);
      return Response.json({ vulns: [] });
    });
    const audit = new OsvAudit({ fetch, failOpen: false, maxEntries: 2 });
    await audit.audit(npmAdapter, "a");
    await audit.audit(npmAdapter, "b");
    await audit.audit(npmAdapter, "a"); // a is now most recently used
    await audit.audit(npmAdapter, "c"); // evicts b
    await audit.audit(npmAdapter, "a"); // still cached
    await audit.audit(npmAdapter, "b"); // queried again
    expect(queried).toEqual(["a", "b", "c", "b"]);
  });

  it("drops expired entries before evicting live ones", async () => {
    let now = 0;
    const queried: string[] = [];
    const fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
      queried.push((JSON.parse(init?.body ?? "{}") as { package: { name: string } }).package.name);
      return Response.json({ vulns: [] });
    });
    const audit = new OsvAudit({ fetch, failOpen: false, maxEntries: 2, ttlMs: 1_000, now: () => now });
    await audit.audit(npmAdapter, "old");
    now = 900;
    await audit.audit(npmAdapter, "live");
    now = 1_001; // "old" has expired, "live" has not
    await audit.audit(npmAdapter, "new"); // drops "old", keeps "live"
    await audit.audit(npmAdapter, "live");
    expect(queried).toEqual(["old", "live", "new"]);
  });
});
