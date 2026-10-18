import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { MAX_DEBUG_TRACE_LINE_BYTES, createDebugTracer } from "../../coding-worker/debug-trace.js";
import type { V1ContainerStatus, V1Pod } from "@kubernetes/client-node";
import tar from "tar-stream";
import { collectExclusions, tarExcludeArgs } from "../../coding/collect-exclude.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Power } from "../../core/power.js";
import { jobLauncherContract } from "./contract-suite.js";
import { FakeKubernetesApi } from "./fake-kubernetes-api.js";
import { KubernetesConflictError, KubernetesQuotaExceededError } from "./kubernetes-api.js";
import { KubernetesJobLauncher, hostTarArchive, type KubernetesJobLauncherOptions } from "./kubernetes.js";
import { kubernetesRunNames } from "./kubernetes-isolation.js";
import type { ServiceStateUpdate } from "./service-state.js";
import { JobCapacityError, type JobHandle, type JobSpec } from "./types.js";

const IMAGE = `localhost:5001/wardby-coding-worker@sha256:${"a".repeat(64)}`;
const CAPABILITY = `rrp_${"c".repeat(32)}`;
const roots: string[] = [];
const isEnforcementProbe = (command: string[]) => command[0] === "node" && command[2].includes("await tcp(8788)");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function harness(
  runId = "run-k8s-test",
  options: { runtimeClassName?: string; priorityClassName?: string; resourceQuota?: string } = {},
  launcherOptions: Partial<KubernetesJobLauncherOptions> = {},
) {
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
    spec: {
      clusterIP: "10.96.0.50",
      selector: { "app.kubernetes.io/name": "wardby-coding-proxy" },
      ports: [
        { name: "proxy", port: 8787, protocol: "TCP" },
        { name: "deny", port: 8788, protocol: "TCP" },
      ],
    },
  });
  api.put("endpoints", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    subsets: [
      {
        addresses: [{ ip: "10.244.0.5" }],
        ports: [
          { name: "proxy", port: 8787, protocol: "TCP" },
          { name: "deny", port: 8788, protocol: "TCP" },
        ],
      },
    ],
  });
  // The attribution precondition the witness now verifies: the proxy admits run pods on the deny
  // port at its own ingress, so the run pod's egress policy is the only thing that can drop it.
  api.put("networkpolicy", "wardby-coding", {
    metadata: { name: "wardby-coding-proxy" },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "wardby-coding-proxy" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: { "wardby.io/component": "coding-run" } } }],
          ports: [
            { protocol: "TCP", port: 8787 },
            { protocol: "TCP", port: 8788 },
          ],
        },
      ],
    },
  });
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
    config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic", ...options },
    workspaceRoot,
    resolveCapability: async () => CAPABILITY,
    now: () => now,
    sleep: async () => {},
    createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
    onWarning: (m) => warnings.push(m),
    ...launcherOptions,
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
    const secret = h.api.objects.get(`secret/wardby-coding/${h.names.secret}`) as {
      stringData: Record<string, string>;
    };
    // A Codex launch's Secret carries only the capability: no tool-setup key.
    expect(Object.keys(secret.stringData)).toEqual(["capability"]);
    const commands = h.api.execCalls.map((c) => c.command.join(" "));
    // One streak exec (three consecutive "blocked" probes inside it) before anything is seeded.
    expect(isEnforcementProbe(h.api.execCalls[0].command)).toBe(true);
    expect(commands[1]).toContain("tar -C /run/wardby/storage/workspace");
    expect(commands[2]).toContain("tar -C /run/wardby/storage/input");
    // Re-confirmed with another full streak exec immediately before the marker write.
    expect(isEnforcementProbe(h.api.execCalls[3].command)).toBe(true);
    expect(commands[4]).toContain("/run/wardby/storage/input/.seeded");
    expect(h.api.execCalls).toHaveLength(5);
    expect(h.api.execCalls.every((c) => c.container === "keeper")).toBe(true);
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
  });

  it("submits the configured priority class and attests the pod the class resolves to", async () => {
    const h = await harness("run-priority", { priorityClassName: "wardby-coding-run" });
    // The API server's Priority admission fills these two fields from the class.
    const create = h.api.createPod;
    h.api.createPod = async (ns, body) => {
      const created = await create(ns, body);
      const stored = structuredClone(h.api.objects.get(`pod/wardby-coding/${h.names.pod}`) as V1Pod);
      stored.spec!.priority = 1000;
      stored.spec!.preemptionPolicy = "Never";
      h.api.put("pod", "wardby-coding", stored);
      return created;
    };
    const handle = await h.launcher.launch(h.spec);
    const pod = h.api.objects.get(`pod/wardby-coding/${h.names.pod}`) as V1Pod;
    expect(pod.spec!.priorityClassName).toBe("wardby-coding-run");
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
  });

  it("submits no priority class when none is configured", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    const pod = h.api.objects.get(`pod/wardby-coding/${h.names.pod}`) as V1Pod;
    expect(pod.spec).not.toHaveProperty("priorityClassName");
  });

  it("warns on every launch when no runtime class is configured", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    expect(h.warnings.join("\n")).toMatch(/runtime class/i);
    const g = await harness("run-gvisor", { runtimeClassName: "gvisor" });
    await g.launcher.launch(g.spec);
    expect(g.warnings).toEqual([]);
  });

  it("warns with the specific validation reason and rethrows unchanged when the spec is rejected", async () => {
    const h = await harness();
    await expect(h.launcher.launch({ ...h.spec, toolImage: IMAGE })).rejects.toThrow(
      "kubernetes_isolation_unsupported:tool-image-set",
    );
    expect(h.warnings.some((w) => w.includes("kubernetes_isolation_unsupported:tool-image-set"))).toBe(true);
    // Nothing beyond the fixed reason tag leaked into the warning: no image reference, no limit value.
    expect(h.warnings.join("\n")).not.toContain(IMAGE);
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

  it("still finds the diagnostic after full-size debug-trace lines", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    const lines: string[] = [];
    const trace = createDebugTracer({ runId: h.spec.runId, secrets: [], write: (line) => lines.push(line) });
    for (let index = 0; index < 10; index += 1) trace.record("event", { text: "z".repeat(MAX_DEBUG_TRACE_LINE_BYTES) });
    expect(lines.every((line) => Buffer.byteLength(line) > MAX_DEBUG_TRACE_LINE_BYTES - 64)).toBe(true);
    h.api.logs.set(
      `wardby-coding/${h.names.pod}/worker`,
      `${lines.join("")}${JSON.stringify({ error: "coding_stream_agent_exited" })}\n`,
    );
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "coding_stream_agent_exited",
    });
  });

  it("keeps output-schema issue locations alongside the diagnostic code", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    h.api.logs.set(
      `wardby-coding/${h.names.pod}/worker`,
      '{"error":"coding_output_invalid","issues":["tag:invalid_string","tests.0.command:custom"]}',
    );
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "coding_output_invalid",
      diagnosticIssues: ["tag:invalid_string", "tests.0.command:custom"],
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

  it("collects a worker's dependency cache report with its result, bounded", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    const output = {
      schemaVersion: 1,
      runId: h.spec.runId,
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    };
    h.setResult(JSON.stringify({ ...output, dependencyCache: { projects: [{ path: ".", result: "hit" }] } }));
    const collected = await h.launcher.collect(handle);
    expect(JSON.parse(collected.resultArtifact!).dependencyCache).toEqual({ projects: [{ path: ".", result: "hit" }] });
    // A report the worker wrote malformed is bounded, never a failed collection.
    const other = await harness();
    const otherHandle = await other.launcher.launch(other.spec);
    await other.finish(otherHandle);
    other.setResult(JSON.stringify({ ...output, runId: other.spec.runId, dependencyCache: { projects: "x" } }));
    expect(JSON.parse((await other.launcher.collect(otherHandle)).resultArtifact!).dependencyCache).toEqual({
      projects: [],
      reason: "report_invalid",
    });
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

  it("excludes dependency folders and per-agent paths from the keeper archive", async () => {
    const h = await harness();
    const handle = await h.launcher.launch({
      ...h.spec,
      collectExclude: { names: ["node_modules"], paths: ["web/dist"] },
    });
    await h.finish(handle);
    const target = join(h.workspaceRoot, h.spec.runId, "workspace");
    let archiveCommand: string[] = [];
    h.api.onExec = async ({ command, stdout }) => {
      if (command[0] === "tar" && command.includes("-cf")) {
        archiveCommand = command;
        const pack = tar.pack();
        pack.entry({ name: "./kept.txt" }, "kept");
        pack.finalize();
        (pack as unknown as Readable).pipe(stdout as PassThrough);
        await new Promise((r) => (stdout as PassThrough).once("finish", r));
      } else stdout?.end();
      return 0;
    };
    await h.launcher.materializeWorkspace(handle, target);
    // Names always come from the current built-in list; only the paths come from the spec.
    expect(archiveCommand).toEqual([
      "tar",
      "-C",
      expect.any(String),
      ...tarExcludeArgs(collectExclusions(["web/dist"])),
      "-cf",
      "-",
      ".",
    ]);
  });

  it("falls back to the built-in exclusions for a record launched without any", async () => {
    const h = await harness();
    const handle = await h.launcher.launch(h.spec);
    await h.finish(handle);
    let archiveCommand: string[] = [];
    h.api.onExec = async ({ command, stdout }) => {
      if (command[0] === "tar" && command.includes("-cf")) {
        archiveCommand = command;
        const pack = tar.pack();
        pack.finalize();
        (pack as unknown as Readable).pipe(stdout as PassThrough);
        await new Promise((r) => (stdout as PassThrough).once("finish", r));
      } else stdout?.end();
      return 0;
    };
    await h.launcher.materializeWorkspace(handle, join(h.workspaceRoot, h.spec.runId, "workspace"));
    expect(archiveCommand).toContain("--exclude=node_modules");
    expect(archiveCommand).toContain("--exclude=.venv");
  });

  it("runs the preflight once and fails every launch after a failed preflight", async () => {
    const h = await harness();
    let calls = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
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

  it("warmUp runs the preflight once; a following launch reuses it", async () => {
    const h = await harness();
    let calls = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        return { proxyIp: "10.96.0.50" };
      },
    });
    await launcher.warmUp();
    expect(calls).toBe(1);
    await launcher.launch(h.spec);
    expect(calls).toBe(1);
  });

  it("warmUp never rejects when the preflight fails, and logs the failure code (never the raw cause)", async () => {
    const h = await harness();
    let calls = 0;
    const warnings: string[] = [];
    const launcher = new KubernetesJobLauncher({
      onWarning: (m) => warnings.push(m),
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        throw new Error("canary_reached_internet");
      },
    });
    await expect(launcher.warmUp()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    expect(warnings.some((w) => w.includes("kubernetes_isolation_unsupported"))).toBe(true);
    expect(warnings.some((w) => w.includes("canary_reached_internet"))).toBe(false);
  });

  it("a failed warmUp is not left stuck memoized: the next launch retries the preflight and can succeed", async () => {
    const h = await harness();
    let calls = 0;
    let failNext = true;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        if (failNext) throw new Error("canary_reached_internet");
        return { proxyIp: "10.96.0.50" };
      },
    });
    await launcher.warmUp();
    expect(calls).toBe(1);
    // A transient cluster problem at start-up must not stick until restart: the cluster has since
    // recovered, and the next launch() must see that, not the warm-up's stale memoized failure.
    failNext = false;
    await launcher.launch(h.spec);
    expect(calls).toBe(2);
  });

  it("launch()'s own preflight failure stays memoized (no retry), unlike warmUp's", async () => {
    const h = await harness();
    let calls = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        throw new Error("canary_reached_internet");
      },
    });
    // No warmUp() here: launch() starts its own preflight attempt directly.
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(calls).toBe(1);
  });

  it("a launch already awaiting a failing warmUp shares that failure; a following launch retries", async () => {
    const h = await harness();
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: { proxyIp: string }) => void;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        if (calls === 1) return new Promise((_resolve, reject) => void (rejectFirst = reject));
        return new Promise((resolve) => void (resolveSecond = resolve));
      },
    });
    const warm = launcher.warmUp();
    const launch = launcher.launch(h.spec);
    rejectFirst(new Error("canary_reached_internet"));
    await warm;
    // The launch that was already awaiting the warm-up's in-flight attempt shares that same
    // failure, exactly as it would without warmUp in the picture.
    await expect(launch).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(calls).toBe(1);

    // Cleared by the failed warm-up: the next launch starts a fresh attempt, which can succeed.
    const retry = launcher.launch(h.spec);
    resolveSecond({ proxyIp: "10.96.0.50" });
    await retry;
    expect(calls).toBe(2);
  });

  it("shares one preflight between a concurrent warmUp and launch", async () => {
    const h = await harness();
    let calls = 0;
    let resolvePreflight!: (value: { proxyIp: string }) => void;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      sleep: async () => {},
      createArchive: () => ({ stream: Readable.from([Buffer.alloc(0)]), done: Promise.resolve(0) }),
      preflight: async () => {
        calls += 1;
        return new Promise((resolve) => {
          resolvePreflight = resolve;
        });
      },
    });
    const warm = launcher.warmUp();
    const launch = launcher.launch(h.spec);
    resolvePreflight({ proxyIp: "10.96.0.50" });
    await warm;
    await launch;
    expect(calls).toBe(1);
  });
});

