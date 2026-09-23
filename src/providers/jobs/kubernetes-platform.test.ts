import { describe, expect, it } from "vitest";
import type { V1PodSpec } from "@kubernetes/client-node";
import {
  KUBERNETES_PLATFORM_ERROR,
  assertPlatformConfig,
  conformResources,
  describeMib,
  normalizePlatformMetadata,
  platformProfile,
  podEphemeralStorageMib,
} from "./kubernetes-platform.js";

const generic = platformProfile("generic");
const autopilot = platformProfile("gke-autopilot");

describe("conformResources", () => {
  it("leaves a generic request exactly as asked", () => {
    expect(conformResources(generic, { cpuMillicores: 500, memoryMib: 512 })).toEqual({
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    });
    expect(conformResources(generic, { cpuMillicores: 100, memoryMib: 128 })).toEqual({
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "100m", memory: "128Mi" },
    });
  });

  it("raises CPU to Autopilot's floor and rounds to its increment", () => {
    // 256Mi is inside the memory:CPU band at every CPU below, so the floor and the
    // increment are the only things moving the request here.
    const at = (cpuMillicores: number) =>
      conformResources(autopilot, { cpuMillicores, memoryMib: 256, ephemeralStorageMib: 64 }).requests.cpu;
    expect(at(100)).toBe("250m");
    expect(at(600)).toBe("750m");
    expect(at(1000)).toBe("1000m");
  });

  it("raises memory to the 1:1 floor of the memory:CPU band", () => {
    // The keeper's 250m/128Mi is a 0.5:1 ratio, which Autopilot would silently raise.
    expect(conformResources(autopilot, { cpuMillicores: 250, memoryMib: 128, ephemeralStorageMib: 64 })).toEqual({
      requests: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
      limits: { cpu: "250m", memory: "256Mi", "ephemeral-storage": "64Mi" },
    });
  });

  it("raises CPU rather than lowering memory when the 6.5:1 ceiling is exceeded", () => {
    const conformed = conformResources(autopilot, { cpuMillicores: 250, memoryMib: 8192, ephemeralStorageMib: 1024 });
    expect(conformed.requests.memory).toBe("8192Mi");
    // 8192 / 6656 MiB-per-vCPU = 1.2308 vCPU, rounded up to the 250m increment.
    expect(conformed.requests.cpu).toBe("1250m");
  });

  it("raises CPU past the floor when the request's own memory demands it", () => {
    // 2048Mi at the 250m floor would be 8192 MiB per vCPU, above the 6656 ceiling,
    // so Autopilot would rewrite it: 2048 / 6656 = 0.3077 vCPU -> 500m at the increment.
    expect(conformResources(autopilot, { cpuMillicores: 100, memoryMib: 2048, ephemeralStorageMib: 64 })).toEqual({
      requests: { cpu: "500m", memory: "2048Mi", "ephemeral-storage": "64Mi" },
      limits: { cpu: "500m", memory: "2048Mi", "ephemeral-storage": "64Mi" },
    });
  });

  it("emits limits equal to requests on every platform", () => {
    for (const profile of [generic, autopilot]) {
      const conformed = conformResources(profile, { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 1024 });
      expect(conformed.limits).toEqual(conformed.requests);
      // Separate objects, so a later caller mutating one cannot silently move the other.
      expect(conformed.limits).not.toBe(conformed.requests);
    }
  });

  it("refuses an Autopilot container with no ephemeral-storage request", () => {
    expect(() => conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512 })).toThrow(
      KUBERNETES_PLATFORM_ERROR,
    );
  });

  it("drops a supplied ephemeral-storage request under generic, which never emits one", () => {
    expect(conformResources(generic, { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 1024 })).toEqual({
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    });
  });

  it.each([
    ["cpuMillicores", { cpuMillicores: 0, memoryMib: 512, ephemeralStorageMib: 64 }],
    ["cpuMillicores", { cpuMillicores: -250, memoryMib: 512, ephemeralStorageMib: 64 }],
    ["cpuMillicores", { cpuMillicores: Number.NaN, memoryMib: 512, ephemeralStorageMib: 64 }],
    ["cpuMillicores", { cpuMillicores: Number.POSITIVE_INFINITY, memoryMib: 512, ephemeralStorageMib: 64 }],
    ["memoryMib", { cpuMillicores: 500, memoryMib: 0, ephemeralStorageMib: 64 }],
    ["memoryMib", { cpuMillicores: 500, memoryMib: -512, ephemeralStorageMib: 64 }],
    ["memoryMib", { cpuMillicores: 500, memoryMib: Number.NaN, ephemeralStorageMib: 64 }],
    ["ephemeralStorageMib", { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 0 }],
    ["ephemeralStorageMib", { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: -5 }],
    ["ephemeralStorageMib", { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: Number.NaN }],
  ])("refuses a %s that is not a finite positive number, on every platform", (field, request) => {
    for (const profile of [generic, autopilot]) {
      expect(() => conformResources(profile, request)).toThrow(new RegExp(`${KUBERNETES_PLATFORM_ERROR}.*${field}=`));
    }
  });

  it("refuses one container asking for more ephemeral storage than the whole pod may have", () => {
    expect(() =>
      conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 20_480 }),
    ).toThrow(/20480 MiB, over the 10240 MiB ceiling for the whole pod/);
    expect(() =>
      conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 10_240 }),
    ).not.toThrow();
  });
});

