/**
 * The only surface KubernetesJobLauncher uses to reach a cluster. Kept narrow
 * so every launcher behavior is unit-tested against FakeKubernetesApi and
 * re-proven against a real cluster by kubernetes.integration.test.ts.
 */
import type { V1ConfigMap, V1Endpoints, V1NetworkPolicy, V1Pod, V1Secret, V1Service } from "@kubernetes/client-node";
import type { Readable, Writable } from "node:stream";

export class KubernetesNotFoundError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "KubernetesNotFoundError";
  }
}

/** Stale resourceVersion on replace. */
export class KubernetesConflictError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "KubernetesConflictError";
  }
}

/** Create of an existing name. */
export class KubernetesAlreadyExistsError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "KubernetesAlreadyExistsError";
  }
}

export interface KubernetesExecOptions {
  stdin?: Readable;
  stdout?: Writable;
  timeoutMs: number;
}

/** Deletes are idempotent (a missing object is not an error). Reads return `undefined` for a missing object. */
export interface KubernetesApi {
  createConfigMap(namespace: string, body: V1ConfigMap): Promise<V1ConfigMap>;
  readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined>;
  replaceConfigMap(namespace: string, name: string, body: V1ConfigMap): Promise<V1ConfigMap>;
  createSecret(namespace: string, body: V1Secret): Promise<V1Secret>;
  deleteSecret(namespace: string, name: string): Promise<void>;
  createPod(namespace: string, body: V1Pod): Promise<V1Pod>;
  /**
   * Server-side dry-run create: the API server runs the whole admission chain and returns the
   * mutated object without persisting anything. Used only by src/tools/capture-autopilot-dry-run.ts;
   * never by the launcher, which must not let a cluster tell it what it is allowed to change.
   */
  dryRunCreatePod(namespace: string, body: V1Pod): Promise<V1Pod>;
  readPod(namespace: string, name: string): Promise<V1Pod | undefined>;
  deletePod(namespace: string, name: string, gracePeriodSeconds: number): Promise<void>;
  createNetworkPolicy(namespace: string, body: V1NetworkPolicy): Promise<V1NetworkPolicy>;
  readNetworkPolicy(namespace: string, name: string): Promise<V1NetworkPolicy | undefined>;
  deleteNetworkPolicy(namespace: string, name: string): Promise<void>;
  readService(namespace: string, name: string): Promise<V1Service | undefined>;
  /**
   * Reads a Service's Endpoints by name. EndpointSlice is the durable successor to this core/v1
   * resource (migrating to it is a follow-up); Endpoints is read by name so RBAC stays one object wide.
   */
  readEndpoints(namespace: string, name: string): Promise<V1Endpoints | undefined>;
  readNamespace(name: string): Promise<boolean>;
  /** Runs a command in a container; resolves with its exit code. Never uses a shell. */
  exec(
    namespace: string,
    pod: string,
    container: string,
    command: string[],
    options: KubernetesExecOptions,
  ): Promise<number>;
  /**
   * The API server's reported version (`gitVersion`, e.g. `v1.33.4-gke.1000`). Read-only and
   * cluster-wide; used by src/tools/capture-fixture.ts to stamp a capture with the server that
   * produced it, so a fixture cannot claim provenance it never recorded.
   */
  readApiServerVersion(): Promise<string>;
  /** Reads at most `limitBytes` of the last `tailLines` lines of a container's log. */
  readLogTail(
    namespace: string,
    pod: string,
    container: string,
    tailLines: number,
    limitBytes: number,
  ): Promise<string>;
}
