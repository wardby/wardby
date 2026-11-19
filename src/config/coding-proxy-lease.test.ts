import { describe, expect, it } from "vitest";
import { loadCodingProxyLeaseConfig } from "./coding-proxy-lease.js";

describe("loadCodingProxyLeaseConfig", () => {
  it("defaults to a 30 s lease renewed every 10 s and swept every 15 s", () => {
    expect(loadCodingProxyLeaseConfig({})).toEqual({ leaseMs: 30_000, heartbeatMs: 10_000, sweepMs: 15_000 });
  });

  it("reads the three settings in seconds", () => {
    expect(
      loadCodingProxyLeaseConfig({
        CODING_PROXY_LEASE_SECONDS: "90",
        CODING_PROXY_HEARTBEAT_SECONDS: "20",
        CODING_PROXY_SWEEP_SECONDS: "5",
      }),
    ).toEqual({ leaseMs: 90_000, heartbeatMs: 20_000, sweepMs: 5_000 });
  });

  it.each(["0", "-5", "1.5", "ten", "1e3"])("refuses %j as a setting", (value) => {
    expect(() => loadCodingProxyLeaseConfig({ CODING_PROXY_SWEEP_SECONDS: value })).toThrow(
      "CODING_PROXY_SWEEP_SECONDS must be a positive integer.",
    );
  });

  it("refuses a lease that does not outlast two heartbeats", () => {
    const message = "CODING_PROXY_LEASE_SECONDS must be greater than twice CODING_PROXY_HEARTBEAT_SECONDS.";
    expect(() => loadCodingProxyLeaseConfig({ CODING_PROXY_LEASE_SECONDS: "20" })).toThrow(message);
    expect(() =>
      loadCodingProxyLeaseConfig({ CODING_PROXY_LEASE_SECONDS: "30", CODING_PROXY_HEARTBEAT_SECONDS: "15" }),
    ).toThrow(message);
    expect(loadCodingProxyLeaseConfig({ CODING_PROXY_LEASE_SECONDS: "21" }).leaseMs).toBe(21_000);
  });
});