describe("KubernetesJobLauncher low-power mode", () => {
  function recordingPower(asleep: boolean) {
    const calls: string[] = [];
    const power: Power = {
      enabled: true,
      ensureAwake: async (target, opts) => {
        calls.push(`wake:${target}:${opts.runId}:${opts.timeoutMs}`);
      },
      isAsleep: async () => asleep,
      sleepIfIdle: async () => {},
      checkAccess: async () => [],
      status: async () => ({ enabled: true, targets: [] }),
      sleepNow: async () => ({ slept: [], blocked: [] }),
    };
    return { power, calls };
  }

  it("wakes the proxy before the preflight on launch", async () => {
    const order: string[] = [];
    const { power, calls } = recordingPower(false);
    const wake = power.ensureAwake;
    power.ensureAwake = async (target, opts) => {
      order.push("wake");
      await wake(target, opts);
    };
    const h = await harness(
      undefined,
      {},
      {
        power,
        preflight: async () => {
          order.push("preflight");
          return { proxyIp: "10.96.0.50" };
        },
      },
    );
    await h.launcher.launch(h.spec);
    expect(order.slice(0, 2)).toEqual(["wake", "preflight"]);
    // The wake bound has a 5-minute floor (a cold node can take minutes), above the 120 s ready timeout.
    expect(calls).toEqual(["wake:proxy:run-k8s-test:300000"]);
  });

  it("a ready timeout above the 5-minute floor raises the wake bound too", async () => {
    const { power, calls } = recordingPower(false);
    const h = await harness(
      undefined,
      {},
      { power, readyTimeoutMs: 600_000, preflight: async () => ({ proxyIp: "10.96.0.50" }) },
    );
    await h.launcher.launch(h.spec);
    expect(calls).toEqual(["wake:proxy:run-k8s-test:600000"]);
  });

  it("a wake failure fails the launch before the preflight runs", async () => {
    const { power } = recordingPower(false);
    power.ensureAwake = async () => {
      throw new Error("low_power_wake_timeout: proxy not ready");
    };
    const preflight = vi.fn(async () => ({ proxyIp: "10.96.0.50" }));
    const h = await harness(undefined, {}, { power, preflight });
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("low_power_wake_timeout");
    expect(preflight).not.toHaveBeenCalled();
  });

  it("defers the start-up preflight while the proxy is asleep; the first launch still runs it", async () => {
    const { power } = recordingPower(true);
    const preflight = vi.fn(async () => ({ proxyIp: "10.96.0.50" }));
    const h = await harness(undefined, {}, { power, preflight });
    await h.launcher.warmUp();
    expect(preflight).not.toHaveBeenCalled();
    power.isAsleep = async () => false;
    await h.launcher.launch(h.spec);
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it("runs the start-up preflight when low-power mode is on but the proxy is awake", async () => {
    const { power } = recordingPower(false);
    const preflight = vi.fn(async () => ({ proxyIp: "10.96.0.50" }));
    const h = await harness(undefined, {}, { power, preflight });
    await h.launcher.warmUp();
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      new Error('low_power_scale_forbidden: the control plane may not get Deployment "wardby-coding-proxy"'),
      "low_power_scale_forbidden",
    ],
    [new TypeError("connect ECONNREFUSED 10.0.0.1:443"), "TypeError"],
  ])("logs a failed asleep check by code only, then runs the start-up preflight", async (error, code) => {
    const { power } = recordingPower(false);
    power.isAsleep = async () => {
      throw error;
    };
    const warnings: string[] = [];
    const preflight = vi.fn(async () => ({ proxyIp: "10.96.0.50" }));
    const h = await harness(undefined, {}, { power, preflight, onWarning: (m) => warnings.push(m) });
    await h.launcher.warmUp();
    expect(warnings).toEqual([`kubernetes_preflight_power_check_failed: ${code}`]);
    expect(preflight).toHaveBeenCalledTimes(1);
  });

  it("with power disabled, warm-up runs the preflight as before", async () => {
    const preflight = vi.fn(async () => ({ proxyIp: "10.96.0.50" }));
    const h = await harness(undefined, {}, { preflight });
    await h.launcher.warmUp();
    expect(preflight).toHaveBeenCalledTimes(1);
  });
});

describe("KubernetesJobLauncher planned handles", () => {
  it("derives the handle launch will return, without touching the cluster", async () => {
    const h = await harness();
    const planned = h.launcher.plannedHandle(h.spec);
    expect(planned).toEqual({ backend: "kubernetes", id: `wardby-coding/${h.names.token}` });
    expect(h.api.objects.has(`configmap/wardby-coding/${h.names.record}`)).toBe(false);
    expect(await h.launcher.launch(h.spec)).toEqual(planned);
  });

  it("has no planned handle for a spec launch would refuse", async () => {
    const h = await harness();
    expect(h.launcher.plannedHandle({ ...h.spec, runId: "../escape" })).toBeUndefined();
  });

  it("gives a claude-code spec with a registry-digest tool image the same handle as its codex counterpart", async () => {
    const h = await harness();
    const claudeSpec: JobSpec = {
      ...h.spec,
      provider: "claude-code",
      toolImage: `localhost:5001/wardby-claude-tool-runner@sha256:${"b".repeat(64)}`,
    };
    expect(h.launcher.plannedHandle(claudeSpec)).toEqual(h.launcher.plannedHandle(h.spec));
  });

  it("has no planned handle for a claude-code spec without a tool image", async () => {
    const h = await harness();
    expect(h.launcher.plannedHandle({ ...h.spec, provider: "claude-code" })).toBeUndefined();
  });

  it("cleans the cluster through a handle persisted before launch (crash recovery)", async () => {
    const h = await harness();
    const planned = h.launcher.plannedHandle(h.spec)!;
    await h.launcher.launch(h.spec);
    // The caller only ever saw the planned handle, as after a crash between launch and the DB write.
    await h.launcher.stop(planned, "coding_ambiguous_provisioning");
    await h.launcher.collect(planned);
    await h.launcher.remove(planned);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
  });
});

describe("Claude Code", () => {
  const TOOL_IMAGE = `localhost:5001/wardby-claude-tool-runner@sha256:${"b".repeat(64)}`;
  const claudeOf = (spec: JobSpec): JobSpec => ({ ...spec, provider: "claude-code", toolImage: TOOL_IMAGE });
  const toolStatus = (over: Partial<V1ContainerStatus> = {}): V1ContainerStatus => ({
    name: "tool-runner",
    ready: true,
    started: true,
    image: TOOL_IMAGE,
    imageID: TOOL_IMAGE,
    restartCount: 0,
    state: { running: {} },
    ...over,
  });
  const setToolRunner = (h: Awaited<ReturnType<typeof harness>>, status: V1ContainerStatus) => {
    const pod = structuredClone(h.api.objects.get(`pod/wardby-coding/${h.names.pod}`)) as V1Pod;
    pod.status = { ...pod.status, initContainerStatuses: [status] };
    h.api.put("pod", "wardby-coding", pod);
  };

  it("launches the pod with the tool runner and puts only the registry-only setup next to the capability", async () => {
    const h = await harness("run-claude-ok");
    await h.launcher.launch(claudeOf(h.spec));
    const pod = h.api.objects.get(`pod/wardby-coding/${h.names.pod}`) as V1Pod;
    expect(pod.spec!.initContainers!.map((c) => c.name)).toEqual(["storage-init", "tool-runner"]);
    const secret = h.api.objects.get(`secret/wardby-coding/${h.names.secret}`) as {
      stringData: Record<string, string>;
    };
    expect(Object.keys(secret.stringData).sort()).toEqual(["capability", "tool-setup"]);
    expect(secret.stringData["tool-setup"]).not.toContain(CAPABILITY);
    expect(JSON.parse(secret.stringData["tool-setup"]).schemaVersion).toBe(1);
  });

  it.each([
    ["it restarted", { restartCount: 1 }],
    ["it exited", { state: { terminated: { exitCode: 1, reason: "Error" } } }],
    ["its image can't be pulled", { started: false, ready: false, state: { waiting: { reason: "ImagePullBackOff" } } }],
  ])("fails the launch by name when the tool runner %s before the keeper started", async (_label, over) => {
    // A fake clock, not the default harness launcher's fixed-`now` real-timer one: against code that
    // doesn't detect this, a pod stuck like this would otherwise never reach the ready-timeout bound,
    // so the launch would hang (spin forever on readPod/sleep) instead of failing. The fake clock makes
    // a missing detection fail at the bound rather than hang the test.
    const h = await harness("run-claude-bad-start");
    let clock = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      readyTimeoutMs: 1_000,
    });
    h.api.createPod = async (ns, body) => {
      const created = await FakeKubernetesApi.prototype.createPod.call(h.api, ns, body);
      h.api.put("pod", ns, {
        ...created,
        status: { phase: "Pending", initContainerStatuses: [toolStatus(over as Partial<V1ContainerStatus>)] },
      });
      return created;
    };
    await expect(launcher.launch(claudeOf(h.spec))).rejects.toThrow("kubernetes_tool_runner_failed");
  });

  it("names the tool runner when it never started by the pod-start bound", async () => {
    const g = await harness("run-claude-slow");
    let clock = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: g.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: g.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      readyTimeoutMs: 1_000,
    });
    g.api.createPod = async (ns, body) => {
      const created = await FakeKubernetesApi.prototype.createPod.call(g.api, ns, body);
      g.api.put("pod", ns, {
        ...created,
        status: { phase: "Pending", initContainerStatuses: [toolStatus({ started: false, ready: false })] },
      });
      return created;
    };
    await expect(launcher.launch(claudeOf(g.spec))).rejects.toThrow("kubernetes_tool_runner_unready");
  });

  it("fails a running job with worker_tool_runner_failed when the tool runner crashes mid-run", async () => {
    const h = await harness("run-claude-crash");
    const handle = await h.launcher.launch(claudeOf(h.spec));
    setToolRunner(h, toolStatus({ restartCount: 1 }));
    expect(await h.launcher.status(handle)).toMatchObject({ state: "failed" });
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "worker_tool_runner_failed",
    });
  });

  it("finds the worker's diagnostic after full-size Claude Code trace lines", async () => {
    const h = await harness("run-claude-traced");
    const handle = await h.launcher.launch(claudeOf(h.spec));
    const lines: string[] = [];
    const trace = createDebugTracer({ runId: h.spec.runId, secrets: [], write: (line) => lines.push(line) });
    for (let index = 0; index < 10; index += 1) {
      // A tool_result whose output itself looks like a diagnostic must not be read as one.
      trace.record("message", {
        type: "user",
        message: {
          content: [
            { type: "tool_result", content: `{"error":"worker_cancelled"} ${"z".repeat(MAX_DEBUG_TRACE_LINE_BYTES)}` },
          ],
        },
      });
    }
    h.api.logs.set(
      `wardby-coding/${h.names.pod}/worker`,
      `${lines.join("")}${JSON.stringify({ error: "coding_stream_failed" })}\n`,
    );
    h.fail(1);
    expect(await h.launcher.collect(handle)).toEqual({
      exitCode: 1,
      reason: "failed",
      diagnostic: "coding_stream_failed",
    });
  });

  it("still succeeds when the worker finished cleanly, whatever the tool runner does afterwards", async () => {
    const h = await harness("run-claude-done");
    const handle = await h.launcher.launch(claudeOf(h.spec));
    await h.finish(handle);
    setToolRunner(h, toolStatus({ state: { terminated: { exitCode: 143, reason: "Error" } } }));
    expect(await h.launcher.status(handle)).toEqual({ state: "succeeded" });
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
      config: {
        namespace: "wardby-coding",
        proxyService: "wardby-coding-proxy",
        runtimeClassName: "gvisor",
        platform: "generic",
      },
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
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: h.workspaceRoot,
      resolveCapability: async () => "not-a-capability",
      sleep: async () => {},
    });
    await expect(bad.launch(h.spec)).rejects.toThrow("kubernetes_capability_invalid");
    const g = await harness("run-no-proxy");
    g.api.put("service", "wardby-coding", {
      metadata: { name: "wardby-coding-proxy" },
      spec: { selector: { "app.kubernetes.io/name": "wardby-coding-proxy" } },
    });
    // launch() routes every failure through runPreflight's errorWithCode, so the thrown message is
    // always kubernetes_isolation_unsupported and the specific reason rides on `cause`.
    await expect(g.launcher.launch(g.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    await expect(g.launcher.launch(g.spec)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("kubernetes_proxy_witness_unusable") }),
    });
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
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
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
    // The stop deletes the pod, so the parked seed exec fails on the way out; either way the gate stays shut.
    await expect(launching).rejects.toThrow(/kubernetes_(seed_failed|launch_superseded)/);
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(await h.launcher.status(handle)).toEqual({ state: "stopped" });
  });

  it("refuses to open the gate when another replica finished the run during seeding", async () => {
    const h = await harness();
    const handle = { backend: "kubernetes", id: `wardby-coding/${h.names.token}` };
    const seeding = parkExec(h, isWorkspaceSeed);
    const launching = h.launcher.launch(h.spec);
    await seeding.parked;
    // Another replica records a terminal phase without touching the pod, so seeding still succeeds.
    const record = h.api.objects.get(`configmap/wardby-coding/${h.names.record}`) as {
      data: Record<string, string>;
    };
    const parsed = JSON.parse(record.data["record.json"]) as Record<string, unknown>;
    h.api.put("configmap", "wardby-coding", {
      metadata: { name: h.names.record },
      data: {
        "record.json": JSON.stringify({ ...parsed, phase: "stopped", result: { exitCode: 143, reason: "stopped" } }),
      },
    });
    seeding.release();
    await expect(launching).rejects.toThrow("kubernetes_launch_superseded");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
    expect(await h.launcher.status(handle)).toEqual({ state: "stopped" });
  });

  it("fails seeding promptly when the extract exits non-zero without draining the archive", async () => {
    const h = await harness();
    const launcher = new KubernetesJobLauncher({
      api: h.api,
      config: {
        namespace: "wardby-coding",
        proxyService: "wardby-coding-proxy",
        runtimeClassName: "gvisor",
        platform: "generic",
      },
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
  function clockedLauncher(h: Awaited<ReturnType<typeof harness>>, extra: Partial<KubernetesJobLauncherOptions> = {}) {
    let clock = 0;
    const sleeps: number[] = [];
    /** Lets a fake exec take wall-clock time, as a slow keeper would. */
    const advance = (ms: number) => void (clock += ms);
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: h.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
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
    return { launcher, sleeps, advance, now: () => clock };
  }

  /** Answers enforcement streak execs from `answers` in order (then 0), recording the exec order. */
  function scriptProbe(h: Awaited<ReturnType<typeof harness>>, answers: number[]) {
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? (answers.shift() ?? 0) : original(call));
    return () =>
      h.api.execCalls.map((c) => (isEnforcementProbe(c.command) ? "probe" : isMarker(c.command) ? "marker" : "seed"));
  }

  it("runs each stage as one streak exec when the first streak passes", async () => {
    const h = await harness();
    const { launcher, sleeps } = clockedLauncher(h);
    const kinds = scriptProbe(h, []);
    await launcher.launch(h.spec);
    // One exec for the initial proof, then seeding, then one exec for the pre-marker re-proof, then
    // the marker — with nothing else in between.
    expect(kinds()).toEqual(["probe", "seed", "seed", "probe", "marker"]);
    // The 500 ms between probes happens inside the streak exec, so the launcher itself never sleeps.
    expect(sleeps.filter((ms) => ms === 500)).toHaveLength(0);
  });

  it("execs the streak script requiring three consecutive probes 500 ms apart", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    const probes = h.api.execCalls.filter((c) => isEnforcementProbe(c.command));
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe.command[2]).toContain("index < 3;");
      expect(probe.command[2]).toContain("await pause(500)");
    }
  });

  it("a broken streak retries with a fresh streak after 500 ms (3, 0 opens the gate)", async () => {
    const h = await harness();
    const { launcher, sleeps } = clockedLauncher(h);
    const kinds = scriptProbe(h, [3, 4, 5, 127, 0]);
    await launcher.launch(h.spec);
    // Four broken streaks (any non-zero code, including one that measured nothing), then one that
    // held: seeding starts only after the fifth exec.
    expect(kinds().slice(0, 5)).toEqual(Array(5).fill("probe"));
    expect(kinds().indexOf("seed")).toBe(5);
    expect(sleeps.filter((ms) => ms === 500)).toHaveLength(4);
    // The pre-marker stage still needs its own full streak exec.
    expect(kinds().slice(7)).toEqual(["probe", "marker"]);
  });

  it("the pre-marker stage retries a broken streak the same way, and still needs a full streak", async () => {
    const h = await harness();
    const { launcher, sleeps } = clockedLauncher(h);
    const kinds = scriptProbe(h, [0, 3, 0]);
    await launcher.launch(h.spec);
    expect(kinds()).toEqual(["probe", "seed", "seed", "probe", "probe", "marker"]);
    expect(sleeps.filter((ms) => ms === 500)).toHaveLength(1);
  });

  it("never opens the gate while every streak is broken: the wall-clock bound fails the launch", async () => {
    const g = await harness("run-reset-timeout");
    const { launcher: bounded } = clockedLauncher(g);
    const pattern = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 3 : 4));
    const gKinds = scriptProbe(g, pattern);
    // 500 ms retry sleeps against the 5_000 ms bound: the 11th exec (index 10, a 3) is the last.
    await expect(bounded.launch(g.spec)).rejects.toThrow(/^kubernetes_policy_not_enforced: .*the last probe exited 3;/);
    expect(gKinds()).not.toContain("seed");
    expect(gKinds()).not.toContain("marker");
  });

  it("at the bound, the verdict is the last streak exec's code, at both stages", async () => {
    for (const [last, initialCode, preMarkerCode] of [
      [3, "kubernetes_policy_not_enforced", "kubernetes_policy_enforcement_lost_before_marker"],
      [4, "kubernetes_policy_witness_unavailable", "kubernetes_policy_witness_unavailable_before_marker"],
      [5, "kubernetes_policy_witness_unserved", "kubernetes_policy_witness_unserved_before_marker"],
      [127, "kubernetes_policy_probe_unusable", "kubernetes_policy_probe_unusable_before_marker"],
    ] as const) {
      // Every earlier exec answers a different non-proven code, so only the last one can name the verdict.
      const earlier = last === 4 ? 3 : 4;
      for (const stage of ["initial", "pre_marker"] as const) {
        const h = await harness(`run-last-${last}-${stage.replace("_", "-")}`);
        const { launcher, now } = clockedLauncher(h);
        const original = h.api.onExec;
        let started: number | undefined;
        let streaks = 0;
        h.api.onExec = async (call) => {
          if (!isEnforcementProbe(call.command)) return original(call);
          streaks += 1;
          if (stage === "pre_marker" && streaks === 1) return 0;
          started ??= now();
          // clockedLauncher's bound is 5_000 ms; only sleeps advance the clock.
          return now() - started >= 5_000 ? last : earlier;
        };
        const error = (await launcher.launch(h.spec).catch((e: unknown) => e)) as Error;
        expect(error.message).toContain(`${stage === "initial" ? initialCode : preMarkerCode}:`);
        expect(error.message).toContain(`the last probe exited ${last};`);
        expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
      }
    }
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

  it("bounds each streak exec at three default 10 s probes plus the two 500 ms gaps", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    const probes = h.api.execCalls.filter((c) => isEnforcementProbe(c.command));
    expect(probes).toHaveLength(2);
    // 10_000 * 3 + 500 * 2
    expect(probes.every((c) => c.timeoutMs === 31_000)).toBe(true);
  });

  it("bounds each streak exec at three configured enforcementExecTimeoutMs probes plus the gaps", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h, { enforcementExecTimeoutMs: 60_000 });
    await launcher.launch(h.spec);
    const probes = h.api.execCalls.filter((c) => isEnforcementProbe(c.command));
    expect(probes.length).toBeGreaterThan(0);
    // 60_000 * 3 + 500 * 2
    expect(probes.every((c) => c.timeoutMs === 181_000)).toBe(true);
  });

  it("derives an overall enforcement bound long enough for a full streak at a raised exec timeout", async () => {
    const h = await harness();
    // clockedLauncher hard-codes enforcementTimeoutMs: 5_000; left un-overridden here to prove the
    // launcher itself raises the effective floor to one full streak exec's timeout
    // (60_000 * 3 + 500 * 2 = 181_000) rather than giving up after the ~10 execs a bare 5_000 ms
    // bound would allow.
    const { launcher } = clockedLauncher(h, { enforcementExecTimeoutMs: 60_000 });
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 3 : original(call));
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_not_enforced");
    const probes = h.api.execCalls.filter((c) => isEnforcementProbe(c.command));
    // Only the 500 ms retry sleeps advance this clock: 181_000 / 500 retries, plus the first exec.
    expect(probes).toHaveLength(363);
    expect(probes.every((c) => c.timeoutMs === 181_000)).toBe(true);
  });

  it("never lets the overall bound expire inside one slow-but-healthy streak exec", async () => {
    const h = await harness();
    // A keeper slow enough that a broken streak takes almost its whole exec timeout must still get a
    // retry: the bound (floored at 181_000 here) has to cover at least one full streak exec, or "the
    // keeper is just slow" reads as "the policy is not enforced".
    const { launcher, advance } = clockedLauncher(h, { enforcementExecTimeoutMs: 60_000 });
    const original = h.api.onExec;
    let streaks = 0;
    h.api.onExec = async (call) => {
      if (!isEnforcementProbe(call.command)) return original(call);
      streaks += 1;
      if (streaks === 1) {
        advance(180_500); // past streak * exec timeout (180_000), within one streak exec (181_000)
        return 3;
      }
      return 0;
    };
    await launcher.launch(h.spec);
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(true);
  });

  it("execs the probe in the keeper as an argv array with the validated IP literal, never a shell", async () => {
    const h = await harness();
    await h.launcher.launch(h.spec);
    const probe = h.api.execCalls.find((c) => isEnforcementProbe(c.command))!;
    expect(probe.container).toBe("keeper");
    expect(probe.command).toHaveLength(3);
    expect(probe.command.slice(0, 2)).toEqual(["node", "-e"]);
    expect(probe.command[2]).toContain('host: "10.96.0.50"');
    expect(probe.command[2]).toContain("await tcp(8788)");
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

  it("treats any other probe exit code as not proven, and says the probe itself failed", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 127 : original(call));
    // It still resets the streak and still fails closed; what changed is the attribution, since
    // an exit code the probe never produces measured nothing and so indicts nothing.
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_probe_unusable");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
  });

  it("probes the proxy ClusterIP it re-read for this launch, not a stale memoized one", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h, { preflight: async () => ({ proxyIp: "10.96.0.99" }) });
    await launcher.launch(h.spec);
    const probe = h.api.execCalls.find((c) => isEnforcementProbe(c.command))!;
    expect(probe.command[2]).toContain('host: "10.96.0.50"');
    expect(probe.command[2]).not.toContain("10.96.0.99");
  });

  it("without a preflight, fails closed when the proxy witness is unusable", async () => {
    const g = await harness("run-witness-b");
    g.api.put("service", "wardby-coding", {
      metadata: { name: "wardby-coding-proxy" },
      spec: { clusterIP: "None", selector: { "app.kubernetes.io/name": "wardby-coding-proxy" } },
    });
    await expect(g.launcher.launch(g.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    expect(g.api.objects.has(`pod/wardby-coding/${g.names.pod}`)).toBe(false);
  });

  it("surfaces the witness failure unwrapped when a supplied preflight passed but the re-read fails", async () => {
    const h = await harness("run-witness-reread");
    // A supplied preflight skips the memoized witness read, so provision's own per-launch re-read is
    // the first witness check of the launch — and it is NOT wrapped by runPreflight's errorWithCode,
    // so the caller sees the witness code itself rather than kubernetes_isolation_unsupported.
    const { launcher } = clockedLauncher(h, { preflight: async () => ({ proxyIp: "10.96.0.50" }) });
    h.api.put("endpoints", "wardby-coding", {
      metadata: { name: "wardby-coding-proxy" },
      subsets: [{ addresses: [{ ip: "10.244.0.5" }], ports: [{ name: "proxy", port: 8787, protocol: "TCP" }] }],
    });
    await expect(launcher.launch(h.spec)).rejects.toThrow(
      "kubernetes_proxy_witness_unusable: Service wardby-coding/wardby-coding-proxy has no ready endpoint serving port 8788",
    );
    // It fails closed before the pod exists, so nothing is ever probed or gated.
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.execCalls.some((c) => isEnforcementProbe(c.command))).toBe(false);
  });

  it("reports an unavailable witness when the proxy port itself cannot be reached", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 4 : original(call));
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_witness_unavailable");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
  });

  it("refuses to open the gate when the deny port is refused rather than dropped", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 5 : original(call));
    // The reviewer's live-cluster scenario end to end: 8787 connects, 8788 answers with an RST,
    // and no policy exists anywhere. An RST proves the packet arrived, so this must never count.
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_witness_unserved");
    expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
  });

  it("never blames the policy for a probe that did not run", async () => {
    // A crash (1), a missing interpreter (127) or an OOM-killed keeper (137) measured nothing.
    // Reporting those as kubernetes_policy_not_enforced sends an operator to the CNI over a
    // failure that says nothing at all about the CNI.
    for (const exitCode of [1, 126, 127, 137]) {
      const h = await harness(`run-exit-${exitCode}`);
      const { launcher } = clockedLauncher(h);
      const original = h.api.onExec;
      h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? exitCode : original(call));
      const error = (await launcher.launch(h.spec).catch((e: unknown) => e)) as Error;
      expect(error.message).toContain("kubernetes_policy_probe_unusable");
      expect(error.message).not.toContain("kubernetes_policy_not_enforced");
      expect(error.message).toContain(String(exitCode));
    }
  });

  it("names both causes of a refused deny port, with the exit code and the probed address", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? 5 : original(call));
    const error = (await launcher.launch(h.spec).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("kubernetes_policy_witness_unserved");
    // On a reject-style CNI EVERY run fails this way, so the message must not lead with the
    // deny listener and leave the operator to find the other cause in the documentation.
    expect(error.message).toMatch(/nothing is serving/i);
    expect(error.message).toMatch(/reject/i);
    expect(error.message).toContain("10.96.0.50");
    expect(error.message).toContain("5");
  });

  it("keeps the three verdicts distinct: unserved is neither not_enforced nor witness_unavailable", async () => {
    for (const [exitCode, verdict] of [
      [3, "kubernetes_policy_not_enforced"],
      [4, "kubernetes_policy_witness_unavailable"],
      [5, "kubernetes_policy_witness_unserved"],
    ] as const) {
      const h = await harness(`run-verdict-${exitCode}`);
      const { launcher } = clockedLauncher(h);
      const original = h.api.onExec;
      h.api.onExec = async (call) => (isEnforcementProbe(call.command) ? exitCode : original(call));
      await expect(launcher.launch(h.spec)).rejects.toThrow(verdict);
    }
  });

  it("still reports not_enforced when the last probe found the deny port reachable", async () => {
    const h = await harness();
    const { launcher } = clockedLauncher(h);
    const original = h.api.onExec;
    let calls = 0;
    h.api.onExec = async (call) => {
      if (!isEnforcementProbe(call.command)) return original(call);
      calls += 1;
      // One unavailable probe early must not make the final verdict say "witness".
      return calls === 1 ? 4 : 3;
    };
    await expect(launcher.launch(h.spec)).rejects.toThrow("kubernetes_policy_not_enforced");
  });

  describe("re-confirmation immediately before the marker", () => {
    /** Proves the first N enforcement streak execs (the initial proof), then returns `after` for every exec past that. */
    function proveThenChange(h: Awaited<ReturnType<typeof harness>>, provenCount: number, after: number) {
      let probes = 0;
      const original = h.api.onExec;
      h.api.onExec = async (call) => {
        if (!isEnforcementProbe(call.command)) return original(call);
        probes += 1;
        return probes <= provenCount ? 0 : after;
      };
    }

    it("fails closed with a code distinct from the initial failure when enforcement is lost during seeding, and cleans up without opening the gate", async () => {
      const h = await harness();
      const { launcher } = clockedLauncher(h);
      // The initial proof passes cleanly (one streak exec of 3 consecutive blocked probes). Every
      // streak exec after that — i.e. only the pre-marker re-probe, seeding never execs anything
      // matching isEnforcementProbe —
      // finds the deny port reachable, as if a permissive NetworkPolicy landed while the workspace
      // was being seeded (the live-cluster attack this fix closes).
      proveThenChange(h, 1, 3 /* ENFORCEMENT_PROBE_DENY_REACHABLE */);
      const error = (await launcher.launch(h.spec).catch((e: unknown) => e)) as Error;
      expect(error.message).toContain("kubernetes_policy_enforcement_lost_before_marker");
      // Distinguishable from the code the initial proof would have produced for the same exit code.
      expect(error.message).not.toContain("kubernetes_policy_not_enforced:");
      // The marker gate must never be written on this path.
      expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
      // Cleanup ran exactly as any other provisioning failure: pod, policy, secret gone.
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

    it("distinguishes each pre-marker verdict from its initial-stage counterpart", async () => {
      for (const [exitCode, initialCode, preMarkerCode] of [
        [3, "kubernetes_policy_not_enforced", "kubernetes_policy_enforcement_lost_before_marker"],
        [4, "kubernetes_policy_witness_unavailable", "kubernetes_policy_witness_unavailable_before_marker"],
        [5, "kubernetes_policy_witness_unserved", "kubernetes_policy_witness_unserved_before_marker"],
      ] as const) {
        const h = await harness(`run-pre-marker-${exitCode}`);
        const { launcher } = clockedLauncher(h);
        proveThenChange(h, 1, exitCode);
        const error = (await launcher.launch(h.spec).catch((e: unknown) => e)) as Error;
        expect(error.message).toContain(preMarkerCode);
        expect(error.message).not.toContain(`${initialCode}:`);
        expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(false);
      }
    });

    it("still opens the gate when the re-probe cleanly re-proves enforcement (happy path)", async () => {
      const h = await harness();
      const handle = await h.launcher.launch(h.spec);
      expect(h.api.execCalls.some((c) => isMarker(c.command))).toBe(true);
      expect(await h.launcher.status(handle)).toEqual({ state: "running" });
    });

    it("pins the ordering: the re-probe runs strictly after seeding and strictly before the marker, with nothing else exec'd in between", async () => {
      const h = await harness();
      await h.launcher.launch(h.spec);
      const kinds = h.api.execCalls.map((c) =>
        isEnforcementProbe(c.command) ? "probe" : isMarker(c.command) ? "marker" : "seed",
      );
      const lastSeed = kinds.lastIndexOf("seed");
      const markerIndex = kinds.indexOf("marker");
      expect(lastSeed).toBeGreaterThan(-1);
      expect(markerIndex).toBe(kinds.length - 1);
      // Everything strictly between the last seed exec and the marker exec is a probe — the
      // re-confirmation — and nothing else runs in that window.
      const between = kinds.slice(lastSeed + 1, markerIndex);
      expect(between.length).toBeGreaterThan(0);
      expect(between.every((kind) => kind === "probe")).toBe(true);
    });
  });

  it("refuses to launch when the proxy Service has no ready endpoint on the deny port", async () => {
    const h = await harness("run-no-deny-endpoint");
    h.api.put("endpoints", "wardby-coding", {
      metadata: { name: "wardby-coding-proxy" },
      subsets: [{ addresses: [{ ip: "10.244.0.5" }], ports: [{ port: 8787, protocol: "TCP" }] }],
    });
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("kubernetes_isolation_unsupported");
    await expect(h.launcher.launch(h.spec)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining("kubernetes_proxy_witness_unusable") }),
    });
  });
});

