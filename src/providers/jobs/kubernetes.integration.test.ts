/**
 * Integration tests against a real Kubernetes cluster (the `deploy/kind-coding/`
 * harness). Skipped entirely unless WARDBY_KUBERNETES_TEST=1; with that set but
 * KUBERNETES_CONTEXT or a registry-digest CODING_WORKER_IMAGE missing, the suite
 * fails loudly instead of silently skipping. `npm test` (no env set) stays
 * cluster-free and can't be broken by a bad ~/.kube/config, since nothing that
 * touches a kubeconfig runs outside a `beforeAll` gated on those checks.
 *
 * What this proves that FakeKubernetesApi cannot: the real API server's
 * defaulting round-trips through attestation unchanged; the NetworkPolicy
 * enforcement gate actually blocks the worker's egress until it opens; the
 * pod really is isolated (no DNS, no internet, no metadata endpoint, no
 * reach to the cluster DNS or API server ClusterIPs, and no reach to the
 * cluster DNS pod's own IP either — proving the block holds at the pod-IP
 * level, not just via Service DNAT — while the proxy's own pod IP is
 * reachable, proving the allow side isn't an artifact of routing through a
 * Service either); a failing worker yields the exact safe diagnostic it
 * emits for a deterministically-invalid input; stop/remove/relaunch behave
 * against real objects; the record survives removal as a tombstone.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ApiException, CoreV1Api, KubeConfig, NetworkingV1Api, type V1Endpoints } from "@kubernetes/client-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKubernetesJobConfig, type KubernetesJobConfig } from "../../config/providers.js";
import type { KubernetesApi, KubernetesExecOptions } from "./kubernetes-api.js";
import { ClientNodeKubernetesApi } from "./kubernetes-client.js";
import { kubernetesRunNames, type KubernetesRunNames } from "./kubernetes-isolation.js";
import { runKubernetesPreflight } from "./kubernetes-preflight.js";
import { KubernetesJobLauncher, type KubernetesClusterInfo } from "./kubernetes.js";
import type { JobHandle, JobSpec } from "./types.js";

const requested = process.env.WARDBY_KUBERNETES_TEST === "1";

describe.skipIf(!requested)("KubernetesJobLauncher against a real cluster", () => {
  const contextGiven = !!process.env.KUBERNETES_CONTEXT;
  const imageIsDigest = /@sha256:[a-f0-9]{64}$/.test(process.env.CODING_WORKER_IMAGE ?? "");
  const configured = contextGiven && imageIsDigest;

  // Fails loudly rather than silently skipping: WARDBY_KUBERNETES_TEST=1 is an explicit request to
  // run against a real cluster, so a missing/malformed config is a mistake worth failing the run over.
  it.runIf(!configured)(
    "fails loudly when WARDBY_KUBERNETES_TEST=1 is set but the cluster config is incomplete",
    () => {
      const problems = [
        !contextGiven && "KUBERNETES_CONTEXT is not set",
        !imageIsDigest && "CODING_WORKER_IMAGE is not a registry-digest reference (repo@sha256:<64 hex>)",
      ].filter((problem): problem is string => problem !== false);
      throw new Error(`WARDBY_KUBERNETES_TEST=1 requires a complete cluster config: ${problems.join("; ")}`);
    },
  );

  // Nested so that nothing here — including constructing ClientNodeKubernetesApi, which loads a real
  // kubeconfig — runs during collection or outside a beforeAll gated on `configured`. A plain `const`
  // at the outer describe's top level runs during collection even when the describe is skipped.
  describe.skipIf(!configured)("against the cluster", () => {
    let workerImage: string;
    let config: KubernetesJobConfig;
    let namespace: string;
    let rawApi: ClientNodeKubernetesApi;
    let rawCore: CoreV1Api;
    let rawNetworking: NetworkingV1Api;
    let cluster: KubernetesClusterInfo;
    let apiServerIp: string;
    let dnsPodIp: string;
    let proxyPodIp: string;
    const roots: string[] = [];
    const tracked: Array<{ launcher: KubernetesJobLauncher; handle: JobHandle; names: KubernetesRunNames }> = [];

    /** The IP of one ready endpoint behind a Service, read via the legacy (still-served) Endpoints API. */
    function readyEndpointIp(endpoints: V1Endpoints): string | undefined {
      return endpoints.subsets?.flatMap((subset) => subset.addresses ?? []).find((address) => address.ip)?.ip;
    }

    beforeAll(async () => {
      workerImage = process.env.CODING_WORKER_IMAGE!;
      config = loadKubernetesJobConfig(process.env);
      namespace = config.namespace;
      rawApi = new ClientNodeKubernetesApi({ context: config.context });
      const kubeConfig = new KubeConfig();
      kubeConfig.loadFromDefault();
      if (config.context) kubeConfig.setCurrentContext(config.context);
      rawCore = kubeConfig.makeApiClient(CoreV1Api);
      rawNetworking = kubeConfig.makeApiClient(NetworkingV1Api);

      const result = await runKubernetesPreflight({ api: rawApi, config, workerImage, maxDiskMb: 2048 });
      cluster = { proxyIp: result.proxyIp };

      // The API server's Service ClusterIP (the "default/kubernetes" Service every cluster provides).
      const apiServerService = await rawApi.readService("default", "kubernetes");
      const apiServerClusterIp = apiServerService?.spec?.clusterIP;
      if (!apiServerClusterIp) throw new Error("Service default/kubernetes has no ClusterIP");
      apiServerIp = apiServerClusterIp;

      // Real pod IPs (not Service ClusterIPs) for the two probes that must be non-vacuous: a
      // connect to a ClusterIP with no matching Service port never reaches kube-proxy's DNAT table
      // at all, so it fails whether or not any NetworkPolicy exists. Going straight to a pod IP
      // that actually has a listener removes that ambiguity for both the blocked and allowed case.
      const dnsEndpoints = await rawCore.readNamespacedEndpoints({ name: "kube-dns", namespace: "kube-system" });
      const dnsIp = readyEndpointIp(dnsEndpoints);
      if (!dnsIp) throw new Error("kube-system/kube-dns has no ready endpoint");
      dnsPodIp = dnsIp;
      const proxyEndpoints = await rawCore.readNamespacedEndpoints({ name: config.proxyService, namespace });
      const proxyIp = readyEndpointIp(proxyEndpoints);
      if (!proxyIp) throw new Error(`${namespace}/${config.proxyService} has no ready endpoint`);
      proxyPodIp = proxyIp;
    }, 120_000);

    function statusCode(error: unknown): number | undefined {
      return error instanceof ApiException ? (error as ApiException<unknown>).code : undefined;
    }

    async function ignoreNotFound(promise: Promise<unknown>): Promise<void> {
      try {
        await promise;
      } catch (error) {
        if (statusCode(error) !== 404) throw error;
      }
    }

    /** Runs every delete even if earlier ones failed, so one non-404 error can't abort cleanup for later runs. */
    async function deleteAllBestEffort(deletes: Array<() => Promise<void>>): Promise<void> {
      const errors: unknown[] = [];
      for (const del of deletes) {
        try {
          await del();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `kubernetes integration test cleanup: ${errors.length} delete(s) failed`);
      }
    }

    afterAll(async () => {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
      // beforeAll may have failed before any run was tracked (e.g. the preflight itself failed);
      // nothing below is safe to touch in that case, and there is nothing to clean up either.
      if (tracked.length === 0) return;
      // Best-effort graceful path first: let each run's own launcher stop/record it normally.
      for (const { launcher, handle } of tracked) {
        await launcher.stop(handle).catch(() => undefined);
        await launcher.remove(handle).catch(() => undefined);
      }
      // Raw-client backstop for whatever the graceful path couldn't reach: a launch that failed
      // before a handle's objects fully existed, a failed assertion that left objects behind, and
      // the record ConfigMap tombstone `remove()` intentionally leaves behind on success.
      // deleteConfigMap isn't part of the KubernetesApi seam, so this goes straight to the library.
      const deletes: Array<() => Promise<void>> = [];
      for (const { names } of tracked) {
        deletes.push(() =>
          ignoreNotFound(rawCore.deleteNamespacedPod({ namespace, name: names.pod, gracePeriodSeconds: 0 })),
        );
        deletes.push(() =>
          ignoreNotFound(rawNetworking.deleteNamespacedNetworkPolicy({ namespace, name: names.policy })),
        );
        deletes.push(() => ignoreNotFound(rawCore.deleteNamespacedSecret({ namespace, name: names.secret })));
        deletes.push(() => ignoreNotFound(rawCore.deleteNamespacedConfigMap({ namespace, name: names.record })));
      }
      await deleteAllBestEffort(deletes);
    });

    interface ExecRecord {
      command: string[];
      exitCode?: number;
    }

    /** Wraps the real api so every keeper exec (and its exit code) can be inspected after a launch. */
    function wrapExec(inner: KubernetesApi, log: ExecRecord[]): KubernetesApi {
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "exec") {
            return async (
              execNamespace: string,
              pod: string,
              container: string,
              command: string[],
              options: KubernetesExecOptions,
            ) => {
              const record: ExecRecord = { command };
              log.push(record);
              const exitCode = await target.exec(execNamespace, pod, container, command, options);
              record.exitCode = exitCode;
              return exitCode;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    }

    /** The enforcement gate's probe command is a distinctive `node -e` script connecting to port 53. */
    function isEnforcementProbe(command: string[]): boolean {
      return (
        command[0] === "node" &&
        command[1] === "-e" &&
        typeof command[2] === "string" &&
        command[2].includes("port: 53")
      );
    }

    function handleFor(names: KubernetesRunNames): JobHandle {
      return { backend: "kubernetes", id: `${namespace}/${names.token}` };
    }

    async function setup() {
      const runId = `k8s-it-${randomBytes(6).toString("hex")}`;
      const root = await mkdtemp(join(tmpdir(), "wardby-k8s-it-"));
      roots.push(root);
      const workspaceRoot = join(root, "workspaces");
      await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
      await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "integration\n");
      const inputArtifact = join(root, "input.json");
      // Deliberately not a valid coding input: the worker must fail fast with a safe code.
      await writeFile(inputArtifact, "{}");
      const spec: JobSpec = {
        kind: "coding-agent",
        runId,
        provider: "codex",
        image: workerImage,
        inputArtifact,
        timeoutSec: 300,
        limits: { cpus: 0.5, memoryMb: 512, pids: 128, diskMb: 256 },
        labels: {},
      };
      const execLog: ExecRecord[] = [];
      const api = wrapExec(rawApi, execLog);
      const launcher = new KubernetesJobLauncher({
        api,
        config,
        workspaceRoot,
        resolveCapability: async () => `rrp_${randomBytes(24).toString("hex")}`,
        preflight: async () => cluster,
      });
      const names = kubernetesRunNames(runId);
      // Tracked before launch() is ever called, so a failed assertion after a real launch still
      // gets cleaned up in afterAll even though this scope's local `handle` was never assigned.
      tracked.push({ launcher, handle: handleFor(names), names });
      return { spec, launcher, api, execLog, names };
    }

    async function keeperRun(podName: string, command: string[]): Promise<{ code: number; out: string }> {
      const stdout = new PassThrough();
      const chunks: Buffer[] = [];
      stdout.on("data", (c: Buffer) => chunks.push(c));
      const code = await rawApi.exec(namespace, podName, "keeper", command, { stdout, timeoutMs: 30_000 });
      return { code, out: Buffer.concat(chunks).toString("utf8") };
    }

    async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 120_000): Promise<T> {
      const end = Date.now() + ms;
      for (;;) {
        const value = await read();
        if (done(value) || Date.now() > end) return value;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    it("launches an attested, isolated pod behind a proven enforcement gate; a failing worker yields a safe diagnostic; remove cleans up", async () => {
      const { spec, launcher, api, execLog, names } = await setup();
      const handle = await launcher.launch(spec);

      // The enforcement gate: waitForPolicyEnforcement execs the probe into the keeper, repeatedly,
      // before the workspace/input are ever seeded (the first `tar` exec). It only stops once it sees
      // ENFORCEMENT_BLOCKED_STREAK (3) consecutive blocked (exit 0) probes.
      const firstSeedIndex = execLog.findIndex((r) => r.command[0] === "tar");
      expect(firstSeedIndex).toBeGreaterThan(0);
      const beforeSeed = execLog.slice(0, firstSeedIndex);
      expect(beforeSeed.length).toBeGreaterThanOrEqual(3);
      expect(beforeSeed.every((r) => isEnforcementProbe(r.command))).toBe(true);
      expect(beforeSeed.slice(-3).every((r) => r.exitCode === 0)).toBe(true);

      // Isolation, observed from inside the pod: these probes run in the keeper, which shares the
      // worker's network namespace, so what the keeper can/can't reach is what the worker can/can't
      // reach. Beyond hostname-based DNS/internet/metadata checks, this also connects directly to
      // the cluster DNS and API server ClusterIPs (bypassing DNS entirely), to the cluster DNS
      // pod's own IP (bypassing the Service/DNAT path too — proving the block holds at the pod-IP
      // level, which a NetworkPolicy actually operates on), and to the proxy's own pod IP (proving
      // the allow side isn't an artifact of routing through its Service either). This intentionally
      // does NOT attempt to prove per-port scoping on the proxy: a connect to its ClusterIP on an
      // unmapped port has no kube-proxy DNAT rule and would fail whether or not any NetworkPolicy
      // existed, so that check would be vacuous without a second port on the proxy's manifest.
      const probe = await keeperRun(names.pod, [
        "node",
        "-e",
        [
          'const net=require("node:net"),dns=require("node:dns").promises,fs=require("node:fs");',
          "const tcp=(h,p)=>new Promise(d=>{const s=net.connect({host:h,port:p,timeout:3000});",
          's.once("connect",()=>{s.destroy();d(true)});s.once("timeout",()=>{s.destroy();d(false)});s.once("error",()=>d(false))});',
          '(async()=>{let rootWritable=true;try{fs.writeFileSync("/probe","x")}catch{rootWritable=false}',
          "console.log(JSON.stringify({uid:process.getuid(),rootWritable,",
          'token:fs.existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token"),',
          'dns:await dns.lookup("kubernetes.default.svc.cluster.local").then(()=>true,()=>false),',
          'internet:await tcp("1.1.1.1",443),metadata:await tcp("169.254.169.254",80),',
          `proxyDeny:await tcp(${JSON.stringify(cluster.proxyIp)},8788),`,
          `apiServerIp:await tcp(${JSON.stringify(apiServerIp)},443),`,
          `dnsPodIp:await tcp(${JSON.stringify(dnsPodIp)},53),`,
          `proxyPodIp:await tcp(${JSON.stringify(proxyPodIp)},8787),`,
          'proxy:await tcp("wardby-proxy",8787)}))})()',
        ].join(""),
      ]);
      expect(probe.code).toBe(0);
      expect(JSON.parse(probe.out.trim())).toEqual({
        uid: 10001,
        rootWritable: false,
        token: false,
        dns: false,
        internet: false,
        metadata: false,
        proxyDeny: false,
        apiServerIp: false,
        dnsPodIp: false,
        proxyPodIp: true,
        proxy: true,
      });

      const status = await until(
        () => launcher.status(handle),
        (s) => s.state === "failed" || s.state === "succeeded",
      );
      expect(status.state).toBe("failed");
      const result = await launcher.collect(handle);
      expect(result.reason).toBe("failed");
      // The exact code the worker emits for this deterministically-invalid `{}` input: it fails
      // zod validation before ever reaching the "execution" stage, and that's not one of
      // SAFE_WORKER_ERROR_CODES, so main.ts maps it to `worker_${stage}_failed` with stage "input".
      expect(result.diagnostic).toBe("worker_input_failed");

      await launcher.remove(handle);
      expect(await api.readPod(namespace, names.pod)).toBeUndefined();
      expect(await api.readNetworkPolicy(namespace, names.policy)).toBeUndefined();
      await expect(launcher.status(handle)).rejects.toThrow("job_removed");
      expect(await launcher.launch(spec)).toEqual(handle);
    }, 240_000);

    it("stops a running job and reports it as stopped", async () => {
      const { spec, launcher, names } = await setup();
      const handle = await launcher.launch({ ...spec, timeoutSec: 600 });
      await launcher.stop(handle, "integration stop");
      expect(await launcher.status(handle)).toEqual({ state: "stopped" });
      expect(await launcher.collect(handle)).toEqual({ exitCode: 143, reason: "stopped" });
      await launcher.remove(handle);
      await until(
        () => rawApi.readPod(namespace, names.pod),
        (pod) => pod === undefined,
        60_000,
      );
    }, 180_000);

    it("rejects a conflicting relaunch of the same run", async () => {
      const { spec, launcher } = await setup();
      const handle = await launcher.launch(spec);
      await expect(launcher.launch({ ...spec, timeoutSec: spec.timeoutSec + 1 })).rejects.toThrow("job_spec_conflict");
      await launcher.stop(handle);
      await launcher.remove(handle);
    }, 180_000);
  });
});
