/**
 * Lockfile verification ("approve a plan"): the registry core's check of a
 * lockfile a run submits to `POST /registry/<ecosystem>/-/plan`. Nothing the
 * lockfile claims is trusted:
 *
 * - every entry's integrity must equal the registry's own for that exact
 *   version (a per-version fact read from the registry, stored forever);
 * - edges come from the registry too: a parent version's declared
 *   dependencies, resolved to lockfile entries by the client's own rule
 *   (npm: nearest ancestor node_modules), and kept only when the entry is
 *   the declared package at a version inside the declared range;
 * - reachability starts at the projects' dependencies that are allowlist
 *   roots (at a version inside the root's range) and follows only verified
 *   edges, through versions old enough and without a HIGH/CRITICAL advisory.
 *
 * A refused entry refuses itself and whatever is reachable only through it;
 * everything else is approved, as exact name@version pairs. The work is
 * bounded: facts are fetched only for entries reached (so a lockfile of
 * unrelated packages costs nothing upstream), with bounded concurrency and a
 * deadline.
 */
import { matchRoot } from "../../../coding/registry/allowlist.js";
import {
  RegistryError,
  type AllowlistEntry,
  type LockfileEntry,
  type LockfilePlanSupport,
  type ParsedLockfile,
  type RegistryAdapter,
  type UpstreamFetch,
  type VersionFact,
} from "../../../coding/registry/types.js";
import { versionKey, type AuditedVersion, type WithheldVersions } from "./audit.js";
import type { ApprovedVersion, StoredVersionFact } from "./store.js";

export const DEFAULT_PLAN_MAX_ENTRIES = 5000;
export const DEFAULT_PLAN_TIMEOUT_MS = 120_000;
/** Per-version documents fetched at once (each is a few KB). */
export const DEFAULT_PLAN_FACT_CONCURRENCY = 16;
/** Full package documents streamed at once for publish times (each may be
 *  tens of MB, never held). */
export const DEFAULT_PLAN_TIME_CONCURRENCY = 8;
/** Largest (decompressed) package document streamed for publish times. */
export const DEFAULT_PLAN_MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;

export interface PlanRefusal {
  name: string;
  version: string;
  code: string;
  reason: string;
}

export interface PlanResult {
  approved: ApprovedVersion[];
  refused: PlanRefusal[];
}

export interface PlanFacts {
  getVersionFacts(versions: readonly { name: string; version: string }[]): Promise<StoredVersionFact[]>;
  putVersionFacts(facts: readonly StoredVersionFact[]): Promise<void>;
}

export interface PlanInput {
  adapter: RegistryAdapter;
  support: LockfilePlanSupport;
  lockfile: ParsedLockfile;
  roots: readonly AllowlistEntry[];
  /** Latest publish time a version may have (the release-age cutoff). */
  cutoff: Date;
  facts: PlanFacts;
  /** Bounded fetch for small per-version documents. */
  upstream: UpstreamFetch;
  /** Unbuffered fetch for streamed package documents. */
  streamUpstream: UpstreamFetch;
  audit(versions: readonly AuditedVersion[], signal: AbortSignal): Promise<WithheldVersions>;
  hostAllowed(url: string): boolean;
  signal: AbortSignal;
  factConcurrency?: number;
  timeConcurrency?: number;
  maxDocumentBytes?: number;
}

/** Runs `task` over `items`, at most `concurrency` at once. */
async function eachLimited<T>(items: readonly T[], concurrency: number, task: (item: T) => Promise<void>) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) await task(items[cursor++]);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** A failed registry read is retried once before the entry is refused. */
async function withRetry<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (signal.aborted) throw error;
    return read();
  }
}

type FactOutcome = { fact: StoredVersionFact } | { refusal: Omit<PlanRefusal, "name" | "version"> };

