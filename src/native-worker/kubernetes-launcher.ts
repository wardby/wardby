/**
 * Launches, watches, stops, and removes native sandbox workers as Kubernetes pods
 * (docs/native-sandbox.md), from the builders in kubernetes-isolation.ts. Like the Docker
 * launcher it keeps no state of its own: names derive from the run id, state comes from the pod,
 * and sessions live in Postgres, so any replica can act on any run.
 *
 * A pod's NetworkPolicy takes effect a few seconds after the pod starts (the CNI programs it), so
 * the session is created not ready (`networkReadyAtLaunch = false`): the gateway refuses the
 * worker until this launcher has read back the pod and policy it created, then proven from inside
 * the pod that the gateway port answers while the gateway's deny port and an outside address do
 * not — and only then marks the session ready.
 */

import type { V1NetworkPolicy, V1Pod } from "@kubernetes/client-node";
import { logger } from "../core/logger.js";
import { KubernetesAlreadyExistsError, type KubernetesApi } from "../providers/jobs/kubernetes-api.js";
import { canonicalResources } from "../providers/jobs/kubernetes-isolation.js";
import type { KubernetesPlatform } from "../providers/jobs/kubernetes-platform.js";
import { NATIVE_GATEWAY_PORT, type NativeWorkerLimits } from "./docker-isolation.js";
import type { NativeWorkerState } from "./docker-launcher.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  buildNativeInputSecret,
  buildNativeRunNetworkPolicy,
  buildNativeRunPod,
  buildNativeWarmNetworkPolicy,
  buildNativeWarmPod,
  NATIVE_PROBE,
  NATIVE_RUN_SELECTOR,
  NATIVE_RUN_SHA_LABEL,
  NATIVE_WARM_SELECTOR,
  NATIVE_WARM_TOKEN_LABEL,
  NATIVE_WORKER_CONTAINER,
  nativeEnforcementProbe,
  nativeKubernetesNames,
  nativeWarmWorkerName,
} from "./kubernetes-isolation.js";
import type { WorkerHandle } from "./launch.js";
import type { WorkerInput } from "./protocol.js";
import type { ManagedWorkerLauncher } from "./sandbox-executor.js";
import { warmDeliveryCommand } from "./warm-delivery.js";
import { NATIVE_SANDBOX_WARM_DELIVERY_FAILED, type WarmWorkerLauncher } from "./warm-pool.js";

const k8sLog = logger.child({ module: "native-kubernetes-launcher" });

export const NATIVE_SANDBOX_NETWORK_UNENFORCED = "native_sandbox_network_unenforced";
export const NATIVE_SANDBOX_ISOLATION_MISMATCH = "native_sandbox_isolation_mismatch";
export const NATIVE_SANDBOX_CAPACITY = "native_sandbox_capacity";

/** The API server's refusal of a pod the namespace's ResourceQuota has no room for (403 "exceeded quota"). */
export function isQuotaRejection(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, body, message } = err as { code?: unknown; body?: unknown; message?: unknown };
  const text = `${typeof body === "string" ? body : JSON.stringify(body ?? "")} ${typeof message === "string" ? message : ""}`;
  return (code === 403 || code === undefined) && /exceeded quota/i.test(text);
}

export interface KubernetesNativeWorkerLauncherOptions {
  api: KubernetesApi;
  namespace: string;
  image: string;
  limits: NativeWorkerLimits;
  /** The native gateway's Service, in the same namespace (NetworkPolicy selects its pods there). */
  gatewayService: string;
  runtimeClassName?: string;
  /** KUBERNETES_PLATFORM: the admission rules native pods are conformed to. */
  platform?: KubernetesPlatform;
  /** KUBERNETES_RUN_PRIORITY_CLASS. */
  priorityClassName?: string;
  /** NATIVE_GATEWAY_URL: dial this instead of the Service's ClusterIP (its host is also what the probe checks). */
  gatewayUrl?: string;
  /** Called once a pod's isolation is proven; the executor marks the run's session ready. */
  onNetworkProven: (runId: string) => Promise<void>;
  /** The pod's hard lifetime (its session's deadline). */
  deadlineSeconds: number;
  readyTimeoutMs?: number;
  enforcementTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * An object as the API server would store it, for comparison: keys sorted, and missing, undefined,
 * and empty arrays alike (it drops an empty `ingress: []`, which `policyTypes` already makes deny-all).
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? undefined : value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = canonical((value as Record<string, unknown>)[key]);
    if (item !== undefined) out[key] = item;
  }
  return out;
}