describe("the profiles themselves", () => {
  it("are frozen, so an allowance list cannot be widened at runtime", () => {
    for (const profile of [generic, autopilot]) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.resources)).toBe(true);
      expect(Object.isFrozen(profile.metadata)).toBe(true);
      expect(Object.isFrozen(profile.metadata.tolerations)).toBe(true);
      expect(Object.isFrozen(profile.metadata.nodeSelector)).toBe(true);
      expect(Object.isFrozen(profile.metadata.podLabelKeyPrefixes)).toBe(true);
      expect(Object.isFrozen(profile.metadata.podAnnotationKeyPrefixes)).toBe(true);
    }
    expect(() => (autopilot.metadata.podLabelKeyPrefixes as string[]).push("anything/")).toThrow(TypeError);
    expect(() => (generic.metadata.podLabelKeyPrefixes as string[]).push("anything/")).toThrow(TypeError);
  });
});

describe("podEphemeralStorageMib", () => {
  it("is the keeper's storage plus the worker's reservation", () => {
    expect(podEphemeralStorageMib(2048)).toBe(3072);
  });
});

describe("assertPlatformConfig", () => {
  it("accepts anything under generic", () => {
    expect(() => assertPlatformConfig(generic, { maxDiskMb: 32_768 })).not.toThrow();
    expect(() => assertPlatformConfig(generic, { runtimeClassName: undefined, maxDiskMb: 64 })).not.toThrow();
  });

  it("requires gvisor under gke-autopilot", () => {
    expect(() => assertPlatformConfig(autopilot, { maxDiskMb: 2048 })).toThrow(
      "requires KUBERNETES_RUNTIME_CLASS=gvisor (found unset)",
    );
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "runsc", maxDiskMb: 2048 })).toThrow(
      "requires KUBERNETES_RUNTIME_CLASS=gvisor (found runsc)",
    );
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "gvisor", maxDiskMb: 2048 })).not.toThrow();
  });

  it("refuses a CODING_MAX_DISK_MB that cannot fit the 10 GiB ephemeral-storage ceiling", () => {
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "gvisor", maxDiskMb: 9216 })).not.toThrow();
    expect(() => assertPlatformConfig(autopilot, { runtimeClassName: "gvisor", maxDiskMb: 9217 })).toThrow(
      /CODING_MAX_DISK_MB=9217 needs 10241 MiB of pod ephemeral storage, over the 10240 MiB \(10 GiB\) ceiling/,
    );
  });
});

describe("describeMib", () => {
  // Both ephemeral-storage refusals render their ceiling through this, so the GiB figure
  // tracks whatever the profile actually says rather than Autopilot's 10 GiB by hand.
  it.each([
    [10_240, "10240 MiB (10 GiB)"],
    [1024, "1024 MiB (1 GiB)"],
    [20_480, "20480 MiB (20 GiB)"],
    [1536, "1536 MiB (1.5 GiB)"],
    [512, "512 MiB (0.5 GiB)"],
    [1025, "1025 MiB (1.001 GiB)"],
  ])("renders %i MiB as %s", (mib, expected) => {
    expect(describeMib(mib)).toBe(expected);
  });
});

