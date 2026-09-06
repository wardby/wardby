/**
 * The MCP server core: wraps @modelcontextprotocol/server's McpServer with
 * reevo's own ToolSpec contract (scope-gated, McpRequestContext-aware).
 *
 * Architecture note (adapted from the plan during implementation): the SDK
 * already provides correct, spec-compliant serving entries —
 * `createMcpHandler` (HTTP, Task 7) and `serveStdio` (stdio, below) — both
 * of which construct a fresh McpServer per request/connection from a cheap,
 * side-effect-free `McpServerFactory`. Hand-rolling message dispatch
 * ourselves (an earlier draft of this file did exactly that) turned out to
 * require re-deriving the 2026-07-28 stateless per-request `_meta` envelope
 * by hand — fragile and exactly the kind of protocol-fidelity risk the real
 * SDK exists to remove. This file instead accumulates ToolSpecs and exposes
 * an `McpServerFactory`; the transports (this file's `runStdioServer` /
 * Task 7's HTTP transport) call it exactly the way the SDK expects.
 *
 * Auth threading: per-tool-call caller identity travels as the SDK's own
 * `AuthInfo.extra.principal` (an in-process object reference, never
 * serialized — see the official `scoped-tools` example, which enforces
 * scope the same way, inside each tool handler via `ctx.http?.authInfo`).
 * stdio has no per-call AuthInfo at all (serveStdio never sets it), so
 * `setFixedContext` supplies one fixed LOCAL_PRINCIPAL identity for the
 * whole connection.
 */
import { McpServer, fromJsonSchema, type McpServerFactory, type ServerContext } from "@modelcontextprotocol/server";
import type { PrismaClient, Principal } from "@prisma/client";
import type { ProviderRegistry } from "../providers/index.js";
import type { McpRequestContext } from "./context.js";
import { requireScope } from "./auth/resource-server.js";
import { McpError } from "./errors.js";
import { TASKS_EXTENSION_ID } from "./capabilities.js";

export interface ToolSpec<Args = Record<string, unknown>> {
  name: string;
  description?: string;
  /** Scope(s) required to call this tool — checked before the handler ever runs. */
  scope: string | string[];
  /**
   * A plain JSON Schema object (matching this codebase's existing
   * JSON-Schema-first tool convention — see src/sandbox/deriveJsonSchema).
   * Converted via the SDK's own `fromJsonSchema()` rather than accepted as
   * a zod raw shape: `McpServer.registerTool`'s zod-shape overload requires
   * REAL zod v4, and `@modelcontextprotocol/server` bundles its own nested
   * zod@4.5.4 copy — any zod v4 reevo-run itself installs (even the exact
   * same version) is a structurally-incompatible separate module instance.
   * JSON Schema has no such identity problem.
   */
  inputSchema?: Record<string, unknown>;
  handler: (
    args: Args,
    ctx: McpRequestContext,
  ) => Promise<{ content: { type: "text"; text: string }[]; structuredContent?: unknown }>;
}

export interface McpServerConfig {
  canonicalUri: string;
}

export interface BuildMcpServerOptions {
  providers: ProviderRegistry;
  db: PrismaClient;
  config: McpServerConfig;
}

export interface DiscoverResultLike {
  capabilities: { extensions?: Record<string, unknown>; [key: string]: unknown };
}

export interface ReevoMcpServer {
  registerTool<Args = Record<string, unknown>>(spec: ToolSpec<Args>): void;
  /** Passed directly to createMcpHandler (Task 7) / serveStdio (below). */
  factory: McpServerFactory;
  /** Local capability introspection without a protocol round-trip. */
  discover(): DiscoverResultLike;
  /** stdio only: the one fixed identity every call in this connection resolves to. */
  setFixedContext(ctx: McpRequestContext | undefined): void;
}

interface AuthInfoExtra {
  principal?: Principal;
}

export function buildMcpServer(opts: BuildMcpServerOptions): ReevoMcpServer {
  const specs: ToolSpec<never>[] = [];
  let fixedContext: McpRequestContext | undefined;

  function resolveCtx(sdkCtx: ServerContext): McpRequestContext {
    const authInfo = sdkCtx.http?.authInfo;
    const extra = authInfo?.extra as AuthInfoExtra | undefined;
    if (extra?.principal) {
      return { principal: extra.principal, scopes: new Set(authInfo!.scopes), providers: opts.providers, db: opts.db };
    }
    if (fixedContext) return fixedContext;
    throw new McpError(401, "No authenticated context available for this call.");
  }

  function registerTool<Args = Record<string, unknown>>(spec: ToolSpec<Args>): void {
    specs.push(spec as ToolSpec<never>);
  }

  const factory: McpServerFactory = () => {
    const mcpServer = new McpServer({ name: "reevo-run", version: "0.0.0" });
    mcpServer.server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } });

    for (const spec of specs) {
      const requiredScopes = Array.isArray(spec.scope) ? spec.scope : [spec.scope];
      mcpServer.registerTool(
        spec.name,
        {
          description: spec.description,
          inputSchema: spec.inputSchema ? fromJsonSchema(spec.inputSchema) : undefined,
        },
        async (args: unknown, sdkCtx: ServerContext) => {
          const ctx = resolveCtx(sdkCtx);
          requireScope(ctx, opts.config.canonicalUri, ...requiredScopes);
          return spec.handler(args as never, ctx);
        },
      );
    }

    return mcpServer;
  };

  function discover(): DiscoverResultLike {
    const probe = factory({ era: "modern" }) as McpServer;
    return { capabilities: probe.server.getCapabilities() };
  }

  function setFixedContext(ctx: McpRequestContext | undefined): void {
    fixedContext = ctx;
  }

  return { registerTool, factory, discover, setFixedContext };
}
