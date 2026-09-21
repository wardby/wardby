/**
 * Read-only lookup for which model IDs the deployment actually has an LLM
 * provider registered for — without it, the only way to learn a valid
 * model name was to trigger a run and read the "Known models" list off a
 * failed run's error message.
 */
import type { WardbyMcpServer } from "../server.js";
import type { RoutingLlmProvider } from "../../providers/llm/index.js";
import { textResult } from "./text-result.js";

export function registerModelTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "list_models",
    scope: "agents:read",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args: Record<string, never>, ctx) => {
      // Production always wires ctx.providers.llm as a RoutingLlmProvider
      // (see buildMcpProviders in mcp/index.ts) — listModels() is specific
      // to that composite router, not part of the single-provider LlmProvider seam.
      const llm = ctx.providers.llm as RoutingLlmProvider;
      return textResult({ models: llm.listModels() });
    },
  });
}