export class KubernetesNativeWorkerLauncher implements ManagedWorkerLauncher, WarmWorkerLauncher {
  readonly networkReadyAtLaunch = false;
  private gatewayHost: Promise<string> | undefined;

  constructor(private readonly options: KubernetesNativeWorkerLauncherOptions) {}

  private get api(): KubernetesApi {
    return this.options.api;
  }
  private get ns(): string {
    return this.options.namespace;
  }
  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? ((t) => new Promise((resolve) => setTimeout(resolve, t))))(ms);
  }

  /** The gateway Service's ClusterIP: workers dial an address, so they need no DNS egress. */
  private resolveGatewayHost(): Promise<string> {
    if (this.options.gatewayUrl) return Promise.resolve(new URL(this.options.gatewayUrl).hostname);
    this.gatewayHost ??= (async () => {
      const service = await this.api.readService(this.ns, this.options.gatewayService);
      const ip = service?.spec?.clusterIP;
      if (!ip || ip === "None") {
        this.gatewayHost = undefined;
        throw new Error(
          `native_sandbox_gateway_unavailable: Service "${this.options.gatewayService}" in "${this.ns}" has no ClusterIP.`,
        );
      }
      return ip;
    })();
    return this.gatewayHost;
  }

  async resolveGatewayUrl(): Promise<string> {
    if (this.options.gatewayUrl) return this.options.gatewayUrl;
    return `http://${await this.resolveGatewayHost()}:${NATIVE_GATEWAY_PORT}/native-gateway/v1/call`;
  }

  private async createIfMissing(create: () => Promise<unknown>): Promise<void> {
    try {
      await create();
    } catch (err) {
      if (!(err instanceof KubernetesAlreadyExistsError)) throw err;
    }
  }

  async launch(input: WorkerInput): Promise<WorkerHandle> {
    const runId = input.runId;
    const names = nativeKubernetesNames(runId);
    if ((await this.inspect(runId)).state === "missing") {
      const pod = buildNativeRunPod({
        runId,
        namespace: this.ns,
        image: this.options.image,
        limits: this.options.limits,
        activeDeadlineSeconds: this.options.deadlineSeconds,
        runtimeClassName: this.options.runtimeClassName,
        platform: this.options.platform,
        priorityClassName: this.options.priorityClassName,
      });
      const policy = buildNativeRunNetworkPolicy(runId, this.ns);
      await this.createIsolated(pod, policy, () => this.remove(runId), {
        // The Secret before the pod that mounts it.
        beforePod: () =>
          this.createIfMissing(() => this.api.createSecret(this.ns, buildNativeInputSecret(input, this.ns))),
      });
      await this.options.onNetworkProven(runId);
    } else {
      k8sLog.info({ pod: names.pod }, "native worker pod already exists: attaching, not relaunching");
    }
    return this.handle(runId);
  }

  /**
   * Policy first, so the pod never exists without it; then the pod; then attest and prove it. A
   * quota rejection becomes native_sandbox_capacity. Any failure removes what was made.
   */
  private async createIsolated(
    pod: V1Pod,
    policy: V1NetworkPolicy,
    cleanup: () => Promise<void>,
    hooks: { beforePod?: () => Promise<void> } = {},
  ): Promise<void> {
    await this.createIfMissing(() => this.api.createNetworkPolicy(this.ns, policy));
    await hooks.beforePod?.();
    try {
      await this.createIfMissing(() => this.api.createPod(this.ns, pod));
    } catch (err) {
      if (!isQuotaRejection(err)) throw err;
      await cleanup().catch(() => {});
      throw new Error(
        `${NATIVE_SANDBOX_CAPACITY}: the namespace's ResourceQuota has no room for another native worker pod.`,
        { cause: err },
      );
    }
    try {
      await this.attest(pod, policy);
      await this.proveIsolation(pod.metadata!.name!);
    } catch (err) {
      await cleanup().catch(() => {});
      throw err;
    }
  }

  /** What the API server stored must still be what was built: an admission change voids the run. */
  private async attest(built: V1Pod, builtPolicy: V1NetworkPolicy): Promise<void> {
    if (!(await this.matches(built, builtPolicy))) {
      throw new Error(
        `${NATIVE_SANDBOX_ISOLATION_MISMATCH}: the worker pod or its NetworkPolicy as stored differs from what was built.`,
      );
    }
  }

  private async matches(built: V1Pod, builtPolicy: V1NetworkPolicy): Promise<boolean> {
    const [pod, policy] = await Promise.all([
      this.api.readPod(this.ns, built.metadata!.name!),
      this.api.readNetworkPolicy(this.ns, builtPolicy.metadata!.name!),
    ]);
    const stored = pod?.spec;
    const want = built.spec!;
    const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
    const ok =
      !!stored &&
      !!policy &&
      same(policy.spec, builtPolicy.spec) &&
      stored.automountServiceAccountToken === false &&
      stored.hostNetwork !== true &&
      stored.runtimeClassName === want.runtimeClassName &&
      stored.priorityClassName === want.priorityClassName &&
      stored.containers.length === 1 &&
      stored.containers[0].image === want.containers[0].image &&
      same(stored.containers[0].securityContext, want.containers[0].securityContext) &&
      same(stored.containers[0].env, want.containers[0].env) &&
      same(canonicalResources(stored.containers[0].resources), canonicalResources(want.containers[0].resources)) &&
      (stored.initContainers ?? []).length === 0;
    return ok;
  }

  /** Waits for the pod to run, then proves its egress from inside it (bounded). */
  private async proveIsolation(podName: string): Promise<void> {
    const pollMs = this.options.pollMs ?? 1_000;
    const readyBy = Date.now() + (this.options.readyTimeoutMs ?? 120_000);
    for (;;) {
      const pod = await this.api.readPod(this.ns, podName);
      if (!pod) throw new Error("native_sandbox_worker_lost: the worker pod disappeared before it was ready.");
      const phase = pod.status?.phase ?? "Pending";
      if (phase === "Running") break;
      if (phase === "Succeeded" || phase === "Failed") {
        throw new Error(`native_sandbox_worker_exited: the worker pod ended before it was ready (${phase}).`);
      }
      if (Date.now() >= readyBy)
        throw new Error("native_sandbox_worker_unready: the worker pod did not start in time.");
      await this.sleep(pollMs);
    }
    const command = nativeEnforcementProbe(await this.resolveGatewayHost());
    const provenBy = Date.now() + (this.options.enforcementTimeoutMs ?? 30_000);
    let last: number;
    for (;;) {
      last = await this.api
        .exec(this.ns, podName, NATIVE_WORKER_CONTAINER, command, { timeoutMs: 20_000 })
        .catch(() => NATIVE_PROBE.gatewayUnreachable);
      if (last === NATIVE_PROBE.proven) return;
      if (Date.now() >= provenBy) break;
      await this.sleep(pollMs);
    }
    const why =
      last === NATIVE_PROBE.denyReachable
        ? "the gateway's deny port was reachable"
        : last === NATIVE_PROBE.outsideReachable
          ? "an outside address was reachable"
          : "the gateway was unreachable";
    throw new Error(`${NATIVE_SANDBOX_NETWORK_UNENFORCED}: the worker pod's isolation could not be proven (${why}).`);
  }

  handle(runId: string): WorkerHandle {
    return this.handleByName(nativeKubernetesNames(runId).pod);
  }

  private handleByName(podName: string): WorkerHandle {
    const exited = (async () => {
      for (;;) {
        const state = await this.inspectByName(podName);
        if (state.state === "exited") return state.exitCode;
        if (state.state === "missing") return null;
        await this.sleep(this.options.pollMs ?? 1_000);
      }
    })();
    return { exited, kill: () => void this.api.deletePod(this.ns, podName, 0) };
  }

  async inspect(runId: string): Promise<NativeWorkerState> {
    return this.inspectByName(nativeKubernetesNames(runId).pod);
  }

  private async inspectByName(podName: string): Promise<NativeWorkerState> {
    const pod = await this.api.readPod(this.ns, podName);
    if (!pod) return { state: "missing" };
    const phase = pod.status?.phase;
    if (phase === "Succeeded" || phase === "Failed") {
      const terminated = pod.status?.containerStatuses?.find((c) => c.name === NATIVE_WORKER_CONTAINER)?.state
        ?.terminated;
      return { state: "exited", exitCode: terminated?.exitCode ?? 137 };
    }
    return { state: "running" };
  }

  async kill(runId: string): Promise<void> {
    await this.api.deletePod(this.ns, nativeKubernetesNames(runId).pod, 0);
  }

  async remove(runId: string): Promise<void> {
    await this.removeByWorkerName(nativeKubernetesNames(runId).pod);
  }

  async listWorkers(): Promise<{ name: string; runHash: string }[]> {
    const pods = await this.api.listPods(this.ns, NATIVE_RUN_SELECTOR);
    return pods
      .map((pod) => ({ name: pod.metadata?.name ?? "", runHash: pod.metadata?.labels?.[NATIVE_RUN_SHA_LABEL] ?? "" }))
      .filter((worker) => worker.name && worker.runHash);
  }

  async removeByWorkerName(name: string): Promise<void> {
    if (!/^wardby-native-[0-9a-f]{20}$/.test(name)) return;
    await this.api.deletePod(this.ns, name, 0);
    await this.api.deleteSecret(this.ns, `${name}-input`);
    await this.api.deleteNetworkPolicy(this.ns, name);
  }

  // --- Warm pool workers (native sandbox phase 6) ---

  private warmPod(token: string, waitMs: number): V1Pod {
    return buildNativeWarmPod({
      token,
      waitMs,
      namespace: this.ns,
      image: this.options.image,
      limits: this.options.limits,
      // A claimed worker keeps the run's whole deadline however long it waited.
      activeDeadlineSeconds: Math.ceil(waitMs / 1000) + this.options.deadlineSeconds,
      runtimeClassName: this.options.runtimeClassName,
      platform: this.options.platform,
      priorityClassName: this.options.priorityClassName,
    });
  }

  warmSpecHash(waitMs: number): string {
    const { image, limits, runtimeClassName, platform, priorityClassName, gatewayService, gatewayUrl } = this.options;
    const spec = { launcher: "kubernetes", ns: this.ns, image, limits, runtimeClassName, platform, priorityClassName };
    return createHash("sha256")
      .update(JSON.stringify({ ...spec, gatewayService, gatewayUrl, waitMs }))
      .digest("hex");
  }

  async startWarm(token: string, waitMs: number): Promise<void> {
    await this.createIsolated(this.warmPod(token, waitMs), buildNativeWarmNetworkPolicy(token, this.ns), () =>
      this.removeWarm(token),
    );
  }

  async reattestWarm(token: string, waitMs: number): Promise<boolean> {
    const pod = await this.api.readPod(this.ns, nativeWarmWorkerName(token));
    if (pod?.status?.phase !== "Running") return false;
    return this.matches(this.warmPod(token, waitMs), buildNativeWarmNetworkPolicy(token, this.ns));
  }

  async deliver(token: string, input: WorkerInput): Promise<void> {
    const code = await this.api.exec(
      this.ns,
      nativeWarmWorkerName(token),
      NATIVE_WORKER_CONTAINER,
      warmDeliveryCommand(),
      {
        timeoutMs: 20_000,
        stdin: Readable.from([`${JSON.stringify(input)}\n`]),
      },
    );
    if (code !== 0) {
      throw new Error(`${NATIVE_SANDBOX_WARM_DELIVERY_FAILED}: delivering the run's input exited ${code}.`);
    }
  }

  warmHandle(token: string): WorkerHandle {
    return this.handleByName(nativeWarmWorkerName(token));
  }

  inspectWarm(token: string): Promise<NativeWorkerState> {
    return this.inspectByName(nativeWarmWorkerName(token));
  }

  async killWarm(token: string): Promise<void> {
    await this.api.deletePod(this.ns, nativeWarmWorkerName(token), 0);
  }

  async removeWarm(token: string): Promise<void> {
    const name = nativeWarmWorkerName(token);
    await this.api.deletePod(this.ns, name, 0);
    await this.api.deleteNetworkPolicy(this.ns, name);
  }

  async listWarm(): Promise<string[]> {
    const pods = await this.api.listPods(this.ns, NATIVE_WARM_SELECTOR);
    return pods
      .map((pod) => pod.metadata?.labels?.[NATIVE_WARM_TOKEN_LABEL] ?? "")
      .filter((token) => /^[0-9a-f]{20}$/.test(token));
  }
}