export async function verifyLockfilePlan(input: PlanInput): Promise<PlanResult> {
  const { adapter, support, lockfile, signal } = input;
  const refusals = new Map<LockfileEntry, Omit<PlanRefusal, "name" | "version">>();
  for (const entry of lockfile.entries) {
    if (entry.kind === "unsupported")
      refusals.set(entry, {
        code: "wardby_lockfile_entry_unsupported",
        reason: entry.unsupportedReason ?? "cannot be verified against the registry",
      });
  }

  // Starting points: what the projects themselves declare, when it is an
  // allowlist root at a version inside the root's range.
  const starts = new Set<LockfileEntry>();
  for (const project of lockfile.projects) {
    for (const dependency of project.dependencies) {
      const entry = lockfile.resolve(project.path, dependency.key);
      if (!entry || entry.kind !== "registry" || entry.name !== dependency.name) continue;
      const root = matchRoot(input.roots, adapter.normalizeName(entry.name));
      if (!root) continue;
      if (root.range && !safeSatisfies(adapter, entry.version, root.range)) continue;
      starts.add(entry);
    }
  }

  // Breadth first over verified edges, fetching facts one layer at a time
  // (only for entries actually reached).
  const outcomes = new Map<string, FactOutcome>();
  const edges = new Map<LockfileEntry, LockfileEntry[]>();
  const candidates = new Set<LockfileEntry>();
  const visited = new Set<LockfileEntry>(starts);
  let layer = [...starts];
  while (layer.length > 0) {
    signal.throwIfAborted();
    await loadFacts(input, layer, outcomes);
    const next: LockfileEntry[] = [];
    for (const entry of layer) {
      const outcome = outcomes.get(versionKey(entry.name, entry.version))!;
      if ("refusal" in outcome) {
        refusals.set(entry, outcome.refusal);
        continue;
      }
      const { fact } = outcome;
      if (entry.integrity === null || entry.integrity.trim() !== fact.integrity) {
        refusals.set(entry, {
          code: "wardby_lockfile_integrity_mismatch",
          reason: `the lockfile's integrity is not the registry's for ${entry.name}@${entry.version}`,
        });
        continue;
      }
      if (fact.publishedAt.getTime() > input.cutoff.getTime()) {
        refusals.set(entry, {
          code: "wardby_version_filtered",
          reason: `published ${fact.publishedAt.toISOString()}, newer than the release-age limit`,
        });
        continue;
      }
      candidates.add(entry);
      const children: LockfileEntry[] = [];
      for (const dependency of fact.dependencies) {
        const child = lockfile.resolve(entry.path, dependency.key);
        if (!child || child.kind !== "registry" || child.name !== dependency.name) continue;
        if (!support.edgeSatisfies(child.version, dependency.range)) continue;
        children.push(child);
        if (!visited.has(child)) {
          visited.add(child);
          next.push(child);
        }
      }
      edges.set(entry, children);
    }
    layer = next;
  }

  // One advisory lookup for every candidate version.
  const withheld = await input.audit(
    [...new Map([...candidates].map((entry) => [versionKey(entry.name, entry.version), entry])).values()].map(
      ({ name, version }) => ({ name, version }),
    ),
    signal,
  );
  for (const entry of candidates) {
    const ids = withheld.get(versionKey(entry.name, entry.version));
    if (ids && ids.length > 0) {
      candidates.delete(entry);
      refusals.set(entry, { code: "wardby_version_filtered", reason: `high-severity advisory ${ids.join(", ")}` });
    }
  }

  // Reachability again, now only through entries that passed every check:
  // a refused entry refuses whatever is reachable only through it.
  const approvedEntries = new Set<LockfileEntry>();
  const queue = [...starts].filter((entry) => candidates.has(entry));
  for (const entry of queue) approvedEntries.add(entry);
  while (queue.length > 0) {
    const entry = queue.shift()!;
    for (const child of edges.get(entry) ?? []) {
      if (!candidates.has(child) || approvedEntries.has(child)) continue;
      approvedEntries.add(child);
      queue.push(child);
    }
  }

  const approved = new Map<string, ApprovedVersion>();
  for (const entry of approvedEntries) {
    const outcome = outcomes.get(versionKey(entry.name, entry.version));
    if (outcome && "fact" in outcome)
      approved.set(versionKey(entry.name, entry.version), {
        name: entry.name,
        version: entry.version,
        integrity: outcome.fact.integrity,
      });
  }
  const refused = new Map<string, PlanRefusal>();
  for (const entry of lockfile.entries) {
    if (entry.kind === "bundled") continue;
    const key = versionKey(entry.name, entry.version);
    if (approved.has(key) || refused.has(key)) continue;
    const refusal = refusals.get(entry) ?? {
      code: "wardby_package_not_allowed",
      reason: "not reachable from this agent's allowlist through dependencies the registry confirms",
    };
    refused.set(key, { name: entry.name, version: entry.version, ...refusal });
  }
  // An entry refused at one place in the tree but approved at another (the
  // same name@version) is approved: approvals are per exact version.
  return { approved: [...approved.values()], refused: [...refused.values()] };
}

