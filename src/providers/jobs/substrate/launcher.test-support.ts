// Shared harness for the Substrate launcher's unit, contract and database tests.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1Secret } from "@kubernetes/client-node";
import { MemoryRelayStore } from "../../coding-proxy/substrate/memory-relay-store.js";
import { LocalBlobStore } from "../../storage/local.js";
import type { BlobInfo } from "../../storage/types.js";
import { KubernetesAlreadyExistsError } from "../kubernetes-api.js";
import type { JobSpec } from "../types.js";
import { FakeSubstrateApi, type FakeSubstrateOptions } from "./fake-api.js";
import { SubstrateJobLauncher, type SubstrateCallFailure, type WarmEvent, type WarmRoundsOptions } from "./launcher.js";
import { substrateRunToken } from "./names.js";
import { MemorySubstrateRunStore, type SubstrateRunStore } from "./run-store.js";
import type { SubstrateLaunchConfig } from "./specs.js";

export const FAKE_CAP = "rrp_fake_capability_value_000001";
/** The configured bridge tool images (the default toolchain's and a per-toolchain one). */
export const TOOL_IMAGE = `registry.example/tool@sha256:${"b".repeat(64)}`;
export const PYTHON_TOOL_IMAGE = `registry.example/tool-python@sha256:${"c".repeat(64)}`;
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

/** A worker too small for both default-sized actors at once (agent 750m, tool 250m: 1000m in all). */
export const SMALL_WORKER = { cpuMillicores: 800, memoryBytes: 2 ** 30 };

/**
 * A local blob store whose `updatedAt` is the harness clock at the time of the write, so the
 * launcher's deadline checks compare like with like (the real stores report their write time).
 */
export class ClockedBlobStore extends LocalBlobStore {
  private readonly written = new Map<string, Date>();
  constructor(
    root: string,
    private readonly clock: () => number,
  ) {
    super(root);
  }
  override async put(key: string, body: Buffer): Promise<void> {
    await super.put(key, body);
    this.written.set(key, new Date(this.clock()));
  }
  override async putStream(
    key: string,
    body: NodeJS.ReadableStream,
    opts?: { contentType?: string; maxBytes?: number },
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const result = await super.putStream(key, body, opts);
    this.written.set(key, new Date(this.clock()));
    return result;
  }
  override async delete(key: string): Promise<void> {
    await super.delete(key);
    this.written.delete(key);
  }
  override async head(key: string): Promise<BlobInfo | null> {
    const info = await super.head(key);
    const at = this.written.get(key);
    return info && at ? { ...info, updatedAt: at } : info;
  }
}

export interface Harness {
  launcher: SubstrateJobLauncher;
  api: FakeSubstrateApi;
  runs: SubstrateRunStore;
  blobs: ClockedBlobStore;
  secrets: RecordingSecrets;
  /** The proxy's relay, with the run registered (its SubstrateRun row). */
  relay: MemoryRelayStore;
  spec: JobSpec;
  token: string;
  workspaceRoot: string;
  output: { schemaVersion: 1; runId: string; outcome: string; summary: string; tests: never[] };
  setNow: (ms: number) => void;
  /** Every failed Substrate call the launcher reported. */
  callFailures: SubstrateCallFailure[];
  /** Every warm-round event the launcher reported (warm rounds only). */
  warmEvents: WarmEvent[];
  root: string;
}

export async function makeHarness(
  options: {
    workers?: number;
    workerSize?: FakeSubstrateOptions["workerSize"];
    workerLabels?: FakeSubstrateOptions["workerLabels"];
    config?: Partial<SubstrateLaunchConfig>;
    runId?: string;
    runs?: SubstrateRunStore;
    collectGraceMs?: number;
    startupTimeoutMs?: number;
    warmRounds?: WarmRoundsOptions;
    /** The capability per run (default FAKE_CAP for every run). */
    capabilityFor?: (runId: string) => string;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "wardby-substrate-launcher-"));
  const workspaceRoot = join(root, "runs");
  const runId = options.runId ?? "run-1";
  await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "# hello\n");
  const inputArtifact = join(root, "input.json");
  await writeFile(inputArtifact, JSON.stringify({ schemaVersion: 1, task: "say hello" }));
  const api = new FakeSubstrateApi({
    workers: options.workers ?? 2,
    ...(options.workerSize ? { workerSize: options.workerSize } : {}),
    ...(options.workerLabels ? { workerLabels: options.workerLabels } : {}),
  });
  let now = 1_000_000;
  const runs = options.runs ?? new MemorySubstrateRunStore(() => now);
  const secrets = new RecordingSecrets();
  const callFailures: SubstrateCallFailure[] = [];
  const warmEvents: WarmEvent[] = [];
  const blobs = new ClockedBlobStore(join(root, "blobs"), () => now);
  const relay = new MemoryRelayStore();
  relay.register(substrateRunToken(runId), 1 << 20);
  const launcher = new SubstrateJobLauncher({
    api,
    runs,
    blobs,
    secrets,
    relay,
    bridgeToolImages: [TOOL_IMAGE, PYTHON_TOOL_IMAGE],
    config: { ...CONFIG, ...options.config },
    workspaceRoot,
    resolveCapability: async (id) => options.capabilityFor?.(id) ?? FAKE_CAP,
    now: () => now,
    onSubstrateCallFailed: (failure) => callFailures.push(failure),
    ...(options.collectGraceMs !== undefined ? { collectGraceMs: options.collectGraceMs } : {}),
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.warmRounds ? { warmRounds: options.warmRounds, onWarmEvent: (event) => warmEvents.push(event) } : {}),
  });
  const spec: JobSpec = {
    kind: "coding-agent",
    runId,
    provider: "claude-code",
    image: `registry.example/agent@sha256:${"a".repeat(64)}`,
    toolImage: TOOL_IMAGE,
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
    relay,
    spec,
    token: substrateRunToken(runId),
    workspaceRoot,
    output: { schemaVersion: 1, runId, outcome: "no_changes", summary: "done", tests: [] },
    setNow: (ms) => {
      now = ms;
    },
    callFailures,
    warmEvents,
    root,
  };
}
