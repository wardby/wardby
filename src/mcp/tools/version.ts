import { packageVersion } from "../../core/version.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

/** Reports the installed Wardby version; exposes no instance data or credentials. */
export function registerVersionTool(mcp: WardbyMcpServer, version: () => string = packageVersion): void {
  mcp.registerTool({
    name: "get_version",
    description: "Return the version of the Wardby server this client is connected to.",
    scope: "agents:read",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    handler: async () => textResult({ version: version() }),
  });
}
