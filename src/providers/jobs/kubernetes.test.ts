import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { V1Pod } from "@kubernetes/client-node";
import tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import { jobLauncherContract } from "./contract-suite.js";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { KubernetesConflictError } from "./kubernetes-api.js";
import { KubernetesJobLauncher } from "./kubernetes.js";
import { kubernetesRunNames } from "./kubernetes-isolation.js";
import type { JobHandle, JobSpec } from "./types.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const CAPABILITY = `rrp_${"c".repeat(32)}`;
const roots: string[] = [];
const isEnforcementProbe = (command: string[]) => command[0] === "node" && command[2].includes(", port: 53,");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function harness(runId = "run-k8s-test", options: { runtimeClassName?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "wardby-k8s-launcher-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspaces");
  await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "hello\n");
  const inputArtifact = join(root, "input.json");
  await writeFile(inputArtifact, JSON.stringify({ runId }));
  const api = new FakeKubernetesApi();
  api.put("service", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    spec: { clusterIP: "10.96.0.50" },
  });
  api.put("service", "kube-system", { metadata: { name: "kube-dns" }, spec: { clusterIP: "10.96.0.10" } });
  const names = kubernetesRunNames(runId);
  const spec: JobSpec = {
    kind: "coding-agent",
    runId,
    provider: "codex",
    image: IMAGE,
    inputArtifact,
    timeoutSec: 900,
    limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
    labels: {},
  };
  let now = 1_000_000;
  let result = JSON.stringify({ schemaVersion: 1, runId, outcome: "no_changes", summary: "done", tests: [] });
  const setPod = (mutate: (pod: V1Pod) => void) => {
    const pod = structuredClone(api.objects.get(`pod/wardby-coding/${names.pod}`));
    if (!pod) return;
    mutate(pod);
    api.put("pod", "wardby-coding", pod);
  };
  const keeperReady = () =>
    setPod((pod) => {
      pod.status = {
        phase: "Running",
        containerStatuses: [
          { name: "keeper", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
          { name: "worker", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
        ],
      };
    });
  // Fake kubelet: the pod becomes ready as soon as it exists.
  const originalCreatePod = api.createPod.bind(api);
  api.createPod = async (ns, body) => {
    const created = await originalCreatePod(ns, body);
    keeperReady();
    return created;
  };
  api.onExec = async ({ command, stdin, stdout }) => {
    stdin?.resume();
    if (command[0] === "head") stdout?.end(result);
    else stdout?.end();
    return 0;
  };
  const warnings: string[] = [];
  const launcher = new KubernetesJobLauncher({
    api,
    config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", ...options },
    workspaceRoot,
    resolveCapability: async () => CAPABILITY,
    now: () => now,
    sleep: async () => {},
    createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
    onWarning: (m) => warnings.push(m),
  });
  const finish = async (_handle: JobHandle, _r?: unknown) =>
    setPod((pod) => {
      pod.status!.containerStatuses![1].state = {
        terminated: { exitCode: 0, reason: "Completed", finishedAt: new Date(now) },
      };
    });
  const fail = (exitCode: number, reason = "Error") =>
    setPod((pod) => {
      pod.status!.containerStatuses![1].state = { terminated: { exitCode, reason } };
    });
  const lose = async (_handle: JobHandle) => api.deletePod("wardby-coding", names.pod, 0);
  return {
    api,
    launcher,
    spec,
    names,
    workspaceRoot,
    warnings,
    finish,
    fail,
    lose,
    advance: (ms: number) => void (now += ms),
    /** Terminates the worker with exit 0 at `finishedAt` (ms), optionally on a pod being deleted or past DeadlineExceeded. */
    exitZero: (finishedAt: number | undefined, pod: { deleting?: boolean; deadlineExceeded?: boolean } = {}) =>
      setPod((p) => {
        p.status!.containerStatuses![1].state = {
          terminated: {
            exitCode: 0,
            reason: "Completed",
            ...(finishedAt === undefined ? {} : { finishedAt: new Date(finishedAt) }),
          },
        };
        if (pod.deleting) p.metadata!.deletionTimestamp = new Date(now);
        if (pod.deadlineExceeded) {
          p.status!.phase = "Failed";
          p.status!.reason = "DeadlineExceeded";
        }
      }),
    clock: () => now,
    setResult: (value: string) => void (result = value),
  };
}

jobLauncherContract("Kubernetes", async () => {
  const h = await harness();
  return { launcher: h.launcher, spec: h.spec, finish: h.finish, lose: h.lose };
});

describe("KubernetesJobLauncher", () => {
  it("creates the attested pod, policy, and secret, seeds the keeper, then opens the gate", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    expect(handle).toEqual({ backend: "kubernetes", id: `wardby-coding/${h.names.token}` });
    expect(await h.api.readNetworkPolicy("wardby-coding", h.names.policy)).toBeDefined();
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(true);
    const commands = h.api.execCalls.map((c) => c.command.join(" "));
    // Three consecutive "blocked" probes before anything is seeded.
    expect(h.api.execCalls.slice(0, 3).every((c) => isEnforcementProbe(c.command))).toBe(true);
    expect(commands[3]).toContain("tar -C /run/wardby/storage/workspace");
    expect(commands[4]).toContain("tar -C /run/wardby/storage/input");
    expect(commands[5]).toContain("/run/wardby/storage/input/.seeded");
    expect(h.api.execCalls.every((c) => c.container === "keeper")).toBe(true);
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
  });

  it("warns on every launch when no runtime class is configured", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    expect(h.warnings.join("\n")).toMatch(/runtime class/i);
    const g = await harness("run-gvisor", { runtimeClassName: "gvisor" });
    await g.launcher.launch(g.spec);
    expect(g.warnings).toEqual([]);
  });

  it("fails closed and cleans up when attestation finds a mutated pod", async () => {
    const h = await harness();
    const originalRead = h.api.readPod.bind(h.api);
    h.api.readPod = async (ns, name) => {
      const pod = await originalRead(ns, name);
      if (pod) pod.spec!.automountServiceAccountToken = true;
      return pod;
    };
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    expect(h.api.execCalls.some((c) => c.command.join(" ").includes(".seeded"))).toBe(false);
  });

  it("reports a timeout as failed/timed_out and stops the pod", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.advance(901_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(await h.launcher.collect(handle)).toMatchObject({ exitCode: 124, reason: "timed_out" });
    expect(h.api.deletedPods).toContainEqual({ name: h.names.pod, gracePeriodSeconds: 10 });
  });

  it("keeps only a validated diagnostic code from the worker's log tail", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.api.logs.set(
      `wardby-coding/${h.names.pod}/worker`,
      ['{"progress":"secret repo text"}', "not json", '{"error":"worker_execution_failed"}'].join("\n"),
    );
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "worker_execution_failed",
    });
  });

  it("ignores a log line whose error isn't a safe diagnostic code", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.api.logs.set(`wardby-coding/${h.names.pod}/worker`, '{"error":"rm -rf / please"}');
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 1, reason: "failed" });
  });

  it("reports OOM kills with exit code 137", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.fail(137, "OOMKilled");
    expect(await h.launcher.collect(handle)).toMatchObject({ exitCode: 137, reason: "failed" });
  });

  it("rejects an oversized or mismatched result artifact", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    h.setResult("x".repeat(64 * 1024 + 10));
    await expect(h.launcher.collect(handle)).rejects.toThrow("kubernetes_result_artifact_invalid");
  });

  it("materializes only a succeeded run, only into its exact workspace, via the strict extractor", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    await expect(h.launcher.materializeWorkspace(handle, target)).rejects.toThrow("job_not_succeeded");
    await h.finish(handle);
    await expect(h.launcher.materializeWorkspace(handle, join(h.workspaceRoot, "other"))).rejects.toThrow(
      "kubernetes_workspace_destination_invalid",
    );
    const pack = tar.pack();
    pack.entry({ name: "./changed.txt" }, "new content");
    pack.finalize();
    h.api.onExec = async ({ command, stdout }) => {
      if (command[0] === "tar" && command.includes("-cf")) {
        (pack as unknown as Readable).pipe(stdout as PassThrough);
        await new Promise((r) => (stdout as PassThrough).once("finish", r));
      } else stdout?.end();
      return 0;
    };
    await h.launcher.materializeWorkspace(handle, target);
    expect(await readFile(join(target, "changed.txt"), "utf8")).toBe("new content");
  });

  it("refuses Claude Code specs until Plan 2b", async () => {
    const h = await harness();
    await expect(h.launcher.launch({ ...h.spec, provider: "claude-code", toolImage: IMAGE })).rejects.toThrow(
      "kubernetes_provider_unsupported",
    );
  });

  it("runs the preflight once and fails every launch after a failed preflight", async () => {
    const h = await harness();
    let calls = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        throw new Error("canary_reached_internet");
      },
    });
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(calls).toBe(1);
  });
});