describe("normalizePlatformMetadata", () => {
  const view = () => ({
    labels: { "app.kubernetes.io/managed-by": "wardby", "autopilot.gke.io/injected": "yes" },
    annotations: {
      "wardby.io/run-id": "run-1",
      "autopilot.gke.io/resource-adjustment": "{}",
      "dev.gvisor.internal.seccomp.worker": "RuntimeDefault",
      "example.com/injected": "no",
    },
    spec: {
      containers: [],
      nodeSelector: { "sandbox.gke.io/runtime": "gvisor" },
      tolerations: [{ key: "sandbox.gke.io/runtime", operator: "Equal", value: "gvisor", effect: "NoSchedule" }],
    } as V1PodSpec,
  });

  it("tolerates nothing at all under generic", () => {
    const before = view();
    const after = view();
    normalizePlatformMetadata(generic, after);
    expect(after).toEqual(before);
  });

  it("removes exactly the metadata the Autopilot profile names", () => {
    const after = view();
    normalizePlatformMetadata(autopilot, after);
    expect(after.labels).toEqual({ "app.kubernetes.io/managed-by": "wardby" });
    // dev.gvisor.* (the seccomp/mount bookkeeping a real Autopilot dry run adds, measured
    // 2026-09-23) is removed alongside autopilot.gke.io/*; an unrelated annotation is not.
    expect(after.annotations).toEqual({ "wardby.io/run-id": "run-1", "example.com/injected": "no" });
    expect(after.spec.nodeSelector).toBeUndefined();
    expect(after.spec.tolerations).toBeUndefined();
  });

  it("keeps a toleration whose value differs from the profile's", () => {
    const after = view();
    // Both the named toleration and a look-alike with a different value, so a
    // normalizer that did nothing at all would leave two and fail this test.
    after.spec.tolerations = [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "gvisor", effect: "NoSchedule" },
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "other", effect: "NoSchedule" },
    ];
    normalizePlatformMetadata(autopilot, after);
    expect(after.spec.tolerations).toEqual([
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "other", effect: "NoSchedule" },
    ]);
  });

  it("leaves the caller's own label and annotation objects untouched", () => {
    // normalizePod hands over the live pod's metadata bags; deleting from them
    // would edit the real V1Pod on both sides of the comparison.
    const labels = { "app.kubernetes.io/managed-by": "wardby", "autopilot.gke.io/injected": "yes" };
    const annotations = { "wardby.io/run-id": "run-1", "autopilot.gke.io/resource-adjustment": "{}" };
    const normalized = { labels, annotations, spec: { containers: [] } as V1PodSpec };
    normalizePlatformMetadata(autopilot, normalized);
    expect(labels).toEqual({ "app.kubernetes.io/managed-by": "wardby", "autopilot.gke.io/injected": "yes" });
    expect(annotations).toEqual({ "wardby.io/run-id": "run-1", "autopilot.gke.io/resource-adjustment": "{}" });
    expect(normalized.labels).toEqual({ "app.kubernetes.io/managed-by": "wardby" });
    expect(normalized.annotations).toEqual({ "wardby.io/run-id": "run-1" });
  });

  it("keeps a nodeSelector entry whose value differs from the profile's", () => {
    const after = view();
    after.spec.nodeSelector = { "sandbox.gke.io/runtime": "none" };
    normalizePlatformMetadata(autopilot, after);
    expect(after.spec.nodeSelector).toEqual({ "sandbox.gke.io/runtime": "none" });
  });

  // Regression: a real server-side dry run against GKE Autopilot 1.35.8-gke.1036000
  // (2026-09-23) adds this toleration alongside the gVisor one. Before this toleration was
  // added to the profile's allowance, it survived normalization on the autopilot side and
  // attestation failed a conforming, already-verified real pod.
  it("removes the kubernetes.io/arch toleration Autopilot adds, under autopilot only", () => {
    const archToleration = { key: "kubernetes.io/arch", operator: "Equal", value: "amd64", effect: "NoSchedule" };
    const withArch = () => {
      const built = view();
      built.spec.tolerations = [...(built.spec.tolerations ?? []), archToleration];
      return built;
    };

    const afterAutopilot = withArch();
    normalizePlatformMetadata(autopilot, afterAutopilot);
    expect(afterAutopilot.spec.tolerations).toBeUndefined();

    // generic must stay exactly as strict as before: it forgives nothing, so the same
    // toleration list survives normalization untouched (proving the fix is scoped to autopilot).
    const beforeGeneric = withArch();
    const afterGeneric = withArch();
    normalizePlatformMetadata(generic, afterGeneric);
    expect(afterGeneric).toEqual(beforeGeneric);
  });
});
