/**
 * The proxy variables that point a run's commands at the coding proxy's CONNECT tunnel
 * (docs/coding-proxy-tunnel.md). One builder for every launcher, so a Codex shell and Claude's tool
 * runner get the same settings. The token is deriveTunnelToken(capability): tunnel-only, never the
 * capability, and it must be redacted wherever the registry token is.
 */

/** Hosts that never go through the tunnel: the machine itself, and the proxy's own address. */
export function tunnelNoProxy(proxyHost: string): string {
  return ["localhost", "127.0.0.1", "::1", proxyHost].join(",");
}

/**
 * Both cases of each name, because clients disagree on which they read. The proxy's own address is
 * in NO_PROXY: registry and model requests go to its main port directly over plain HTTP, and would
 * otherwise be sent into the tunnel and refused.
 */
export function tunnelProxyEnv(input: { proxyHost: string; port: number; token: string }): Record<string, string> {
  const url = `http://run:${input.token}@${input.proxyHost}:${input.port}`;
  const noProxy = tunnelNoProxy(input.proxyHost);
  return {
    HTTPS_PROXY: url,
    https_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/** Where a run's cache root holds the CA certificate the proxy intercepts TLS with (tunnel-trust-ca.ts). */
export const TUNNEL_CA_RELATIVE_PATH = "tunnel/ca.crt";

/**
 * The variables that make a run's tools trust that certificate. Only those that add to the system roots:
 * the file holds the one CA, so a variable that replaces them (REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE) would
 * break TLS to every other tunnelled host. A tool that reads neither is not helped, and says so.
 */
export function tunnelTrustEnv(caFile: string): Record<string, string> {
  return { SSL_CERT_FILE: caFile, NODE_EXTRA_CA_CERTS: caFile, PIP_CERT: caFile };
}
