// Shared harness for the Substrate launcher's unit, contract and database tests.
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { V1Secret } from "@kubernetes/client-node";
import { BUILTIN_CODING_SERVICES } from "../../../coding/services/builtins.js";
import { resolvedFromDefinition, type ResolvedCodingService } from "../../../coding/services/catalog.js";
import { MemoryRelayStore } from "../../coding-proxy/substrate/memory-relay-store.js";
import { LocalBlobStore } from "../../storage/local.js";
import type { BlobInfo } from "../../storage/types.js";
import { KubernetesAlreadyExistsError } from "../kubernetes-api.js";
import type { ServiceStateUpdate } from "../service-state.js";
import type { JobSpec } from "../types.js";
import { FakeSubstrateApi, type FakeSubstrateOptions } from "./fake-api.js";
import {
  SubstrateJobLauncher,
  type SubstrateCallFailure,
  type TemplateEvent,
  type WarmEvent,
  type WarmRoundsOptions,
} from "./launcher.js";
import { BLOB, substrateRunToken, type SubstrateServiceReport } from "./names.js";
import { MemorySubstrateRunStore, type SubstrateRunStore } from "./run-store.js";
import type { SubstrateLaunchConfig } from "./specs.js";
import { MemorySubstrateTemplateStore, type SubstrateTemplateStore } from "./template-store.js";

export const FAKE_CAP = "rrp_fake_capability_value_000001";
/** Fake MCP tokens, isMcpToken-shaped (`rmt_` + 43 characters). */
export const FAKE_MCP = "rmt_FAKE_MCP_TOKEN_NOT_REAL_" + "1".repeat(19);
export const FAKE_MCP_2 = "rmt_FAKE_MCP_TOKEN_NOT_REAL_" + "2".repeat(19);
/** The configured tool images (the default toolchain's and a per-toolchain one). */
export const TOOL_IMAGE = `registry.example/tool@sha256:${"b".repeat(64)}`;
export const PYTHON_TOOL_IMAGE = `registry.example/tool-python@sha256:${"c".repeat(64)}`;
/** The configured Codex image (the Codex worker built on the Substrate Codex bridge). */
export const CODEX_IMAGE = `registry.example/substrate-codex@sha256:${"d".repeat(64)}`;
/** An agent's custom images (workerImageRef): registry digests the deployment does not configure. */
export const CUSTOM_TOOL_IMAGE = `registry.example/byo-tool@sha256:${"e".repeat(64)}`;
export const CUSTOM_CODEX_IMAGE = `registry.example/byo-codex@sha256:${"9".repeat(64)}`;
/** Docker's content-addressed local image ID: no registry to pull it from, so Substrate refuses it. */
export const LOCAL_IMAGE_ID = `sha256:${"f".repeat(64)}`;
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
  /** The launcher's template record. */
  templates: SubstrateTemplateStore;
  /** Every template event the launcher reported. */
  templateEvents: TemplateEvent[];
  /** Every coding-service display state the launcher reported (onServiceState). */
  serviceStates: ServiceStateUpdate[];
  /** How many times the launcher slept (each sleep advances the clock by its ms). */
  sleeps: () => number;
  root: string;
}

