import { describe, expect, it } from "vitest";
import type { V1PodSpec } from "@kubernetes/client-node";
import {
  KUBERNETES_PLATFORM_ERROR,
  assertPlatformConfig,
  conformResources,
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
    const conformed = conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512, ephemeralStorageMib: 1024 });
    expect(conformed.limits).toEqual(conformed.requests);
  });

  it("refuses an Autopilot container with no ephemeral-storage request", () => {
    expect(() => conformResources(autopilot, { cpuMillicores: 500, memoryMib: 512 })).toThrow(
      KUBERNETES_PLATFORM_ERROR,
    );
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

describe("normalizePlatformMetadata", () => {
  const view = () => ({
    labels: { "app.kubernetes.io/managed-by": "wardby", "autopilot.gke.io/injected": "yes" },
    annotations: {
      "wardby.io/run-id": "run-1",
      "autopilot.gke.io/resource-adjustment": "{}",
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
    expect(after.annotations).toEqual({ "wardby.io/run-id": "run-1", "example.com/injected": "no" });
    expect(after.spec.nodeSelector).toBeUndefined();
    expect(after.spec.tolerations).toBeUndefined();
  });

  it("keeps a toleration whose value differs from the profile's", () => {
    const after = view();
    after.spec.tolerations = [
      { key: "sandbox.gke.io/runtime", operator: "Equal", value: "other", effect: "NoSchedule" },
    ];
    normalizePlatformMetadata(autopilot, after);
    expect(after.spec.tolerations).toHaveLength(1);
  });

  it("keeps a nodeSelector entry whose value differs from the profile's", () => {
    const after = view();
    after.spec.nodeSelector = { "sandbox.gke.io/runtime": "none" };
    normalizePlatformMetadata(autopilot, after);
    expect(after.spec.nodeSelector).toEqual({ "sandbox.gke.io/runtime": "none" });
  });
});
