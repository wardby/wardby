/**
 * Lockfile verification ("approve a plan"): the registry core's check of a
 * lockfile a run submits to `POST /registry/<ecosystem>/-/plan`. Nothing the
 * lockfile claims is trusted:
 *
 * - every entry's integrity must equal the registry's own for that exact
 *   version (a per-version fact read from the registry, stored forever),
 *   unless the format records no npm integrity at all (yarn Berry): then
 *   the approval is the exact name@version, and the download is checked
 *   against the registry's integrity alone;
 * - edges come from the registry too: a parent version's declared
 *   dependencies, resolved to lockfile entries by the client's own rule
 *   (npm: nearest ancestor node_modules), and kept only when the entry is
 *   the declared package at a version inside the declared range;
 * - reachability starts at every lockfile entry that is an allowlist root
 *   (at a version inside the root's range), wherever it sits and whether or
 *   not a project declares it, and follows only verified
 *   edges, through versions old enough and without a HIGH/CRITICAL advisory
 *   (one the run's accepted set waives does not count; malware always does).
 *
 * PyPI dependency lines may be gated on extras: an entry is expanded with the
 * extras it is installed with (a start's allowlist entry's, then those its
 * parents' lines ask of it), and a plain install follows none.
 *
 * A refused entry refuses itself and whatever is reachable only through it;
 * everything else is approved, as exact name@version pairs (an ecosystem
 * that `approves: "names"` turns them into name allowances). In package
 * audit mode every registry entry is a start as well: one the allowlist does
 * not reach is approved when it passes every other check, marked with its
 * audit verdict (and, in `full`, a version kept only past non-malware
 * blocking advisories is approved and marked too). The work is
 * bounded: facts are fetched only for entries reached (so a lockfile of
 * unrelated packages costs nothing upstream), with bounded concurrency and a
 * deadline.
 */
import { matchRoot } from "../../../coding/registry/allowlist.js";
import type {
  AuditAdvisory,
  AuditRelation,
  PackageAuditMode,
  PackageAuditVerdict,
} from "../../../coding/registry/audit-mode.js";
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
import { auditAdvisoryOf, splitWaived, versionKey, type AuditedVersion, type WithheldVersions } from "./audit.js";
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
  /** A verdict about the registry's name@version itself (too new, an
   *  advisory, not published, no integrity, hosted elsewhere), true of it
   *  whatever lockfile names it. Only these answer later downloads; a
   *  lockfile-dependent verdict (unreachable, an integrity or source the
   *  lockfile claims) never does. */
  intrinsic?: boolean;
  /** For a too-new refusal: the version's publish time, so whoever answers
   *  from it can re-check the age against the cutoff at that time. */
  publishedAt?: Date;
}

export interface PlanResult {
  approved: ApprovedVersion[];
  refused: PlanRefusal[];
  /** Approvals carrying an audit verdict (package audit mode only; 0 otherwise). */
  audited: number;
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
  /** The run's accepted advisory ids (packagePolicy.acceptedAdvisories):
   *  blocking advisories they waive do not refuse a version (see
   *  `isWaived`; malware is never waived). Absent or empty waives nothing. */
  accepted?: ReadonlySet<string>;
  /** The run's package audit mode (CodingRun.packageAuditMode); absent or null = normal enforcement. */
  auditMode?: PackageAuditMode | null;
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

/** An audited approval's relation and parent (PackageAuditVerdict without advisories). */
type AuditRelationOf = { relation: AuditRelation; via?: string };

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

  // Starting points: every registry entry that is an allowlist root at a
  // version inside the root's range, wherever it sits in the lockfile and
  // whether or not a project declares it. An allowlisted name may be
  // installed by name anyway (the download path allows the same name@version:
  // `authorize` matches the name with `matchRoot`, and `keptVersions`
  // applies the root's range, release age and advisories), so an `overrides`-forced version of it, which no parent's
  // declared range reaches, is a start in its own right. Every start still
  // passes the fact checks below (integrity, release age, advisories), and
  // edges are still followed only inside declared ranges.
  const starts = new Set<LockfileEntry>();
  // The extras each reached entry is installed with (PyPI): a start's are its
  // allowlist entry's, a child's those its parents' lines ask of it.
  const extrasOf = new Map<LockfileEntry, Set<string>>();
  for (const entry of lockfile.entries) {
    if (entry.kind !== "registry") continue;
    const root = matchRoot(input.roots, adapter.normalizeName(entry.name));
    if (!root) continue;
    if (root.range && !safeSatisfies(adapter, entry.version, root.range)) continue;
    starts.add(entry);
    extrasOf.set(entry, new Set(root.extras ?? []));
  }

