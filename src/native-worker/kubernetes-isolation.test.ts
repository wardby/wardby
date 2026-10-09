import { describe, expect, it } from "vitest";
import {
  buildNativeInputSecret,
  buildNativeRunNetworkPolicy,
  buildNativeRunPod,
  buildNativeWarmNetworkPolicy,
  buildNativeWarmPod,
  NATIVE_INPUT_FILE,
  nativeEnforcementProbe,
  nativeKubernetesNames,
  nativeRunLabels,
} from "./kubernetes-isolation.js";
import type { WorkerInput } from "./protocol.js";

const runId = "cmrun_k8s_1";
const image = `registry.local:5001/wardby-native-worker@sha256:${"a".repeat(64)}`;
const limits = { cpus: 1, memoryMb: 512, pids: 128 };
const pod = () => buildNativeRunPod({ runId, namespace: "wardby-runs", image, limits, activeDeadlineSeconds: 3600 });

describe("native run Kubernetes objects", () => {
  it("names and labels objects by a run hash, never the run id", () => {
    const names = nativeKubernetesNames(runId);
    expect(names.pod).toMatch(/^wardby-native-[0-9a-f]{20}$/);
    expect(names.secret).toBe(`${names.pod}-input`);
    expect(JSON.stringify(pod())).not.toContain(runId);
    expect(nativeRunLabels(runId)).toMatchObject({ "wardby.io/component": "native-run" });
  });

  it("runs one locked-down, token-less, credential-free container with a hard deadline", () => {
    const spec = pod().spec!;
    expect(spec).toMatchObject({
      restartPolicy: "Never",
      activeDeadlineSeconds: 3600,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
    });
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      fsGroup: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(spec.containers).toHaveLength(1);
    const [worker] = spec.containers;
    expect(worker.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    // Its only environment is where its input file is: no credentials, no URLs, no capability.
    expect(worker.env).toEqual([{ name: "NATIVE_WORKER_INPUT_FILE", value: NATIVE_INPUT_FILE }]);
    expect(worker.resources?.limits).toEqual({ cpu: "1000m", memory: "512Mi", "ephemeral-storage": "128Mi" });
    expect(worker.resources?.requests).toEqual(worker.resources?.limits);
    expect(worker.volumeMounts).toContainEqual({ name: "input", mountPath: "/run/wardby/input", readOnly: true });
    expect(spec.volumes).toContainEqual({ name: "tmp", emptyDir: { sizeLimit: "64Mi" } });
    expect(spec.volumes).toContainEqual({
      name: "input",
      secret: { secretName: nativeKubernetesNames(runId).secret, defaultMode: 0o440 },
    });
    expect(spec.runtimeClassName).toBeUndefined();
    expect(
      buildNativeRunPod({ runId, namespace: "n", image, limits, activeDeadlineSeconds: 60, runtimeClassName: "gvisor" })
        .spec?.runtimeClassName,
    ).toBe("gvisor");
  });

  it("pulls only by registry digest", () => {
    expect(() =>
      buildNativeRunPod({
        runId,
        namespace: "n",
        image: "wardby-native-worker:latest",
        limits,
        activeDeadlineSeconds: 60,
      }),
    ).toThrow(/native_sandbox_image_not_pinned/);
    expect(() =>
      buildNativeRunPod({
        runId,
        namespace: "n",
        image: `sha256:${"b".repeat(64)}`,
        limits,
        activeDeadlineSeconds: 60,
      }),
    ).toThrow(/native_sandbox_image_not_pinned/);
  });

  it("allows no ingress, and egress only to the gateway's pods on the gateway port", () => {
    const policy = buildNativeRunNetworkPolicy(runId, "wardby-runs");
    expect(policy.spec).toEqual({
      podSelector: { matchLabels: nativeRunLabels(runId) },
      policyTypes: ["Ingress", "Egress"],
      ingress: [],
      egress: [
        {
          to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "wardby-native-gateway" } } }],
          ports: [{ protocol: "TCP", port: 8790 }],
        },
      ],
    });
  });

  it("keeps the input, capability included, in an immutable per-run Secret", () => {
    const input = {
      runId,
      gateway: { url: "http://10.0.0.5:8790/x", capability: "c".repeat(43) },
    } as unknown as WorkerInput;
    const secret = buildNativeInputSecret(input, "wardby-runs");
    expect(secret).toMatchObject({
      immutable: true,
      type: "Opaque",
      metadata: { name: nativeKubernetesNames(runId).secret },
    });
    expect(JSON.parse(secret.stringData!["input.json"])).toEqual(input);
  });

  it("probes the gateway port, its deny port, and an outside address from inside the pod", () => {
    const [node, flag, script] = nativeEnforcementProbe("10.96.0.42");
    expect([node, flag]).toEqual(["node", "-e"]);
    expect(script).toContain('"10.96.0.42", 8790');
    expect(script).toContain('"10.96.0.42", 8791');
    expect(script).toContain('"1.1.1.1", 443');
    expect(script).toContain('"169.254.169.254", 80');
    const custom = nativeEnforcementProbe("10.96.0.42", [{ host: "10.1.2.3", port: 3307 }])[2];
    expect(custom).toContain('"10.1.2.3", 3307');
    expect(custom).not.toContain("1.1.1.1");
  });

  it("conforms resources to GKE Autopilot so admission rewrites nothing, and requires gVisor there", () => {
    const autopilot = (cpus: number, memoryMb: number, runtimeClassName?: string) =>
      buildNativeRunPod({
        runId,
        namespace: "n",
        image,
        limits: { cpus, memoryMb, pids: 128 },
        activeDeadlineSeconds: 60,
        platform: "gke-autopilot",
        runtimeClassName,
        priorityClassName: "wardby-coding-run",
      }).spec!;
    // 1 vCPU needs at least 1 GiB on Autopilot; 0.3 vCPU rounds up to the 250m increment.
    expect(autopilot(1, 512, "gvisor").containers[0].resources?.limits).toEqual({
      cpu: "1000m",
      memory: "1024Mi",
      "ephemeral-storage": "128Mi",
    });
    expect(autopilot(0.3, 512, "gvisor").containers[0].resources?.requests).toMatchObject({ cpu: "500m" });
    expect(autopilot(0.5, 512, "gvisor").priorityClassName).toBe("wardby-coding-run");
    expect(() => autopilot(0.5, 512)).toThrow(/native_sandbox_platform_unsupported/);
    expect(() => autopilot(0.5, 512, "runc")).toThrow(/native_sandbox_platform_unsupported/);
    expect(pod().spec?.priorityClassName).toBeUndefined();
  });
});

