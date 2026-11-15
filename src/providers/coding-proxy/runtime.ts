import type { PrismaClient } from "#prisma";
import { createRemoteJWKSet } from "jose";
import { loadDependencyCacheConfig } from "../../config/dependency-cache.js";
import {
  createSimulatorModelFetch,
  createSimulatorRegistryFetch,
  startupTestSimulators,
} from "../../config/test-simulators.js";
import { logger } from "../../core/logger.js";
import { loadRunStepsLevel } from "../../core/run-steps/config.js";
import { REGISTRY_ADAPTERS } from "../../coding/registry/adapters.js";
import type { UpstreamFetch } from "../../coding/registry/types.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { loadBlobStoreConfig, substrateProxyPort } from "../../config/providers.js";
import { substrateRunToken } from "../jobs/substrate/names.js";
import { parseRunRepositories, parseRunServices, type SubstrateRunLayout } from "../jobs/substrate/run-store.js";
import { createBlobStore, type BlobStoreConfig } from "../storage/index.js";
import type { BlobStore } from "../storage/types.js";
import { startEviction } from "./dependency-cache/eviction.js";
import { PrismaDependencyCacheStore } from "./dependency-cache/prisma-store.js";
import { ModelRequestSeal } from "./dependency-cache/model-request-seal.js";
import { DependencyCacheService } from "./dependency-cache/service.js";
import { startDenyPortListener, type DenyPortListenerHandle } from "./deny-port.js";
import { EnvironmentCredentialResolver } from "./environment-credentials.js";
import { createMcpRoute } from "./mcp-route.js";
import { createMockUpstream, mockUpstreamFromEnv } from "./mock-upstream.js";
import { CodingProxy } from "./proxy.js";
import { PrismaProxyLedger } from "./prisma-ledger.js";
import { RunStepForwarder } from "./run-step-forwarder.js";
import { OsvAudit } from "./registry/audit.js";
import { PrismaRegistryStore } from "./registry/prisma-store.js";
import { DEFAULT_PLAN_MAX_ENTRIES, DEFAULT_PLAN_TIMEOUT_MS } from "./registry/plan.js";
import {
  DEFAULT_GRAPH_TIMEOUT_MS,
  DEFAULT_MAX_GRAPH_PACKAGES,
  DEFAULT_PLAN_MAX_PER_RUN,
  RegistryService,
} from "./registry/service.js";
import { createPinnedProxyFetch, PROXY_EGRESS_ERROR, type PinnedProxyFetchOptions } from "./secure-fetch.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";
import type { ProxyAuditSink } from "./types.js";
import { createActorIdentityVerifier } from "./substrate/actor-identity.js";
import { PrismaRelayStore } from "./substrate/prisma-relay-store.js";
import { createSubstrateRoutes, SUBSTRATE_UPLOAD_MS } from "./substrate/routes.js";

const MIB = 1024 * 1024;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Adapts the pinned upstream `fetch` (which only forwards `init.headers`)
 *  to `UpstreamFetch`'s narrower init shape: `accept` becomes an `accept`
 *  header, `acceptEncoding` an `accept-encoding` header (the pinned fetch
 *  never decompresses; the caller that asks for gzip does), and a `content-type: application/json` header is set whenever a
 *  body is present (every registry/OSV upstream call sends or expects
 *  JSON). Exported so its header-mapping can be unit-tested directly,
 *  without needing a live upstream. */
