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
import {
  McpServer,
  fromJsonSchema,
  createRequestStateCodec,
  CLIENT_CAPABILITIES_META_KEY,
  type McpServerFactory,
  type ServerContext,
  type InputRequiredResult,
} from "@modelcontextprotocol/server";
import { randomBytes } from "node:crypto";
import type { Agent, PrismaClient, Principal } from "@prisma/client";
import type { McpRequestContext, McpProviders } from "./context.js";
import { requireScope } from "./auth/resource-server.js";
import { McpError } from "./errors.js";
import { TASKS_EXTENSION_ID, clientSupportsTasks } from "./capabilities.js";
import { visibleToPrincipal } from "./auth/ownership.js";
import { logger } from "../core/logger.js";

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
  ) => Promise<{ content: { type: "text"; text: string }[]; structuredContent?: unknown } | InputRequiredResult>;
}

export interface McpServerConfig {
  canonicalUri: string;
}

export interface BuildMcpServerOptions {
  providers: McpProviders;
  db: PrismaClient;
  config: McpServerConfig;
  /** Testability hook for REQUEST_STATE_KEY — defaults to process.env, matching buildSecretCipher's convention. */
  env?: NodeJS.ProcessEnv;
}

export interface DiscoverResultLike {
  capabilities: { extensions?: Record<string, unknown>; [key: string]: unknown };
}

export interface ReevoMcpServer {
  registerTool<Args = Record<string, unknown>>(spec: ToolSpec<Args>): void;
  /**
   * Registers a custom JSON-RPC method (e.g. the Tasks extension's
   * tasks/get, tasks/cancel, tasks/update — there is no npm runtime package
   * for the extension, see Task 6's ledger note, so these are hand-wired
   * the same way this SDK itself expects any custom method to be added:
   * `Server.setRequestHandler`). Scope is enforced BEFORE the handler runs,
   * exactly like registerTool — a custom method is not exempt from the
   * scope gate just because it isn't a tool.
   */
  registerRequestHandler(
    method: string,
    scope: string | string[],
    handler: (params: unknown, ctx: McpRequestContext) => Promise<unknown>,
  ): void;
  /** Passed directly to createMcpHandler (Task 7) / serveStdio (below). */
  factory: McpServerFactory;
  /** Local capability introspection without a protocol round-trip. */
  discover(): Promise<DiscoverResultLike>;
  /** stdio only: the one fixed identity every call in this connection resolves to. */
  setFixedContext(ctx: McpRequestContext | undefined): void;
  /**
   * Seals `payload` into the opaque `requestState` string a multi-round-trip
   * tool hands back via `inputRequired({ requestState })`. Backed by one
   * HMAC codec created for the life of this `ReevoMcpServer` (stable across
   * every `factory()` call, so state minted on one call verifies on a
   * later one) — see the module doc for why the key never needs to be
   * shared beyond this process.
   */
  mintRequestState<T>(payload: T): Promise<string>;
  /**
   * Verifies a `requestState`-shaped token OUTSIDE the normal MCP request
   * path — used by the secret-elicitation browser form (stdio's ephemeral
   * local server, or the HTTP transport's mounted route), which receives
   * the token via a URL query param rather than the protocol's own
   * `requestState` field. Throws on a malformed, tampered, or expired
   * token. Uses the same codec as `mintRequestState`/the SDK's own
   * `ServerOptions.requestState.verify` hook, so a token is valid on
   * either path interchangeably.
   */
  verifyRequestState<T>(token: string): Promise<T>;
}

interface AuthInfoExtra {
  principal?: Principal;
}

const REQUEST_STATE_KEY_BYTES = 32;

/**
 * REQUEST_STATE_KEY (hex, 32 bytes) shares the requestState HMAC key across
 * instances — see the requestStateCodec construction below. Unset falls back
 * to a fresh random key, which is correct for stdio and single-instance HTTP
 * and is NOT an error: only a multi-instance HTTP deployment needs this set.
 */
