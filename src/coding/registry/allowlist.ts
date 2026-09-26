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
}
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;

const PolicySchema = z
  .object({ minReleaseAgeDays: z.number().int().min(0).max(30).default(DEFAULT_MIN_RELEASE_AGE_DAYS) })
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
  return parsed;
}

export function matchRoot(entries: readonly AllowlistEntry[], normalizedName: string): AllowlistEntry | undefined {
  return entries.find((entry) =>
    entry.wildcard
      ? normalizedName.startsWith(entry.name) && normalizedName.length > entry.name.length
      : entry.name === normalizedName,
  );
}