export async function makeHarness(
  options: {
    workers?: number;
    workerSize?: FakeSubstrateOptions["workerSize"];
    workerLabels?: FakeSubstrateOptions["workerLabels"];
    suspendedHoldRoom?: boolean;
    config?: Partial<SubstrateLaunchConfig>;
    runId?: string;
    runs?: SubstrateRunStore;
    /** The template record (default: a fresh MemorySubstrateTemplateStore). */
    templates?: SubstrateTemplateStore;
    templateReadyMs?: number;
    templateRetryMs?: number;
    templateTtlMs?: number;
    collectGraceMs?: number;
    startupTimeoutMs?: number;
    warmRounds?: WarmRoundsOptions;
    /** The capability per run (default FAKE_CAP for every run). */
    capabilityFor?: (runId: string) => string;
    /** The MCP token per run (the launcher's resolveMcpToken); default none. */
    mcpTokenFor?: (runId: string) => string | undefined;
    /** "codex": the spec is a Codex run (one actor) on CODEX_IMAGE, with no tool image. */
    provider?: "claude-code" | "codex";
    /**
     * Extra repositories: each gets `<workspaceRoot>/<runId>/repos/<name>/workspace/README.md`
     * (`# <name>`), and the spec lists it with that folder as its host path.
     */
    repositories?: { name: string; access: "read" | "write" }[];
    /** The run's coding services (JobSpec.services). */
    services?: ResolvedCodingService[];
    /** Called on each launcher sleep, after the clock advanced (write a services report here). */
    onSleep?: (h: Harness) => Promise<void> | void;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "wardby-substrate-launcher-"));
  const workspaceRoot = join(root, "runs");
  const runId = options.runId ?? "run-1";
  await mkdir(join(workspaceRoot, runId, "workspace"), { recursive: true });
  await writeFile(join(workspaceRoot, runId, "workspace", "README.md"), "# hello\n");
  const repositories = [];
  for (const { name, access } of options.repositories ?? []) {
    const hostPath = join(workspaceRoot, runId, "repos", name, "workspace");
    await mkdir(hostPath, { recursive: true });
    await writeFile(join(hostPath, "README.md"), `# ${name}\n`);
    repositories.push({ name, access, hostPath });
  }
  const inputArtifact = join(root, "input.json");
  await writeFile(inputArtifact, JSON.stringify({ schemaVersion: 1, task: "say hello" }));
  const api = new FakeSubstrateApi({
    workers: options.workers ?? 2,
    ...(options.workerSize ? { workerSize: options.workerSize } : {}),
    ...(options.workerLabels ? { workerLabels: options.workerLabels } : {}),
    ...(options.suspendedHoldRoom ? { suspendedHoldRoom: true } : {}),
  });
  let now = 1_000_000;
  const runs = options.runs ?? new MemorySubstrateRunStore(() => now);
  const secrets = new RecordingSecrets();
  const callFailures: SubstrateCallFailure[] = [];
  const warmEvents: WarmEvent[] = [];
  const templates = options.templates ?? new MemorySubstrateTemplateStore();
  const templateEvents: TemplateEvent[] = [];
  const serviceStates: ServiceStateUpdate[] = [];
  let sleeps = 0;
  // Set once the harness exists: a sleep hands it to onSleep.
  const ref: { harness?: Harness } = {};
  const blobs = new ClockedBlobStore(join(root, "blobs"), () => now);
  const relay = new MemoryRelayStore();
  relay.register(substrateRunToken(runId), 1 << 20);
  const launcher = new SubstrateJobLauncher({
    api,
    runs,
    blobs,
    secrets,
    relay,
    config: { ...CONFIG, ...options.config },
    workspaceRoot,
    resolveCapability: async (id) => options.capabilityFor?.(id) ?? FAKE_CAP,
    resolveMcpToken: async (id) => options.mcpTokenFor?.(id),
    now: () => now,
    onSubstrateCallFailed: (failure) => callFailures.push(failure),
    templates,
    onTemplateEvent: (event) => templateEvents.push(event),
    ...(options.templateReadyMs !== undefined ? { templateReadyMs: options.templateReadyMs } : {}),
    ...(options.templateRetryMs !== undefined ? { templateRetryMs: options.templateRetryMs } : {}),
    ...(options.templateTtlMs !== undefined ? { templateTtlMs: options.templateTtlMs } : {}),
    ...(options.collectGraceMs !== undefined ? { collectGraceMs: options.collectGraceMs } : {}),
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    ...(options.warmRounds ? { warmRounds: options.warmRounds, onWarmEvent: (event) => warmEvents.push(event) } : {}),
    onServiceState: async (update) => {
      serviceStates.push(update);
    },
    sleep: async (ms) => {
      sleeps++;
      now += ms;
      if (ref.harness) await options.onSleep?.(ref.harness);
    },
  });
  const spec: JobSpec = {
    kind: "coding-agent",
    runId,
    ...(options.provider === "codex"
      ? { provider: "codex" as const, image: CODEX_IMAGE }
      : {
          provider: "claude-code" as const,
          image: `registry.example/agent@sha256:${"a".repeat(64)}`,
          toolImage: TOOL_IMAGE,
        }),
    inputArtifact,
    timeoutSec: 600,
    limits: { cpus: 1, memoryMb: 1024, pids: 256, diskMb: 64 },
    labels: {},
    ...(options.repositories ? { repositories } : {}),
    ...(options.services ? { services: options.services } : {}),
  };
  const harness: Harness = {
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
    templates,
    templateEvents,
    serviceStates,
    sleeps: () => sleeps,
    root,
  };
  ref.harness = harness;
  return harness;
}

/** Writes the holder bridge's services report (as the proxy stores it) for the harness's run. */
export async function reportServices(h: Harness, entries: SubstrateServiceReport[]): Promise<void> {
  await h.blobs.put(BLOB.services(h.token), Buffer.from(JSON.stringify({ services: entries })));
}

/** Every file the blob store holds, with its contents. */
export async function allBlobs(h: Harness): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, await readFile(path, "utf8"));
    }
  };
  await walk(join(h.root, "blobs"), "");
  return out;
}

/** A fake service (no substrateImage): every catalog value that must stay out of a template is a marker. */
export const FAKE_SERVICE: ResolvedCodingService = {
  name: "fakedb",
  version: "1",
  image: `registry.example/fakedb@sha256:${"b".repeat(64)}`,
  port: 5999,
  serviceEnv: { FAKEDB_PASSWORD: "FAKE_SERVICE_ENV_VALUE_0001" },
  testEnv: {},
  readiness: {
    command: ["fakedb-ping", "FAKE_READINESS_ARG_0001"],
    periodSeconds: 1,
    timeoutSeconds: 1,
    failureThreshold: 3,
  },
  startCommand: ["fakedb-serve", "--fake-start-arg-0001"],
  resources: { cpuMillicores: 250, memoryMib: 256, diskMib: 128 },
  dataPath: "/var/lib/fakedb",
  writablePaths: ["/tmp"],
};

/** The built-in postgres 16 entry, as dispatch snapshots it (with its substrateImage). */
export const POSTGRES_16_SERVICE: ResolvedCodingService = (() => {
  const definition = BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16");
  if (!definition) throw new Error("no built-in postgres 16");
  return resolvedFromDefinition(definition);
})();
