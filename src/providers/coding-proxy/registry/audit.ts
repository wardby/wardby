import { RegistryError, type UpstreamFetch } from "../../../coding/registry/types.js";

const OSV_QUERY = "https://api.osv.dev/v1/query";
const BLOCKING = new Set(["HIGH", "CRITICAL"]);

interface OsvVuln {
  id: string;
  affected?: { versions?: string[] }[];
  database_specific?: { severity?: string };
}

export interface AdvisoryIndex {
  withheld: ReadonlyMap<string, readonly string[]>;
  reported: ReadonlyMap<string, readonly string[]>;
}

function add(map: Map<string, string[]>, version: string, id: string) {
  map.set(version, [...(map.get(version) ?? []), id]);
}

export class OsvAudit {
  private readonly cache = new Map<string, { expires: number; index: AdvisoryIndex }>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly options: { fetch: UpstreamFetch; failOpen: boolean; now?: () => number; ttlMs?: number },
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 3_600_000;
  }

  async audit(osvEcosystem: string, name: string): Promise<AdvisoryIndex> {
    const key = `${osvEcosystem}:${name}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.index;
    let vulns: OsvVuln[];
    try {
      vulns = await this.query(osvEcosystem, name);
    } catch {
      if (this.options.failOpen) return { withheld: new Map(), reported: new Map() };
      throw new RegistryError(
        503,
        "wardby_audit_unavailable",
        `the vulnerability audit for "${name}" could not reach OSV; try again later`,
      );
    }
    const withheld = new Map<string, string[]>();
    const reported = new Map<string, string[]>();
    for (const vuln of vulns) {
      const severity = vuln.database_specific?.severity?.toUpperCase() ?? "";
      for (const affected of vuln.affected ?? []) {
        for (const version of affected.versions ?? [])
          add(BLOCKING.has(severity) ? withheld : reported, version, vuln.id);
      }
    }
    const index = { withheld, reported };
    this.cache.set(key, { expires: this.now() + this.ttlMs, index });
    return index;
  }

  private async query(ecosystem: string, name: string): Promise<OsvVuln[]> {
    const vulns: OsvVuln[] = [];
    let pageToken: string | undefined;
    do {
      const response = await this.options.fetch(OSV_QUERY, {
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
