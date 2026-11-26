import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { liveAdvertiseAddress } from "./address.js";

const iface = (address: string, internal: boolean, family: "IPv4" | "IPv6" = "IPv4") =>
  ({ address, internal, family, netmask: "", mac: "", cidr: null }) as NetworkInterfaceInfo;
const bind = { host: "0.0.0.0", port: 8080 };

describe("liveAdvertiseAddress", () => {
  it("uses WARDBY_LIVE_ADVERTISE_ADDRESS when set", () => {
    expect(liveAdvertiseAddress(bind, { WARDBY_LIVE_ADVERTISE_ADDRESS: " 10.1.2.3:9000 " }, {})).toBe("10.1.2.3:9000");
    expect(liveAdvertiseAddress(bind, { WARDBY_LIVE_ADVERTISE_ADDRESS: "wardby-1.internal:8080" }, {})).toBe(
      "wardby-1.internal:8080",
    );
  });

  it("refuses a value that is not host:port", () => {
    for (const bad of ["10.1.2.3", "http://10.1.2.3:80", "10.1.2.3:0", "10.1.2.3:70000", "a b:80"]) {
      expect(() => liveAdvertiseAddress(bind, { WARDBY_LIVE_ADVERTISE_ADDRESS: bad }, {})).toThrow(
        /WARDBY_LIVE_ADVERTISE_ADDRESS/,
      );
    }
  });

  it("otherwise uses the first non-internal IPv4 address with the HTTP port", () => {
    const ifs = {
      lo: [iface("127.0.0.1", true)],
      eth0: [iface("fe80::1", false, "IPv6"), iface("10.8.0.12", false)],
    };
    expect(liveAdvertiseAddress(bind, {}, ifs)).toBe("10.8.0.12:8080");
  });

  it("falls back to the bind address when there is no other", () => {
    expect(liveAdvertiseAddress(bind, {}, { lo: [iface("127.0.0.1", true)] })).toBe("0.0.0.0:8080");
  });
});
