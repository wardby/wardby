// Template pieces both Substrate launchers (coding runs and the native sandbox) build on.

/** The port a template's wake-up probe asks (GET /readyz). */
export const READY_PORT = 8080;

/** Where Substrate puts the actor's name, atespace and uid files. */
export const ACTOR_METADATA_DIR = "/run/ate/actor";

// The files name/atespace/uid appear at the volume root, so the mount path is the directory.
export const actorMetadataVolume = { name: "actor", actorMetadata: { path: "" } } as const;
export const actorMetadataMount = { name: "actor", mountPath: ACTOR_METADATA_DIR };

export interface Size {
  cpuMillicores: number;
  memoryBytes: number;
}

// Refuse rather than resize: the Kubernetes launcher's split is the policy, so a run whose share
// rounds to nothing is a configuration error, not something to paper over.
export function toSize(cpus: number, memoryMb: number): Size {
  const size = { cpuMillicores: Math.round(cpus * 1000), memoryBytes: Math.round(memoryMb * 2 ** 20) };
  if (size.cpuMillicores <= 0 || size.memoryBytes <= 0) throw new Error("substrate_limits_too_small");
  return size;
}

/** The worker selector with its keys sorted, so the same selector always hashes the same way. */
export function sortedSelector(selector: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(selector ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
