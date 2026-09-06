/**
 * Read-only lookup for which model IDs the deployment actually has an LLM
 * provider registered for — without it, the only way to learn a valid
 * model name was to trigger a run and read the "Known models" list off a
 * failed run's error message.
 */
import type { ReevoMcpServer } from "../server.js";
import type { RoutingLlmProvider } from "../../providers/llm/index.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function registerModelTools(mcp: ReevoMcpServer): void {
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
