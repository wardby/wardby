/**
 * Native sandbox acceptance on the kind harness (npm run test:native-kind): a real model
 * (claude-haiku-4-5, cents per run), worker pods in the deploy/kind-coding cluster, and the
 * in-cluster wardby-native-gateway, against the local Postgres. Opt-in only:
 * WARDBY_NATIVE_KIND_TEST=1 after `bash deploy/kind-coding/up.sh`, plus
 *   NATIVE_TEST_KIND_WORKER_IMAGE  (required: the digest up.sh printed as NATIVE_SANDBOX_WORKER_IMAGE)
 *   NATIVE_TEST_KIND_CONTEXT       (default kind-wardby)
 *   NATIVE_TEST_KIND_NAMESPACE     (default wardby-coding)
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../core/db.js";
import { NativeEngine } from "../core/engine-native.js";
import { SANDBOX_RUN_MAX_SEC, type NativeRunProviders } from "../core/runner.js";
import { loadProviderConfig } from "../config/providers.js";
import { PostgresDatastore } from "../providers/datastore/index.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { RoutingLlmProvider, resolveLlmRegistrations } from "../providers/llm/index.js";
import { startModelCatalog } from "../providers/llm/catalog-store.js";
import { PostgresAgentMemory } from "../providers/memory/index.js";
import { buildSecretCipher } from "../providers/secrets/index.js";
import { DEFAULT_NATIVE_WORKER_LIMITS } from "./docker-isolation.js";
import { nativeKubernetesNames, nativeRunLabels } from "./kubernetes-isolation.js";
import { KubernetesNativeWorkerLauncher } from "./kubernetes-launcher.js";
import { PrismaGatewayLedger } from "./ledger.js";
import { NativeSandboxExecutor } from "./sandbox-executor.js";

const enabled = process.env.WARDBY_NATIVE_KIND_TEST === "1";
const CONTEXT = process.env.NATIVE_TEST_KIND_CONTEXT ?? "kind-wardby";
const NAMESPACE = process.env.NATIVE_TEST_KIND_NAMESPACE ?? "wardby-coding";
const IMAGE = process.env.NATIVE_TEST_KIND_WORKER_IMAGE ?? "";
const MODEL = "claude-haiku-4-5";

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

describe.skipIf(!enabled)("native sandbox on kind (acceptance)", () => {
  const tag = randomUUID().slice(0, 8);
  const ownerId = `nka-owner-${tag}`;
  const agents = { quick: `nka-quick-${tag}`, slow: `nka-slow-${tag}` };
  let providers: NativeRunProviders;
  let launcher: KubernetesNativeWorkerLauncher;
  let executor: NativeSandboxExecutor;
  // Built in beforeAll, not here: the describe body runs even when skipped, and with no kubeconfig
  // (CI) the client throws at construction.
  let api: ClientNodeKubernetesApi;
  const ledger = new PrismaGatewayLedger(prisma);
  const newLauncher = () =>
    new KubernetesNativeWorkerLauncher({
      api,
      namespace: NAMESPACE,
      image: IMAGE,
      limits: DEFAULT_NATIVE_WORKER_LIMITS,
      gatewayService: "wardby-native-gateway",
      deadlineSeconds: SANDBOX_RUN_MAX_SEC,
      onNetworkProven: (runId) => ledger.markNetworkReadyForRun(runId),
    });
  const newExecutor = () => new NativeSandboxExecutor({ db: prisma, providers, launcher, gatewayUrl: "unused" });

  beforeAll(async () => {
    if (!/@sha256:[0-9a-f]{64}$/.test(IMAGE))
      throw new Error("set NATIVE_TEST_KIND_WORKER_IMAGE to the digest up.sh printed");
    api = new ClientNodeKubernetesApi({ context: CONTEXT });
    await startModelCatalog(prisma);
    const regs = resolveLlmRegistrations();
    if (regs.kind !== "registrations") throw new Error("no LLM credentials");
    const secrets = buildSecretCipher(loadProviderConfig());
    providers = {
      llm: new RoutingLlmProvider(regs.registrations),
      engine: new NativeEngine(),
      datastore: new PostgresDatastore(prisma, secrets),
      secrets,
      memory: new PostgresAgentMemory(prisma),
    };
    launcher = newLauncher();
    executor = newExecutor();
    await prisma.principal.create({ data: { id: ownerId, subject: ownerId } });
    const code = {
      quick: "return { note: await datastore.get(params.key) };",
      slow: "await new Promise((r) => setTimeout(r, 7000));\nreturn { note: await datastore.get(params.key) };",
    };
    for (const kind of ["quick", "slow"] as const) {
      const agentId = agents[kind];
      const toolName = kind === "quick" ? "lookup" : "slow_lookup";
      await prisma.agent.create({
        data: {
          id: agentId,
          name: agentId,
          model: MODEL,
          budgetUsd: 0.05,
          maxTurns: 4,
          ownerId,
          nativeExecutionMode: "sandbox",
          systemPrompt: `Call the ${toolName} tool once with key "notes/a". Then answer in one short sentence with what the note says.`,
        },
      });
      await prisma.tool.create({
        data: {
          id: `${agentId}-tool`,
          name: toolName,
          ownerId,
          description: "Reads a note by key.",
          code: code[kind],
          paramsZod: "z.object({ key: z.string() })",
          jsonSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        },
      });
      await prisma.agentTool.create({
        data: {
          agentId,
          toolId: `${agentId}-tool`,
          allowedDatastorePrefixes: ["notes/"],
          capabilitiesGrantedById: ownerId,
        },
      });
      await providers.datastore.set(agentId, "notes/a", "The launch moved to Friday.");
    }
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(agents);
    const runs = await prisma.run.findMany({ where: { agentId: { in: ids } }, select: { id: true } });
    for (const { id } of runs) await launcher?.remove(id).catch(() => {});
    const runIds = runs.map((r) => r.id);
    await prisma.runModelUsage.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.runAttribution.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.agentTool.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.tool.deleteMany({ where: { id: { in: ids.map((a) => `${a}-tool`) } } });
    await prisma.datastoreEntry.deleteMany({ where: { agentId: { in: ids } } });
    await prisma.agent.deleteMany({ where: { id: { in: ids } } });
    await prisma.principal.deleteMany({ where: { id: ownerId } });
  });

  const newRun = (kind: "quick" | "slow") =>
    prisma.run.create({ data: { agentId: agents[kind], nativeExecutionMode: "sandbox", executionManaged: true } });
  const waitFor = async (runId: string, timeoutMs = 150_000) => {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const run = await prisma.run.findUniqueOrThrow({ where: { id: runId } });
      if (!["pending", "running"].includes(run.status)) return run;
      if (Date.now() > until) throw new Error(`run ${runId} still ${run.status}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  const podExists = (runId: string) => kubectlOk(["get", "pod", nativeKubernetesNames(runId).pod]) !== null;

  it("runs a sandboxed agent in a worker pod whose isolation was proven first, then removes it", async () => {
    const run = await newRun("quick");
    await executor.start(run.id); // returns once the pod runs and its isolation is proven
    const session = await prisma.nativeGatewaySession.findUniqueOrThrow({ where: { runId: run.id } });
    expect(session.networkReadyAt).toBeInstanceOf(Date);
    const done = await waitFor(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.finalText).toMatch(/Friday/);
    expect(done.executionBackend).toBe("native-sandbox");
    for (let i = 0; i < 30 && podExists(run.id); i += 1) await new Promise((r) => setTimeout(r, 1000));
    expect(podExists(run.id)).toBe(false);
    expect(kubectlOk(["get", "secret", nativeKubernetesNames(run.id).secret])).toBeNull();
  }, 240_000);

  it("gives a run pod no route but the gateway: Postgres and the internet are unreachable from inside it", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    const pod = nativeKubernetesNames(run.id).pod;
    const reach = (host: string, port: number) =>
      kubectlOk([
        "exec",
        pod,
        "-c",
        "worker",
        "--",
        "node",
        "-e",
        `const s=require("node:net").connect({host:${JSON.stringify(host)},port:${port},timeout:3000});s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1));`,
      ]) !== null;
    expect(reach("host.docker.internal", 55432)).toBe(false);
    expect(reach("1.1.1.1", 443)).toBe(false);
    expect(kubectl(["get", "pod", pod, "-o", "jsonpath={.spec.automountServiceAccountToken}"])).toBe("false");
    expect((await waitFor(run.id)).status).toBe("succeeded");
  }, 240_000);

  it("fails a run whose pod is deleted mid-run, and never relaunches it", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    kubectl(["delete", "pod", nativeKubernetesNames(run.id).pod, "--grace-period=0", "--wait=false"]);
    const done = await waitFor(run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/^native_sandbox_worker_exited/);
    expect(await prisma.nativeGatewaySession.count({ where: { runId: run.id } })).toBe(1);
  }, 240_000);

  it("finishes a run while the gateway Deployment rolls its pods", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    kubectl(["rollout", "restart", "deploy/wardby-native-gateway"]);
    const done = await waitFor(run.id);
    expect(done.status).toBe("succeeded");
    kubectl(["rollout", "status", "deploy/wardby-native-gateway", "--timeout=120s"]);
  }, 300_000);

  it("stops a run mid tool call: cancelled, pod gone", async () => {
    const run = await newRun("slow");
    await executor.start(run.id);
    await new Promise((r) => setTimeout(r, 3000));
    await executor.stop(run.id, "operator cancelled");
    expect(await prisma.run.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: "cancelled" });
    for (let i = 0; i < 30 && podExists(run.id); i += 1) await new Promise((r) => setTimeout(r, 1000));
    expect(podExists(run.id)).toBe(false);
  }, 240_000);

  it("sweeps away a leftover pod whose run ended", async () => {
    const ended = await newRun("quick");
    await prisma.run.update({ where: { id: ended.id }, data: { status: "succeeded" } });
    await prisma.nativeGatewaySession.create({
      data: {
        runId: ended.id,
        capabilityHash: `h-${randomUUID()}`,
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        snapshot: {},
      },
    });
    const name = nativeKubernetesNames(ended.id).pod;
    await api.createPod(NAMESPACE, {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, namespace: NAMESPACE, labels: nativeRunLabels(ended.id) },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        securityContext: { runAsNonRoot: true, runAsUser: 10001 },
        containers: [
          {
            name: "worker",
            image: IMAGE,
            command: ["node", "-e", "setTimeout(()=>{},600000)"],
            // The namespace's ResourceQuota admits only pods that declare their limits.
            resources: {
              requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "64Mi" },
              limits: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "64Mi" },
            },
          },
        ],
      },
    });
    expect(await newExecutor().sweep()).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 30 && podExists(ended.id); i += 1) await new Promise((r) => setTimeout(r, 1000));
    expect(podExists(ended.id)).toBe(false);
  }, 120_000);
});