describe("KubernetesJobLauncher pod start failures", () => {
  const startWith = async (status: V1Pod["status"]) => {
    const h = await harness();
    h.api.createPod = async (ns, body) => {
      const created = await FakeKubernetesApi.prototype.createPod.call(h.api, ns, body);
      h.api.put("pod", ns, { ...created, status });
      return created;
    };
    return h;
  };
  const init = (state: NonNullable<NonNullable<V1Pod["status"]>["initContainerStatuses"]>[number]["state"]) => ({
    name: "storage-init",
    ready: false,
    image: IMAGE,
    imageID: "",
    restartCount: 0,
    state,
  });

  it.each([
    [
      "a failed storage init container (Init:Error)",
      { phase: "Pending", initContainerStatuses: [init({ terminated: { exitCode: 1, reason: "Error" } })] },
    ],
    [
      "an init container in CrashLoopBackOff",
      { phase: "Pending", initContainerStatuses: [init({ waiting: { reason: "CrashLoopBackOff" } })] },
    ],
    [
      "an init container image pull failure",
      { phase: "Pending", initContainerStatuses: [init({ waiting: { reason: "ErrImagePull" } })] },
    ],
    [
      "a keeper that already exited",
      {
        phase: "Running",
        initContainerStatuses: [init({ terminated: { exitCode: 0, reason: "Completed" } })],
        containerStatuses: [
          {
            name: "keeper",
            ready: false,
            image: IMAGE,
            imageID: IMAGE,
            restartCount: 0,
            state: { terminated: { exitCode: 1, reason: "Error" } },
          },
          { name: "worker", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
        ],
      },
    ],
  ] as Array<[string, V1Pod["status"]]>)(
    "fails fast on %s instead of waiting out the timeout",
    async (_name, status) => {
      const h = await startWith(status);
      let polls = 0;
      const read = h.api.readPod.bind(h.api);
      h.api.readPod = async (ns, name) => {
        polls += 1;
        return read(ns, name);
      };
      await expect(h.launcher.launch(h.spec)).rejects.toThrow("kubernetes_pod_start_failed");
      expect(polls).toBe(1);
      expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    },
  );

  it("proceeds past a successfully completed init container to a ready keeper", async () => {
    const h = await startWith({
      phase: "Running",
      initContainerStatuses: [init({ terminated: { exitCode: 0, reason: "Completed" } })],
      containerStatuses: [
        { name: "keeper", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
        { name: "worker", ready: true, image: IMAGE, imageID: IMAGE, restartCount: 0, state: { running: {} } },
      ],
    });
    const handle = await h.launcher.launch(h.spec);
    expect(await h.launcher.status(handle)).toEqual({ state: "running" });
  });
});

describe("hostTarArchive", () => {
  it("keeps the archive readable after tar has already exited (no data lost before exec attaches)", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-k8s-archive-"));
    roots.push(root);
    await writeFile(join(root, "a.txt"), "hello");
    const archive = hostTarArchive(root);
    expect(await archive.done).toBe(0);
    // Let the child's exit handling run before anything consumes the stream, as when exec is slow to connect.
    await new Promise((r) => setTimeout(r, 50));
    const names: string[] = [];
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      names.push(header.name);
      stream.resume();
      stream.on("end", next);
    });
    archive.stream.pipe(extract);
    await new Promise<void>((r, j) => {
      extract.on("finish", () => r());
      extract.on("error", (error) => j(error));
    });
    expect(names).toContain("./a.txt");
  });

  it("swallows an error on the archive stream instead of crashing the process", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-k8s-archive-"));
    roots.push(root);
    const archive = hostTarArchive(root);
    await archive.done;
    // The returned stream re-emits a child.stdout error via destroy(error). Node emits an unhandled
    // "error" event asynchronously (via process.nextTick), so wrapping destroy() in
    // `expect(...).not.toThrow()` can't observe anything — it always passes, with or without a
    // listener. Check the listener is really attached, then prove the process doesn't crash by
    // watching for uncaughtException across a real tick.
    expect(archive.stream.listenerCount("error")).toBeGreaterThan(0);
    let crashed: unknown;
    const onUncaughtException = (error: unknown) => {
      crashed = error;
    };
    process.once("uncaughtException", onUncaughtException);
    try {
      archive.stream.destroy(new Error("simulated stdout error"));
      // nextTick-scheduled emissions run before this, so a real crash would have already fired.
      await new Promise((resolve) => setImmediate(resolve));
      expect(crashed).toBeUndefined();
    } finally {
      process.removeListener("uncaughtException", onUncaughtException);
    }
  });
});

