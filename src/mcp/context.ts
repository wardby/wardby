/**
 * Per-request context every MCP tool handler receives: who's calling
 * (principal + granted scopes) and what they can call into (the same
 * ProviderRegistry the CLI uses — no business logic lives in the MCP
 * layer, handlers just call core functions with this context).
 */
import type { Principal, PrismaClient } from "@prisma/client";
import type { ProviderRegistry } from "../providers/index.js";

export interface McpRequestContext {
  principal: Principal;
  scopes: Set<string>;
  providers: ProviderRegistry;
  db: PrismaClient;
  /**
   * Whether THIS call's client declared the Tasks extension
   * (io.modelcontextprotocol/tasks) — read from the modern-era per-request
   * `_meta` envelope (`ctx.mcpReq.envelope.clientCapabilities`). A legacy
   * (2025-era) client carries no envelope at all and is therefore always
   * `false` here — Tasks is a 2026-07-28-only concept.
   */
  clientSupportsTasks: boolean;
}
