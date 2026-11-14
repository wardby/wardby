// Typed surface over Agent Substrate's control API. The job launcher depends only on this
// interface; client.ts adapts the build-time-generated gRPC client to it and fake-api.ts is
// the in-memory double used by tests.

export type ActorState =
  "RESUMING" | "RUNNING" | "SUSPENDING" | "SUSPENDED" | "CRASHED" | "DELETING" | "REVERTING" | "UNKNOWN";

export interface ContainerSpec {
  name: string;
  image: string; // must be repo@sha256:...
  command?: string[];
  /** NEVER secret values: the API server logs templates. */
  env?: { name: string; value: string }[];
  wakeupProbe?: { path: string; port: number };
  volumeMounts?: { name: string; mountPath: string }[];
}

export interface ActorTemplateSpec {
  atespace: string;
  name: string;
  workerSelector?: Record<string, string>;
  containers: ContainerSpec[];
  volumes: (
    | { name: string; durableDir: true }
    | { name: string; trustBundle: { names: string[]; path: string } }
    /**
     * A systemInfo volume exposing the actor's own metadata: the actor's name, atespace and
     * uid are written as the files `<path>/name`, `<path>/atespace` and `<path>/uid`.
     */
    | { name: string; actorMetadata: { path: string } }
  )[];
  cpuMillicores: number;
  memoryBytes: number;
  snapshotFidelity: "MEMORY" | "VOLUMES";
}

export interface EgressRule {
  kind: "http" | "https";
  hostnames: string[];
  ports?: number[];
  replaceHeaders?: (
    | { header: string; prefix?: string; credentialUri: string }
    | {
        header: string;
        prefix?: string;
        actorJwt: { audiences: string[]; expirationSeconds: number };
      }
  )[];
}

export interface ActorInfo {
  state: ActorState;
  templateName: string;
  workerPod?: string;
}

export interface WorkerInfo {
  pool: string;
  /** The WorkerPool's labels, which a template's worker selector matches against. */
  labels: Record<string, string>;
  /** Capacity less allocated (Substrate's allocated includes each actor's runtime overhead). */
  freeCpuMillicores: number;
  freeMemoryBytes: number;
}

export class SubstrateNotFoundError extends Error {
  readonly code = "substrate_not_found";
}
export class SubstrateAlreadyExistsError extends Error {
  readonly code = "substrate_already_exists";
}
export class SubstrateExhaustedError extends Error {
  readonly code = "substrate_resource_exhausted";
}
export class SubstrateUnavailableError extends Error {
  readonly code = "substrate_unavailable";
}

export interface SubstrateApi {
  /** AlreadyExists is success. */
  ensureActorTemplate(spec: ActorTemplateSpec): Promise<void>;
  /** Throws SubstrateAlreadyExistsError. */
  createActor(atespace: string, name: string, template: string): Promise<void>;
  getActor(atespace: string, name: string): Promise<ActorInfo | undefined>;
  /** Throws SubstrateExhaustedError when no worker has room. */
  resumeActor(atespace: string, name: string): Promise<void>;
  /** A missing actor is success. */
  deleteActor(atespace: string, name: string): Promise<void>;
  /** Creates the actor's egress policy; AlreadyExists is success. */
  putEgressPolicy(atespace: string, actor: string, rules: EgressRule[]): Promise<void>;
  /** A missing policy is success. */
  deleteEgressPolicy(atespace: string, actor: string): Promise<void>;
  listWorkers(): Promise<WorkerInfo[]>;
}
