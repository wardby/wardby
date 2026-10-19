// Types for registry-refusals.mjs, so its tests and the tool runner's are type-checked.
export interface RegistryAccess {
  base: string;
  token: string;
}

export interface RecentRefusal {
  ecosystem: string;
  name: string;
  version?: string;
  code: string;
  hint?: string;
}

export declare function registryAccess(env?: Record<string, string | undefined>): RegistryAccess | undefined;
export declare function recentRefusals(
  access: RegistryAccess | undefined,
  since?: Date,
  fetchImpl?: typeof fetch,
): Promise<RecentRefusal[]>;
export declare function formatRefusals(refusals: readonly RecentRefusal[]): string[];
