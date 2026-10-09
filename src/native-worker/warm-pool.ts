/**
 * The native sandbox warm pool (phase 6, docs/native-sandbox.md): up to NATIVE_SANDBOX_WARM_POOL_SIZE
 * idle workers, each already isolated (on Kubernetes: attested and probed from inside), holding no
 * run data and no capability. A run claims one with a compare-and-swap on its row
 * (warm-pool-ledger.ts), its input arrives by exec only after the claim, and the worker is
 * destroyed after that one run like any other. With no idle worker, or any doubt about the one it
 * claimed, a run cold-launches exactly as without a pool.
 *
 * Maintenance runs in the process that calls the executor's `launch()`: every tick it reaps rows
 * whose runs have ended, retires idle workers that are too old, of another spec, gone, or over the
 * size (only ever unclaimed ones), and replenishes the deficit. Claims work from any process.
 */

import { randomBytes } from "node:crypto";
import { logger } from "../core/logger.js";
import { nativeWarmWorkerName } from "./docker-isolation.js";
import type { NativeWorkerState } from "./docker-launcher.js";
import type { WorkerHandle } from "./launch.js";
import type { WorkerInput } from "./protocol.js";
import type { ManagedWorkerLauncher } from "./sandbox-executor.js";
import type { PrismaWarmPoolLedger, WarmWorkerRow } from "./warm-pool-ledger.js";

const poolLog = logger.child({ module: "native-warm-pool" });

export const NATIVE_SANDBOX_WARM_DELIVERY_FAILED = "native_sandbox_warm_delivery_failed";

/** What a launcher does for pool workers. Every operation is keyed by the worker's random token. */
export interface WarmWorkerLauncher {
  /** What its pool workers are built from (with the worker's wait): a claim takes only a matching one. */
  warmSpecHash(waitMs: number): string;
  /**
   * Creates a pool worker and proves its isolation, resolving once it is claimable. On failure it
   * removes what it created and throws.
   */
  startWarm(token: string, waitMs: number): Promise<void>;
  /** The claimed worker still runs, as built: cheap reads, not a new isolation probe. */
  reattestWarm(token: string, waitMs: number): Promise<boolean>;
  /** Writes the run's input into the worker over exec stdin (warm-delivery.ts). */
  deliver(token: string, input: WorkerInput): Promise<void>;
  warmHandle(token: string): WorkerHandle;
  inspectWarm(token: string): Promise<NativeWorkerState>;
  killWarm(token: string): Promise<void>;
  /** Removes the worker and everything made for it. Idempotent. */
  removeWarm(token: string): Promise<void>;
  /** The tokens of every pool worker this launcher holds, rows or not. */
  listWarm(): Promise<string[]>;
}

/** A pool worker waits this much longer than the max age, so a claim never meets one about to exit. */
const WAIT_MARGIN_MS = 5 * 60_000;
/** How long another configuration's idle worker is left alone before it is retired (rolling updates). */
const OTHER_SPEC_GRACE_MS = 60_000;
/** How long a removed worker that may hold a capability has to be confirmed gone before a cold launch. */
const GONE_TIMEOUT_MS = 30_000;

const runEnded = (status: string | undefined) => status !== "pending" && status !== "running";

export interface WarmPoolOptions {
  ledger: PrismaWarmPoolLedger;
  /** The cold launcher, which also runs pool workers. */
  launcher: ManagedWorkerLauncher & WarmWorkerLauncher;
  /** NATIVE_SANDBOX_WARM_POOL_SIZE. 0 still cleans up a pool left from an earlier configuration, once. */
  size: number;
  /** NATIVE_SANDBOX_WARM_MAX_AGE_MS. */
  maxAgeMs: number;
  /** How long starting and proving a pool worker may take; a `warming` row older than this was abandoned. */
  warmTimeoutMs: number;
  /** Marks a run's session ready once its input is delivered (when sessions start not ready: Kubernetes). */
  onDelivered?: (runId: string) => Promise<void>;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newToken?: () => string;
}

/** A ManagedWorkerLauncher that hands a run a warm worker when it can, and cold-launches otherwise. */
export class PooledWorkerLauncher implements ManagedWorkerLauncher {
  readonly networkReadyAtLaunch: boolean | undefined;
  readonly waitMs: number;
  readonly specHash: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  /** The one pass queued behind a running one: a tick asked for mid-pass sees state from after the ask. */
  private queued: Promise<void> | undefined;
  private readonly warming = new Set<Promise<void>>();
  /** Tokens this process is still starting: never reaped as abandoned, however slow. */
  private readonly warmingHere = new Set<string>();
  /** The first pass (orphan sweep included) has run. */
  private swept = false;

