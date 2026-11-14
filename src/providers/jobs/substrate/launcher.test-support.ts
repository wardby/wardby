// Shared harness for the Substrate launcher's unit, contract and database tests.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1Secret } from "@kubernetes/client-node";
import { LocalBlobStore } from "../../storage/local.js";
import { KubernetesAlreadyExistsError } from "../kubernetes-api.js";
import type { JobSpec } from "../types.js";
import { FakeSubstrateApi } from "./fake-api.js";
import { SubstrateJobLauncher } from "./launcher.js";
import { substrateRunToken } from "./names.js";
import { MemorySubstrateRunStore, type SubstrateRunStore } from "./run-store.js";
import type { SubstrateLaunchConfig } from "./specs.js";

export const FAKE_CAP = "rrp_fake_capability_value_000001";
export const ATESPACE = "wardby-runs";
export const CONFIG: SubstrateLaunchConfig = {
  atespace: ATESPACE,
  credentialsNamespace: "wardby-run-credentials",
  proxyHost: "coding-proxy.wardby.svc.cluster.local",
  proxyPort: 8787,
};

/** Records Secrets by `<namespace>/<name>`; a second create of the same name is AlreadyExists. */
export class RecordingSecrets {
  readonly secrets = new Map<string, V1Secret>();
  readonly calls: string[] = [];

  async createSecret(namespace: string, body: V1Secret): Promise<V1Secret> {
    const key = `${namespace}/${body.metadata?.name}`;
    this.calls.push(`create ${key}`);
    if (this.secrets.has(key)) throw new KubernetesAlreadyExistsError(key);
    this.secrets.set(key, structuredClone(body));
    return body;
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.calls.push(`delete ${namespace}/${name}`);
    this.secrets.delete(`${namespace}/${name}`);
  }
}

export interface Harness {
  launcher: SubstrateJobLauncher;
  api: FakeSubstrateApi;
  runs: SubstrateRunStore;
  blobs: LocalBlobStore;
  secrets: RecordingSecrets;
  spec: JobSpec;
  token: string;
  workspaceRoot: string;
  output: { schemaVersion: 1; runId: string; outcome: string; summary: string; tests: never[] };
  setNow: (ms: number) => void;
}

export async function makeHarness(
  options: { workers?: number; runId?: string; runs?: SubstrateRunStore } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "wardby-substrate-launcher-"));
  const workspaceRoot = join(root, "runs");
  const runId = options.runId ?? "run-1";
  await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "# hello\n");
  const inputArtifact = join(root, "input.json");
  await writeFile(inputArtifact, JSON.stringify({ schemaVersion: 1, task: "say hello" }));
  const api = new FakeSubstrateApi({ workers: options.workers ?? 2 });
  const runs = options.runs ?? new MemorySubstrateRunStore();
  const blobs = new LocalBlobStore(join(root, "blobs"));
  const secrets = new RecordingSecrets();
  let now = 1_000_000;
  const launcher = new SubstrateJobLauncher({
    api,
    runs,
    blobs,
    secrets,
    config: CONFIG,
    workspaceRoot,
    resolveCapability: async () => FAKE_CAP,
    now: () => now,
  });
  const spec: JobSpec = {
    kind: "coding-agent",
    runId,
    provider: "claude-code",
    image: `registry.example/agent@sha256:${"a".repeat(64)}`,
    toolImage: `registry.example/tool@sha256:${"b".repeat(64)}`,
    inputArtifact,
    timeoutSec: 600,
    limits: { cpus: 1, memoryMb: 1024, pids: 256, diskMb: 64 },
    labels: {},
  };
  return {
    launcher,
    api,
    runs,
    blobs,
    secrets,
    spec,
    token: substrateRunToken(runId),
    workspaceRoot,
    output: { schemaVersion: 1, runId, outcome: "no_changes", summary: "done", tests: [] },
    setNow: (ms) => {
      now = ms;
    },
  };
}