function safeSatisfies(adapter: RegistryAdapter, version: string, range: string): boolean {
  try {
    return adapter.satisfies(version, range);
  } catch {
    return false;
  }
}

/** Facts for every entry of `layer` not already known: stored facts first,
 *  then the registry (per-version documents, then publish times streamed
 *  once per package), storing each complete fact for reuse. */
async function loadFacts(input: PlanInput, layer: readonly LockfileEntry[], outcomes: Map<string, FactOutcome>) {
  const { support, signal } = input;
  const wanted = [
    ...new Map(
      layer
        .filter((entry) => !outcomes.has(versionKey(entry.name, entry.version)))
        .map((entry) => [versionKey(entry.name, entry.version), { name: entry.name, version: entry.version }]),
    ).values(),
  ];
  if (wanted.length === 0) return;
  for (const fact of await input.facts.getVersionFacts(wanted)) {
    // A stored fact whose download host is not (or no longer) allowed is
    // refused below like a fresh one would be.
    outcomes.set(versionKey(fact.name, fact.version), checkedFact(input, fact));
  }
  const missing = wanted.filter(({ name, version }) => !outcomes.has(versionKey(name, version)));
  if (missing.length === 0) return;

  const fresh = new Map<string, VersionFact>();
  await eachLimited(missing, input.factConcurrency ?? DEFAULT_PLAN_FACT_CONCURRENCY, async ({ name, version }) => {
    const key = versionKey(name, version);
    try {
      const fact = await withRetry(signal, () => support.fetchVersionFact(name, version, input.upstream, signal));
      if (!fact) {
        outcomes.set(key, {
          refusal: { code: "wardby_package_not_found", reason: `the registry has no ${name}@${version}` },
        });
        return;
      }
      fresh.set(key, fact);
    } catch (error) {
      if (signal.aborted) throw error;
      outcomes.set(key, { refusal: upstreamRefusal(error) });
    }
  });
  signal.throwIfAborted();

  const byName = new Map<string, string[]>();
  for (const fact of fresh.values()) byName.set(fact.name, [...(byName.get(fact.name) ?? []), fact.version]);
  const complete: StoredVersionFact[] = [];
  await eachLimited(
    [...byName.entries()],
    input.timeConcurrency ?? DEFAULT_PLAN_TIME_CONCURRENCY,
    async ([name, versions]) => {
      let times: Map<string, Date>;
      try {
        times = await withRetry(signal, () =>
          support.fetchPublishTimes(name, versions, input.streamUpstream, {
            signal,
            maxBytes: input.maxDocumentBytes ?? DEFAULT_PLAN_MAX_DOCUMENT_BYTES,
          }),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        for (const version of versions) outcomes.set(versionKey(name, version), { refusal: upstreamRefusal(error) });
        return;
      }
      for (const version of versions) {
        const key = versionKey(name, version);
        const publishedAt = times.get(version);
        if (!publishedAt) {
          // Unknown publish time counts as too new; not stored, so a later
          // plan reads it again.
          outcomes.set(key, {
            refusal: { code: "wardby_version_filtered", reason: "the registry records no publish time for it" },
          });
          continue;
        }
        const fact: StoredVersionFact = { ...fresh.get(key)!, publishedAt };
        complete.push(fact);
        outcomes.set(key, checkedFact(input, fact));
      }
    },
  );
  signal.throwIfAborted();
  await input.facts.putVersionFacts(complete);
}

/** A fact is usable only when the registry gave an integrity to check
 *  downloads against and a download on this adapter's own upstream hosts. */
function checkedFact(input: PlanInput, fact: StoredVersionFact): FactOutcome {
  if (fact.integrity === "")
    return {
      refusal: { code: "wardby_lockfile_integrity_mismatch", reason: "the registry publishes no integrity for it" },
    };
  if (!input.hostAllowed(fact.downloadUrl))
    return {
      refusal: {
        code: "wardby_upstream_host_not_allowed",
        reason: `hosted outside the ${input.adapter.id} registry's upstreams`,
      },
    };
  return { fact };
}

function upstreamRefusal(error: unknown): Omit<PlanRefusal, "name" | "version"> {
  if (error instanceof RegistryError && error.code === "wardby_metadata_too_large")
    return { code: "wardby_metadata_too_large", reason: error.message };
  if (error instanceof RegistryError && error.code === "wardby_package_not_found")
    return { code: "wardby_package_not_found", reason: error.message };
  return { code: "wardby_upstream_error", reason: "the registry could not be read for it; try again" };
}
