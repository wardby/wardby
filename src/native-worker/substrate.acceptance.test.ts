/**
 * Native sandbox on a real Agent Substrate (npm run test:native-substrate): the Substrate launcher
 * alone, against the cluster's deployed wardby-native-gateway. No model is called. A launch waits for
 * the startup canary, whose verdict the deployed gateway records in its database, so the cases that
 * launch a worker need NATIVE_TEST_CANARY_DATABASE_URL. Opt-in only: WARDBY_NATIVE_SUBSTRATE_TEST=1, plus
 *   NATIVE_TEST_WORKER_IMAGE            (required: the worker image digest the cluster pulls)
 *   NATIVE_TEST_GATEWAY_URL             (required: the gateway's http://<hostname>:<port> URL, as in NATIVE_GATEWAY_URL)
 *   SUBSTRATE_API_URL, SUBSTRATE_TOKEN_FILE, SUBSTRATE_ATESPACE  (required, as for the server)
 *   SUBSTRATE_CREDENTIALS_NAMESPACE, SUBSTRATE_CA_FILE, SUBSTRATE_SERVER_NAME,
 *   SUBSTRATE_KUBE_CONTEXT, SUBSTRATE_WORKER_SELECTOR  (optional, as for the server)
 *   NATIVE_TEST_CANARY_DATABASE_URL     (optional: the database the deployed gateway writes canaries
 *                                        to; without it only the golden snapshot case runs)
 *
 * A worker here is launched with a capability the gateway has never issued, so it is refused and
 * crashes: that proves the worker reaches the gateway through the egress policy and that the
 * gateway checks the capability. Printed output is statuses only, never a value.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubstrateConnectionConfig } from "../config/providers.js";
import { createPrismaClient } from "../core/db.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { createSubstrateApiFor } from "../providers/substrate/composition.js";
import type { SubstrateApi } from "../providers/substrate/api.js";
import { nativeActorName, substrateRunToken } from "../providers/substrate/names.js";
import type { WorkerInput } from "./protocol.js";
import { MemoryNativeCanaryStore, PrismaNativeCanaryStore, type NativeCanaryStore } from "./substrate-canary-store.js";
import { SubstrateNativeWorkerLauncher } from "./substrate-launcher.js";
import { nativeTemplate, type NativeSubstrateLaunchConfig } from "./substrate-specs.js";

const enabled = process.env.WARDBY_NATIVE_SUBSTRATE_TEST === "1";
const IMAGE = process.env.NATIVE_TEST_WORKER_IMAGE ?? "";
const GATEWAY_URL = process.env.NATIVE_TEST_GATEWAY_URL ?? "";
const CANARY_DATABASE_URL = process.env.NATIVE_TEST_CANARY_DATABASE_URL?.trim() || undefined;
const GOLDEN_TIMEOUT_MS = 180_000;
const REFUSED_TIMEOUT_MS = 120_000;
const CANARY_TIMEOUT_MS = 180_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Polls until `done` returns a value, up to `timeoutMs`; undefined on timeout. */
async function until<T>(done: () => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await done();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(2_000);
  }
}