describe("KubernetesJobLauncher failure handling", () => {
  const stagingLeftovers = async (h: Awaited<ReturnType<typeof harness>>) =>
    (await readdir(join(h.workspaceRoot, h.spec.runId))).filter((name) => name.startsWith(".wardby-workspace-"));

  it("rejects a hostile workspace archive, leaves the destination untouched, and destroys its stream", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    const pack = tar.pack();
    pack.entry({ name: "./escape", type: "symlink", linkname: "../../.." });
    pack.entry({ name: "./escape/owned.txt" }, "outside");
    pack.finalize();
    let archiveStream: PassThrough | undefined;
    h.api.onExec = async ({ command, stdout }) => {
      if (command[0] === "tar" && command.includes("-cf")) {
        archiveStream = stdout as PassThrough;
        (pack as unknown as Readable).pipe(archiveStream);
        await new Promise((r) => archiveStream!.once("close", r));
        return 0;
      }
      stdout?.end();
      return 0;
    };
    await expect(h.launcher.materializeWorkspace(handle, target)).rejects.toThrow(/^extract_/);
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("hello\n");
    expect(await stagingLeftovers(h)).toEqual([]);
    expect(archiveStream?.destroyed).toBe(true);
  });

  it("fails materialization when the keeper's archive command fails, without swapping", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    h.api.onExec = async () => 2;
    await expect(h.launcher.materializeWorkspace(handle, target)).rejects.toThrow(
      "kubernetes_workspace_archive_failed",
    );
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("hello\n");
    expect(await stagingLeftovers(h)).toEqual([]);
  });

  it("destroys the exec output stream and cleans staging when exec rejects", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    let output: PassThrough | undefined;
    h.api.onExec = async ({ stdout }) => {
      output = stdout as PassThrough;
      output.write(Buffer.alloc(10));
      throw new Error("exec_timeout");
    };
    await expect(h.launcher.materializeWorkspace(handle, target)).rejects.toThrow("exec_timeout");
    expect(output?.destroyed).toBe(true);
    expect(await stagingLeftovers(h)).toEqual([]);
  });

  it("aborts a stalled workspace transfer at the run's time budget", async () => {
    const h = await harness();
    const spec = { ...h.spec, timeoutSec: 1 };
    const handle = await h.launcher.launch(spec);
    await h.finish(handle);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    let output: PassThrough | undefined;
    h.api.onExec = async ({ stdout }) => {
      output = stdout as PassThrough;
      return new Promise<number>(() => undefined); // never finishes
    };
    await expect(h.launcher.materializeWorkspace(handle, target)).rejects.toThrow("extract_aborted");
    expect(output?.destroyed).toBe(true);
    expect(await stagingLeftovers(h)).toEqual([]);
  });

  it("fails provisioning with kubernetes_seed_failed, destroys the archive stream, and records the failure", async () => {
    const h = await harness();
    const archives: Readable[] = [];
    const launcher = new KubernetesJobLauncher({
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", runtimeClassName: "gvisor" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => {
        const stream = new PassThrough();
        archives.push(stream);
        return { stream, done: new Promise<number>(() => undefined) };
      },
    });
    h.api.onExec = async ({ command }) => {
      if (isEnforcementProbe(command)) return 0;
      throw new Error("exec_timeout");
    };
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_seed_failed");
    expect(archives[0]?.destroyed).toBe(true);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    expect(await launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "kubernetes_provisioning_failed",
    });
    expect(await launcher.launch(h.spec)).toEqual(handle);
  });

  it("rejects an invalid capability and a proxy Service without a ClusterIP", async () => {
    const h = await harness();
    const bad = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => "not-a-capability",
      sleep: async () => {},
    });
    await expect(bad.launch(h.spec)).rejects.toThrow("kubernetes_capability_invalid");
    const g = await harness("run-no-proxy");
    g.api.put("service", "wardby-coding", { metadata: { name: "wardby-coding-proxy" }, spec: {} });
    await expect(g.launcher.launch(g.spec)).rejects.toThrow("kubernetes_proxy_unavailable");
  });

  it("fails pod start on an image pull error and on a keeper that never becomes ready", async () => {
    const h = await harness();
    const originalCreatePod = h.api.createPod.bind(h.api);
    h.api.createPod = async (ns, body) => {
      const created = await originalCreatePod(ns, body);
      h.api.put("pod", ns, {
        ...created,
        status: {
          phase: "Pending",
          containerStatuses: [
            {
              name: "keeper",
              ready: false,
              image: IMAGE,
              imageID: "",
              restartCount: 0,
              state: { waiting: { reason: "ImagePullBackOff" } },
            },
          ],
        },
      });
      return created;
    };
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("kubernetes_pod_start_failed");

    const g = await harness("run-slow");
    let clock = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: g.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" },
      workspaceRoot: g.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      readyTimeoutMs: 1_000,
    });
    g.api.createPod = async (ns, body) => FakeKubernetesApi.prototype.createPod.call(g.api, ns, body);
    await expect(launcher.launch(g.spec)).rejects.toThrow("kubernetes_pod_start_timeout");
  });

  it("ignores any error reading the worker's log tail", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.api.readLogTail = async () => {
      throw new Error("404 pod not found");
    };
    h.fail(3);
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 3, reason: "failed" });
  });

  it("gives up with kubernetes_record_conflict after repeated write conflicts", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.fail(1);
    let attempts = 0;
    h.api.replaceConfigMap = async () => {
      attempts += 1;
      throw new KubernetesConflictError("stale");
    };
    await expect(h.launcher.status(handle)).rejects.toThrow("kubernetes_record_conflict");
    expect(attempts).toBe(5);
  });

  it("never regresses a terminal record written concurrently by another replica", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.fail(1);
    const original = h.api.replaceConfigMap.bind(h.api);
    let raced = false;
    h.api.replaceConfigMap = async (ns, name, body) => {
      if (!raced) {
        raced = true;
        // Another replica stops the run between our read and our write.
        const current = await h.api.readConfigMap(ns, name);
        const record = JSON.parse(current!.data!["record.json"]) as Record<string, unknown>;
        record.phase = "stopped";
        record.result = { exitCode: 143, reason: "stopped" };
        await original(ns, name, { ...current, data: { "record.json": JSON.stringify(record) } });
      }
      return original(ns, name, body);
    };
    expect(await h.launcher.status(handle)).toEqual({ state: "stopped" });
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 143, reason: "stopped" });
  });

  it("treats handles for another backend, namespace, or malformed token as unknown", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    for (const bad of [
      { ...handle, backend: "docker" },
      { ...handle, id: `other-ns/${h.names.token}` },
      { ...handle, id: "wardby-coding/../../etc" },
    ]) {
      await expect(h.launcher.status(bad)).rejects.toThrow("job_not_found");
      await expect(h.launcher.stop(bad)).resolves.toBeUndefined();
      await expect(h.launcher.remove(bad)).resolves.toBeUndefined();
    }
  });

  it("removes the pod, policy, and secret but keeps the record as a tombstone", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    await h.launcher.remove(handle);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
    expect(h.api.objects.has(`configmap/wardby-coding/${h.names.record}`)).toBe(true);
  });
});

