/**
 * Native sandbox isolation on a real cluster, with no database (npm run test:native-cluster): the
 * Kubernetes launcher alone, against the cluster's deployed wardby-native-gateway — so it runs
 * against a managed cluster (GKE Autopilot under gVisor) whose database a laptop cannot reach, as
 * well as kind. No model is called. Opt-in only: WARDBY_NATIVE_CLUSTER_TEST=1, plus
 *   NATIVE_TEST_WORKER_IMAGE     (required: the worker image digest the cluster pulls)
 *   NATIVE_TEST_CONTEXT          (default kind-wardby)
 *   NATIVE_TEST_NAMESPACE        (default wardby-coding)
 *   NATIVE_TEST_PLATFORM         (generic | gke-autopilot; default generic)
 *   NATIVE_TEST_RUNTIME_CLASS    (gvisor on GKE Autopilot)
 *   NATIVE_TEST_PRIORITY_CLASS   (optional: the run priority class)
 *   NATIVE_TEST_FORBIDDEN        (optional: host:port,... a worker must not reach, e.g. the database)
 *
 * Warm pool pods (phase 6) are covered too: proven before any run exists, given an input by exec.
 *
 * A worker here never gets a session: its input dials the gateway's deny port, which its policy
 * blocks, so it keeps retrying (and stays running) while the tests look at it from outside and in.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import type { KubernetesPlatform } from "../providers/jobs/kubernetes-platform.js";
import { NATIVE_GATEWAY_DENY_PORT, NATIVE_GATEWAY_PORT } from "./docker-isolation.js";
import {
  NATIVE_PROBE,
  NATIVE_PROBE_OUTSIDE,
  nativeEnforcementProbe,
  nativeKubernetesNames,
  nativeWarmWorkerName,
} from "./kubernetes-isolation.js";
import { KubernetesNativeWorkerLauncher } from "./kubernetes-launcher.js";
import type { WorkerInput } from "./protocol.js";
import { WARM_INPUT_FILE, WARM_WORKER_UNCLAIMED_EXIT } from "./warm-delivery.js";

const enabled = process.env.WARDBY_NATIVE_CLUSTER_TEST === "1";
const CONTEXT = process.env.NATIVE_TEST_CONTEXT ?? "kind-wardby";
const NAMESPACE = process.env.NATIVE_TEST_NAMESPACE ?? "wardby-coding";
const IMAGE = process.env.NATIVE_TEST_WORKER_IMAGE ?? "";
const PLATFORM = (process.env.NATIVE_TEST_PLATFORM ?? "generic") as KubernetesPlatform;
const RUNTIME_CLASS = process.env.NATIVE_TEST_RUNTIME_CLASS || undefined;
const PRIORITY_CLASS = process.env.NATIVE_TEST_PRIORITY_CLASS || undefined;
const FORBIDDEN = (process.env.NATIVE_TEST_FORBIDDEN ?? "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const at = entry.lastIndexOf(":");
    return { host: entry.slice(0, at), port: Number(entry.slice(at + 1)) };
  });
// A cold gVisor node on Autopilot takes about two minutes to appear.
const READY_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = READY_TIMEOUT_MS + 120_000;

const kubectl = (args: string[]) =>
  execFileSync("kubectl", ["--context", CONTEXT, "-n", NAMESPACE, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const kubectlOk = (args: string[]) => {
  try {
    return kubectl(args);
  } catch {
    return null;
  }
};
/** The exit code of a command run inside a pod's worker container. */
const execCode = (pod: string, command: string[]): number => {
  try {
    kubectl(["exec", pod, "-c", "worker", "--", ...command]);
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
};

describe.skipIf(!enabled)("native sandbox isolation on a cluster (acceptance, no database)", () => {
  const tag = randomUUID().slice(0, 8);
  const proven: string[] = [];
  const launched: string[] = [];
  const warmed: string[] = [];
  const warmToken = () => {
    const token = randomUUID().replace(/-/g, "").slice(0, 20);
    warmed.push(token);
    return token;
  };
  let api: ClientNodeKubernetesApi;
  let launcher: KubernetesNativeWorkerLauncher;
  let gatewayHost: string;

  const input = (runId: string): WorkerInput => ({
    v: 1,
    runId,
    agent: { systemPrompt: "unused", model: "claude-haiku-4-5", budgetUsd: 0.01, maxTurns: 1 },
    tools: [],
    builtinTools: [],
    userTools: {},
    runsConcurrently: [],
    pricing: {
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      encoding: "cl100k_base",
      inputPerMTok: 1,
      outputPerMTok: 5,
      cachedInputPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
      efforts: [],
      thinkingMode: "none",
    },
    // The deny port: blocked by the pod's own policy, so the worker retries instead of exiting.
    gateway: {
      url: `http://${gatewayHost}:${NATIVE_GATEWAY_DENY_PORT}/native-gateway/v1/call`,
      capability: "x".repeat(43),
    },
  });
  const launch = async (name: string) => {
    const runId = `ncl-${tag}-${name}`;
    launched.push(runId);
    await launcher.launch(input(runId));
    return { runId, pod: nativeKubernetesNames(runId).pod };
  };
  const gone = async (kind: string, name: string) => {
    for (let i = 0; i < 60 && kubectlOk(["get", kind, name]) !== null; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    return kubectlOk(["get", kind, name]) === null;
  };

  beforeAll(async () => {
    if (!/@sha256:[0-9a-f]{64}$/.test(IMAGE)) throw new Error("set NATIVE_TEST_WORKER_IMAGE to a registry digest");
    api = new ClientNodeKubernetesApi({ context: CONTEXT });
    launcher = new KubernetesNativeWorkerLauncher({
      api,
      namespace: NAMESPACE,
      image: IMAGE,
      limits: { cpus: 0.5, memoryMb: 512, pids: 128 },
      gatewayService: "wardby-native-gateway",
      platform: PLATFORM,
      runtimeClassName: RUNTIME_CLASS,
      priorityClassName: PRIORITY_CLASS,
      deadlineSeconds: 900,
      readyTimeoutMs: READY_TIMEOUT_MS,
      enforcementTimeoutMs: 60_000,
      onNetworkProven: async (runId) => void proven.push(runId),
    });
    gatewayHost = new URL(await launcher.resolveGatewayUrl()).hostname;
  });

  afterAll(async () => {
    for (const runId of launched) await launcher?.remove(runId).catch(() => {});
    for (const token of warmed) await launcher?.removeWarm(token).catch(() => {});
  });

  it(
    "launches a worker pod as built (attested), proves its isolation from inside, then marks it ready",
    async () => {
      const { runId, pod } = await launch("proven");
      expect(proven).toContain(runId);
      const spec = JSON.parse(kubectl(["get", "pod", pod, "-o", "jsonpath={.spec}"])) as Record<string, unknown>;
      expect(spec.automountServiceAccountToken).toBe(false);
      expect(spec.runtimeClassName).toBe(RUNTIME_CLASS);
      expect(spec.priorityClassName).toBe(PRIORITY_CLASS);
      expect(kubectl(["get", "pod", pod, "-o", "jsonpath={.status.phase}"])).toBe("Running");
      // The worker holds no credential: no token file, and an environment of one path.
      expect(execCode(pod, ["node", "-e", "require('fs').accessSync('/var/run/secrets/kubernetes.io')"])).not.toBe(0);
      expect(
        kubectl([
          "exec",
          pod,
          "-c",
          "worker",
          "--",
          "node",
          "-e",
          // The kubelet always sets the API server's address (KUBERNETES_SERVICE_*, KUBERNETES_PORT*):
          // an address, not a credential, and unreachable (the egress test proves it).
          "console.log(Object.keys(process.env).filter((k) => !['PATH','HOSTNAME','HOME','NODE_VERSION','YARN_VERSION','TERM'].includes(k) && !k.startsWith('KUBERNETES_')).join(','))",
        ]),
      ).toBe("NATIVE_WORKER_INPUT_FILE");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives a worker no route but the gateway port: not its deny port, the internet, the metadata server, or the database",
    async () => {
      const { pod } = await launch("egress");
      const reach = (host: string, port: number) =>
        execCode(pod, [
          "node",
          "-e",
          `const s=require("node:net").connect({host:${JSON.stringify(host)},port:${port},timeout:4000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));`,
        ]) === 0;
      expect(reach(gatewayHost, NATIVE_GATEWAY_PORT)).toBe(true);
      expect(reach(gatewayHost, NATIVE_GATEWAY_DENY_PORT)).toBe(false);
      const apiServer = {
        host: kubectl([
          "exec",
          pod,
          "-c",
          "worker",
          "--",
          "node",
          "-e",
          "console.log(process.env.KUBERNETES_SERVICE_HOST)",
        ]),
        port: Number(
          kubectl([
            "exec",
            pod,
            "-c",
            "worker",
            "--",
            "node",
            "-e",
            "console.log(process.env.KUBERNETES_SERVICE_PORT)",
          ]),
        ),
      };
      for (const target of [...NATIVE_PROBE_OUTSIDE, ...FORBIDDEN, apiServer]) {
        expect(reach(target.host, target.port), `${target.host}:${target.port}`).toBe(false);
      }
      // Without its own policy the namespace's default deny still holds: the probe no longer passes.
      kubectl(["delete", "networkpolicy", nativeKubernetesNames(`ncl-${tag}-egress`).policy]);
      let code: number = NATIVE_PROBE.proven;
      for (let i = 0; i < 20 && code === NATIVE_PROBE.proven; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        code = execCode(pod, nativeEnforcementProbe(gatewayHost, [...NATIVE_PROBE_OUTSIDE, ...FORBIDDEN]));
      }
      expect(code).not.toBe(NATIVE_PROBE.proven);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "attaches to a worker already launched instead of launching or probing again",
    async () => {
      const { runId, pod } = await launch("twice");
      const uid = kubectl(["get", "pod", pod, "-o", "jsonpath={.metadata.uid}"]);
      await launcher.launch(input(runId));
      expect(kubectl(["get", "pod", pod, "-o", "jsonpath={.metadata.uid}"])).toBe(uid);
      expect(proven.filter((id) => id === runId)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports a worker pod deleted from under it, and the janitor's listing finds and removes leftovers",
    async () => {
      const { runId, pod } = await launch("lost");
      const handle = launcher.handle(runId);
      expect((await launcher.listWorkers()).map((w) => w.name)).toContain(pod);
      kubectl(["delete", "pod", pod, "--grace-period=0", "--wait=false"]);
      await expect(handle.exited).resolves.not.toBe(0);
      await launcher.removeByWorkerName(pod);
      const names = nativeKubernetesNames(runId);
      expect(await gone("pod", pod)).toBe(true);
      expect(await gone("secret", names.secret)).toBe(true);
      expect(await gone("networkpolicy", names.policy)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts a warm pod proven before any run, holding no input; delivers one by exec, once; re-attests it",
    async () => {
      const token = warmToken();
      const pod = nativeWarmWorkerName(token);
      const provenBefore = proven.length;
      await launcher.startWarm(token, 600_000);
      expect(kubectl(["get", "pod", pod, "-o", "jsonpath={.status.phase}"])).toBe("Running");
      expect(proven).toHaveLength(provenBefore); // proving a warm pod marks no run ready
      expect(await launcher.listWarm()).toContain(token);
      expect((await launcher.listWorkers()).map((w) => w.name)).not.toContain(pod);
      const hasInput = () =>
        execCode(pod, ["node", "-e", `require("fs").accessSync(${JSON.stringify(WARM_INPUT_FILE)})`]) === 0;
      expect(hasInput()).toBe(false);
      expect(kubectl(["get", "pod", pod, "-o", "jsonpath={.spec.volumes[*].name}"])).toBe("tmp");
      expect(await launcher.reattestWarm(token, 600_000)).toBe(true);
      const runId = `ncl-${tag}-warm`;
      await launcher.deliver(token, input(runId));
      expect(hasInput()).toBe(true);
      await expect(launcher.deliver(token, input(runId))).rejects.toThrow(/native_sandbox_warm_delivery_failed/);
      // It read its input and now dials the (blocked) deny port: running, not exited.
      await new Promise((r) => setTimeout(r, 3000));
      expect((await launcher.inspectWarm(token)).state).toBe("running");
      await launcher.removeWarm(token);
      expect(await gone("pod", pod)).toBe(true);
      expect(await gone("networkpolicy", pod)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lets an unclaimed warm pod exit on its own after its wait",
    async () => {
      const token = warmToken();
      await launcher.startWarm(token, 15_000);
      let state = await launcher.inspectWarm(token);
      for (let i = 0; i < 60 && state.state === "running"; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        state = await launcher.inspectWarm(token);
      }
      expect(state).toEqual({ state: "exited", exitCode: WARM_WORKER_UNCLAIMED_EXIT });
    },
    TEST_TIMEOUT_MS,
  );
});
