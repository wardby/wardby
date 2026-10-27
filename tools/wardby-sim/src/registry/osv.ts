// TEST ONLY (wardby-sim). api.osv.dev, mounted at /osv: POST /v1/query, POST /v1/querybatch
// (ids and modified only, as OSV answers a batch) and GET /v1/vulns/{id}, over scripted
// advisories in the OSV schema. An outage is a fault (`osv.outage`), for
// REGISTRY_AUDIT_FAIL_OPEN. Version matching: an advisory's `versions` list, or its
// SEMVER/ECOSYSTEM ranges (introduced opens, fixed closes, last_affected closes inclusively),
// with a dotted-numeric comparison (enough for the suite's fixtures; not full semver/PEP 440).
import { json, jsonBody, record, textOf, type SimRequest } from "../http.js";
import { Router } from "../router.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";

export const OSV_PREFIX = "/osv";

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
export interface OsvAdvisory {
  id: string;
  modified: string;
  summary?: string;
  aliases?: string[];
  database_specific?: Record<string, unknown>;
  affected: {
    package: { name: string; ecosystem: string };
    versions?: string[];
    ranges?: { type: string; events: OsvEvent[] }[];
  }[];
}

export class OsvState {
  advisories: OsvAdvisory[] = [];
  reset(): void {
    this.advisories = [];
  }
}

function compare(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

export function affects(advisory: OsvAdvisory, ecosystem: string, name: string, version: string): boolean {
  return advisory.affected.some((entry) => {
    if (entry.package.ecosystem !== ecosystem || entry.package.name !== name) return false;
    if (entry.versions?.includes(version)) return true;
    return (entry.ranges ?? []).some((range) => {
      let inside = false;
      for (const event of range.events) {
        if (event.introduced !== undefined && (event.introduced === "0" || compare(version, event.introduced) >= 0))
          inside = true;
        if (event.fixed !== undefined && compare(version, event.fixed) >= 0) inside = false;
        if (event.last_affected !== undefined && compare(version, event.last_affected) > 0) inside = false;
      }
      return inside;
    });
  });
}

export function createOsvService(): SimService {
  const osv = new OsvState();
  const matching = (query: Record<string, unknown>): OsvAdvisory[] => {
    const pkg = record(query.package);
    const version = textOf(query.version);
    return osv.advisories.filter((a) => affects(a, textOf(pkg.ecosystem), textOf(pkg.name), version));
  };
  const router = new Router()
    .on("POST", "/v1/query", (req: SimRequest) => {
      const vulns = matching(record(jsonBody(req)));
      return json(vulns.length > 0 ? { vulns } : {});
    })
    .on("POST", "/v1/querybatch", (req: SimRequest) => {
      const queries = record(jsonBody(req)).queries;
      if (!Array.isArray(queries)) return json({ code: 3, message: "Invalid query." }, 400);
      if (queries.length > 1000) return json({ code: 3, message: "Too many queries." }, 400);
      return json({
        results: queries.map((q) => {
          const vulns = matching(record(q));
          return vulns.length > 0 ? { vulns: vulns.map((v) => ({ id: v.id, modified: v.modified })) } : {};
        }),
      });
    })
    .on("GET", "/v1/vulns/{id}", (_req, params) => {
      const advisory = osv.advisories.find((a) => a.id === params.id);
      return advisory ? json(advisory) : json({ code: 5, message: "Bug not found." }, 404);
    });

  const actions: Record<string, ScriptAction> = {
    /** An advisory: {id, ecosystem, package, versions?, introduced?, fixed?, severity?, summary?, aliases?}. */
    "osv.advisory": async (args) => {
      const id = textOf(args.id);
      if (!id) throw new Error("id is required");
      const ranges =
        typeof args.introduced === "string"
          ? [
              {
                type: textOf(args.rangeType, "ECOSYSTEM"),
                events: [
                  { introduced: args.introduced },
                  ...(typeof args.fixed === "string" ? [{ fixed: args.fixed }] : []),
                ],
              },
            ]
          : undefined;
      osv.advisories = osv.advisories.filter((a) => a.id !== id);
      osv.advisories.push({
        id,
        modified: new Date().toISOString(),
        ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
        ...(Array.isArray(args.aliases) ? { aliases: args.aliases.map(String) } : {}),
        ...(typeof args.severity === "string" ? { database_specific: { severity: args.severity } } : {}),
        affected: [
          {
            package: { name: textOf(args.package), ecosystem: textOf(args.ecosystem, "npm") },
            ...(Array.isArray(args.versions) ? { versions: args.versions.map(String) } : {}),
            ...(ranges ? { ranges } : {}),
          },
        ],
      });
      return { count: osv.advisories.length };
    },
    /** OSV is down: every call answers 503 until cleared (sticky) or once. */
    "osv.outage": async (args, { state }) =>
      state.faults.add({
        service: "osv",
        method: "*",
        path: "/*",
        mode: args.mode === "once" ? "once" : "sticky",
        response: { status: 503, headers: { "content-type": "text/plain" }, body: "upstream connect error" },
      }),
  };

  return {
    name: "osv",
    prefix: OSV_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init: (state: SimState) => {
      if (!state.part("osv")) state.register("osv", osv);
    },
  };
}
