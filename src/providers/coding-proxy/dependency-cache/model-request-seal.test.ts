import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../../core/logger.js", () => ({ logger: { child: () => log, ...log } }));

import { deriveRegistryToken } from "../../../coding/registry/token.js";
import { LocalBlobStore } from "../../storage/local.js";
import type { ModelPricing } from "../../llm/pricing-core.js";
import { MemoryProxyLedger } from "../memory-ledger.js";
import { CodingProxy, capabilityHash, type ProxyResponseSink } from "../proxy.js";
import { MemoryRegistryStore } from "../registry/store.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "../server.js";
import { ModelRequestSeal } from "./model-request-seal.js";
import { DependencyCacheService } from "./service.js";
import { MemoryDependencyCacheStore } from "./store.js";

const LOCK = "a".repeat(64);
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2,
  outputPerMTok: 4,
};

class Sink implements ProxyResponseSink {
  status?: number;
  start(status: number) {
    this.status = status;
  }
  async write() {}
  end() {}
  destroy() {}
}

const servers: CodingProxyServerHandle[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: { sealOnModel?: boolean; cacheOff?: boolean } = {}) {
  const registry = new MemoryRegistryStore();
  const store = new MemoryDependencyCacheStore(registry.cacheSessions);
  const seal = new ModelRequestSeal(store);
  const upstream = vi.fn(async () => Response.json({ id: "resp", usage: { input_tokens: 1, output_tokens: 1 } }));
  const proxy = new CodingProxy({
    ledger: new MemoryProxyLedger(),
    credentials: { resolve: async () => "UPSTREAM_SECRET" },
    fetch: upstream,
    pricing: () => PRICE,
    pricingVersion: "test-v1",
    ...(options.sealOnModel === false ? {} : { onModelRequest: (runId: string) => seal.onModelRequest(runId) }),
  });
  const session = await proxy.createSession({
    runId: "run-1",
    credentialRef: "openai/project-a",
    protocol: "openai-responses",
    allowedModels: ["test-model"],
    deadlineAt: new Date(Date.now() + 3_600_000),
    budgetUsd: 1,
  });
  const token = deriveRegistryToken(session.capability);
  registry.contexts.set(capabilityHash(token), {
    runId: "run-1",
    deadlineAt: session.deadlineAt,
    allowlist: { npm: ["react"] },
    policy: { minReleaseAgeDays: 3 },
    repository: "owner/repo",
    cacheImage: "worker:1",
    dependencyCache: !options.cacheOff,
    packageAudit: null,
  });
  registry.cacheSessions.set("run-1", { lockHashes: [LOCK], sealedAt: null, createdAt: new Date() });
  if (options.cacheOff) store.cacheOff.add("run-1");
  const dir = await mkdtemp(join(tmpdir(), "model-seal-"));
  dirs.push(dir);
  const cache = new DependencyCacheService({
    registry,
    store,
    blobs: new LocalBlobStore(dir),
    maxSnapshotBytes: 1024 * 1024,
    uploadMs: 900_000,
  });
  const server = await startCodingProxyServer(proxy, { host: "127.0.0.1", port: 0, dependencyCache: cache });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}/cache/npm`;
  const headers = { authorization: `Bearer ${token}` };
  const model = async () => {
    const sink = new Sink();
    await proxy.execute(
      {
        bearer: session.capability,
        protocol: "openai-responses",
        rawBody: JSON.stringify({ model: "test-model", input: "hello", max_output_tokens: 10, stream: false }),
        requestKey: `request-${Math.random()}`,
      },
      sink,
    );
    return sink.status;
  };
  return {
    store,
    registry,
    upstream,
    model,
    sealedAt: () => registry.cacheSessions.get("run-1")!.sealedAt,
    lookup: () => fetch(`${base}/lookup?lock=${LOCK}`, { headers }).then((response) => response.status),
    upload: () =>
      fetch(`${base}/blob?lock=${LOCK}`, { method: "PUT", headers, body: "bytes" }).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      })),
  };
}

describe("the run's first model request seals its dependency cache", () => {
  it("seals an unsealed session, after which the cache refuses lookups and uploads", async () => {
    const env = await setup();
    expect(await env.lookup()).toBe(200);
    expect(await env.model()).toBe(200);
    expect(env.sealedAt()).toBeInstanceOf(Date);
    expect(await env.lookup()).toBe(409);
    expect(await env.upload()).toEqual({ status: 409, body: { error: "sealed" } });
  });

  it("writes once per run per process, keeping the first seal time", async () => {
    const env = await setup();
    const spy = vi.spyOn(env.store, "sealForModelRequest");
    await env.model();
    const first = env.sealedAt();
    await env.model();
    await env.model();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(env.sealedAt()).toBe(first);
  });

  it("does nothing for a run whose agent has the cache off", async () => {
    const env = await setup({ cacheOff: true });
    expect(await env.model()).toBe(200);
    expect(env.sealedAt()).toBeNull();
  });

  it("does nothing on a proxy without the cache", async () => {
    const env = await setup({ sealOnModel: false });
    expect(await env.model()).toBe(200);
    expect(env.sealedAt()).toBeNull();
  });

  it("never fails the model request on a database error, and tries again on the next one", async () => {
    const env = await setup();
    log.warn.mockClear();
    const spy = vi.spyOn(env.store, "sealForModelRequest").mockRejectedValueOnce(new Error("db down"));
    expect(await env.model()).toBe(200);
    expect(env.upstream).toHaveBeenCalledTimes(1);
    expect(env.sealedAt()).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "dependency_cache.model_seal_failed", runId: "run-1" }),
      expect.any(String),
    );
    expect(await env.model()).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(env.sealedAt()).toBeInstanceOf(Date);
  });
});
