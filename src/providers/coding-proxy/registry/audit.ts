/**
 * OSV vulnerability audit for the coding package registry. One query per
 * package (cached), evaluated against every candidate version with the
 * ecosystem's own version comparator:
 *
 * - only `affected[]` entries for the queried package count: same OSV
 *   ecosystem, and the same name under the adapter's normalization (PEP 503
 *   for PyPI, exact for npm). A GHSA advisory lists every package it touches
 *   (e.g. `lodash-es`, or RubyGems `lodash-rails`), and none of those may
 *   leak onto the one being installed;
 * - a version is affected when it is listed in `versions`, or falls inside a
 *   SEMVER/ECOSYSTEM range (npm GHSA entries carry ranges only). Ranges are
 *   evaluated per the OSV schema: events sorted by version, `introduced`
 *   (including "0") opens, `fixed` closes (exclusive), `last_affected`
 *   closes (inclusive), `limit` bounds;
 * - a version or event the comparator cannot parse counts as affected
 *   (fail closed).
 */
import { RegistryError, type RegistryAdapter, type UpstreamFetch } from "../../../coding/registry/types.js";
import { boundedMetadataFetch, DEFAULT_MAX_METADATA_BYTES, DEFAULT_METADATA_TIMEOUT_MS } from "./bounded-fetch.js";

const OSV_QUERY = "https://api.osv.dev/v1/query";
const OSV_QUERY_BATCH = "https://api.osv.dev/v1/querybatch";
const OSV_VULN = "https://api.osv.dev/v1/vulns/";
/** OSV's own limit on queries per querybatch request. */
const OSV_BATCH_SIZE = 1000;
/** Rounds of per-query pagination one batch follows before giving up
 *  (fail closed): a package with that many pages of advisories is not a
 *  real case. */
const OSV_BATCH_MAX_PAGES = 20;
/** Advisory details fetched at once. */
const OSV_VULN_CONCURRENCY = 8;
export const DEFAULT_VULN_CACHE_ENTRIES = 10_000;
const BLOCKING = new Set(["HIGH", "CRITICAL"]);
const RANGE_TYPES = new Set(["SEMVER", "ECOSYSTEM"]);

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}
interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: { type?: string; events?: OsvEvent[] }[];
  versions?: string[];
}
interface OsvVuln {
  id: string;
  affected?: OsvAffected[];
  database_specific?: { severity?: string };
}

/** What the audit needs from an adapter: which OSV ecosystem to query, how
 *  names compare, and how versions order. */
export type AuditAdapter = Pick<RegistryAdapter, "osvEcosystem" | "normalizeName" | "compareVersions">;

export interface AdvisoryIndex {
  /** Advisory ids with HIGH or CRITICAL severity that affect `version`. */
  withheld(version: string): readonly string[];
  /** Advisory ids of any other severity that affect `version`. */
  reported(version: string): readonly string[];
}

interface Advisory {
  id: string;
  blocking: boolean;
  affected: OsvAffected[];
}

type Compare = (a: string, b: string) => number;

function eventVersion(event: OsvEvent): string | undefined {
  return event.introduced ?? event.fixed ?? event.last_affected ?? event.limit;
}

/** OSV range evaluation: sort events by version, then sweep. A version or
 *  event the comparator cannot parse makes the version count as affected. */
export function inOsvRange(version: string, events: readonly OsvEvent[], compare: Compare): boolean {
  try {
    const sorted = events
      .filter((event) => eventVersion(event) !== undefined)
      .sort((a, b) => {
        if (a.introduced === "0") return b.introduced === "0" ? 0 : -1;
        if (b.introduced === "0") return 1;
        const order = compare(eventVersion(a)!, eventVersion(b)!);
        if (order !== 0) return order;
        // Ties are resolved independent of array order: an `introduced` at
        // the same version as a closing event is processed last, so that
        // version counts as affected (fail closed).
        return Number(a.introduced !== undefined) - Number(b.introduced !== undefined);
      });
    let affected = false;
    for (const event of sorted) {
      if (event.introduced !== undefined) {
        if (event.introduced === "0" || compare(version, event.introduced) >= 0) affected = true;
      } else if (event.fixed !== undefined) {
        if (compare(version, event.fixed) >= 0) affected = false;
      } else if (event.last_affected !== undefined) {
        if (compare(version, event.last_affected) > 0) affected = false;
      } else if (event.limit !== undefined && event.limit !== "*") {
        if (compare(version, event.limit) >= 0) affected = false;
      }
    }
    return affected;
  } catch {
    return true;
  }
}

function sameVersion(a: string, b: string, compare: Compare): boolean {
  if (a === b) return true;
  try {
    return compare(a, b) === 0;
  } catch {
    return false;
  }
}

function affects(version: string, affected: OsvAffected, compare: Compare): boolean {
  if ((affected.versions ?? []).some((listed) => sameVersion(version, listed, compare))) return true;
  return (affected.ranges ?? []).some(
    (range) => RANGE_TYPES.has(range.type ?? "") && inOsvRange(version, range.events ?? [], compare),
  );
}

