/**
 * `wardby serve`: the complete wardby process. Runs the MCP server, the
 * scheduler, and the reconciler together on ONE provider set and ONE
 * executor, which is what a single-container deployment (Cloud Run, a lone
 * VM) needs - `wardby mcp` alone never fires a schedule.
 *
 * Why one executor: DbosExecutor is a per-process singleton and refuses to
 * launch twice under different ids (providers/executor/dbos.ts), and its
 * recovery decisions key on that id. Building providers once and sharing
 * them is the whole trick; it also gives scheduled native runs the same
 * `providers.executor` wiring MCP-triggered runs get, so sub-agent dispatch
 * from a scheduled run works (it does not from `wardby scheduler`).
 *
 * Why the scheduler and reconciler can run in every replica: the scheduler
 * elects one ticker via a Postgres lease and enforces at-most-once with row
 * locks regardless (core/scheduler.ts); the reconciler is deliberately not
 * lease-gated and is safe under concurrency (core/reconciler.ts).
 */
import type { Server } from "node:http";
import { loadCodingConcurrencyConfig, loadMcpConfig } from "./config/providers.js";
import { drainCodingQueue } from "./core/coding-queue.js";
import { prisma } from "./core/db.js";
import { logger } from "./core/logger.js";
import { DISABLED_POWER } from "./core/power.js";
import { startNotifications } from "./core/notifications.js";
import { startRunHookDispatcher } from "./core/run-hooks/dispatcher.js";
import { startReconciler } from "./core/reconciler.js";
import { createRepoAccessGate } from "./core/repo-access.js";
import { markRunFailedFromExecutorError } from "./core/dispatch.js";
import { startScheduler } from "./core/scheduler.js";
import { drainDeferredRuns } from "./providers/executor/deferred.js";
import { resolveDeferredCodingRun } from "./core/deferred-coding.js";
import { RunStepSweeper } from "./core/run-steps/sweep.js";
import { parseRunStepsListen, startRunStepIngress } from "./core/run-steps/ingress.js";
import type { McpProviders } from "./mcp/context.js";
import { buildMcpProviders, startMcp } from "./mcp/index.js";

const serveLog = logger.child({ module: "serve" });

export interface ServeOptions {
  /** Scheduler lease scope; defaults to "default" like `wardby scheduler --scope`. */
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
      `wardby serve requires MCP_TRANSPORT=http (got "${transport}"): in stdio mode stdout is the JSON-RPC wire ` +
        `and a scheduler has no stdio client to serve. Use "wardby mcp" for stdio.`,
    );
  }

  // Parsed before anything starts, so a malformed CODING_MAX_CONCURRENT or
  // CODING_QUEUE_TIMEOUT_SEC fails fast instead of after HTTP is listening.
  const concurrency = loadCodingConcurrencyConfig();
  // Run steps from the coding proxy (POST /internal/run-steps); parsed early so a bad value stops start-up.
  const runStepsListen = parseRunStepsListen(process.env.WARDBY_RUN_STEPS_LISTEN);
  const providers = options.providers ?? buildMcpProviders().providers;
  const power = providers.power ?? DISABLED_POWER;
  if (power.enabled) {
    void power.checkAccess().then(
      (missing) => {
        if (missing.length) serveLog.warn(`low_power_scale_forbidden: missing ${missing.join(", ")}`);
      },
      (err) => serveLog.warn({ err }, "low_power_access_check_failed"),
    );
  }
  const mcp = await startMcp({ providers, schedulerAttached: true });
  // Its own port (not the MCP listener's): only the coding proxy reaches it.
  let runStepIngress: Server | undefined;
  if (runStepsListen && providers.runSteps) {
    try {
      runStepIngress = await startRunStepIngress(runStepsListen, { db: prisma, sink: providers.runSteps });
    } catch (err) {
      await mcp.close();
      throw err;
    }
    serveLog.info({ host: runStepsListen.host, port: runStepsListen.port }, "run steps listener started");
  } else if (runStepsListen) {
    serveLog.warn("WARDBY_RUN_STEPS_LISTEN is set but this server has no run-steps writer; not listening");
  }
  const reviewHosts = providers.reviewHosts;
  const reconciler = startReconciler({
    executor: providers.executor,
    reviewHosts,
    issueTrackers: providers.issueTrackers,
    // Comment threads sent to runs that ended unanswered (lost, failed to start, missed hook).
    documentRuns: { db: prisma, cipher: providers.secrets, executor: providers.executor },
    ...(reviewHosts
      ? {
          deferredReviews: {
            db: prisma,
            executor: providers.executor,
            hosts: reviewHosts,
            repoAccess: providers.repoAccess ?? createRepoAccessGate({ db: prisma, hosts: reviewHosts }),
            ...(providers.issueTrackers ? { issueTrackers: providers.issueTrackers } : {}),
          },
        }
      : {}),
  });
  const notifications = await startNotifications({ db: prisma, chat: providers.chat ?? {} });
  // Run hooks deliver with or without a chat provider (every replica; a lease elects one sender).
  const runHooks = startRunHookDispatcher({ db: prisma, secrets: providers.secrets, datastore: providers.datastore });
  const selfDefects = { db: prisma, issueTrackers: providers.issueTrackers };
  // Expired run steps (RUN_STEP_RETENTION_DAYS), from the scheduler leader only.
  const runStepSweeper = new RunStepSweeper(prisma);
  const scheduler = startScheduler({
    executor: providers.executor,
    scope: options.scope,
    selfDefects,
    onLeaderTick: async () => {
      await drainCodingQueue({ db: prisma, executor: providers.executor, ...concurrency, selfDefects });
      // Runs the native sandbox gateway dispatched (or asked to stop): it holds no executor of its own.
      await drainDeferredRuns({
        db: prisma,
        executor: providers.executor,
        beforeStart: (runId) => resolveDeferredCodingRun({ db: prisma, executor: providers.executor, runId }),
        onStartFailed: (runId, err) => markRunFailedFromExecutorError(prisma, runId, err, selfDefects),
      });
      // Scale idle coding-proxy/native-gateway Deployments to zero (no-op unless WARDBY_LOW_POWER=1).
      await power.sleepIfIdle().catch((err) => serveLog.warn({ err }, "power_sleep_failed"));
      await runStepSweeper.maybeSweep();
    },
  });

  return {
    isLeader: () => scheduler.isLeader(),
    close: async () => {
      // Order matters under a SIGTERM grace period: stop creating new runs,
      // stop reaping, then let startMcp close HTTP and drain the executor.
      scheduler.stop();
      reconciler.stop();
      notifications.stop();
      runHooks.stop();
      // Before mcp.close(), which flushes the run-steps writer: no batch arrives after the flush.
      const ingress = runStepIngress;
      if (ingress) await new Promise<void>((resolve) => ingress.close(() => resolve()));
      await mcp.close();
    },
  };
}
