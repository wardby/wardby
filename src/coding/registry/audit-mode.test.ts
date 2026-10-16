import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKAGE_AUDIT_MINUTES,
  isPackageAuditActive,
  mergePackageAuditReports,
  MAX_PACKAGE_AUDIT_MINUTES,
  PackageAuditPatchError,
  packageAuditWording,
  parsePackageAuditVerdict,
  resolvePackageAuditPatch,
  sanitizeAuditAdvisories,
  summarizePackageAudit,
} from "./audit-mode.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("resolvePackageAuditPatch", () => {
  it("defaults to 24 hours when the mode is turned on without minutes", () => {
    expect(resolvePackageAuditPatch({ mode: null }, { packageAuditMode: "audit" }, NOW)).toEqual({
      mode: "audit",
      until: minutes(DEFAULT_PACKAGE_AUDIT_MINUTES),
    });
  });
  it("takes explicit minutes up to 7 days", () => {
    expect(
      resolvePackageAuditPatch(
        { mode: null },
        { packageAuditMode: "full", packageAuditMinutes: MAX_PACKAGE_AUDIT_MINUTES },
        NOW,
      ),
    ).toEqual({ mode: "full", until: minutes(MAX_PACKAGE_AUDIT_MINUTES) });
    expect(() =>
      resolvePackageAuditPatch(
        { mode: null },
        { packageAuditMode: "full", packageAuditMinutes: MAX_PACKAGE_AUDIT_MINUTES + 1 },
        NOW,
      ),
    ).toThrow(PackageAuditPatchError);
    expect(() =>
      resolvePackageAuditPatch({ mode: null }, { packageAuditMode: "full", packageAuditMinutes: 0 }, NOW),
    ).toThrow(PackageAuditPatchError);
  });
  it("re-arms the stored mode from minutes alone, and refuses minutes with no mode", () => {
    expect(resolvePackageAuditPatch({ mode: "audit" }, { packageAuditMinutes: 30 }, NOW)).toEqual({
      mode: "audit",
      until: minutes(30),
    });
    expect(() => resolvePackageAuditPatch({ mode: null }, { packageAuditMinutes: 30 }, NOW)).toThrow(
      PackageAuditPatchError,
    );
  });
  it("clears with null and refuses minutes alongside null", () => {
    expect(resolvePackageAuditPatch({ mode: "full" }, { packageAuditMode: null }, NOW)).toEqual({
      mode: null,
      until: null,
    });
    expect(() =>
      resolvePackageAuditPatch({ mode: "full" }, { packageAuditMode: null, packageAuditMinutes: 5 }, NOW),
    ).toThrow(PackageAuditPatchError);
  });
  it("is no change when neither field is given", () => {
    expect(resolvePackageAuditPatch({ mode: "audit" }, {}, NOW)).toBeUndefined();
  });
});

describe("isPackageAuditActive", () => {
  it("is active only for a mode with a future expiry", () => {
    expect(isPackageAuditActive("audit", minutes(1), NOW)).toBe(true);
    expect(isPackageAuditActive("audit", NOW, NOW)).toBe(false);
    expect(isPackageAuditActive("audit", null, NOW)).toBe(false);
    expect(isPackageAuditActive(null, minutes(1), NOW)).toBe(false);
    expect(isPackageAuditActive("bogus", minutes(1), NOW)).toBe(false);
  });
});

const row = (
  name: string,
  relation: string,
  extra: Partial<{ via: string; advisories: unknown; version: string; ecosystem: string }> = {},
) => ({
  ecosystem: extra.ecosystem ?? "npm",
  name,
  version: extra.version ?? "1.0.0",
  relation,
  via: extra.via ?? null,
  sizeBytes: 10,
  advisories: extra.advisories ?? [],
});