function indexOf(advisories: readonly Advisory[], adapter: AuditAdapter): AdvisoryIndex {
  const compare: Compare = (a, b) => adapter.compareVersions(a, b);
  const matching = (version: string, blocking: boolean) =>
    advisories
      .filter((advisory) => advisory.blocking === blocking)
      .filter((advisory) => advisory.affected.some((affected) => affects(version, affected, compare)))
      .map((advisory) => advisory.id);
  return { withheld: (version) => matching(version, true), reported: (version) => matching(version, false) };
}

const EMPTY_INDEX: AdvisoryIndex = { withheld: () => [], reported: () => [] };

export const DEFAULT_AUDIT_CACHE_ENTRIES = 5000;

/** One exact package version to audit. */
export interface AuditedVersion {
  name: string;
  version: string;
}

/** `name@version` -> the HIGH/CRITICAL advisory ids affecting it; a
 *  version with none is absent. */
export type WithheldVersions = Map<string, string[]>;

export const versionKey = (name: string, version: string) => `${name}@${version}`;

export class OsvAudit {
  /** Advisories per package, least recently used first. Bounded to
   *  `maxEntries`; expired entries are dropped on access and before any
   *  live entry is evicted. A failed query is never cached. */
  private readonly cache = new Map<string, { expires: number; advisories: Advisory[] }>();
  /** Single-flight: concurrent audits of one package share one OSV query. */
  private readonly loads = new Map<string, Promise<Advisory[]>>();
  /** Advisory severities by id, with the OSV `modified` time they were
   *  read at, least recently used first. */
  private readonly vulns = new Map<string, { modified: string; blocking: boolean }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly fetch: UpstreamFetch;

