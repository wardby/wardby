/**
 * A stand-in for the Substrate egress gateway in front of the coding proxy, shared by the Codex and
 * Claude Code compatibility tests. Like the gateway's replaceHeaders, it replaces the worker's
 * placeholder `x-api-key` with the run's real capability, and its placeholder `x-wardby-mcp-token`
 * with the run's real MCP token, each only when the request carries that header, then pipes the
 * request on. Every other header passes through unchanged.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { INJECTED_MCP_TOKEN_PLACEHOLDER, MCP_TOKEN_HEADER } from "../coding/mcp-token.js";
import { PLACEHOLDER_CAPABILITY } from "../providers/jobs/substrate/names.js";

/** What the gateway simulator saw on one request: booleans only, never a header value. */
export interface GatewayObservation {
  url: string;
  hasAuthorization: boolean;
  /** Bearer rrp_placeholder_injected_by_gateway */
  authorizationIsPlaceholderBearer: boolean;
  /** Bearer rmt_placeholder_injected_by_gateway */
  authorizationIsMcpPlaceholderBearer: boolean;
  apiKeyIsPlaceholder: boolean;
  mcpTokenIsPlaceholder: boolean;
}

/** Like the egress gateway: replaces x-api-key and x-wardby-mcp-token only when present. */
export async function startGatewaySimulator(
  proxyPort: number,
  inject: { capability: string; mcpToken?: string },
): Promise<{ url: string; observed: GatewayObservation[]; close(): Promise<void> }> {
  const observed: GatewayObservation[] = [];
  const server = createServer((request, response) => {
    observed.push({
      url: request.url ?? "",
      hasAuthorization: request.headers.authorization !== undefined,
      authorizationIsPlaceholderBearer: request.headers.authorization === `Bearer ${PLACEHOLDER_CAPABILITY}`,
      authorizationIsMcpPlaceholderBearer: request.headers.authorization === `Bearer ${INJECTED_MCP_TOKEN_PLACEHOLDER}`,
      apiKeyIsPlaceholder: request.headers["x-api-key"] === PLACEHOLDER_CAPABILITY,
      mcpTokenIsPlaceholder: request.headers[MCP_TOKEN_HEADER] === INJECTED_MCP_TOKEN_PLACEHOLDER,
    });
    const headers: IncomingHttpHeaders = { ...request.headers, host: `127.0.0.1:${proxyPort}` };
    if (headers["x-api-key"] !== undefined) headers["x-api-key"] = inject.capability;
    if (headers[MCP_TOKEN_HEADER] !== undefined && inject.mcpToken !== undefined) {
      headers[MCP_TOKEN_HEADER] = inject.mcpToken;
    }
    const upstream = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: request.method, path: request.url, headers },
      (proxied) => {
        response.writeHead(proxied.statusCode ?? 502, proxied.headers);
        proxied.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
