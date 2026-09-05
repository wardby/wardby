import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { assertFetchDestinationAllowed } from "./fetch-policy.js";

async function expectBlocked(url: string) {
  await expect(assertFetchDestinationAllowed(url)).rejects.toThrow(/blocked/);
}
async function expectAllowed(url: string) {
  await expect(assertFetchDestinationAllowed(url)).resolves.toBeUndefined();
}

describe("assertFetchDestinationAllowed (literal IPs, no DNS involved)", () => {
  it("blocks the cloud instance metadata address", () => expectBlocked("http://169.254.169.254/latest/meta-data/"));
  it("blocks loopback (127.0.0.1)", () => expectBlocked("http://127.0.0.1:5432/"));
  it("blocks the localhost hostname literal", () => expectBlocked("http://localhost:5432/"));
  it("blocks RFC1918 10.0.0.0/8", () => expectBlocked("http://10.1.2.3/"));
  it("blocks RFC1918 172.16.0.0/12", () => expectBlocked("http://172.20.5.5/"));
  it("blocks RFC1918 192.168.0.0/16", () => expectBlocked("http://192.168.1.1/"));
  it("blocks carrier-grade NAT 100.64.0.0/10", () => expectBlocked("http://100.64.0.1/"));
  it("does not block a public IP just outside the 172.16/12 range", () => expectAllowed("http://172.32.0.1/"));
  it("blocks IPv6 loopback", () => expectBlocked("http://[::1]/"));
  it("blocks IPv6 link-local", () => expectBlocked("http://[fe80::1]/"));
  it("blocks IPv6 unique local", () => expectBlocked("http://[fd12:3456::1]/"));
  it("blocks an IPv4-mapped IPv6 loopback", () => expectBlocked("http://[::ffff:127.0.0.1]/"));
  it("allows a real public IP", () => expectAllowed("http://8.8.8.8/"));
});

describe("assertFetchDestinationAllowed (allowlist)", () => {
  it("allows an otherwise-blocked host when explicitly allowlisted", async () => {
    await expect(
      assertFetchDestinationAllowed("http://localhost:5432/", { allowedHosts: ["localhost"] }),
    ).resolves.toBeUndefined();
  });
});

describe("assertFetchDestinationAllowed (hostname resolution)", () => {
  beforeEach(() => {
    vi.doMock("node:dns/promises", () => ({
      lookup: vi.fn(async (hostname: string) => {
        if (hostname === "internal.example.test") {
          return [{ address: "10.0.0.5", family: 4 }];
        }
        return [{ address: "93.184.216.34", family: 4 }]; // a public address
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("node:dns/promises");
    vi.resetModules();
  });

  it("blocks a hostname that resolves to a private address (DNS-rebinding style)", async () => {
    vi.resetModules();
    const { assertFetchDestinationAllowed: freshAssert } = await import("./fetch-policy.js");
    await expect(freshAssert("http://internal.example.test/")).rejects.toThrow(/blocked/);
  });

  it("allows a hostname that resolves to a public address", async () => {
    vi.resetModules();
    const { assertFetchDestinationAllowed: freshAssert } = await import("./fetch-policy.js");
    await expect(freshAssert("http://public.example.test/")).resolves.toBeUndefined();
  });
});