  constructor(
    private readonly options: {
      fetch: UpstreamFetch;
      failOpen: boolean;
      now?: () => number;
      ttlMs?: number;
      /** Packages kept in the advisory cache (default 5000). */
      maxEntries?: number;
      /** Advisory severities kept for exact-version audits (default 10000). */
      maxVulnEntries?: number;
      /** Timeout for one OSV request, body included (default 30 s). */
      timeoutMs?: number;
      /** Largest OSV response read (default 64 MiB). */
      maxBytes?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.maxEntries = options.maxEntries ?? DEFAULT_AUDIT_CACHE_ENTRIES;
    // Every OSV request is bounded in time and size; any failure, including
    // these, makes the audit unavailable (fail closed unless configured open).
    this.fetch = boundedMetadataFetch(options.fetch, {
      timeoutMs: options.timeoutMs ?? DEFAULT_METADATA_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_METADATA_BYTES,
    });
  }

  async audit(adapter: AuditAdapter, name: string): Promise<AdvisoryIndex> {
    const wanted = adapter.normalizeName(name);
    const key = `${adapter.osvEcosystem}:${wanted}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expires > this.now()) {
        this.cache.set(key, cached); // most recently used
        return indexOf(cached.advisories, adapter);
      }
    }
    let load = this.loads.get(key);
    if (!load) {
      load = this.load(adapter, name, wanted)
        .then((advisories) => {
          this.remember(key, advisories);
          return advisories;
        })
        .finally(() => this.loads.delete(key));
      this.loads.set(key, load);
    }
    try {
      return indexOf(await load, adapter);
    } catch {
      if (this.options.failOpen) return EMPTY_INDEX;
      throw new RegistryError(
        503,
        "wardby_audit_unavailable",
        `the vulnerability audit for "${name}" could not reach OSV; try again later`,
      );
    }
  }

  /** Advisories for exact versions, in as few OSV requests as possible:
   *  one querybatch per 1000 versions (OSV matches each version itself),
   *  then each affecting advisory's severity from /v1/vulns/{id}, cached by
   *  id and OSV's `modified` time. Fails closed like `audit`: any failure
   *  is a 503 wardby_audit_unavailable, unless configured to fail open. */
  async auditVersions(
    adapter: AuditAdapter,
    versions: readonly AuditedVersion[],
    signal?: AbortSignal,
  ): Promise<WithheldVersions> {
    try {
      return await this.loadVersions(adapter, versions, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.options.failOpen) return new Map();
      throw new RegistryError(
        503,
        "wardby_audit_unavailable",
        "the vulnerability audit of the lockfile's versions could not reach OSV; try again later",
      );
    }
  }

  private async loadVersions(
    adapter: AuditAdapter,
    versions: readonly AuditedVersion[],
    signal?: AbortSignal,
  ): Promise<WithheldVersions> {
    const unique = [...new Map(versions.map((entry) => [versionKey(entry.name, entry.version), entry])).values()];
    /** Advisory id -> its `modified` time, and the versions it affects. */
    const found = new Map<string, { modified: string; versions: Set<string> }>();
    for (let start = 0; start < unique.length; start += OSV_BATCH_SIZE) {
      const chunk = unique.slice(start, start + OSV_BATCH_SIZE);
      let pending = chunk.map((entry) => ({ entry, pageToken: undefined as string | undefined }));
      for (let page = 0; pending.length > 0; page += 1) {
        if (page >= OSV_BATCH_MAX_PAGES) throw new Error("osv_batch_pages");
        const response = await this.fetch(OSV_QUERY_BATCH, {
          method: "POST",
          accept: "application/json",
          signal,
          body: JSON.stringify({
            queries: pending.map(({ entry, pageToken }) => ({
              package: { name: entry.name, ecosystem: adapter.osvEcosystem },
              version: entry.version,
              ...(pageToken ? { page_token: pageToken } : {}),
            })),
          }),
        });
        if (!response.ok) throw new Error(`osv_status_${response.status}`);
        const body = (await response.json()) as {
          results?: { vulns?: { id?: unknown; modified?: unknown }[]; next_page_token?: unknown }[];
        };
        const results = body.results ?? [];
        // One result per query, in order: anything else cannot be matched
        // to the versions it answers (fail closed).
        if (results.length !== pending.length) throw new Error("osv_batch_mismatch");
        const next: typeof pending = [];
        results.forEach((result, index) => {
          const key = versionKey(pending[index].entry.name, pending[index].entry.version);
          for (const vuln of result.vulns ?? []) {
            if (typeof vuln.id !== "string" || vuln.id === "") throw new Error("osv_batch_vuln_id");
            const modified = typeof vuln.modified === "string" ? vuln.modified : "";
            const advisory = found.get(vuln.id) ?? { modified, versions: new Set<string>() };
            advisory.versions.add(key);
            found.set(vuln.id, advisory);
          }
          if (typeof result.next_page_token === "string" && result.next_page_token !== "")
            next.push({ entry: pending[index].entry, pageToken: result.next_page_token });
        });
        pending = next;
      }
    }
    const withheld: WithheldVersions = new Map();
    const ids = [...found.keys()];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const advisory = found.get(id)!;
        if (!(await this.blocking(id, advisory.modified, signal))) continue;
        for (const key of advisory.versions) withheld.set(key, [...(withheld.get(key) ?? []), id]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(OSV_VULN_CONCURRENCY, ids.length) }, worker));
    return withheld;
  }

  /** Whether an advisory is HIGH or CRITICAL, cached by id while OSV's
   *  `modified` time for it is unchanged. */
  private async blocking(id: string, modified: string, signal?: AbortSignal): Promise<boolean> {
    const cached = this.vulns.get(id);
    if (cached && modified !== "" && cached.modified === modified) {
      this.vulns.delete(id);
      this.vulns.set(id, cached); // most recently used
      return cached.blocking;
    }
    const response = await this.fetch(`${OSV_VULN}${encodeURIComponent(id)}`, { accept: "application/json", signal });
    if (!response.ok) throw new Error(`osv_status_${response.status}`);
    const vuln = (await response.json()) as OsvVuln & { modified?: unknown };
    const severity = vuln.database_specific?.severity?.toUpperCase() ?? "";
    const blocking = BLOCKING.has(severity);
    this.vulns.delete(id);
    while (this.vulns.size >= (this.options.maxVulnEntries ?? DEFAULT_VULN_CACHE_ENTRIES)) {
      const oldest = this.vulns.keys().next();
      if (oldest.done) break;
      this.vulns.delete(oldest.value);
    }
    this.vulns.set(id, { modified: typeof vuln.modified === "string" ? vuln.modified : modified, blocking });
    return blocking;
  }

  private remember(key: string, advisories: Advisory[]): void {
    const now = this.now();
    for (const [cachedKey, entry] of this.cache) if (entry.expires <= now) this.cache.delete(cachedKey);
    this.cache.delete(key);
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { expires: now + this.ttlMs, advisories });
  }

  private async load(adapter: AuditAdapter, name: string, wanted: string): Promise<Advisory[]> {
    const vulns = await this.query(adapter.osvEcosystem, name);
    const advisories: Advisory[] = [];
    for (const vuln of vulns) {
      const affected = (vuln.affected ?? []).filter(
        (entry) =>
          entry.package?.ecosystem === adapter.osvEcosystem &&
          typeof entry.package.name === "string" &&
          adapter.normalizeName(entry.package.name) === wanted,
      );
      if (affected.length === 0) continue;
      const severity = vuln.database_specific?.severity?.toUpperCase() ?? "";
      advisories.push({ id: vuln.id, blocking: BLOCKING.has(severity), affected });
    }
    return advisories;
  }

  private async query(ecosystem: string, name: string): Promise<OsvVuln[]> {
    const vulns: OsvVuln[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.fetch(OSV_QUERY, {
        method: "POST",
        accept: "application/json",
        body: JSON.stringify({ package: { name, ecosystem }, ...(pageToken ? { page_token: pageToken } : {}) }),
      });
      if (!response.ok) throw new Error(`osv_status_${response.status}`);
      const page = (await response.json()) as { vulns?: OsvVuln[]; next_page_token?: string };
      vulns.push(...(page.vulns ?? []));
      pageToken = page.next_page_token;
    } while (pageToken);
    return vulns;
  }
}
