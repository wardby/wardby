/**
 * MCP-layer errors that carry an HTTP status + WWW-Authenticate challenge —
 * the transport (Task 7) maps these to the actual HTTP response; JSON-RPC
 * dispatch (Task 6) maps them to a JSON-RPC error object. One error type
 * for both call sites avoids two parallel error hierarchies.
 */
export class McpError extends Error {
  readonly httpStatus: number;
  readonly wwwAuthenticate?: string;

  constructor(httpStatus: number, message: string, wwwAuthenticate?: string) {
    super(message);
    this.name = "McpError";
    this.httpStatus = httpStatus;
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export function unauthorized(message: string, resourceMetadataUrl: string): McpError {
  return new McpError(401, message, `Bearer resource_metadata="${resourceMetadataUrl}"`);
}

export function insufficientScope(scopes: string[], resourceMetadataUrl: string): McpError {
  return new McpError(
    403,
    `Insufficient scope; this operation requires: ${scopes.join(" ")}`,
    `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopes.join(" ")}"`,
  );
}
