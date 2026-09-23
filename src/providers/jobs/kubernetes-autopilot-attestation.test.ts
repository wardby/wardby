/**
 * Attestation against the recorded Autopilot mutation set. The submitted pod is
 * rebuilt from the live builder, the fixture supplies only what the platform
 * changes, and the comparator must accept exactly that and nothing more.
 */
import { describe, expect, it } from "vitest";
import type { V1Pod } from "@kubernetes/client-node";
import { KUBERNETES_ISOLATION_ERROR, assertRunPodMatches, buildRunPod } from "./kubernetes-isolation.js";
import { applyMutations, loadDryRunFixture } from "./kubernetes-dry-run-fixture.js";
import type { JobSpec } from "./types.js";

const IMAGE = `us-central1-docker.pkg.dev/example/wardby/coding-worker@sha256:${"a".repeat(64)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-autopilot-1",
  provider: "codex",
  image: IMAGE,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const options = {
  namespace: "wardby-coding",
  proxyIp: "10.96.0.50",
  runtimeClassName: "gvisor",
  platform: "gke-autopilot" as const,
};
const fixture = loadDryRunFixture();
const submitted = () => buildRunPod(spec, options);
const returned = () => applyMutations(submitted(), fixture.mutations);

describe("Autopilot attestation", () => {
  // Named, not silent: while the fixture is provisional this test is reported as skipped with
  // that sentence in its title on every `npm test`, and it becomes a real assertion the moment
  // `npm run capture:autopilot` replaces the file.
  it.skipIf(fixture.provisional)(
    fixture.provisional
      ? "PENDING: the committed fixture is PROVISIONAL (documentation-derived), not a server-side dry-run capture"
      : "the committed fixture is a real server-side dry-run capture",
    () => {
      expect(fixture.provisional).toBe(false);
      expect(fixture.source).not.toContain("PROVISIONAL");
    },
  );

  it("accepts the recorded mutation set under gke-autopilot", () => {
    expect(() => assertRunPodMatches(returned(), submitted(), "gke-autopilot")).not.toThrow();
  });

  it("rejects the same mutation set under generic, and by default", () => {
    expect(() => assertRunPodMatches(returned(), submitted(), "generic")).toThrow(KUBERNETES_ISOLATION_ERROR);
    expect(() => assertRunPodMatches(returned(), submitted())).toThrow(KUBERNETES_ISOLATION_ERROR);
  });

  it("rejects one more mutation the profile does not name", () => {
    for (const tamper of [
      (p: V1Pod) => void (p.metadata!.annotations!["example.com/injected"] = "1"),
      (p: V1Pod) => void (p.metadata!.labels!["example.com/injected"] = "1"),
      (p: V1Pod) => void (p.spec!.nodeSelector!["sandbox.gke.io/runtime"] = "none"),
      (p: V1Pod) => void p.spec!.tolerations!.push({ key: "anything", operator: "Exists" }),
      (p: V1Pod) => void (p.spec!.hostPID = true),
      (p: V1Pod) => void (p.spec!.serviceAccountName = "default"),
      (p: V1Pod) => void (p.spec!.securityContext!.runAsUser = 0),
      (p: V1Pod) => void delete p.spec!.securityContext!.seccompProfile,
      (p: V1Pod) => void delete p.spec!.runtimeClassName,
    ]) {
      const tampered = returned();
      tamper(tampered);
      expect(() => assertRunPodMatches(tampered, submitted(), "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
    }
  });

  it("rejects a resource rewrite, which is what conformance exists to prevent", () => {
    const tampered = returned();
    tampered.spec!.containers.find((c) => c.name === "worker")!.resources!.requests!.cpu = "1250m";
    expect(() => assertRunPodMatches(tampered, submitted(), "gke-autopilot")).toThrow(KUBERNETES_ISOLATION_ERROR);
  });
});
