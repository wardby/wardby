/**
 * The per-agent package allowlist and policy model: parsing raw allowlist
 * strings (via each ecosystem's adapter) into `AllowlistEntry` values, and
 * matching a normalized package name against them.
 */
import { z } from "zod";
import type { AllowlistEntry, RegistryAdapter } from "./types.js";

export type PackageAllowlist = Readonly<Record<string, readonly string[]>>;
export interface PackagePolicy {
  minReleaseAgeDays: number;
  /** Advisory ids (GHSA-…, CVE-…) whose installs this agent may proceed with; malware (MAL-…) is never acceptable. */
  acceptedAdvisories: readonly string[];
}
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;
export const ACCEPTED_ADVISORY_ID = /^[A-Z][A-Z0-9]*-[A-Za-z0-9-]{3,64}$/;
export const MAX_ACCEPTED_ADVISORIES = 32;

/** The one definition of the acceptedAdvisories field, shared by the policy and the coding profile. */
export const acceptedAdvisoriesSchema = z
  .array(
    z
      .string()
      .refine((id) => !id.startsWith("MAL-"), "acceptedAdvisories: malware advisories (MAL-…) can never be accepted.")
      .pipe(z.string().regex(ACCEPTED_ADVISORY_ID, "must look like GHSA-xxxx-xxxx-xxxx or CVE-2026-12345")),
  )
  .max(MAX_ACCEPTED_ADVISORIES)
  .refine((ids) => new Set(ids).size === ids.length, "must not contain duplicates");

const PolicySchema = z
  .object({
    minReleaseAgeDays: z.number().int().min(0).max(30).default(DEFAULT_MIN_RELEASE_AGE_DAYS),
    acceptedAdvisories: acceptedAdvisoriesSchema.default([]),
  })
  .strict();

export function resolvePolicy(value: unknown): PackagePolicy {
  return PolicySchema.parse(value ?? {});
}

export function parseAllowlist(
  allowlist: PackageAllowlist,
  adapters: ReadonlyMap<string, RegistryAdapter>,
): Map<string, AllowlistEntry[]> {
  const parsed = new Map<string, AllowlistEntry[]>();
  for (const [ecosystem, entries] of Object.entries(allowlist)) {
    const adapter = adapters.get(ecosystem);
    if (!adapter) throw new Error(`unknown package ecosystem "${ecosystem}"`);
    parsed.set(
      ecosystem,
      entries.map((entry) => adapter.parseAllowlistEntry(entry)),
    );
  }
  // Roots the operator grants every agent, even one with no entry for the ecosystem.
  for (const [ecosystem, adapter] of adapters) {
    if (adapter.implicitRoots) parsed.set(ecosystem, [...(parsed.get(ecosystem) ?? []), ...adapter.implicitRoots]);
  }
  return parsed;
}

export function matchRoot(entries: readonly AllowlistEntry[], normalizedName: string): AllowlistEntry | undefined {
  return entries.find((entry) =>
    entry.wildcard
      ? normalizedName.startsWith(entry.name) && normalizedName.length > entry.name.length
      : entry.name === normalizedName,
  );
}
