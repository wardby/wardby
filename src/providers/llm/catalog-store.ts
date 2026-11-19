/**
 * Holds this process's merged model catalog. Loads it at startup (failing
 * the process if the database is unreachable: running on the shipped catalog
 * alone would quietly re-enable models an admin turned off), then polls
 * ModelCatalogEntry every WARDBY_MODEL_CATALOG_REFRESH_SECONDS (default 45)
 * and swaps in a new immutable catalog. A failed poll keeps the last good
 * catalog. current() is synchronous: per-token pricing reads it.
 *
 * One store per process (serve, mcp, scheduler); installModelCatalog makes
 * it what currentModelCatalog() returns everywhere. Before a store is
 * installed (unit tests, offline CLI commands) currentModelCatalog() is the
 * shipped catalog.
 */
import { startInterval, type IntervalHandle } from "../../core/interval.js";
import { logger } from "../../core/logger.js";
import { buildCatalog, rowFromRecord, shippedCatalog, type ModelCatalog } from "./catalog.js";
import { SHIPPED_CATALOG, SHIPPED_CATALOG_VERSION } from "./catalog-shipped.js";
import type { CatalogRow } from "./catalog-types.js";

export interface CatalogDb {
  modelCatalogEntry: { findMany(): Promise<Record<string, unknown>[]> };
}

export interface CatalogLog {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}

const DEFAULT_REFRESH_SECONDS = 45;

export function refreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WARDBY_MODEL_CATALOG_REFRESH_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_REFRESH_SECONDS * 1000;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`WARDBY_MODEL_CATALOG_REFRESH_SECONDS must be a positive whole number of seconds (got "${raw}").`);
  }
  return Number(raw) * 1000;
}

export class CatalogStore {
  private catalog: ModelCatalog = shippedCatalog();
  private poller: IntervalHandle | undefined;
  private readonly intervalMs: number;
  private readonly log: CatalogLog;
  /** Monotonic id handed out per load attempt (poll or refreshNow), taken before the
   *  awaited fetch starts so loads can be ordered by when they were *initiated*, not
   *  when they happen to resolve. */
  private loadSeq = 0;
  /** The seq of the load currently reflected in `catalog`. A load whose result arrives
   *  after a newer one already applied is discarded — see `applyLoad`. */
  private appliedSeq = 0;
  /** True once `close()` has run; a load already in flight at that point must not
   *  assign into `catalog` or log on failure when it eventually settles. */
  private closed = false;

  constructor(
    private readonly db: CatalogDb,
    options: { intervalMs?: number; log?: CatalogLog } = {},
  ) {
    this.intervalMs = options.intervalMs ?? refreshIntervalMs();
    this.log = options.log ?? logger.child({ module: "model-catalog" });
  }

  async start(): Promise<void> {
    void this.poller?.stop();
    this.poller = undefined;
    this.closed = false;
    try {
      await this.applyLoad();
    } catch (err) {
      throw new Error(
        `Could not load the model catalog from the database: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    this.poller = startInterval({
      name: "model-catalog-refresh",
      everyMs: this.intervalMs,
      // A query hung past this is abandoned, so one stuck read cannot stop refreshes until restart.
      timeoutMs: this.intervalMs * 2,
      tick: async () => {
        try {
          await this.applyLoad();
        } catch (err) {
          if (this.closed) return;
          this.log.warn(
            { event: "models.catalog.refresh_failed", err: err instanceof Error ? err.message : String(err) },
            "model catalog refresh failed; keeping the last good catalog",
          );
        }
      },
    });
  }

  current(): ModelCatalog {
    return this.catalog;
  }

  async refreshNow(): Promise<void> {
    await this.applyLoad();
  }

  close(): void {
    this.closed = true;
    // `closed` already keeps a load in flight from assigning or logging, so close() need not wait for it.
    void this.poller?.stop();
    this.poller = undefined;
  }

  /** Runs one load, then applies it only if it is still the newest load to have
   *  started and the store hasn't been closed in the meantime. Rejects (without
   *  touching `catalog`) if the underlying load fails. */
  private async applyLoad(): Promise<void> {
    const seq = ++this.loadSeq;
    const next = await this.load();
    if (this.closed) return;
    if (seq > this.appliedSeq) {
      this.catalog = next;
      this.appliedSeq = seq;
    }
  }

  private async load(): Promise<ModelCatalog> {
    const records = await this.db.modelCatalogEntry.findMany();
    const rows: CatalogRow[] = [];
    for (const record of records) {
      const row = rowFromRecord(record);
      if (row) rows.push(row);
      else
        this.log.warn(
          { event: "models.catalog.row_invalid", provider: record.provider, modelId: record.modelId },
          "skipping a malformed ModelCatalogEntry row",
        );
    }
    return buildCatalog(SHIPPED_CATALOG, rows, SHIPPED_CATALOG_VERSION, (message) =>
      this.log.warn({ event: "models.catalog.conflict" }, message),
    );
  }
}

/**
 * Starts a store against `db`, installs it as what `currentModelCatalog()`
 * returns process-wide, and returns it. Throws (via `CatalogStore.start()`)
 * if the database is unreachable — every process that calls this fails
 * fast at startup rather than silently running on the shipped catalog
 * alone, which would quietly re-enable models an admin turned off.
 */
export async function startModelCatalog(
  db: CatalogDb,
  options: { intervalMs?: number; log?: CatalogLog } = {},
): Promise<CatalogStore> {
  const store = new CatalogStore(db, options);
  await store.start();
  installModelCatalog(store);
  return store;
}

let installed: CatalogStore | undefined;

export function installModelCatalog(store: CatalogStore): void {
  installed = store;
}

export function currentModelCatalog(): ModelCatalog {
  return installed?.current() ?? shippedCatalog();
}

export function uninstallModelCatalogForTests(): void {
  installed = undefined;
}