describe("coding-run services", () => {
  const POSTGRES = resolvedFromDefinition(
    BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!,
  );
  const sidecarStatus = (over: Partial<V1ContainerStatus> = {}): V1ContainerStatus => ({
    name: "service-postgres",
    ready: false,
    started: false,
    image: POSTGRES.image,
    imageID: "",
    restartCount: 0,
    state: { running: {} },
    ...over,
  });
  /** A fake kubelet that leaves the pod in Init, storage-init done and the sidecar as given. */
  function stuckInInit(h: Awaited<ReturnType<typeof harness>>, status: V1ContainerStatus) {
    h.api.createPod = async (ns, body) => {
      const created = await FakeKubernetesApi.prototype.createPod.call(h.api, ns, body);
      h.api.put("pod", ns, {
        ...created,
        status: {
          phase: "Pending",
          initContainerStatuses: [
            {
              name: "storage-init",
              ready: false,
              image: IMAGE,
              imageID: IMAGE,
              restartCount: 0,
              state: { terminated: { exitCode: 0, reason: "Completed" } },
            },
            status,
          ],
        },
      });
      return created;
    };
  }

  it("says it supports services and launches a run with its sidecar in the pod", async () => {
    const h = await harness("run-svc-ok");
    expect(h.launcher.supportsServicesFor("codex")).toBe(true);
    expect(h.launcher.supportsServicesFor("claude-code")).toBe(true);
    await h.launcher.launch({ ...h.spec, services: [POSTGRES] });
    const submitted = h.api.objects.get(`pod/wardby-coding/${h.names.pod}`) as V1Pod;
    expect(submitted.spec!.initContainers!.map((c) => c.name)).toEqual(["storage-init", "service-postgres"]);
  });

  it.each([
    ["its startup probe gave up and it restarted", { restartCount: 1 }],
    ["its image can't be pulled", { state: { waiting: { reason: "ImagePullBackOff" } } }],
    ["it exited", { state: { terminated: { exitCode: 1, reason: "Error" } } }],
  ])("names the service when %s", async (_label, over) => {
    const h = await harness("run-svc-bad");
    stuckInInit(h, sidecarStatus(over));
    await expect(h.launcher.launch({ ...h.spec, services: [POSTGRES] })).rejects.toThrow(
      "coding_service_unready:postgres",
    );
  });

  it("names the service still starting when the pod-start bound is reached", async () => {
    const g = await harness("run-svc-slow");
    let clock = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: g.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: g.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      readyTimeoutMs: 1_000,
    });
    stuckInInit(g, sidecarStatus());
    await expect(launcher.launch({ ...g.spec, services: [POSTGRES] })).rejects.toThrow(
      "coding_service_unready:postgres",
    );
  });

  it("still reports a plain start timeout when every service started but the keeper did not", async () => {
    const g = await harness("run-svc-keeper");
    let clock = 0;
    const launcher = new KubernetesJobLauncher({
      onWarning: () => {},
      api: g.api,
      config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
      workspaceRoot: g.workspaceRoot,
      resolveCapability: async () => CAPABILITY,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      readyTimeoutMs: 1_000,
    });
    stuckInInit(g, sidecarStatus({ started: true, ready: true }));
    await expect(launcher.launch({ ...g.spec, services: [POSTGRES] })).rejects.toThrow("kubernetes_pod_start_timeout");
  });

  describe("service state reporting", () => {
    function reporting() {
      const updates: ServiceStateUpdate[] = [];
      return { updates, onServiceState: async (update: ServiceStateUpdate) => void updates.push(update) };
    }

    it("reports pending, then ready once the keeper (after every native sidecar) is ready", async () => {
      const { updates, onServiceState } = reporting();
      const h = await harness("run-svc-report", {}, { onServiceState });
      await h.launcher.launch({ ...h.spec, services: [POSTGRES] });
      expect(updates).toEqual([
        { runId: "run-svc-report", name: "postgres", state: "pending" },
        { runId: "run-svc-report", name: "postgres", state: "ready" },
      ]);
    });

    it.each([
      ["probe_failed", { restartCount: 1 }],
      ["image_unavailable", { state: { waiting: { reason: "ImagePullBackOff" } } }],
      ["start_failed", { state: { waiting: { reason: "CreateContainerConfigError" } } }],
      ["exited", { state: { terminated: { exitCode: 1, reason: "Error" } } }],
    ] as const)("reports failed with reason %s", async (reason, over) => {
      const { updates, onServiceState } = reporting();
      const h = await harness(`run-svc-report-${reason.replace("_", "-")}`, {}, { onServiceState });
      stuckInInit(h, sidecarStatus(over));
      await expect(h.launcher.launch({ ...h.spec, services: [POSTGRES] })).rejects.toThrow(
        "coding_service_unready:postgres",
      );
      expect(updates.at(-1)).toMatchObject({ name: "postgres", state: "failed", reason });
    });

    it("never lets a throwing reporter replace the launcher's own error", async () => {
      const onServiceState = async () => {
        throw new Error("reporter_boom");
      };
      const h = await harness("run-svc-report-throws", {}, { onServiceState });
      stuckInInit(h, sidecarStatus({ state: { waiting: { reason: "ImagePullBackOff" } } }));
      await expect(h.launcher.launch({ ...h.spec, services: [POSTGRES] })).rejects.toThrow(
        /^coding_service_unready:postgres$/,
      );
    });

    it("reports probing, then timed_out when the pod-start bound is reached", async () => {
      const { updates, onServiceState } = reporting();
      const g = await harness("run-svc-report-slow");
      let clock = 0;
      const launcher = new KubernetesJobLauncher({
        onWarning: () => {},
        api: g.api,
        config: { namespace: "wardby-coding", proxyService: "wardby-coding-proxy", platform: "generic" },
        workspaceRoot: g.workspaceRoot,
        resolveCapability: async () => CAPABILITY,
        now: () => clock,
        sleep: async (ms) => void (clock += ms),
        readyTimeoutMs: 1_000,
        onServiceState,
      });
      stuckInInit(g, sidecarStatus());
      await expect(launcher.launch({ ...g.spec, services: [POSTGRES] })).rejects.toThrow(
        "coding_service_unready:postgres",
      );
      expect(updates).toEqual([
        { runId: "run-svc-report-slow", name: "postgres", state: "probing" },
        { runId: "run-svc-report-slow", name: "postgres", state: "failed", reason: "timed_out" },
      ]);
    });
  });
});

