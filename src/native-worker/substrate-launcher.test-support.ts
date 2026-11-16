import { vi } from "vitest";
import type { Power } from "../core/power.js";
import { RecordingSecrets } from "../providers/jobs/substrate/launcher.test-support.js";
import type { SubstrateApi } from "../providers/substrate/api.js";
import { FakeSubstrateApi, type FakeSubstrateOptions } from "../providers/substrate/fake-api.js";
import { nativeActorName, substrateRunToken } from "../providers/substrate/names.js";
import type { NativeCanaryResult, WorkerInput } from "./protocol.js";
import { MemoryNativeCanaryStore, type NativeCanaryStore } from "./substrate-canary-store.js";
import {
  SubstrateNativeWorkerLauncher,
  type NativeSubstrateCallFailure,
  type SubstrateNativeWorkerLauncherOptions,
} from "./substrate-launcher.js";
import type { NativeSubstrateLaunchConfig } from "./substrate-specs.js";

// Obviously fake: the run's gateway capability. It must reach only the per-run Secret.
export const FAKE_NATIVE_CAP = "fake_native_capability_" + "0".repeat(21);
export const NATIVE_IMAGE = "registry.example/wardby-native-worker@sha256:" + "a".repeat(64);
export const GATEWAY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/call";
export const NATIVE_CONFIG: NativeSubstrateLaunchConfig = {
  atespace: "wardby-runs",
  credentialsNamespace: "wardby-run-credentials",
  image: NATIVE_IMAGE,
  gatewayUrl: GATEWAY_URL,
  cpus: 1,
  memoryMb: 512,
};
/** Text that must never leave the control plane: the run's prompt. */
export const FAKE_PROMPT = "FAKE_SYSTEM_PROMPT_native_0042";

export const nativeInput: WorkerInput = {
  v: 1,
  runId: "run-1",
  agent: { systemPrompt: FAKE_PROMPT, model: "claude-haiku-4-5", budgetUsd: 1, maxTurns: 4 },
  tools: [],
  builtinTools: [],
  userTools: {},
  runsConcurrently: [],
  pricing: {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    encoding: "cl100k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "none",
  },
  gateway: { url: GATEWAY_URL, capability: FAKE_NATIVE_CAP },
};

const METHODS = [
  "ensureActorTemplate",
  "getActorTemplate",
  "deleteActorTemplate",
  "createActor",
  "getActor",
  "resumeActor",
  "suspendActor",
  "deleteActor",
  "putEgressPolicy",
  "deleteEgressPolicy",
  "listWorkers",
] as const satisfies readonly (keyof SubstrateApi)[];
type Method = (typeof METHODS)[number];

/** Whether a call is about a startup canary actor (an argument names `wr-…-canary`). */
const isCanaryCall = (args: unknown[]) => args.some((arg) => typeof arg === "string" && arg.endsWith("-canary"));

/**
 * The in-memory fake with every call recorded (`calls`, with its arguments, for leak checks; `order`,
 * shared with the Secrets, for call order) and per-method hooks: `before[m]` runs before the fake
 * answers and may throw (or wait) instead.
 *
 * A call about the startup canary's actor is kept apart (`canaryCalls`, `canaryBefore`), so a run's
 * calls, order and failure hooks are the same with the canary as without it. `onCanaryResumed` runs
 * after a canary actor resumes: the harness reports its verdict there, as the worker would.
 */
export class RecordingSubstrateApi extends FakeSubstrateApi {
  readonly calls: { method: Method; args: unknown[] }[] = [];
  readonly before: Partial<Record<Method, (...args: unknown[]) => Promise<void>>> = {};
  readonly canaryCalls: { method: Method; args: unknown[] }[] = [];
  readonly canaryBefore: Partial<Record<Method, (...args: unknown[]) => Promise<void>>> = {};
  onCanaryResumed: ((actor: string) => Promise<void>) | undefined;
  constructor(
    options: FakeSubstrateOptions,
    readonly order: string[],
  ) {
    super(options);
    for (const method of METHODS) {
      const real = (this[method] as (...args: unknown[]) => Promise<unknown>).bind(this);
      (this as unknown as Record<Method, unknown>)[method] = async (...args: unknown[]) => {
        if (isCanaryCall(args)) {
          this.canaryCalls.push({ method, args: structuredClone(args) });
          await this.canaryBefore[method]?.(...args);
          const out = await real(...args);
          if (method === "resumeActor") await this.onCanaryResumed?.(args[1] as string);
          return out;
        }
        this.calls.push({ method, args: structuredClone(args) });
        this.order.push(method);
        await this.before[method]?.(...args);
        return real(...args);
      };
    }
  }
  /** `method` throws `error` for its next `times` calls. */
  failNext(method: Method, error: Error | (() => Error), times = 1): void {
    let left = times;
    const previous = this.before[method];
    this.before[method] = async (...args) => {
      if (left > 0) {
        left -= 1;
        throw typeof error === "function" ? error() : error;
      }
      await previous?.(...args);
    };
  }
}

