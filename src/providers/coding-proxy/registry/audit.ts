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
        return compare(eventVersion(a)!, eventVersion(b)!);
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

export class OsvAudit {
  private readonly cache = new Map<string, { expires: number; advisories: Advisory[] }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly fetch: UpstreamFetch;

  constructor(
    private readonly options: {
      fetch: UpstreamFetch;
      failOpen: boolean;
      now?: () => number;
      ttlMs?: number;
      /** Timeout for one OSV request, body included (default 30 s). */
      timeoutMs?: number;
      /** Largest OSV response read (default 64 MiB). */
      maxBytes?: number;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 3_600_000;
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
    if (cached && cached.expires > this.now()) return indexOf(cached.advisories, adapter);
    let vulns: OsvVuln[];
    try {
      vulns = await this.query(adapter.osvEcosystem, name);
    } catch {
      if (this.options.failOpen) return EMPTY_INDEX;
      throw new RegistryError(
        503,
        "wardby_audit_unavailable",
        `the vulnerability audit for "${name}" could not reach OSV; try again later`,
      );
    }
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
    this.cache.set(key, { expires: this.now() + this.ttlMs, advisories });
    return indexOf(advisories, adapter);
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