describe.skipIf(!enabled)("native sandbox on Substrate (acceptance, launcher only)", () => {
  const launched: string[] = [];
  /** Run ids the launcher asked for a recorded exit of (none is ever recorded for a refused worker). */
  const recordedExitQueries: string[] = [];
  let api: SubstrateApi;
  let config: NativeSubstrateLaunchConfig;
  let kubeContext: string | undefined;
  let db: ReturnType<typeof createPrismaClient> | undefined;
  let makeLauncher: (canaries: NativeCanaryStore) => SubstrateNativeWorkerLauncher;
  let launcher: SubstrateNativeWorkerLauncher;

  const input = (runId: string): WorkerInput => ({
    v: 1,
    runId,
    agent: { systemPrompt: "unused", model: "claude-haiku-4-5", budgetUsd: 0.01, maxTurns: 1 },
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
    // A fresh random capability the gateway never issued (and no session exists for the run).
    gateway: { url: GATEWAY_URL, capability: randomBytes(32).toString("base64url") },
  });

  /** Exit status of `kubectl get secret`, nothing else (never the output). */
  const secretStatus = (name: string): number => {
    try {
      execFileSync(
        "kubectl",
        [...(kubeContext ? ["--context", kubeContext] : []), "-n", config.credentialsNamespace, "get", "secret", name],
        { stdio: "ignore" },
      );
      return 0;
    } catch (err) {
      return (err as { status?: number }).status ?? -1;
    }
  };

  beforeAll(() => {
    if (!/@sha256:[0-9a-f]{64}$/.test(IMAGE)) throw new Error("set NATIVE_TEST_WORKER_IMAGE to a registry digest");
    if (!/^http:\/\/[^/]+/.test(GATEWAY_URL)) throw new Error("set NATIVE_TEST_GATEWAY_URL to the gateway's http URL");
    const connection = loadSubstrateConnectionConfig(process.env, "the native Substrate acceptance test");
    kubeContext = connection.kubeContext;
    api = createSubstrateApiFor(connection);
    config = {
      atespace: connection.atespace,
      credentialsNamespace: connection.credentialsNamespace,
      image: IMAGE,
      gatewayUrl: GATEWAY_URL,
      cpus: 0.5,
      memoryMb: 512,
      denyPort: 8791,
      ...(connection.workerSelector ? { workerSelector: connection.workerSelector } : {}),
    };
    makeLauncher = (canaries) =>
      new SubstrateNativeWorkerLauncher({
        api,
        secrets: new ClientNodeKubernetesApi({ context: kubeContext }),
        config,
        // The gateway refuses a worker holding an unknown capability: no session ever exists for these runs.
        sessionActive: async () => false,
        workerExits: {
          exitCode: async (id: string) => {
            recordedExitQueries.push(id);
            return undefined;
          },
        },
        goldenWaitMs: GOLDEN_TIMEOUT_MS,
        canaries,
      });
    db = CANARY_DATABASE_URL ? createPrismaClient(CANARY_DATABASE_URL) : undefined;
    launcher = makeLauncher(db ? new PrismaNativeCanaryStore(db) : new MemoryNativeCanaryStore());
  });

  afterAll(async () => {
    for (const runId of launched) await launcher?.remove(runId).catch(() => {});
    await db?.$disconnect();
  });

  it(
    "builds the worker template's golden snapshot",
    async () => {
      await launcher.start();
      const name = nativeTemplate(config).name;
      const info = await until(async () => {
        const found = await api.getActorTemplate(config.atespace, name);
        return found?.goldenSnapshotFailed === false || found?.goldenSnapshotFailed === true ? found : undefined;
      }, GOLDEN_TIMEOUT_MS);
      expect(info).toBeDefined();
      expect(info?.goldenSnapshotFailed).toBe(false);
    },
    GOLDEN_TIMEOUT_MS + 30_000,
  );

  it.skipIf(!CANARY_DATABASE_URL)(
    "a worker with an unknown capability is refused by the gateway, and its actor and Secret are removed",
    async () => {
      const runId = `nsub-${randomBytes(4).toString("hex")}`;
      launched.push(runId);
      await launcher.launch(input(runId));
      const token = substrateRunToken(runId);
      // The actor exists after launch (the launcher created it with its Secret).
      expect(await api.getActor(config.atespace, nativeActorName(token))).toBeDefined();
      expect(secretStatus(token)).toBe(0);
      // The gateway refused the capability, so it never opened a session for this run: inspect (which
      // reads the session as well as the actor) reaches exited, and no exit code was ever recorded
      // (the supervisor's report is refused too), so the state is the session-ended exit 0, never a
      // running worker.
      const state = await until(async () => {
        const s = await launcher.inspect(runId);
        return s.state === "exited" ? s : undefined;
      }, REFUSED_TIMEOUT_MS);
      expect(state).toEqual({ state: "exited", exitCode: 0 });
      expect(recordedExitQueries.filter((id) => id === runId).length).toBeGreaterThan(0);

      await launcher.remove(runId);
      expect(await api.getActor(config.atespace, nativeActorName(token))).toBeUndefined();
      // Only the exit status is looked at.
      expect(secretStatus(token)).not.toBe(0);
    },
    REFUSED_TIMEOUT_MS + 120_000,
  );

  it.skipIf(!CANARY_DATABASE_URL)(
    "the canary proves the template",
    async () => {
      // A new launcher has proven nothing: its launch resolves only once its own canary passed.
      const fresh = makeLauncher(new PrismaNativeCanaryStore(db!));
      const runId = `nsub-${randomBytes(4).toString("hex")}`;
      launched.push(runId);
      try {
        await expect(fresh.launch(input(runId))).resolves.toBeDefined();
      } finally {
        await fresh.remove(runId);
      }
    },
    CANARY_TIMEOUT_MS + 120_000,
  );
});