export function createRegistryUpstream(pinned: typeof globalThis.fetch): UpstreamFetch {
  return (url, init = {}) =>
    pinned(url, {
      method: init.method ?? "GET",
      body: init.body,
      signal: init.signal,
      redirect: "error",
      headers: {
        ...(init.accept ? { accept: init.accept } : {}),
        ...(init.acceptEncoding ? { "accept-encoding": init.acceptEncoding } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
}

/**
 * WARDBY_MCP_GATEWAY_URL: the native gateway's base URL, which the /mcp route forwards to (its
 * /coding-mcp route). Unset or empty: /mcp answers 503 mcp_unavailable. Anything but an http(s) URL
 * without credentials, query or fragment stops start-up (the value is not echoed).
 */
export function loadMcpGatewayUrl(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.WARDBY_MCP_GATEWAY_URL?.trim();
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("WARDBY_MCP_GATEWAY_URL must be an http(s) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * WARDBY_RUN_STEPS_URL: the control plane's run-steps listener (WARDBY_RUN_STEPS_LISTEN on the
 * server), which the proxy posts coding runs' steps to. Unset or empty: coding runs record no steps.
 * Anything but an http(s) origin without credentials, path, query or fragment stops start-up (the
 * value is not echoed, so a credential in it never reaches a log).
 */
export function loadRunStepsUrl(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.WARDBY_RUN_STEPS_URL?.trim();
  if (!value) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("WARDBY_RUN_STEPS_URL must be an http(s) URL without credentials, path, query or fragment");
  }
  return url.origin;
}

export interface SubstrateProxyConfig {
  atespace: string;
  /** Hostname actors use to reach this proxy (SUBSTRATE_PROXY_HOST). */
  proxyHost: string;
  /** Port actors use to reach it (SUBSTRATE_PROXY_PORT, default 8787), as the control plane reads it. */
  proxyPort: number;
  issuer: string;
  jwksUrl: URL;
  blobStore: BlobStoreConfig;
  limits: { resultBytes: number; transcriptBytes: number; workspaceBytes: number };
  /** SUBSTRATE_WARM_ROUNDS=true (experimental): per-round files, and run tokens read from SubstrateRun rows. */
  warmRounds?: true;
}

/**
 * The experimental Substrate job launcher's proxy routes (`/substrate/...`). Off unless SUBSTRATE_ATESPACE is
 * set; then SUBSTRATE_ACTOR_JWT_ISSUER and a blob store (BLOB_STORE) are required, and the error names the
 * missing variable (never a value). SUBSTRATE_ACTOR_JWKS_URL overrides the default `<issuer>/openid/v1/jwks`.
 * SUBSTRATE_{RESULT,TRANSCRIPT,WORKSPACE}_MAX_MB bound what a run may transfer. SUBSTRATE_PROXY_PORT
 * (default 8787) is the port actors connect to, which the Host guard accepts.
 */
/**
 * The Host values actor requests carry: `<SUBSTRATE_PROXY_HOST>:<SUBSTRATE_PROXY_PORT>`, and the bare
 * host on port 80, which HTTP clients leave out of the Host header.
 */
/**
 * A run's layout by its token, from its SubstrateRun row (wardby_proxy has SELECT on it): `single`
 * only when the row says so, any other value `pair` (today's behaviour); repositories only when
 * parseRunRepositories accepts them (an unreadable value means none); services only when
 * parseRunServices accepts them (an unreadable value means none: the services route answers 404).
 * Undefined when there is no row (the routes treat it as a pair with no repositories or services
 * without remembering it).
 */
export function substrateRunLayoutLookup(
  db: Pick<PrismaClient, "substrateRun">,
): (token: string) => Promise<SubstrateRunLayout | undefined> {
  return async (token) => {
    const row = await db.substrateRun.findUnique({
      where: { token },
      select: { actorShape: true, repositories: true, services: true },
    });
    if (!row) return undefined;
    const repositories = parseRunRepositories(row.repositories);
    const services = parseRunServices(row.services);
    return {
      shape: row.actorShape === "single" ? "single" : "pair",
      ...(repositories ? { repositories } : {}),
      ...(services ? { services } : {}),
    };
  };
}

export function substrateExpectedHosts(config: Pick<SubstrateProxyConfig, "proxyHost" | "proxyPort">): string[] {
  const withPort = `${config.proxyHost}:${config.proxyPort}`;
  return config.proxyPort === 80 ? [withPort, config.proxyHost] : [withPort];
}

export function loadSubstrateProxyConfig(env: NodeJS.ProcessEnv): SubstrateProxyConfig | undefined {
  const atespace = env.SUBSTRATE_ATESPACE?.trim();
  if (!atespace) return undefined;
  const issuer = env.SUBSTRATE_ACTOR_JWT_ISSUER?.trim().replace(/\/+$/, "");
  if (!issuer) throw new Error("SUBSTRATE_ACTOR_JWT_ISSUER is required when SUBSTRATE_ATESPACE is set");
  let jwksUrl: URL;
  try {
    jwksUrl = new URL(env.SUBSTRATE_ACTOR_JWKS_URL?.trim() || `${issuer}/openid/v1/jwks`);
  } catch {
    throw new Error("SUBSTRATE_ACTOR_JWT_ISSUER or SUBSTRATE_ACTOR_JWKS_URL is not a valid URL");
  }
  const blobStore = loadBlobStoreConfig(env);
  if (!blobStore) throw new Error("BLOB_STORE is required when SUBSTRATE_ATESPACE is set");
  const proxyHost = env.SUBSTRATE_PROXY_HOST?.trim() ?? "";
  if (!proxyHost) throw new Error("SUBSTRATE_PROXY_HOST is required when SUBSTRATE_ATESPACE is set");
  if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(proxyHost))
    throw new Error("SUBSTRATE_PROXY_HOST must be a bare hostname (no scheme, port, or path)");
  const proxyPort = substrateProxyPort(env);
  const warm = env.SUBSTRATE_WARM_ROUNDS?.trim().toLowerCase();
  if (warm !== undefined && warm !== "" && warm !== "true" && warm !== "false")
    throw new Error("SUBSTRATE_WARM_ROUNDS must be true or false");
  return {
    atespace,
    proxyHost,
    proxyPort,
    issuer,
    jwksUrl,
    blobStore,
    ...(warm === "true" ? { warmRounds: true as const } : {}),
    limits: {
      resultBytes: positiveInt(env.SUBSTRATE_RESULT_MAX_MB, 16) * MIB,
      transcriptBytes: positiveInt(env.SUBSTRATE_TRANSCRIPT_MAX_MB, 64) * MIB,
      workspaceBytes: positiveInt(env.SUBSTRATE_WORKSPACE_MAX_MB, 1024) * MIB,
    },
  };
}

export interface CodingProxyRuntimeOptions {
  db: PrismaClient;
  /** The package registry's own client, so its traffic (many concurrent
   *  downloads during an install) cannot starve the budget ledger that every
   *  model request needs. Defaults to `db`. */
  registryDb?: PrismaClient;
  env?: NodeJS.ProcessEnv;
  startServer?: typeof startCodingProxyServer;
  startDenyPort?: typeof startDenyPortListener;
  /** Overridable for tests: proves the OSV host and every adapter's
   *  upstream hosts are actually passed to the pinned-fetch allowlist. */
  createPinnedFetch?: (options: PinnedProxyFetchOptions) => typeof globalThis.fetch;
  audit?: ProxyAuditSink;
  /** Overridable for tests: builds the dependency cache's blob store. */
  createBlobStore?: (config: BlobStoreConfig) => BlobStore;
  onRequest?: (event: {
    protocol: "openai-responses" | "anthropic-messages" | "other";
    status: number;
    durationMs: number;
  }) => void;
}

/** Starts the trusted proxy with the fixed worker-only Docker endpoint, plus the deny port the enforcement witness probes. */
export async function startConfiguredCodingProxy(options: CodingProxyRuntimeOptions): Promise<CodingProxyServerHandle> {
  const env = options.env ?? process.env;
  // Throws on an invalid setting, before anything listens.
  const cacheConfig = loadDependencyCacheConfig(env);
  // Throws (mock_upstream_guard) on a partial or malformed setting, before anything listens.
  const mock = mockUpstreamFromEnv(env);
  if (mock) {
    logger.warn(
      { module: "coding-proxy-runtime", event: "proxy.mock_upstream_enabled" },
      "coding proxy: MOCK MODEL UPSTREAM ENABLED (load test). No request reaches a model provider; never use this on a real deployment.",
    );
  }
  const audit: ProxyAuditSink | undefined = mock
    ? (event) => options.audit?.({ ...event, mockUpstream: true })
    : options.audit;
  // Throws when SUBSTRATE_ATESPACE is set without what it needs, before anything listens.
  const substrateConfig = loadSubstrateProxyConfig(env);
  // Throws on an invalid setting, before anything listens.
  const mcpGatewayUrl = loadMcpGatewayUrl(env);
  // Throws on an invalid setting, before anything listens.
  const runStepsUrl = loadRunStepsUrl(env);
  // Throws on an invalid WARDBY_RUN_STEPS. At off no step text leaves the proxy.
  const runStepsCeiling = loadRunStepsLevel(env);
  // Throws (test_simulators_refused) on any refusal, before anything listens.
  const simulators = startupTestSimulators("coding-proxy", env);
  const buildPinnedFetch = options.createPinnedFetch ?? createPinnedProxyFetch;
  const upstreamHosts = [...new Set([...REGISTRY_ADAPTERS.values()].flatMap((adapter) => adapter.upstreamHosts))];
  // WARDBY_TEST_SIMULATORS (test only): the registry hosts go to their simulators, and every
  // other host is still refused.
  const pinned = simulators
    ? createSimulatorRegistryFetch(simulators, () => new Error(PROXY_EGRESS_ERROR))
    : buildPinnedFetch({ allowedHosts: [...upstreamHosts, "api.osv.dev"] });
  const upstream = createRegistryUpstream(pinned);
  const metadataTimeoutMs = positiveInt(env.REGISTRY_METADATA_TIMEOUT_MS, 30_000);
  const maxMetadataBytes = positiveInt(env.REGISTRY_MAX_METADATA_MB, 64) * MIB;
  const registryStore = new PrismaRegistryStore(options.registryDb ?? options.db);
  const registry = new RegistryService({
    adapters: REGISTRY_ADAPTERS,
    store: registryStore,
    audit: new OsvAudit({
      fetch: upstream,
      failOpen: env.REGISTRY_AUDIT_FAIL_OPEN === "true",
      timeoutMs: metadataTimeoutMs,
      maxBytes: maxMetadataBytes,
    }),
    upstream,
    metadataTimeoutMs,
    maxMetadataBytes,
    maxGraphPackages: positiveInt(env.REGISTRY_MAX_GRAPH_PACKAGES, DEFAULT_MAX_GRAPH_PACKAGES),
    graphTimeoutMs: positiveInt(env.REGISTRY_GRAPH_TIMEOUT_MS, DEFAULT_GRAPH_TIMEOUT_MS),
    planMaxEntries: positiveInt(env.REGISTRY_PLAN_MAX_ENTRIES, DEFAULT_PLAN_MAX_ENTRIES),
    planTimeoutMs: positiveInt(env.REGISTRY_PLAN_TIMEOUT_MS, DEFAULT_PLAN_TIMEOUT_MS),
    planMaxPerRun: positiveInt(env.REGISTRY_PLAN_MAX_PER_RUN, DEFAULT_PLAN_MAX_PER_RUN),
    proxyBase: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}/registry/`,
    limits: {
      maxFileBytes: positiveInt(env.REGISTRY_MAX_FILE_MB, 200) * MIB,
      maxTotalBytes: positiveInt(env.REGISTRY_MAX_TOTAL_MB, 2048) * MIB,
      maxFiles: positiveInt(env.REGISTRY_MAX_FILES, 5000),
      idleTimeoutMs: positiveInt(env.REGISTRY_IDLE_TIMEOUT_MS, 120_000),
    },
  });

  let cacheBlobs: BlobStore | undefined;
  let dependencyCache: DependencyCacheService | undefined;
  let modelRequestSeal: ModelRequestSeal | undefined;
  let eviction: { stop(): void } | undefined;
  if (cacheConfig.enabled) {
    const blobs = (options.createBlobStore ?? createBlobStore)(cacheConfig.blobStore);
    cacheBlobs = blobs;
    const cacheStore = new PrismaDependencyCacheStore(options.registryDb ?? options.db);
    modelRequestSeal = new ModelRequestSeal(cacheStore);
    dependencyCache = new DependencyCacheService({
      registry: registryStore,
      store: cacheStore,
      blobs,
      maxSnapshotBytes: cacheConfig.maxSnapshotBytes,
      uploadMs: cacheConfig.uploadMs,
    });
    eviction = startEviction({
      store: cacheStore,
      blobs,
      limits: {
        maxAgeMs: cacheConfig.maxAgeMs,
        repoCapBytes: cacheConfig.repoCapBytes,
        totalCapBytes: cacheConfig.totalCapBytes,
      },
    });
  } else if (cacheConfig.reason === "no_blob_store") {
    logger.warn(
      { module: "coding-proxy-runtime", event: "proxy.dependency_cache_no_blob_store" },
      "coding proxy: WARDBY_DEPENDENCY_CACHE=true but no BLOB_STORE is configured; the dependency cache is off",
    );
  }

  const seal = modelRequestSeal;
  // Coding runs' steps go to the control plane only when WARDBY_RUN_STEPS_URL is set and
  // WARDBY_RUN_STEPS is not off; otherwise no
  // submitter is passed and the proxy does no step extraction.
  const steps = runStepsUrl && runStepsCeiling !== "off" ? new RunStepForwarder({ url: runStepsUrl }) : undefined;
  const ledger = new PrismaProxyLedger(options.db);
  const substrate = substrateConfig
    ? createSubstrateRoutes({
        atespace: substrateConfig.atespace,
        relay: new PrismaRelayStore(options.db, { maxBufferedBytesPerRun: 8 * MIB }),
        // The dependency cache's store when it is on, else one of the route's own.
        blobs: cacheBlobs ?? (options.createBlobStore ?? createBlobStore)(substrateConfig.blobStore),
        ledger,
        verifyActor: createActorIdentityVerifier({
          issuer: substrateConfig.issuer,
          jwks: createRemoteJWKSet(substrateConfig.jwksUrl),
        }),
        // Warm rounds: an adopting run holds the parked run's token, so it is read from the run's row.
        tokenForRun: substrateConfig.warmRounds
          ? async (runId: string) =>
              (await options.db.substrateRun.findUnique({ where: { runId }, select: { token: true } }))?.token ??
              substrateRunToken(runId)
          : substrateRunToken,
        runLayoutForToken: substrateRunLayoutLookup(options.db),
        ...(substrateConfig.warmRounds ? { warmRounds: true } : {}),
        limits: substrateConfig.limits,
      })
    : undefined;
  const proxy = new CodingProxy({
    ledger,
    credentials: new EnvironmentCredentialResolver(env),
    audit,
    // WARDBY_TEST_SIMULATORS (test only; refused alongside the mock upstream): the scripted model,
    // with every credential header dropped.
    ...(simulators
      ? { fetch: createSimulatorModelFetch(simulators, () => new Error(PROXY_EGRESS_ERROR)) }
      : mock
        ? { fetch: createMockUpstream(mock) }
        : {}),
    // The run's first model request closes its dependency cache (no-op for a run with it off).
    ...(seal ? { onModelRequest: (runId: string) => seal.onModelRequest(runId) } : {}),
    ...(steps ? { steps } : {}),
    runStepsCeiling,
  });
  const startServer = options.startServer ?? startCodingProxyServer;
  let server: CodingProxyServerHandle;
  try {
    server = await startServer(proxy, {
      host: "0.0.0.0",
      port: CODING_PROXY_PORT,
      expectedHosts: [
        `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
        ...(substrateConfig ? substrateExpectedHosts(substrateConfig) : []),
      ],
      registry,
      ...(dependencyCache ? { dependencyCache } : {}),
      mcp: createMcpRoute({ ledger, gatewayUrl: mcpGatewayUrl }),
      ...(substrate ? { substrate, substrateUploadMs: SUBSTRATE_UPLOAD_MS } : {}),
      onRequest: options.onRequest,
    });
  } catch (error) {
    eviction?.stop();
    await steps?.close();
    throw error;
  }
  let deny: DenyPortListenerHandle;
  try {
    deny = await (options.startDenyPort ?? startDenyPortListener)("0.0.0.0", CODING_PROXY_DENY_PORT);
  } catch (error) {
    // A proxy without its witness must not stay up: the launcher's gate would never be able to
    // prove a policy is enforced, and every launch would fail at the gate instead of at startup.
    eviction?.stop();
    try {
      await server.close();
    } finally {
      await steps?.close();
    }
    throw error;
  }
  return {
    port: server.port,
    close: async () => {
      eviction?.stop();
      try {
        await deny.close();
        await server.close();
      } finally {
        // Last: requests are done, so this is the final chance to hand over queued steps (bounded).
        await steps?.close();
      }
    },
  };
}
