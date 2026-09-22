/**
 * Integration tests against a real Kubernetes cluster (the `deploy/kind-coding/`
 * harness). Skipped unless WARDBY_KUBERNETES_TEST=1, KUBERNETES_CONTEXT, and a
 * registry-digest CODING_WORKER_IMAGE are set; `npm test` stays cluster-free.
 *
 * What this proves that FakeKubernetesApi cannot: the real API server's
 * defaulting round-trips through attestation unchanged; the NetworkPolicy
 * enforcement gate actually blocks the worker's egress until it opens; the
 * pod really is isolated (no DNS, no internet, no metadata endpoint, only the
 * proxy); a failing worker yields a safe diagnostic; stop/remove/relaunch
 * behave against real objects; the record survives removal as a tombstone.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKubernetesJobConfig } from "../../config/providers.js";
import type { KubernetesApi, KubernetesExecOptions } from "./kubernetes-api.js";
import { ClientNodeKubernetesApi } from "./kubernetes-client.js";
import { kubernetesRunNames } from "./kubernetes-isolation.js";
import { runKubernetesPreflight } from "./kubernetes-preflight.js";
import { KubernetesJobLauncher, type KubernetesClusterInfo } from "./kubernetes.js";
import type { JobSpec } from "./types.js";

const enabled =
  process.env.WARDBY_KUBERNETES_TEST === "1" &&
  !!process.env.KUBERNETES_CONTEXT &&
  /@sha256:[a-f0-9]{64}$/.test(process.env.CODING_WORKER_IMAGE ?? "");

describe.skipIf(!enabled)("KubernetesJobLauncher against a real cluster", () => {
  const workerImage = process.env.CODING_WORKER_IMAGE!;
  const config = loadKubernetesJobConfig(process.env);
  const namespace = config.namespace;
  const rawApi = new ClientNodeKubernetesApi({ context: config.context });
  const roots: string[] = [];
  // Populated by the real preflight in beforeAll and reused by every launcher below, the same
  // way composition.ts's `preflight` hook feeds a launcher its validated cluster DNS ClusterIP.
  let cluster: KubernetesClusterInfo;

  beforeAll(async () => {
    const result = await runKubernetesPreflight({ api: rawApi, config, workerImage });
    cluster = { clusterDnsIp: result.clusterDnsIp };
  }, 120_000);

  afterAll(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
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
      command[0] === "node" && command[1] === "-e" && typeof command[2] === "string" && command[2].includes("port: 53")
    );
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
    return { spec, launcher, api, execLog, names: kubernetesRunNames(runId) };
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

    // Isolation, observed from inside the pod (the keeper shares the worker's network namespace).
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
      proxy: true,
    });

    const status = await until(
      () => launcher.status(handle),
      (s) => s.state === "failed" || s.state === "succeeded",
    );
    expect(status.state).toBe("failed");
    const result = await launcher.collect(handle);
    expect(result.reason).toBe("failed");
    expect(result.diagnostic ?? "").toMatch(/^(?:worker_[a-z_]+|coding_[a-z_]+|wardby_[a-z_]+)?$/);

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