function loadRequestStateKey(env: NodeJS.ProcessEnv): Uint8Array {
  const hex = env.REQUEST_STATE_KEY;
  if (!hex) return randomBytes(REQUEST_STATE_KEY_BYTES);
  const key = Buffer.from(hex, "hex");
  if (key.length !== REQUEST_STATE_KEY_BYTES) {
    throw new Error(
      `REQUEST_STATE_KEY must be ${REQUEST_STATE_KEY_BYTES} bytes of hex (${REQUEST_STATE_KEY_BYTES * 2} hex chars); got ${key.length} bytes.`,
    );
  }
  return key;
}

/**
 * Shown to every connecting client at session start (Claude Code and other
 * compliant clients surface this directly to the calling assistant) — the
 * main discovery channel for "you can run a reevo-run agent's prompt
 * yourself, right now, instead of only via its schedule/trigger." Paired
 * with the per-agent MCP prompts registered below, which are the concrete,
 * one-call way to actually do it.
 */
const SERVER_INSTRUCTIONS =
  'reevo-run hosts reusable LLM agents (a system prompt, model, budget, and attached tools) that normally run on a schedule or webhook trigger. Every agent\'s full system prompt is available via list_agents/get_agent ("systemPrompt" field), and agents you can see are also registered as MCP prompts by name — you can adopt an agent\'s instructions and run them yourself, in this session, right now. This is a good way to shift work like code review left: e.g., before committing, run the "systemPrompt" of a code-review agent against your own working tree using your own tools, rather than waiting for a separately triggered run. Where a pulled prompt names a reevo-run-specific sandboxed tool, use your own equivalent tool for the same purpose instead.';

/** The MCP prompt body for one Agent — the message a client injects when a user invokes it (e.g. as a slash command). */
function agentPromptText(agent: Pick<Agent, "name" | "model" | "systemPrompt">): string {
  return [
    `You are adopting the instructions of reevo-run agent "${agent.name}" (model "${agent.model}") to run directly in this session, instead of waiting for its schedule/trigger.`,
    "Follow the instructions below as this conversation's operating instructions. Where they name a specific reevo-run tool that isn't available here, use your own equivalent tool for the same purpose instead.",
    "---",
    agent.systemPrompt,
  ].join("\n\n");
}