describe("summarizePackageAudit", () => {
  it("lists top-level names to approve and unknown ones apart, counting their dependencies", () => {
    const summary = summarizePackageAudit([
      row("expo-dev-client", "top-level"),
      row("expo-dev-launcher", "transitive", { via: "expo-dev-client" }),
      row("left-pad", "unknown"),
      row("pad-dep", "transitive", { via: "left-pad" }),
      row("expo-dev-client", "unknown", { version: "2.0.0" }),
    ]);
    expect(summary.toApprove).toEqual([{ ecosystem: "npm", name: "expo-dev-client", dependencies: 1 }]);
    expect(summary.unknown).toEqual([{ ecosystem: "npm", name: "left-pad", dependencies: 1 }]);
  });
  it("orders entries top-level, unknown, transitive, allowed and dedups versions", () => {
    const summary = summarizePackageAudit([
      row("lodash", "allowed", { advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "x" }] }),
      row("dep", "transitive", { via: "top" }),
      row("loose", "unknown"),
      row("top", "top-level"),
      row("top", "top-level"),
      row("weird", "sideways"),
    ]);
    expect(summary.entries.map((e) => [e.name, e.relation])).toEqual([
      ["top", "top-level"],
      ["loose", "unknown"],
      ["weird", "unknown"],
      ["dep", "transitive"],
      ["lodash", "allowed"],
    ]);
    expect(summary.entries.find((e) => e.name === "dep")).toEqual({
      ecosystem: "npm",
      name: "dep",
      version: "1.0.0",
      size: 10,
      relation: "transitive",
      via: "top",
    });
    expect(summary.entries.find((e) => e.name === "top")).not.toHaveProperty("advisories");
  });
  it("keeps only well-formed advisories and bounds the summary", () => {
    const summary = summarizePackageAudit([
      row("lodash", "allowed", {
        advisories: [
          { id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "x".repeat(500) },
          { id: "not an id", severity: "HIGH", summary: "dropped" },
        ],
      }),
    ]);
    expect(summary.advisoryRows).toHaveLength(1);
    expect(summary.advisoryRows[0].advisory.summary.length).toBeLessThanOrEqual(200);
  });
});

describe("sanitizeAuditAdvisories", () => {
  it("drops any MAL- id defensively", () => {
    expect(sanitizeAuditAdvisories([{ id: "MAL-2026-1", severity: "CRITICAL", summary: "" }])).toEqual([]);
  });
  it("normalizes severity, strips markup and control characters, and caps the list", () => {
    expect(
      sanitizeAuditAdvisories([
        { id: "GHSA-aaaa-bbbb-cccc", severity: "high", summary: "a `b` <c>\u0007\nd" },
        { id: "CVE-2026-12345", severity: "weird" },
        "nope",
        null,
      ]),
    ).toEqual([
      { id: "GHSA-aaaa-bbbb-cccc", severity: "HIGH", summary: "a b c d" },
      { id: "CVE-2026-12345", severity: "UNKNOWN", summary: "" },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `GHSA-${i}xxx-yyyy`, severity: "LOW", summary: "" }));
    expect(sanitizeAuditAdvisories(many)).toHaveLength(16);
    expect(sanitizeAuditAdvisories("not a list")).toEqual([]);
  });
});

