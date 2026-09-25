import { describe, expect, it, vi } from "vitest";
import { OsvAudit } from "./audit.js";

const vulns = {
  vulns: [
    { id: "GHSA-high", affected: [{ versions: ["1.0.0"] }], database_specific: { severity: "HIGH" } },
    { id: "GHSA-low", affected: [{ versions: ["1.1.0"] }], database_specific: { severity: "LOW" } },
  ],
};

describe("OsvAudit", () => {
  it("withholds HIGH and CRITICAL versions and reports the rest", async () => {
    const fetch = vi.fn(async () => Response.json(vulns));
    const index = await new OsvAudit({ fetch, failOpen: false }).audit("npm", "left-pad");
    expect([...index.withheld.keys()]).toEqual(["1.0.0"]);
    expect([...index.reported.keys()]).toEqual(["1.1.0"]);
    expect(fetch).toHaveBeenCalledWith("https://api.osv.dev/v1/query", expect.objectContaining({ method: "POST" }));
  });

  it("caches per package for an hour", async () => {
    let now = 0;
    const fetch = vi.fn(async () => Response.json({ vulns: [] }));
    const audit = new OsvAudit({ fetch, failOpen: false, now: () => now });
    await audit.audit("npm", "a");
    await audit.audit("npm", "a");
    now += 3_600_001;
    await audit.audit("npm", "a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails closed when OSV is unreachable, unless configured to fail open", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(new OsvAudit({ fetch, failOpen: false }).audit("npm", "a")).rejects.toMatchObject({
      status: 503,
      code: "wardby_audit_unavailable",
    });
    await expect(new OsvAudit({ fetch, failOpen: true }).audit("npm", "a")).resolves.toMatchObject({});
  });
});
