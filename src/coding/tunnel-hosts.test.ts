import { describe, expect, it } from "vitest";
import {
  ceilingAllows,
  currentTunnelAgentHostLevel,
  loadTunnelAgentHostLevel,
  matchTunnelHost,
  parseTunnelHostPattern,
  tunnelHostKind,
  tunnelHostsWithinCeiling,
} from "./tunnel-hosts.js";

describe("parseTunnelHostPattern", () => {
  it.each([
    ["api.example.com", "api.example.com", "exact"],
    ["*.example.com", "*.example.com", "suffix"],
    ["*", "*", "any"],
    ["  API.Example.COM  ", "api.example.com", "exact"],
    ["*.Example.COM.", "*.example.com", "suffix"],
    ["example.com.", "example.com", "exact"],
    ["*.example.co.uk", "*.example.co.uk", "suffix"],
    ["deep.sub.example.com", "deep.sub.example.com", "exact"],
    ["s3.amazonaws.com", "s3.amazonaws.com", "exact"],
    ["bücher.example", "xn--bcher-kva.example", "exact"],
    ["my_host.example.com", "my_host.example.com", "exact"],
  ])("accepts %j as %j (%s)", (raw, pattern, kind) => {
    expect(parseTunnelHostPattern(raw)).toEqual({ ok: true, pattern, kind });
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["https://example.com", "scheme_port_or_path"],
    ["example.com:443", "scheme_port_or_path"],
    ["example.com/path", "scheme_port_or_path"],
    ["user@example.com", "scheme_port_or_path"],
    ["example.com?x", "scheme_port_or_path"],
    ["[::1]", "scheme_port_or_path"],
    ["ex*.com", "wildcard_inside_label"],
    ["*example.com", "wildcard_inside_label"],
    ["a.*.example.com", "wildcard_inside_label"],
    ["*.*.example.com", "wildcard_inside_label"],
    ["**", "wildcard_inside_label"],
    ["10.0.0.1", "ip_address"],
    ["*.10.0.0.1", "ip_address"],
    ["127.1", "ip_address"],
    ["com", "public_suffix"],
    ["*.com", "public_suffix"],
    ["*.co.uk", "public_suffix"],
    ["co.uk", "public_suffix"],
    ["localhost", "public_suffix"],
    ["*.github.io", "public_suffix"],
    ["*.s3.amazonaws.com", "public_suffix"],
    ["-bad.example.com", "not_a_hostname"],
    ["a..example.com", "not_a_hostname"],
    [`${"a".repeat(64)}.example.com`, "not_a_hostname"],
  ])("refuses %j (%s)", (raw, reason) => {
    expect(parseTunnelHostPattern(raw)).toEqual({ ok: false, reason });
  });
});

describe("matchTunnelHost", () => {
  it("matches an exact host only", () => {
    expect(matchTunnelHost("api.example.com", ["api.example.com"])).toBe("api.example.com");
    expect(matchTunnelHost("x.api.example.com", ["api.example.com"])).toBeUndefined();
    expect(matchTunnelHost("example.com", ["api.example.com"])).toBeUndefined();
  });

  it("matches *.domain at several depths but not the domain itself", () => {
    const patterns = ["*.example.com"];
    expect(matchTunnelHost("a.example.com", patterns)).toBe("*.example.com");
    expect(matchTunnelHost("a.b.example.com", patterns)).toBe("*.example.com");
    expect(matchTunnelHost("a.b.c.d.example.com", patterns)).toBe("*.example.com");
    expect(matchTunnelHost("example.com", patterns)).toBeUndefined();
  });

  it("checks the label boundary", () => {
    expect(matchTunnelHost("evilexample.com", ["*.example.com"])).toBeUndefined();
    expect(matchTunnelHost("a.evilexample.com", ["*.example.com"])).toBeUndefined();
    expect(matchTunnelHost("example.com.evil.net", ["*.example.com"])).toBeUndefined();
    expect(matchTunnelHost("evilexample.com", ["example.com"])).toBeUndefined();
  });

  it("matches every hostname with *, but never an IP literal", () => {
    expect(matchTunnelHost("anything.example.org", ["*"])).toBe("*");
    expect(matchTunnelHost("10.0.0.1", ["*"])).toBeUndefined();
    expect(matchTunnelHost("::1", ["*"])).toBeUndefined();
  });

  it("is case-insensitive and returns the first matching pattern", () => {
    expect(matchTunnelHost("API.Example.com", ["*.example.com", "*"])).toBe("*.example.com");
    expect(matchTunnelHost("other.net", ["*.example.com", "*"])).toBe("*");
    expect(matchTunnelHost("other.net", [])).toBeUndefined();
  });
});

describe("the ceiling", () => {
  it("names each kind's lowest level", () => {
    expect(tunnelHostKind("*")).toBe("any");
    expect(tunnelHostKind("*.example.com")).toBe("suffix");
    expect(tunnelHostKind("example.com")).toBe("exact");
    for (const kind of ["exact", "suffix", "any"] as const) expect(ceilingAllows("off", kind)).toBe(false);
    expect(ceilingAllows("exact", "exact")).toBe(true);
    expect(ceilingAllows("exact", "suffix")).toBe(false);
    expect(ceilingAllows("pattern", "suffix")).toBe(true);
    expect(ceilingAllows("pattern", "any")).toBe(false);
    expect(ceilingAllows("any", "any")).toBe(true);
  });

  it("keeps only the patterns at or below the ceiling", () => {
    const patterns = ["api.example.com", "*.example.com", "*"];
    expect(tunnelHostsWithinCeiling(patterns, "off")).toEqual([]);
    expect(tunnelHostsWithinCeiling(patterns, "exact")).toEqual(["api.example.com"]);
    expect(tunnelHostsWithinCeiling(patterns, "pattern")).toEqual(["api.example.com", "*.example.com"]);
    expect(tunnelHostsWithinCeiling(patterns, "any")).toEqual(patterns);
  });

  it("reads CODING_TUNNEL_AGENT_HOSTS, off by default", () => {
    expect(loadTunnelAgentHostLevel({})).toBe("off");
    expect(loadTunnelAgentHostLevel({ CODING_TUNNEL_AGENT_HOSTS: " Pattern " })).toBe("pattern");
    for (const level of ["off", "exact", "pattern", "any"])
      expect(loadTunnelAgentHostLevel({ CODING_TUNNEL_AGENT_HOSTS: level })).toBe(level);
    expect(() => loadTunnelAgentHostLevel({ CODING_TUNNEL_AGENT_HOSTS: "secret-ish-value" })).toThrow(
      /^CODING_TUNNEL_AGENT_HOSTS must be "off", "exact", "pattern" or "any"\.$/,
    );
  });

  it("is off on the control plane unless the tunnel is on", () => {
    expect(currentTunnelAgentHostLevel({ CODING_TUNNEL_AGENT_HOSTS: "any" })).toBe("off");
    expect(currentTunnelAgentHostLevel({ CODING_TUNNEL_PORT: "8789", CODING_TUNNEL_AGENT_HOSTS: "any" })).toBe("any");
    expect(currentTunnelAgentHostLevel({ CODING_TUNNEL_PORT: "8789", CODING_TUNNEL_AGENT_HOSTS: "bogus" })).toBe("off");
  });
});