describe("packageAuditWording", () => {
  const summary = summarizePackageAudit([
    row("expo-dev-client", "top-level"),
    row("expo-dev-launcher", "transitive", { via: "expo-dev-client" }),
    row("lodash", "allowed", {
      version: "4.17.20",
      advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection in lodash" }],
    }),
  ]);

  it("renders the PR caution banner, the names to approve and, in full mode, the advisory table", () => {
    const text = packageAuditWording("full", summary, { format: "pr" });
    expect(text).toContain("> [!CAUTION]");
    expect(text).toContain("Package audit mode (`full`) was on");
    expect(text).toContain("Malware and the release-age limit were still enforced.");
    expect(text).toContain("**Packages outside the allowlist**");
    expect(text).toContain("- npm `expo-dev-client` (and 1 dependency)");
    expect(text).toContain("**Served despite advisories:**");
    expect(text).toContain("| npm `lodash` | `4.17.20` | `GHSA-35jh-r3h4-6jhm` | HIGH |");
  });

  it("leaves the advisory table out in audit mode and says so when nothing was audited", () => {
    expect(packageAuditWording("audit", summary, { format: "pr" })).not.toContain("Served despite advisories");
    const empty = packageAuditWording("audit", summarizePackageAudit([]), { format: "pr" });
    expect(empty).toContain("> [!CAUTION]");
    expect(empty).toContain("nothing outside the allowlist was installed");
    expect(empty).not.toContain("Packages outside the allowlist");
  });

  it("labels unknown names apart from the names to approve, in the PR body and the status", () => {
    const mixed = summarizePackageAudit([row("expo-dev-client", "top-level"), row("left-pad", "unknown")]);
    const pr = packageAuditWording("audit", mixed, { format: "pr" });
    expect(pr).toContain("- npm `expo-dev-client`");
    expect(pr).toContain(
      "**Relation unknown** — may be a dependency; approve only if needed directly:\n- npm `left-pad`",
    );
    expect(pr.indexOf("left-pad")).toBeGreaterThan(pr.indexOf("Relation unknown"));
    const status = packageAuditWording("audit", mixed, { format: "status" });
    expect(status).toContain("installed outside the allowlist: `expo-dev-client` (npm)");
    expect(status).toContain(
      "Relation unknown — may be a dependency; approve only if needed directly: `left-pad` (npm).",
    );
    const onlyUnknown = packageAuditWording("audit", summarizePackageAudit([row("left-pad", "unknown")]), {
      format: "status",
    });
    expect(onlyUnknown).not.toContain("nothing outside the allowlist");
    expect(onlyUnknown).toContain("`left-pad` (npm)");
  });

  it("renders a short status block with the names and the advisory count", () => {
    const text = packageAuditWording("full", summary, { format: "status" });
    expect(text).toContain("🔎 **Package audit mode (`full`) was on:**");
    expect(text).toContain("`expo-dev-client` (npm)");
    expect(text).toContain("1 served despite advisories");
    expect(text).toContain("`update_agent`");
  });

  it("neutralises names and escapes Slack mrkdwn", () => {
    const hostile = summarizePackageAudit([row("a`b@team<x>&y", "top-level")]);
    const status = packageAuditWording("audit", hostile, { format: "status" });
    expect(status).toContain("`a b@​team x &y`");
    const slack = packageAuditWording("audit", hostile, { slack: true });
    expect(slack).toContain("*Package audit mode (`audit`) was on:*");
    expect(slack).toContain("&amp;y");
    expect(slack).not.toMatch(/<x>/);
  });

  it("bounds the names it lists", () => {
    const many = summarizePackageAudit(Array.from({ length: 14 }, (_, i) => row(`pkg-${i}`, "top-level")));
    const text = packageAuditWording("audit", many, { format: "status" });
    expect(text).toContain("`pkg-9`");
    expect(text).not.toContain("`pkg-10`");
    expect(text).toContain("and 4 more");
  });
});

describe("parsePackageAuditVerdict", () => {
  it("reads a stored verdict back and rejects malformed ones", () => {
    expect(parsePackageAuditVerdict({ relation: "transitive", via: "b" })).toEqual({
      relation: "transitive",
      via: "b",
    });
    expect(
      parsePackageAuditVerdict({
        relation: "allowed",
        via: "ignored",
        advisories: [{ id: "GHSA-aaaa-bbbb-cccc", severity: "HIGH", summary: "s" }, { id: "MAL-1" }],
      }),
    ).toEqual({ relation: "allowed", advisories: [{ id: "GHSA-aaaa-bbbb-cccc", severity: "HIGH", summary: "s" }] });
    expect(parsePackageAuditVerdict(null)).toBeNull();
    expect(parsePackageAuditVerdict({ relation: "sideways" })).toBeNull();
    expect(parsePackageAuditVerdict([])).toBeNull();
  });
});

describe("mergePackageAuditReports", () => {
  it("merges entries across runs, unions advisories, and keeps the strongest mode", () => {
    const advisory = (id: string) => ({ id, severity: "HIGH", summary: "" });
    const merged = mergePackageAuditReports([
      undefined,
      {
        mode: "audit",
        entries: [{ ecosystem: "npm", name: "a", version: "1.0.0", size: 1, relation: "top-level" }],
      },
      {
        mode: "full",
        entries: [
          {
            ecosystem: "npm",
            name: "a",
            version: "1.0.0",
            size: 1,
            relation: "top-level",
            advisories: [advisory("GHSA-aaaa-bbbb-cccc")],
          },
          { ecosystem: "npm", name: "b", version: "2.0.0", size: 2, relation: "transitive", via: "a" },
        ],
      },
    ]);
    expect(merged).toEqual({
      mode: "full",
      entries: [
        {
          ecosystem: "npm",
          name: "a",
          version: "1.0.0",
          size: 1,
          relation: "top-level",
          advisories: [advisory("GHSA-aaaa-bbbb-cccc")],
        },
        { ecosystem: "npm", name: "b", version: "2.0.0", size: 2, relation: "transitive", via: "a" },
      ],
    });
    expect(mergePackageAuditReports([undefined])).toBeUndefined();
  });
});