export function buildMcpServer(opts: BuildMcpServerOptions): ReevoMcpServer {
  const specs: ToolSpec<never>[] = [];
  const requestHandlers: {
    method: string;
    scope: string[];
    handler: (params: unknown, ctx: McpRequestContext) => Promise<unknown>;
  }[] = [];
  let fixedContext: McpRequestContext | undefined;

  // No `bind` callback, so `ctx` is never read by mint()/verify() (confirmed
  // against the codec's implementation) — safe to call verifyRequestState()
  // from outside a real MCP request (the secret-elicitation browser form).
  //
  // REQUEST_STATE_KEY, when set, lets a token minted by one process verify
  // on another — required for the secret-elicitation round trip (mint,
  // browser-form POST, polling retry) to work under a multi-instance HTTP
  // deployment, where those three legs can land on three different
  // processes (see secret-elicitation.ts's matching Postgres-backed outcome
  // store). stdio and single-instance HTTP need no configuration: with the
  // env var unset, a fresh random key per process is fine, since nothing
  // outside this same running server ever needs to verify a token it minted.
  const requestStateCodec = createRequestStateCodec<unknown>({
    key: loadRequestStateKey(opts.env ?? process.env),
    ttlSeconds: 600,
  });

  function mcpReqOf(sdkCtx: ServerContext): McpRequestContext["mcpReq"] {
    return {
      inputResponses: sdkCtx.mcpReq?.inputResponses,
      requestState: sdkCtx.mcpReq?.requestState ?? (() => undefined),
    };
  }

  function resolveCtx(sdkCtx: ServerContext): McpRequestContext {
    const authInfo = sdkCtx.http?.authInfo;
    const extra = authInfo?.extra as AuthInfoExtra | undefined;
    if (extra?.principal) {
      return {
        principal: extra.principal,
        scopes: new Set(authInfo!.scopes),
        canonicalUri: opts.config.canonicalUri,
        providers: opts.providers,
        db: opts.db,
        mcpReq: mcpReqOf(sdkCtx),
        clientSupportsTasks: clientSupportsTasks(
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- ESLint's type-checked view of `envelope` disagrees with the real tsc build; the cast is load-bearing there.
          (sdkCtx.mcpReq?.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] as
            { extensions?: Record<string, unknown> } | undefined,
        ),
      };
    }
    if (fixedContext) return { ...fixedContext, mcpReq: mcpReqOf(sdkCtx) };
    throw new McpError(401, "No authenticated context available for this call.");
  }

  function registerTool<Args = Record<string, unknown>>(spec: ToolSpec<Args>): void {
    specs.push(spec);
  }

  function registerRequestHandler(
    method: string,
    scope: string | string[],
    handler: (params: unknown, ctx: McpRequestContext) => Promise<unknown>,
  ): void {
    requestHandlers.push({ method, scope: Array.isArray(scope) ? scope : [scope], handler });
  }

  const factory: McpServerFactory = async () => {
    const mcpServer = new McpServer(
      { name: "reevo-run", version: "0.0.0" },
      {
        requestState: { verify: (state, ctx) => requestStateCodec.verify(state, ctx) },
        instructions: SERVER_INSTRUCTIONS,
      },
    );
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

    // Non-spec (extension) methods need a { params, result } schema bundle
    // — setRequestHandler only resolves schemas from the method name for
    // spec methods (see docs/advanced/custom-methods.md). A permissive
    // passthrough JSON Schema on both sides keeps this generic: real
    // validation of taskId/etc. happens inside each handler, not here.
    const PERMISSIVE_SCHEMA = fromJsonSchema<Record<string, unknown>>({ type: "object", additionalProperties: true });
    for (const { method, scope, handler } of requestHandlers) {
      mcpServer.server.setRequestHandler(
        method,
        { params: PERMISSIVE_SCHEMA },
        async (params: unknown, sdkCtx: ServerContext) => {
          const ctx = resolveCtx(sdkCtx);
          requireScope(ctx, opts.config.canonicalUri, ...scope);
          return (await handler(params, ctx)) as Record<string, unknown>;
        },
      );
    }

    // One MCP prompt per Agent this connection can see, so a client that
    // supports the prompts UI (e.g. a slash-command picker) can run a
    // reevo-run agent directly — the concrete half of the "shift left"
    // discovery story SERVER_INSTRUCTIONS introduces. Identity isn't
    // reliably known yet for an HTTP connection at this point (resolveCtx
    // resolves it per-dispatch from the SDK's own per-call ServerContext,
    // not at factory time) — stdio's fixedContext IS set by now
    // (mcp/index.ts calls setFixedContext before serveStdio ever invokes
    // this factory), so stdio sees every agent it owns plus public ones;
    // HTTP conservatively falls back to public-only until this factory can
    // see request-scoped identity. A DB hiccup here must not break tool
    // registration — this is a discoverability nicety, not core function.
    try {
      const where = fixedContext ? visibleToPrincipal(fixedContext.principal.id) : { ownerId: null };
      const agents = await opts.db.agent.findMany({ where });
      for (const agent of agents) {
        mcpServer.registerPrompt(
          agent.name,
          {
            title: agent.name,
            description: `Run reevo-run agent "${agent.name}" (model ${agent.model}) directly in this session, instead of via its schedule/trigger.`,
          },
          () => ({
            messages: [{ role: "user" as const, content: { type: "text" as const, text: agentPromptText(agent) } }],
          }),
        );
      }
    } catch (err) {
      logger.warn({ err }, "failed to register agent prompts — continuing without them");
    }

    return mcpServer;
  };

  async function discover(): Promise<DiscoverResultLike> {
    const probe = (await factory({ era: "modern" })) as McpServer;
    return { capabilities: probe.server.getCapabilities() };
  }

  function setFixedContext(ctx: McpRequestContext | undefined): void {
    fixedContext = ctx;
  }

  function mintRequestState<T>(payload: T): Promise<string> {
    return requestStateCodec.mint(payload);
  }

  function verifyRequestState<T>(token: string): Promise<T> {
    // `ctx` is unused by verify() when no `bind` is configured (see the
    // codec construction above) — this cast stands in for the real
    // ServerContext an MCP request would supply.
    return requestStateCodec.verify(token, {} as ServerContext) as Promise<T>;
  }

  return {
    registerTool,
    registerRequestHandler,
    factory,
    discover,
    setFixedContext,
    mintRequestState,
    verifyRequestState,
  };
}
