import type { V1ConfigMap, V1Endpoints, V1NetworkPolicy, V1Pod, V1Secret, V1Service } from "@kubernetes/client-node";
import type { Readable, Writable } from "node:stream";
import {
  KubernetesAlreadyExistsError,
  KubernetesConflictError,
  KubernetesNotFoundError,
  type KubernetesApi,
  type KubernetesExecOptions,
} from "./kubernetes-api.js";

export interface FakeExecCall {
  namespace: string;
  pod: string;
  container: string;
  command: string[];
  stdin?: Readable;
  stdout?: Writable;
}

type Kind = "configmap" | "secret" | "pod" | "networkpolicy" | "service" | "endpoints";
type Obj = { metadata?: { name?: string; namespace?: string; resourceVersion?: string } };

/** In-memory KubernetesApi for unit tests. Tests drive pod status and exec behavior directly. */
export class FakeKubernetesApi implements KubernetesApi {
  readonly objects = new Map<string, Obj>();
  readonly namespaces = new Set<string>(["wardby-coding"]);
  readonly execCalls: FakeExecCall[] = [];
  readonly deletedPods: Array<{ name: string; gracePeriodSeconds: number }> = [];
  /** Returns the exit code; write to stdout / read stdin as the command would. Default: exit 0, no output. */
  onExec: (call: FakeExecCall) => Promise<number> = async ({ stdout, stdin }) => {
    stdin?.resume();
    stdout?.end();
    return 0;
  };
  /** The admission chain a dry-run create runs through. Default: echo the pod back unchanged. */
  onDryRunCreatePod: (namespace: string, body: V1Pod) => Promise<V1Pod> = async (_namespace, body) => body;
  logs = new Map<string, string>();
  /** What readApiServerVersion reports; tests that care about provenance set it. */
  apiServerVersion = "v1.33.0";
  private version = 0;

  private key(kind: Kind, namespace: string, name: string): string {
    return `${kind}/${namespace}/${name}`;
  }

  private create<T extends Obj>(kind: Kind, namespace: string, body: T): T {
    const name = body.metadata?.name;
    if (!name) throw new Error("fake_name_required");
    const key = this.key(kind, namespace, name);
    if (this.objects.has(key)) throw new KubernetesAlreadyExistsError(key);
    const stored = structuredClone({
      ...body,
      metadata: { ...body.metadata, namespace, resourceVersion: String(++this.version) },
    }) as T;
    this.objects.set(key, stored);
    return structuredClone(stored);
  }

  private read<T extends Obj>(kind: Kind, namespace: string, name: string): T | undefined {
    const found = this.objects.get(this.key(kind, namespace, name));
    return found ? (structuredClone(found) as T) : undefined;
  }

  private delete(kind: Kind, namespace: string, name: string): void {
    this.objects.delete(this.key(kind, namespace, name));
  }

  /** Test helper: overwrite an object without a resourceVersion check (e.g. to set pod status). */
  put<T extends Obj>(kind: Kind, namespace: string, body: T): void {
    const name = body.metadata?.name as string;
    this.objects.set(this.key(kind, namespace, name), {
      ...structuredClone(body),
      metadata: { ...body.metadata, namespace, resourceVersion: String(++this.version) },
    });
  }

  async createConfigMap(namespace: string, body: V1ConfigMap) {
    return this.create("configmap", namespace, body);
  }
  async readConfigMap(namespace: string, name: string) {
    return this.read<V1ConfigMap>("configmap", namespace, name);
  }
  async replaceConfigMap(namespace: string, name: string, body: V1ConfigMap) {
    const key = this.key("configmap", namespace, name);
    const current = this.objects.get(key);
    if (!current) throw new KubernetesNotFoundError(key);
    if (body.metadata?.resourceVersion !== current.metadata?.resourceVersion) throw new KubernetesConflictError(key);
    const stored = structuredClone({
      ...body,
      metadata: { ...body.metadata, namespace, resourceVersion: String(++this.version) },
    });
    this.objects.set(key, stored);
    return structuredClone(stored);
  }
  async createSecret(namespace: string, body: V1Secret) {
    return this.create("secret", namespace, body);
  }
  async deleteSecret(namespace: string, name: string) {
    this.delete("secret", namespace, name);
  }
  async createPod(namespace: string, body: V1Pod) {
    return this.create("pod", namespace, body);
  }
  /**
   * A dry-run create persists nothing, but it is still a create: the API server runs the same
   * validation and name checks, so a nameless body and a colliding name both fail exactly as
   * they would on a real create. Tests override `onDryRunCreatePod` to model an admission chain.
   */
  async dryRunCreatePod(namespace: string, body: V1Pod) {
    const name = body.metadata?.name;
    if (!name) throw new Error("fake_name_required");
    const key = this.key("pod", namespace, name);
    if (this.objects.has(key)) throw new KubernetesAlreadyExistsError(key);
    return this.onDryRunCreatePod(namespace, structuredClone(body));
  }
  async readPod(namespace: string, name: string) {
    return this.read<V1Pod>("pod", namespace, name);
  }
  async deletePod(namespace: string, name: string, gracePeriodSeconds: number) {
    this.deletedPods.push({ name, gracePeriodSeconds });
    this.delete("pod", namespace, name);
  }
  async createNetworkPolicy(namespace: string, body: V1NetworkPolicy) {
    return this.create("networkpolicy", namespace, body);
  }
  async readNetworkPolicy(namespace: string, name: string) {
    return this.read<V1NetworkPolicy>("networkpolicy", namespace, name);
  }
  async deleteNetworkPolicy(namespace: string, name: string) {
    this.delete("networkpolicy", namespace, name);
  }
  async readService(namespace: string, name: string) {
    return this.read<V1Service>("service", namespace, name);
  }
  async readEndpoints(namespace: string, name: string) {
    return this.read<V1Endpoints>("endpoints", namespace, name);
  }
  async readApiServerVersion() {
    return this.apiServerVersion;
  }
  async readNamespace(name: string) {
    return this.namespaces.has(name);
  }
  async exec(namespace: string, pod: string, container: string, command: string[], options: KubernetesExecOptions) {
    // Like the real API: exec into a missing pod or an unknown container fails instead of succeeding
    // silently, so no test can pass on behaviour a cluster would reject. (The adapter's timeoutMs is
    // not modelled: tests drive slow execs through onExec directly.)
    const target = this.read<V1Pod>("pod", namespace, pod);
    if (!target) throw new KubernetesNotFoundError(this.key("pod", namespace, pod));
    const containers = [...(target.spec?.containers ?? []), ...(target.spec?.initContainers ?? [])];
    if (!containers.some((entry) => entry.name === container)) {
      throw new KubernetesNotFoundError(`${this.key("pod", namespace, pod)}/${container}`);
    }
    const call: FakeExecCall = { namespace, pod, container, command, stdin: options.stdin, stdout: options.stdout };
    this.execCalls.push(call);
    return this.onExec(call);
  }
  async readLogTail(namespace: string, pod: string, container: string, tailLines: number, limitBytes: number) {
    const lines = (this.logs.get(`${namespace}/${pod}/${container}`) ?? "").split("\n").slice(-tailLines).join("\n");
    return Buffer.from(lines).subarray(0, limitBytes).toString();
  }
}