/** The canary's `method` throws `error` for its next `times` calls. */
export function failNextCanary(
  api: RecordingSubstrateApi,
  method: Method,
  error: Error | (() => Error),
  times = 1,
): void {
  let left = times;
  const previous = api.canaryBefore[method];
  api.canaryBefore[method] = async (...args) => {
    if (left > 0) {
      left -= 1;
      throw typeof error === "function" ? error() : error;
    }
    await previous?.(...args);
  };
}

/** RecordingSecrets whose calls also go to the shared order. */
class OrderedSecrets extends RecordingSecrets {
  constructor(private readonly order: string[]) {
    super();
  }
  override async createSecret(...args: Parameters<RecordingSecrets["createSecret"]>) {
    this.order.push("createSecret");
    return super.createSecret(...args);
  }
  override async deleteSecret(...args: Parameters<RecordingSecrets["deleteSecret"]>) {
    this.order.push("deleteSecret");
    return super.deleteSecret(...args);
  }
}

export interface NativeHarnessOptions {
  fake?: Partial<FakeSubstrateOptions>;
  config?: Partial<NativeSubstrateLaunchConfig>;
  goldenWaitMs?: number;
  power?: Power;
  launcher?: Partial<SubstrateNativeWorkerLauncherOptions>;
  /** The verdict the fake canary worker reports when its actor resumes, or "silent" for none. Default pass. */
  canaryVerdict?: NativeCanaryResult | "silent";
  /** Default: a MemoryNativeCanaryStore. */
  canaries?: NativeCanaryStore;
}

export function nativeHarness(options: NativeHarnessOptions = {}) {
  const order: string[] = [];
  const api = new RecordingSubstrateApi({ workers: 1, ...options.fake }, order);
  const secrets = new OrderedSecrets(order);
  const sessions = new Map<string, boolean>();
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const failures: NativeSubstrateCallFailure[] = [];
  const config = { ...NATIVE_CONFIG, ...options.config };
  const canaries = options.canaries ?? new MemoryNativeCanaryStore();
  const harness = { canaryVerdict: options.canaryVerdict ?? "pass" };
  // The canary worker: probes, then posts its verdict through the gateway's route (the store).
  api.onCanaryResumed = async (actor) => {
    if (harness.canaryVerdict !== "silent") await canaries.report(actor, harness.canaryVerdict, new Date());
  };
  const launcher = new SubstrateNativeWorkerLauncher({
    api,
    secrets,
    config,
    sessionActive: async (runId) => sessions.get(runId) ?? false,
    goldenWaitMs: options.goldenWaitMs ?? 60_000,
    canaries,
    pollMs: 5,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      // A real tick, so a polling handle never starves the test.
      await new Promise((resolve) => setImmediate(resolve));
    },
    onCallFailed: (failure) => failures.push(failure),
    ...(options.power ? { power: options.power } : {}),
    ...options.launcher,
  });
  const token = substrateRunToken("run-1");
  return {
    api,
    secrets,
    sessions,
    launcher,
    config,
    canaries,
    /** Set `canaryVerdict` to change what the next canary reports. */
    harness,
    order,
    sleeps,
    failures,
    token,
    actor: nativeActorName(token),
    actorKey: `${config.atespace}/${nativeActorName(token)}`,
    secretKey: `${config.credentialsNamespace}/${token}`,
    setNow: (ms: number) => void (clock = ms),
    now: () => clock,
    input: (over: Partial<WorkerInput> = {}): WorkerInput => ({ ...structuredClone(nativeInput), ...over }),
  };
}

export const fakePower = (ensureAwake = vi.fn(async () => {})) => ({ enabled: true, ensureAwake }) as unknown as Power;