describe("KubernetesJobLauncher capacity check", () => {
  const quota = (used: Record<string, string>) => ({
    metadata: { name: "wardby-coding" },
    status: {
      hard: { "requests.cpu": "8", "limits.cpu": "8", "requests.memory": "16Gi", "limits.memory": "16Gi", pods: "20" },
      used,
    },
  });

  it("answers yes when no quota is configured, without reading one", async () => {
    const h = await harness();
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
  });

  it("answers no when the run's pod would exceed the quota, and yes when it fits", async () => {
    const h = await harness(undefined, { resourceQuota: "wardby-coding" });
    h.api.put("resourcequota", "wardby-coding", quota({ "requests.cpu": "7800m", "limits.cpu": "7800m" }));
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(false);
    h.api.put("resourcequota", "wardby-coding", quota({ "requests.cpu": "1", "limits.cpu": "1" }));
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
  });

  it("answers yes, warning once, when the configured quota doesn't exist", async () => {
    const h = await harness(undefined, { resourceQuota: "missing-quota" });
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    expect(h.warnings.filter((w) => w.startsWith("kubernetes_resource_quota_missing"))).toHaveLength(1);
  });

  it("answers yes when the quota can't be read (for example, no RBAC grant)", async () => {
    const h = await harness(undefined, { resourceQuota: "wardby-coding" });
    h.api.readResourceQuota = async () => {
      throw new Error("forbidden");
    };
    expect(await h.launcher.hasCapacityFor(h.spec)).toBe(true);
    expect(h.warnings.some((w) => w.startsWith("kubernetes_resource_quota_unreadable"))).toBe(true);
  });
});