describe("native warm pool Kubernetes objects", () => {
  const token = "0123456789abcdef0123";
  const warm = () =>
    buildNativeWarmPod({ token, waitMs: 60_000, namespace: "wardby-runs", image, limits, activeDeadlineSeconds: 3660 });

  it("is the run pod's locked-down spec with no input mount, waiting for an input file in /tmp", () => {
    const run = pod().spec!;
    const spec = warm().spec!;
    expect({ ...spec, containers: undefined, volumes: undefined, activeDeadlineSeconds: undefined }).toEqual({
      ...run,
      containers: undefined,
      volumes: undefined,
      activeDeadlineSeconds: undefined,
    });
    const { env, volumeMounts, ...container } = spec.containers[0];
    const { env: _runEnv, volumeMounts: _runMounts, ...runContainer } = run.containers[0];
    expect(container).toEqual(runContainer);
    expect(env).toEqual([
      { name: "NATIVE_WORKER_INPUT_FILE", value: "/tmp/wardby-input/input.json" },
      { name: "NATIVE_WORKER_INPUT_WAIT_MS", value: "60000" },
    ]);
    expect(volumeMounts).toEqual([{ name: "tmp", mountPath: "/tmp" }]);
    expect(spec.volumes!.some((v) => v.secret)).toBe(false);
  });

  it("is a native-run pod (the gateway admits it) labelled by its token, with no run hash", () => {
    const labels = warm().metadata!.labels!;
    expect(warm().metadata!.name).toBe(`wardby-nwarm-${token}`);
    expect(labels).toMatchObject({
      "wardby.io/component": "native-run",
      "wardby.io/pool": "warm",
      "wardby.io/warm-worker": token,
    });
    expect(labels["wardby.io/run-sha256"]).toBeUndefined();
    expect(() => buildNativeWarmPod({ ...warm(), token: "../x" } as never)).toThrow(/invalid_warm_token/);
  });

  it("gets the run policy's egress, selecting its own pod", () => {
    const policy = buildNativeWarmNetworkPolicy(token, "wardby-runs").spec!;
    const runPolicy = buildNativeRunNetworkPolicy(runId, "wardby-runs").spec!;
    expect(policy.egress).toEqual(runPolicy.egress);
    expect(policy.policyTypes).toEqual(runPolicy.policyTypes);
    expect(policy.podSelector?.matchLabels).toEqual(warm().metadata!.labels);
  });
});