/** Parks the launch's exec for commands matching `match` until `release()` is called. */
function parkExec(h: Awaited<ReturnType<typeof harness>>, match: (command: string[]) => boolean) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const parked = new Promise<void>((r) => (reached = r));
  const original = h.api.onExec;
  h.api.onExec = async (call) => {
    if (match(call.command)) {
      reached();
      await released;
    }
    return original(call);
  };
  return { parked, release };
}

const isMarker = (command: string[]) => command[0] === "node" && command[2].includes(".seeded");
const isWorkspaceSeed = (command: string[]) => command.includes("/run/wardby/storage/workspace");

describe("KubernetesJobLauncher deadlines and launch races", () => {
  it("records a worker that exited 0 as succeeded even when observed after the deadline, keeping the pod", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    h.advance(901_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
    expect(h.api.deletedPods).toEqual([]);
    expect(await h.launcher.collect(handle)).toMatchObject({ exitCode: 0, reason: "completed" });
  });

  it("times out a still-running worker past the deadline and deletes its pod", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.advance(900_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
  });

  it("reports a non-zero exit observed past the deadline as timed out", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.fail(2);
    h.advance(901_000);
    expect(await h.launcher.collect(handle)).toMatchObject({ exitCode: 124, reason: "timed_out" });
  });

  it("rejects a result artifact for another run", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    h.setResult(
      JSON.stringify({ schemaVersion: 1, runId: "someone-else", outcome: "no_changes", summary: "x", tests: [] }),
    );
    await expect(h.launcher.collect(handle)).rejects.toThrow("kubernetes_result_run_mismatch");
  });

  it("keeps a provisioning run pending while its pod exists or is young, and marks it lost once old", async () => {
    const h = await harness();
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    const gate = parkExec(h, isMarker);
    const launching = h.launcher.launch(h.spec);
    await gate.parked;
    expect(await h.launcher.status(handle)).toEqual({ state: "pending" });
    await h.lose(handle);
    expect(await h.launcher.status(handle)).toEqual({ state: "pending" });
    h.advance(120_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "lost" });
    gate.release();
    // The launch's own `active` write is dropped for the terminal record, and it deletes its pod.
    expect(await launching).toEqual(handle);
    expect(h.api.deletedPods.at(-1)).toEqual({ name: h.names.pod, gracePeriodSeconds: 0 });
    expect(await h.launcher.status(handle)).toEqual({ state: "lost" });
  });

  it("times out a provisioning run past its deadline", async () => {
    const h = await harness();
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    const gate = parkExec(h, isMarker);
    const launching = h.launcher.launch(h.spec);
    await gate.parked;
    h.advance(900_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
    gate.release();
    await launching;
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
  });

  it("deletes its pod when the run is stopped after the gate opens but before it is marked active", async () => {
    const h = await harness();
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    const gate = parkExec(h, isMarker);
    const launching = h.launcher.launch(h.spec);
    await gate.parked;
    await h.launcher.stop(handle);
    gate.release();
    expect(await launching).toEqual(handle);
    expect(h.api.deletedPods).toContainEqual({ name: h.names.pod, gracePeriodSeconds: 0 });
    expect(await h.launcher.status(handle)).toEqual({ state: "stopped" });
  });

  it("never opens the gate for a run stopped while it was being seeded", async () => {
    const h = await harness();
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    const seeding = parkExec(h, isWorkspaceSeed);
    const launching = h.launcher.launch(h.spec);
    await seeding.parked;
    await h.launcher.stop(handle);
    seeding.release();
    await expect(launching).rejects.toThrow("kubernetes_launch_superseded");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(await h.launcher.status(handle)).toEqual({ state: "stopped" });
  });

  it("fails seeding promptly when the extract exits non-zero without draining the archive", async () => {
    const h = await harness();
    const launcher = new KubernetesJobLauncher({
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", runtimeClassName: "gvisor" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => {
        const stream = new PassThrough();
        stream.write(Buffer.alloc(1024 * 1024));
        // Resolves only once the archive is fully consumed, like a real `tar` blocked on a full pipe.
        return { stream, done: new Promise<number>((r) => stream.once("end", () => r(0))) };
      },
    });
    h.api.onExec = async ({ command }) => (isEnforcementProbe(command) ? 0 : 2);
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_seed_failed");
  });
});

