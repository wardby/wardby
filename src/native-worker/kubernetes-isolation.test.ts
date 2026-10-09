import { describe, expect, it } from "vitest";
import {
  buildNativeInputSecret,
  buildNativeRunNetworkPolicy,
  buildNativeRunPod,
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
    expect(worker.resources?.limits).toEqual({ cpu: "1", memory: "512Mi", "ephemeral-storage": "128Mi" });
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
  });
});
