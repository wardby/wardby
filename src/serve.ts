/**
 * `reevo serve`: the complete reevo process. Runs the MCP server, the
 * scheduler, and the reconciler together on ONE provider set and ONE
 * executor, which is what a single-container deployment (Cloud Run, a lone
 * VM) needs - `reevo mcp` alone never fires a schedule.
 *
 * Why one executor: DbosExecutor is a per-process singleton and refuses to
 * launch twice under different ids (providers/executor/dbos.ts), and its
 * recovery decisions key on that id. Building providers once and sharing
 * them is the whole trick; it also gives scheduled native runs the same
 * `providers.executor` wiring MCP-triggered runs get, so sub-agent dispatch
 * from a scheduled run works (it does not from `reevo scheduler`).
 *
 * Why the scheduler and reconciler can run in every replica: the scheduler
 * elects one ticker via a Postgres lease and enforces at-most-once with row
 * locks regardless (core/scheduler.ts); the reconciler is deliberately not
 * lease-gated and is safe under concurrency (core/reconciler.ts).
 */
import { loadMcpConfig } from "./config/providers.js";
import { startReconciler } from "./core/reconciler.js";
import { startScheduler } from "./core/scheduler.js";
import type { McpProviders } from "./mcp/context.js";
import { buildMcpProviders, startMcp } from "./mcp/index.js";

export interface ServeOptions {
  /** Scheduler lease scope; defaults to "default" like `reevo scheduler --scope`. */
  scope?: string;
  /** Pre-built providers (tests); built once via buildMcpProviders() when omitted. */
  providers?: McpProviders;
}

export interface ServeHandle {
  /** Stops accepting schedule claims, then reconciling, then closes HTTP and the executor. */
  close(): Promise<void>;
  /** Whether this process currently holds the scheduler lease. */
  isLeader(): boolean;
}

export async function startServe(options: ServeOptions = {}): Promise<ServeHandle> {
  const transport = loadMcpConfig().transport;
  if (transport !== "http") {
    throw new Error(
      `reevo serve requires MCP_TRANSPORT=http (got "${transport}"): in stdio mode stdout is the JSON-RPC wire ` +
        `and a scheduler has no stdio client to serve. Use "reevo mcp" for stdio.`,
    );
  }

  const providers = options.providers ?? buildMcpProviders().providers;
  const mcp = await startMcp({ providers, schedulerAttached: true });
  const reconciler = startReconciler({ executor: providers.executor });
  const scheduler = startScheduler({ executor: providers.executor, scope: options.scope });

  return {
    isLeader: () => scheduler.isLeader(),
    close: async () => {
      // Order matters under a SIGTERM grace period: stop creating new runs,
      // stop reaping, then let startMcp close HTTP and drain the executor.
      scheduler.stop();
      reconciler.stop();
      await mcp.close();
    },
  };
}