describe("KubernetesJobLauncher quota refusal", () => {
  const recordPhase = (h: Awaited<ReturnType<typeof harness>>) => {
    const map = h.api.objects.get(`configmap/wardby-coding/${h.names.record}`) as { data?: Record<string, string> };
    return (JSON.parse(Object.values(map.data ?? {})[0] ?? "{}") as { phase?: string }).phase;
  };
  const refuse = (h: Awaited<ReturnType<typeof harness>>, quotaName?: string) => {
    h.api.onCreatePod = async () => {
      throw new KubernetesQuotaExceededError("exceeded quota: pod/wardby-coding/x", { cause: undefined, quotaName });
    };
  };

  it("reports a quota refusal as a capacity error, cleans up, and records requeued", async () => {
    const h = await harness();
    refuse(h);
    const error = await h.launcher.launch(h.spec).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobCapacityError);
    expect((error as JobCapacityError).code).toBe("coding_capacity_exceeded");
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(false);
    expect(h.api.objects.has(`networkpolicy/wardby-coding/${h.names.policy}`)).toBe(false);
    expect(h.api.objects.has(`secret/wardby-coding/${h.names.secret}`)).toBe(false);
    expect(recordPhase(h)).toBe("requeued");
  });

  it("provisions afresh when launched again after a requeue", async () => {
    const h = await harness();
    refuse(h);
    await h.launcher.launch(h.spec).catch(() => undefined);
    expect((await h.launcher.status({ backend: "kubernetes", id: `wardby-coding/${h.names.token}` })).state).not.toBe(
      "running",
    );
    h.api.onCreatePod = async () => {};
    const handle = await h.launcher.launch(h.spec);
    expect(handle).toEqual({ backend: "kubernetes", id: `wardby-coding/${h.names.token}` });
    expect(h.api.objects.has(`pod/wardby-coding/${h.names.pod}`)).toBe(true);
    expect(["provisioning", "active"]).toContain(recordPhase(h));
  });

  it("rejects a different spec for a requeued run", async () => {
    const h = await harness();
    refuse(h);
    await h.launcher.launch(h.spec).catch(() => undefined);
    await expect(h.launcher.launch({ ...h.spec, timeoutSec: 901 })).rejects.toThrow("job_spec_conflict");
  });

  it("still records failed and rethrows for a non-quota provisioning error", async () => {
    const h = await harness();
    h.api.onCreatePod = async () => {
      throw new Error("boom");
    };
    await expect(h.launcher.launch(h.spec)).rejects.toThrow("boom");
    expect(recordPhase(h)).toBe("failed");
  });

  it("hints once, naming the refusing quota, when no resourceQuota is configured", async () => {
    const h = await harness();
    refuse(h, "wardby-coding");
    await h.launcher.launch(h.spec).catch(() => undefined);
    await h.launcher.launch(h.spec).catch(() => undefined);
    const hints = h.warnings.filter((w) => w.startsWith("kubernetes_resource_quota_unconfigured"));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("KUBERNETES_RESOURCE_QUOTA=wardby-coding");
  });

  it("does not hint when resourceQuota is configured", async () => {
    const h = await harness(undefined, { resourceQuota: "wardby-coding" });
    refuse(h, "wardby-coding");
    await h.launcher.launch(h.spec).catch(() => undefined);
    expect(h.warnings.some((w) => w.startsWith("kubernetes_resource_quota_unconfigured"))).toBe(false);
  });

  it("leaves a malformed quota name out of the hint", async () => {
    const h = await harness();
    refuse(h, "Bad Name!;rm");
    await h.launcher.launch(h.spec).catch(() => undefined);
    const hint = h.warnings.find((w) => w.startsWith("kubernetes_resource_quota_unconfigured"));
    expect(hint).toBeDefined();
    expect(hint).not.toContain("Bad");
    expect(hint).toContain("KUBERNETES_RESOURCE_QUOTA");
  });
});