  // Breadth first over verified edges, fetching facts one layer at a time
  // (only for entries actually reached).
  const outcomes = new Map<string, FactOutcome>();
  const edges = new Map<LockfileEntry, LockfileEntry[]>();
  const candidates = new Set<LockfileEntry>();
  const visited = new Set<LockfileEntry>(starts);
  // Package audit mode: every other registry entry starts too, except an
  // allowlisted name outside its entry's own range (an owner's explicit
  // restriction, never widened by audit mode). Visited after the roots'
  // graph, so facts load in the same bounded layers.
  const auditStarts = input.auditMode
    ? lockfile.entries.filter(
        (entry) =>
          entry.kind === "registry" &&
          !starts.has(entry) &&
          !outsideRootRange(input, adapter.normalizeName(entry.name), entry.version),
      )
    : [];
  let layer = [...starts];
  let auditSeeded = false;
  while (layer.length > 0 || (!auditSeeded && auditStarts.length > 0)) {
    if (layer.length === 0) {
      auditSeeded = true;
      layer = auditStarts.filter((entry) => !visited.has(entry));
      for (const entry of layer) visited.add(entry);
      continue;
    }
    signal.throwIfAborted();
    await loadFacts(input, layer, outcomes);
    const next = new Set<LockfileEntry>();
    for (const entry of layer) {
      const outcome = outcomes.get(versionKey(entry.name, entry.version))!;
      if ("refusal" in outcome) {
        refusals.set(entry, outcome.refusal);
        continue;
      }
      const { fact } = outcome;
      if (
        lockfile.integrity !== "registry" &&
        (entry.integrity === null || entry.integrity.trim() !== fact.integrity)
      ) {
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
          intrinsic: true,
          publishedAt: fact.publishedAt,
        });
        continue;
      }
      candidates.add(entry);
      const children: LockfileEntry[] = [];
      const dependencies = support.dependenciesOf
        ? support.dependenciesOf(fact, [...(extrasOf.get(entry) ?? [])].sort())
        : fact.dependencies;
      for (const dependency of dependencies) {
        const resolved = lockfile.resolveAll
          ? lockfile.resolveAll(entry.path, dependency.key)
          : [lockfile.resolve(entry.path, dependency.key)];
        for (const child of resolved) {
          if (!child || child.kind !== "registry" || child.name !== dependency.name) continue;
          if (!support.edgeSatisfies(child.version, dependency.range)) continue;
          children.push(child);
          const asked = dependency.extras ?? [];
          if (!visited.has(child)) {
            visited.add(child);
            extrasOf.set(child, new Set(asked));
            next.add(child);
            continue;
          }
          // Reached again with extras it lacked: expanded again, now with them
          // (extras only grow, so this ends).
          const known = extrasOf.get(child) ?? new Set<string>();
          if (asked.some((extra) => !known.has(extra))) {
            for (const extra of asked) known.add(extra);
            extrasOf.set(child, known);
            next.add(child);
          }
        }
      }
      edges.set(entry, children);
    }
    layer = [...next];
  }

  // One advisory lookup for every candidate version.
  const withheld = await input.audit(
    [...new Map([...candidates].map((entry) => [versionKey(entry.name, entry.version), entry])).values()].map(
      ({ name, version }) => ({ name, version }),
    ),
    signal,
  );
  // Advisories the run's accepted set waived, per approved name@version,
  // and (full mode) the blocking ones served past.
  const waivers = new Map<string, string[]>();
  const auditAdvisories = new Map<string, AuditAdvisory[]>();
  for (const entry of candidates) {
    const key = versionKey(entry.name, entry.version);
    const split = splitWaived(withheld.get(key) ?? [], input.accepted, { auditAll: input.auditMode === "full" });
    if (split.audited.length > 0) auditAdvisories.set(key, split.audited.map(auditAdvisoryOf));
    if (split.withheld.length > 0) {
      candidates.delete(entry);
      refusals.set(entry, {
        code: "wardby_version_filtered",
        reason: `withheld by advisory ${split.withheld.map(({ id }) => id).join(", ")} (high severity or malware)`,
        intrinsic: true,
      });
    } else if (split.waived.length > 0) {
      waivers.set(
        key,
        split.waived.map(({ id }) => id),
      );
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

  // Package audit mode: every other entry that passed every check is
  // approved too, marked with how it reached the lockfile.
  const relations = input.auditMode
    ? auditRelations(input, approvedEntries, candidates, edges)
    : new Map<LockfileEntry, AuditRelationOf>();

  const approved = new Map<string, ApprovedVersion>();
  const approve = (entry: LockfileEntry, relation: AuditRelationOf | undefined) => {
    const key = versionKey(entry.name, entry.version);
    const outcome = outcomes.get(key);
    if (!outcome || !("fact" in outcome) || approved.has(key)) return;
    const acceptedAdvisories = waivers.get(key);
    const advisories = auditAdvisories.get(key);
    const audit: PackageAuditVerdict | undefined = relation
      ? { ...relation, ...(advisories ? { advisories } : {}) }
      : advisories
        ? { relation: "allowed", advisories }
        : undefined;
    approved.set(key, {
      name: entry.name,
      version: entry.version,
      integrity: outcome.fact.integrity,
      ...(acceptedAdvisories ? { acceptedAdvisories } : {}),
      ...(audit ? { audit } : {}),
    });
  };
  // Approvals through the allowlist first: an exact version approved both
  // ways is not audited.
  for (const entry of approvedEntries) approve(entry, undefined);
  for (const [entry, relation] of relations) approve(entry, relation);
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
  const approvals = [...approved.values()];
  return {
    approved: approvals,
    refused: [...refused.values()],
    audited: approvals.filter((approval) => approval.audit).length,
  };
}

/** Whether `name@version` is an allowlisted name at a version its entry's range excludes. */
function outsideRootRange(input: PlanInput, name: string, version: string): boolean {
  const root = matchRoot(input.roots, name);
  return !!root?.range && !safeSatisfies(input.adapter, version, root.range);
}

/**
 * How each candidate the allowlist does not reach came into the lockfile
 * (package audit mode): `top-level` when a lockfile project declares it,
 * `transitive` when an audited top-level entry reaches it over verified
 * edges (`via` its nearest such ancestor, breadth first), otherwise
 * `unknown`. Best effort: it decides only what a reviewer is shown.
 */
function auditRelations(
  input: PlanInput,
  approvedEntries: ReadonlySet<LockfileEntry>,
  candidates: ReadonlySet<LockfileEntry>,
  edges: ReadonlyMap<LockfileEntry, readonly LockfileEntry[]>,
): Map<LockfileEntry, AuditRelationOf> {
  const { lockfile } = input;
  // An allowlisted name outside its entry's range is never audited in,
  // even when an audited package declares it.
  const audited = new Set(
    [...candidates].filter(
      (entry) =>
        !approvedEntries.has(entry) && !outsideRootRange(input, input.adapter.normalizeName(entry.name), entry.version),
    ),
  );
  const relations = new Map<LockfileEntry, AuditRelationOf>();
  const declared = new Set<LockfileEntry>();
  for (const project of lockfile.projects)
    for (const dependency of project.dependencies) {
      const entry = lockfile.resolve(project.path, dependency.key);
      if (entry) declared.add(entry);
    }
  const queue: LockfileEntry[] = [];
  for (const entry of audited)
    if (declared.has(entry)) {
      relations.set(entry, { relation: "top-level" });
      queue.push(entry);
    }
  const via = new Map<LockfileEntry, string>(queue.map((entry) => [entry, entry.name]));
  while (queue.length > 0) {
    const entry = queue.shift()!;
    for (const child of edges.get(entry) ?? []) {
      if (via.has(child) || !audited.has(child)) continue;
      via.set(child, via.get(entry)!);
      relations.set(child, { relation: "transitive", via: via.get(entry)! });
      queue.push(child);
    }
  }
  for (const entry of audited) if (!relations.has(entry)) relations.set(entry, { relation: "unknown" });
  return relations;
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
  const complete: StoredVersionFact[] = [];
  await eachLimited(missing, input.factConcurrency ?? DEFAULT_PLAN_FACT_CONCURRENCY, async ({ name, version }) => {
    const key = versionKey(name, version);
    try {
      const fact = await withRetry(signal, () => support.fetchVersionFact(name, version, input.upstream, signal));
      if (!fact) {
        outcomes.set(key, {
          refusal: {
            code: "wardby_package_not_found",
            reason: `the registry has no ${name}@${version}`,
            intrinsic: true,
          },
        });
        return;
      }
      // A registry that gives the publish time with the version (PyPI) needs no second read.
      if (fact.publishedAt) {
        const stored: StoredVersionFact = { ...fact, publishedAt: fact.publishedAt };
        complete.push(stored);
        outcomes.set(key, checkedFact(input, stored));
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
      refusal: {
        code: "wardby_registry_integrity_missing",
        reason: "the registry publishes no integrity to check it against",
        intrinsic: true,
      },
    };
  if (!input.hostAllowed(fact.downloadUrl))
    return {
      refusal: {
        code: "wardby_upstream_host_not_allowed",
        reason: `hosted outside the ${input.adapter.id} registry's upstreams`,
        intrinsic: true,
      },
    };
  return { fact };
}

function upstreamRefusal(error: unknown): Omit<PlanRefusal, "name" | "version"> {
  if (error instanceof RegistryError && error.code === "wardby_metadata_too_large")
    return { code: "wardby_metadata_too_large", reason: error.message };
  if (error instanceof RegistryError && error.code === "wardby_package_not_found")
    return { code: "wardby_package_not_found", reason: error.message };
  // A release with nothing the registry may serve (PyPI: no wheel) stays so.
  if (error instanceof RegistryError && error.code === "wardby_file_not_allowed")
    return { code: "wardby_file_not_allowed", reason: error.message, intrinsic: true };
  return { code: "wardby_upstream_error", reason: "the registry could not be read for it; try again" };
}
