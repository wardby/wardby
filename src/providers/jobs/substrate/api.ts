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
     * A systemInfo volume exposing the actor's own metadata as the files `name`, `atespace` and `uid`.
     * `path` is relative to the volume (Substrate refuses an absolute one): `""` puts the files at the
     * volume's root, `"actor"` at `actor/name` etc. The client refuses an absolute path
     * (substrate_template_invalid) before any call.
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

export interface TemplateInfo {
  /**
   * The template's golden snapshot build failed for good (Substrate's
   * status.goldenSnapshotStatus.errorMessage is set, which it documents as terminal): actors
   * cannot start from it until it is deleted and created again. The message itself is never read
   * out: it may quote the template.
   */
  goldenSnapshotFailed: boolean;
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
  getActorTemplate(atespace: string, name: string): Promise<TemplateInfo | undefined>;
  /** A missing template is success. */
  deleteActorTemplate(atespace: string, name: string): Promise<void>;
  /** Throws SubstrateAlreadyExistsError, or SubstrateNotFoundError when the template is gone. */
  createActor(atespace: string, name: string, template: string): Promise<void>;
  getActor(atespace: string, name: string): Promise<ActorInfo | undefined>;
  /** Throws SubstrateExhaustedError when no worker has room. */
  resumeActor(atespace: string, name: string): Promise<void>;
  /**
   * Checkpoints a running actor and waits until its snapshot is in durable storage (warm rounds:
   * the actors of a parked run). A SUSPENDED actor is success. Throws SubstrateNotFoundError.
   */
  suspendActor(atespace: string, name: string): Promise<void>;
  /** A missing actor is success. */
  deleteActor(atespace: string, name: string): Promise<void>;
  /**
   * Creates the actor's egress policy; AlreadyExists is success. The policy belongs to the actor
   * (a foreign key in Substrate), so the actor must exist first.
   */
  putEgressPolicy(atespace: string, actor: string, rules: EgressRule[]): Promise<void>;
  /** A missing policy is success. */
  deleteEgressPolicy(atespace: string, actor: string): Promise<void>;
  listWorkers(): Promise<WorkerInfo[]>;
}
