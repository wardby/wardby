/**
 * Per-request context every MCP tool handler receives: who's calling
 * (principal + granted scopes) and what they can call into. Narrowed to
 * the seams Phase 4's tool modules actually touch (llm/engine/datastore/
 * secrets/executor/memory) — same `Pick<ProviderRegistry, ...>` narrowing
 * this codebase already uses for `executeRun`/`RunnerDb`, since the full
 * registry also carries jobs/email/auth/storage seams no Phase 4 tool
 * needs and this plan never builds real adapters for.
 */
import type { Principal, PrismaClient } from "@prisma/client";
import type { RequestStateAccessor } from "@modelcontextprotocol/server";
import type { ProviderRegistry } from "../providers/index.js";

export type McpProviders = Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets" | "executor" | "memory">;

export interface McpRequestContext {
  principal: Principal;
  scopes: Set<string>;
  providers: McpProviders;
  db: PrismaClient;
  /**
   * The current call's multi-round-trip data (protocol revision 2026-07-28)
   * — present on every call so a tool can tell an initial call from a
   * retried one. `inputResponses` is only populated on a retry;
   * `requestState()` returns the verified payload minted by
   * `ReevoMcpServer.mintRequestState` on a prior round, or `undefined` on
   * an initial call. See src/mcp/tools/secrets.ts for the one current user.
   */
  mcpReq: { inputResponses?: Record<string, unknown>; requestState: RequestStateAccessor };
  /**
   * Whether THIS call's client declared the Tasks extension
   * (io.modelcontextprotocol/tasks) — read from the modern-era per-request
   * `_meta` envelope (`ctx.mcpReq.envelope.clientCapabilities`). A legacy
   * (2025-era) client carries no envelope at all and is therefore always
   * `false` here — Tasks is a 2026-07-28-only concept.
   */
  clientSupportsTasks: boolean;
}