describe("KubernetesJobLauncher exit-0 guard", () => {
  it("does not count an exit 0 on a pod killed by DeadlineExceeded", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.exitZero(h.clock(), { deadlineExceeded: true });
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
  });

  it("does not count an exit 0 on a pod that is being deleted", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.exitZero(h.clock(), { deleting: true });
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({ exitCode: 1, reason: "failed" });
  });

  it("does not count an exit 0 without a finish time", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.exitZero(undefined);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed" });
  });

  it("treats an exit 0 that finished 10s after the deadline as a timeout", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.exitZero(h.clock() + 900_000 + 10_000);
    h.advance(911_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "failed", reason: "timed_out" });
  });

  it("accepts an exit 0 that finished within the clock-skew allowance, observed later", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.exitZero(h.clock() + 900_000 + 4_000);
    h.advance(950_000);
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
  });
});

describe("KubernetesJobLauncher NetworkPolicy enforcement gate", () => {
  function clockedLauncher(
    h: Awaited<ReturnType<typeof harness>>,
    extra: { preflight?: () => Promise<{ clusterDnsIp: string }> } = {},
  ) {
    let clock = 0;
    const sleeps: number[] = [];
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      enforcementTimeoutMs: 5_000,
      ...extra,
    });
    return { launcher, sleeps };
  }

  /** Answers enforcement probes from `answers` in order (then 0), recording the exec order. */
  function scriptProbe(h: Awaited<ReturnType<typeof harness>>, answers: number[]) {
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? (answers.shift() ?? 0) : original(call));
    return () =>
      h.api.execCalls.map((c) => (isEnforcementProbe(c.command) ? "probe" : isMarker(c.command) ? "marker" : "seed"));
  }

  it("opens the gate only after three consecutive blocked probes (0, 3, 0, 0, 0)", async () => {
    const h = await harness();
    const { launcher, sleeps } = clockedLauncher(h);
    const kinds = scriptProbe(h, [0, 3, 0, 0, 0]);
    await launcher.launch(h.spec);
    expect(kinds().slice(0, 5)).toEqual(["probe", "probe", "probe", "probe", "probe"]);
    expect(kinds().indexOf("seed")).toBe(5);
    expect(kinds().at(-1)).toBe("marker");
    expect(sleeps.filter((ms) => ms === 500)).toHaveLength(4);
  });

  it("a connected probe resets the count: 0, 0, 3, 0, 0 does not open the gate", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const kinds = scriptProbe(h, [0, 0, 3, 0, 0, 0]);
    await launcher.launch(h.spec);
    // Two blocked, a reset, then three blocked: seeding starts only after the sixth probe.
    expect(kinds().slice(0, 6)).toEqual(Array(6).fill("probe"));
    expect(kinds().indexOf("seed")).toBe(6);

    const g = await harness("run-reset-timeout");
    const { launcher: bounded } = clockedLauncher(g);
    // Never three in a row: the wall-clock bound still fails the launch.
    const pattern = Array.from({ length: 100 }, (_, i) => (i % 3 === 2 ? 3 : 0));
    const gKinds = scriptProbe(g, pattern);
    await expect(bounded.launch(g.spec)).rejects.toThrow("kubernetes_policy_not_enforced");
    expect(gKinds()).not.toContain("seed");
    expect(gKinds()).not.toContain("marker");
  });

  it("fails provisioning when the probe exec throws, cleaning up without opening the gate", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => {
      if (isEnforcementProbe(call.command)) throw new Error("exec_unavailable");
      return original(call);
    };
    await expect(launcher.launch(h.spec)).rejects.toThrow("exec_unavailable");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    expect(await launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "kubernetes_provisioning_failed",
    });
  });

  it("the probe uses a SYN-safe 3 s connect timeout", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    const probe = h.api.execCalls.find((c) => isEnforcementProbe(c.command))!;
    expect(probe.command[2]).toContain("timeout: 3000");
  });

  it("execs the probe in the keeper as an argv array with the validated IP literal, never a shell", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    const probe = h.api.execCalls.find((c) => isEnforcementProbe(c.command))!;
    expect(probe.container).toBe("keeper");
    expect(probe.command).toHaveLength(3);
    expect(probe.command.slice(0, 2)).toEqual(["node", "-e"]);
    expect(probe.command[2]).toContain('host: "10.96.0.10", port: 53');
    expect(probe.command.some((arg) => /^(\/bin\/)?(ba)?sh$/.test(arg))).toBe(false);
  });

  it("fails with kubernetes_policy_not_enforced when the probe never blocks, cleaning up without opening the gate", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 3 : original(call));
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_not_enforced");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
    expect(h.api.execCalls.every((c) => isEnforcementProbe(c.command))).toBe(true);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    expect(await launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "kubernetes_provisioning_failed",
    });
  });

  it("treats any other probe exit code as not yet enforced", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 127 : original(call));
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_not_enforced");
  });

  it("uses the preflight's cluster DNS IP without reading kube-dns itself", async () => {
    const h = await harness();
    const reads: string[] = [];
    const readService = h.api.readService.bind(h.api);
    h.api.readService = async (ns, name) => {
      reads.push(`${ns}/${name}`);
      return readService(ns, name);
    };
    const { launcher } = clockedLauncher(h, { preflight: async () => ({ clusterDnsIp: "10.96.0.99" }) });
    await launcher.launch(h.spec);
    const probe = h.api.execCalls.find((c) => isEnforcementProbe(c.command))!;
    expect(probe.command[2]).toContain('host: "10.96.0.99"');
    expect(reads).not.toContain("kube-system/kube-dns");
  });

  it("without a preflight, reads kube-dns once per launcher and fails closed when it is unusable", async () => {
    const h = await harness("run-dns-a");
    let dnsReads = 0;
    const readService = h.api.readService.bind(h.api);
    h.api.readService = async (ns, name) => {
      if (ns === "kube-system") dnsReads += 1;
      return readService(ns, name);
    };
    await h.launcher.launch(h.spec);
    await h.launcher.launch({ ...h.spec }); // idempotent relaunch
    expect(dnsReads).toBe(1);

    const g = await harness("run-dns-b");
    g.api.put("service", "kube-system", { metadata: { name: "kube-dns" }, spec: { clusterIP: "None" } });
    await expect(g.launcher.launch(g.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(g.api.objects.has(`pod/wardby-coding/${g.names.pod}`)).toBe(false);
  });
});
