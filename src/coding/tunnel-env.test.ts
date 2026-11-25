import { describe, expect, it } from "vitest";
import { deriveTunnelToken } from "./tunnel-token.js";
import { TUNNEL_CA_RELATIVE_PATH, tunnelProxyEnv, tunnelTrustEnv } from "./tunnel-env.js";

const token = deriveTunnelToken("capability-for-a-test");

describe("tunnelProxyEnv", () => {
  it("points both HTTP and HTTPS at the tunnel port in both cases", () => {
    const env = tunnelProxyEnv({ proxyHost: "wardby-proxy", port: 8789, token });
    const url = `http://run:${token}@wardby-proxy:8789`;
    expect(env).toMatchObject({ HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url });
  });

  it("keeps the proxy's own address out of the tunnel", () => {
    const env = tunnelProxyEnv({ proxyHost: "wardby-proxy", port: 8789, token });
    expect(env.NO_PROXY.split(",")).toEqual(["localhost", "127.0.0.1", "::1", "wardby-proxy"]);
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it("sets nothing but the proxy variables", () => {
    const env = tunnelProxyEnv({ proxyHost: "wardby-proxy", port: 8789, token });
    expect(Object.keys(env).sort()).toEqual(
      ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"].sort(),
    );
  });

  it("carries only the tunnel-only token, never the capability", () => {
    const capability = "capability-for-a-test";
    const env = tunnelProxyEnv({ proxyHost: "wardby-proxy", port: 8789, token: deriveTunnelToken(capability) });
    expect(JSON.stringify(env)).not.toContain(capability);
  });
});

describe("tunnelTrustEnv", () => {
  it("points the tools that add to the system roots at the file, and no replace-style variable", () => {
    const env = tunnelTrustEnv("/workspace/.cache/tunnel/ca.crt");
    expect(env).toEqual({
      SSL_CERT_FILE: "/workspace/.cache/tunnel/ca.crt",
      NODE_EXTRA_CA_CERTS: "/workspace/.cache/tunnel/ca.crt",
      PIP_CERT: "/workspace/.cache/tunnel/ca.crt",
    });
    // These replace the system roots in most clients, so a CA-only file would break every other tunnelled host.
    expect(env).not.toHaveProperty("REQUESTS_CA_BUNDLE");
    expect(env).not.toHaveProperty("CURL_CA_BUNDLE");
  });

  it("keeps the file under the run's cache root", () => {
    expect(TUNNEL_CA_RELATIVE_PATH).toBe("tunnel/ca.crt");
  });
});