  constructor(private readonly options: WarmPoolOptions) {
    this.networkReadyAtLaunch = options.launcher.networkReadyAtLaunch;
    this.waitMs = options.maxAgeMs + WAIT_MARGIN_MS;
    this.specHash = options.launcher.warmSpecHash(this.waitMs);
  }

  private get cold(): ManagedWorkerLauncher & WarmWorkerLauncher {
    return this.options.launcher;
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? ((t) => new Promise((resolve) => setTimeout(resolve, t))))(ms);
  }

  async launch(input: WorkerInput): Promise<WorkerHandle> {
    const runId = input.runId;
    const claimed =
      this.options.size > 0
        ? await this.options.ledger
            .claim(runId, this.specHash, new Date(this.now() - this.options.maxAgeMs))
            .catch((err: unknown) => {
              poolLog.warn({ err, runId }, "warm pool claim failed; launching cold");
              return null;
            })
        : null;
    if (!claimed) {
      if (this.options.size > 0) poolLog.info({ runId, event: "miss" }, "no idle warm worker; launching cold");
      this.nudge();
      return this.cold.launch(input);
    }
    const token = claimed.id;
    this.nudge();
    const intact = await this.cold.reattestWarm(token, this.waitMs).catch(() => false);
    if (!intact) {
      poolLog.warn({ runId, worker: claimed.name, event: "fallback" }, "claimed warm worker failed re-attest");
      await this.discard(token);
      return this.cold.launch(input);
    }
    try {
      await this.cold.deliver(token, input);
    } catch (err) {
      // The worker may hold the capability now: it must be gone before another worker gets it.
      poolLog.warn({ err, runId, worker: claimed.name, event: "fallback" }, "warm delivery failed");
      await this.cold.removeWarm(token).catch(() => {});
      const gone = await this.confirmGone(token);
      if (!gone) {
        throw new Error(
          `${NATIVE_SANDBOX_WARM_DELIVERY_FAILED}: the run's input could not be delivered to its warm worker, which could not be confirmed stopped.`,
          { cause: err },
        );
      }
      await this.options.ledger.remove(token);
      return this.cold.launch(input);
    }
    if (this.networkReadyAtLaunch === false) await this.options.onDelivered?.(runId);
    poolLog.info({ runId, worker: claimed.name, event: "claimed" }, "run claimed a warm worker");
    return this.cold.warmHandle(token);
  }

  private async confirmGone(token: string): Promise<boolean> {
    const until = this.now() + GONE_TIMEOUT_MS;
    for (;;) {
      const state = await this.cold.inspectWarm(token).catch(() => undefined);
      if (state?.state === "missing") return true;
      if (this.now() >= until) return false;
      await this.sleep(1_000);
    }
  }

  /** Removes a pool worker and its row. */
  private async discard(token: string): Promise<void> {
    await this.cold.removeWarm(token).catch((err: unknown) => {
      poolLog.warn({ err, token }, "removing a warm worker failed; the next tick retries");
    });
    await this.options.ledger.remove(token);
  }

  private async claimedToken(runId: string): Promise<string | undefined> {
    return (await this.options.ledger.forRun(runId))?.id;
  }

  handle(runId: string): WorkerHandle {
    const token = this.claimedToken(runId);
    const handle = token.then((t) => (t ? this.cold.warmHandle(t) : this.cold.handle(runId)));
    return {
      exited: handle.then((h) => h.exited),
      kill: () => void handle.then((h) => h.kill()),
    };
  }

  async inspect(runId: string): Promise<NativeWorkerState> {
    const token = await this.claimedToken(runId);
    return token ? this.cold.inspectWarm(token) : this.cold.inspect(runId);
  }

  async kill(runId: string): Promise<void> {
    const token = await this.claimedToken(runId);
    return token ? this.cold.killWarm(token) : this.cold.kill(runId);
  }

  async remove(runId: string): Promise<void> {
    const token = await this.claimedToken(runId);
    if (!token) return this.cold.remove(runId);
    await this.cold.removeWarm(token);
    await this.options.ledger.remove(token);
  }

  listWorkers(): Promise<{ name: string; runHash: string }[]> {
    return this.cold.listWorkers();
  }
  removeByWorkerName(name: string): Promise<void> {
    return this.cold.removeByWorkerName(name);
  }
  get resolveGatewayUrl(): (() => Promise<string>) | undefined {
    return this.cold.resolveGatewayUrl?.bind(this.cold);
  }

  /**
   * Starts maintenance: one pass now, then one every interval. At size 0 a pass is a single count
   * of pool rows until one appears: a replica still running a bigger size during a rolling update
   * can refill the pool after this replica's first pass, and only a later pass retires those.
   */
  async start(): Promise<void> {
    await this.tick();
    this.swept = true;
    if (!this.timer) {
      this.timer = setInterval(() => this.nudge(), this.options.intervalMs ?? 15_000);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Asks for a pass soon, only in the process running maintenance: a short-lived CLI never warms workers. */
  private nudge(): void {
    if (this.timer) void this.tick();
  }

  /** One maintenance pass; resolves once reaping and retiring are done (warming continues behind it). */
  tick(): Promise<void> {
    if (this.ticking) {
      this.queued ??= this.ticking.then(() => {
        this.queued = undefined;
        return this.tick();
      });
      return this.queued;
    }
    this.ticking = this.maintain()
      .catch((err: unknown) => poolLog.warn({ err }, "warm pool maintenance failed"))
      .finally(() => {
        this.ticking = undefined;
      });
    return this.ticking;
  }

  /** Resolves once every worker this process is warming has settled (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.warming.size > 0) await Promise.allSettled([...this.warming]);
  }

  private async maintain(): Promise<void> {
    const { ledger, size } = this.options;
    // With no pool configured, a pass costs one count until another replica leaves rows behind.
    if (size === 0 && this.swept && (await ledger.count()) === 0) return;
    // Listed before the rows are read: a row always exists before its worker, so a worker listed
    // here with no row below is an orphan, never one another replica is still creating.
    const live = new Set(await this.cold.listWarm());
    const rows = await ledger.workers();
    const now = this.now();
    const bornAfter = now - this.options.maxAgeMs;
    const keepIdle: WarmWorkerRow[] = [];
    for (const row of rows) {
      live.delete(row.id);
      if (row.status === "claimed") {
        if (!row.run || runEnded(row.run.status)) await this.discard(row.id);
      } else if (row.status === "warming") {
        if (row.createdAt.getTime() < now - this.options.warmTimeoutMs - 60_000 && !this.warmingHere.has(row.id)) {
          await this.discard(row.id);
          poolLog.info({ worker: row.name, event: "reaped" }, "abandoned warming worker removed");
        }
      } else if (row.status === "retiring") {
        await this.discard(row.id);
      } else if (row.specHash !== this.specHash) {
        // Another configuration's worker is never claimed here. It is retired once it is past the
        // grace, not at once: during a rolling update the old and new replicas would otherwise
        // retire each other's fresh workers and refill their own, over and over.
        if (row.createdAt.getTime() < now - OTHER_SPEC_GRACE_MS) await this.retire(row, "stale");
      } else {
        const stale = row.createdAt.getTime() <= bornAfter;
        const running = !stale && (await this.cold.inspectWarm(row.id).catch(() => undefined))?.state === "running";
        if (running) keepIdle.push(row);
        else await this.retire(row, stale ? "stale" : "gone");
      }
    }
    // Over the size (it was lowered): retire the oldest idle workers first.
    keepIdle.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const row of keepIdle.slice(0, Math.max(0, keepIdle.length - size))) await this.retire(row, "excess");
    for (const orphan of live) {
      await this.cold.removeWarm(orphan).catch(() => {});
      poolLog.info({ token: orphan, event: "reaped" }, "orphan warm worker removed");
    }
    if (size > 0) await this.replenish();
  }

  private async retire(row: WarmWorkerRow, reason: string): Promise<void> {
    // Only an idle worker is retired: the compare-and-swap loses to a claim.
    if (!(await this.options.ledger.retire(row.id))) return;
    await this.discard(row.id);
    poolLog.info({ worker: row.name, reason, event: "retired" }, "warm worker retired");
  }

  private async replenish(): Promise<void> {
    const newToken = this.options.newToken ?? (() => randomBytes(10).toString("hex"));
    const reserved = await this.options.ledger.reserve(
      this.specHash,
      this.options.size,
      newToken,
      nativeWarmWorkerName,
    );
    for (const { id, name } of reserved) {
      this.warmingHere.add(id);
      const started = this.now();
      const warming = this.cold
        .startWarm(id, this.waitMs)
        .then(async () => {
          if (await this.options.ledger.markIdle(id)) {
            poolLog.info({ worker: name, ms: this.now() - started, event: "warmed" }, "warm worker ready");
          } else {
            await this.discard(id);
          }
        })
        .catch(async (err: unknown) => {
          poolLog.warn({ err, worker: name }, "starting a warm worker failed");
          await this.options.ledger.remove(id).catch(() => {});
        })
        .finally(() => {
          this.warmingHere.delete(id);
          this.warming.delete(warming);
        });
      this.warming.add(warming);
    }
  }
}
