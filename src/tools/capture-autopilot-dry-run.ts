/**
 * Captures a platform's admission mutations into the committed fixture.
 *
 * Submits the pod the launcher would really build with `dryRun=All`: the API
 * server runs its whole admission chain and returns the mutated object without
 * scheduling or persisting anything, so the exact mutation set can be read from
 * a real cluster for the price of one API call and no billable workload.
 *
 * This is a development tool, run deliberately and reviewed in a diff. Nothing
 * at runtime calls it: the admission chain that produces these mutations is the
 * same one an attacker with cluster access would subvert, so it can never be
 * allowed to bless itself at launch time.
 *
 *   npm run capture:autopilot     # writes the fixture and prints the mutation list
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../env.js";
import { loadContainerExecutorConfig, loadKubernetesJobConfig } from "../config/providers.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { buildRunPod } from "../providers/jobs/kubernetes-isolation.js";
import { readProxyWitness } from "../providers/jobs/kubernetes-witness.js";
import { diffMutations, type DryRunFixture } from "../providers/jobs/kubernetes-dry-run-fixture.js";
import type { JobSpec } from "../providers/jobs/types.js";

const FIXTURE = fileURLToPath(new URL("../providers/jobs/fixtures/gke-autopilot-dry-run.json", import.meta.url));

async function main(): Promise<void> {
  const config = loadKubernetesJobConfig();
  const container = loadContainerExecutorConfig();
  if (config.platform === "generic") {
    throw new Error("Set KUBERNETES_PLATFORM to the platform you are capturing (e.g. gke-autopilot).");
  }
  if (!container.workerImage) throw new Error("CODING_WORKER_IMAGE is required.");
  const api = new ClientNodeKubernetesApi({ context: config.context });
  const witness = await readProxyWitness(api, config.namespace, config.proxyService);
  const spec: JobSpec = {
    kind: "coding-agent",
    runId: "capture-dry-run",
    provider: "codex",
    image: container.workerImage,
    inputArtifact: "",
    timeoutSec: 900,
    limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
    labels: {},
  };
  const submitted = buildRunPod(spec, {
    namespace: config.namespace,
    proxyIp: witness.clusterIp,
    runtimeClassName: config.runtimeClassName,
    platform: config.platform,
  });
  const returned = await api.dryRunCreatePod(config.namespace, submitted);
  // Fields every API server fills in on any create; they are not platform mutations.
  for (const key of ["creationTimestamp", "uid", "resourceVersion", "generation", "managedFields", "selfLink"]) {
    delete (returned.metadata as Record<string, unknown> | undefined)?.[key];
  }
  delete returned.status;
  const mutations = diffMutations(submitted, returned);
  const fixture: DryRunFixture = {
    capturedAt: new Date().toISOString().slice(0, 10),
    platform: config.platform,
    provisional: false,
    source: `server-side dry run against a ${config.platform} cluster; the cluster version is recorded in docs/phase-12-kubernetes-evidence.md`,
    notes: [
      "Captured by src/tools/capture-autopilot-dry-run.ts. Every entry must have a matching allowance in kubernetes-platform.ts, or the attestation test fails.",
    ],
    mutations,
  };
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify(mutations, null, 2));
  console.log(`wrote ${FIXTURE} (${mutations.length} mutation(s))`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
