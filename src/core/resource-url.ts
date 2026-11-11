/**
 * The MCP server URL rule, on its own so modules below mcp-servers.ts (oauth-secrets.ts, which
 * secrets.ts loads) can use it without an import cycle. mcp-servers.ts re-exports both names.
 */

export class McpServerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServerInputError";
  }
}

/** Validates a server URL: https, no userinfo, no fragment, default port; returns the normalised string. */
export function normaliseServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpServerInputError("The MCP server URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new McpServerInputError("The MCP server URL must use https.");
  if (url.username !== "" || url.password !== "")
    throw new McpServerInputError("The MCP server URL must not contain a username or password; use a brokered secret.");
  if (url.hash !== "") throw new McpServerInputError("The MCP server URL must not contain a fragment (#).");
  if (url.port !== "") throw new McpServerInputError("The MCP server URL must use the default https port (443).");
  return url.href;
}
