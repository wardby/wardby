import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "./registry/token.js";
import { deriveTunnelToken } from "./tunnel-token.js";

describe("deriveTunnelToken", () => {
  it("is rtn_ followed by 32 bytes in base64url", () => {
    expect(deriveTunnelToken("rrp_capability")).toMatch(/^rtn_[A-Za-z0-9_-]{43}$/);
  });

  it("is the same for the same capability and different for another", () => {
    expect(deriveTunnelToken("rrp_one")).toBe(deriveTunnelToken("rrp_one"));
    expect(deriveTunnelToken("rrp_one")).not.toBe(deriveTunnelToken("rrp_two"));
  });

  it("is not the capability, and is not the registry token for it", () => {
    const capability = "rrp_capability";
    expect(deriveTunnelToken(capability)).not.toContain(capability);
    expect(deriveTunnelToken(capability)).not.toBe(deriveRegistryToken(capability));
    expect(deriveTunnelToken(capability).slice(4)).not.toBe(deriveRegistryToken(capability).slice(4));
  });
});
