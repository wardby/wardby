import type { PrismaClient } from "#prisma";
import { REGISTRY_ADAPTERS } from "../../coding/registry/adapters.js";
import type { UpstreamFetch } from "../../coding/registry/types.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { startDenyPortListener, type DenyPortListenerHandle } from "./deny-port.js";
import { EnvironmentCredentialResolver } from "./environment-credentials.js";
import { CodingProxy } from "./proxy.js";
import { PrismaProxyLedger } from "./prisma-ledger.js";
import { OsvAudit } from "./registry/audit.js";
import { PrismaRegistryStore } from "./registry/prisma-store.js";
import { DEFAULT_PLAN_MAX_ENTRIES, DEFAULT_PLAN_TIMEOUT_MS } from "./registry/plan.js";
import {
  DEFAULT_GRAPH_TIMEOUT_MS,
  DEFAULT_MAX_GRAPH_PACKAGES,
  DEFAULT_PLAN_MAX_PER_RUN,
  RegistryService,
} from "./registry/service.js";
import { createPinnedProxyFetch, type PinnedProxyFetchOptions } from "./secure-fetch.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";
import type { ProxyAuditSink } from "./types.js";

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
  onRequest?: (event: {
    protocol: "openai-responses" | "anthropic-messages" | "other";
    status: number;
    durationMs: number;
  }) => void;
}

/** Starts the trusted proxy with the fixed worker-only Docker endpoint, plus the deny port the enforcement witness probes. */
export async function startConfiguredCodingProxy(options: CodingProxyRuntimeOptions): Promise<CodingProxyServerHandle> {
  const env = options.env ?? process.env;
  const proxy = new CodingProxy({
    ledger: new PrismaProxyLedger(options.db),
    credentials: new EnvironmentCredentialResolver(env),
    audit: options.audit,
  });
  const buildPinnedFetch = options.createPinnedFetch ?? createPinnedProxyFetch;
  const upstreamHosts = [...new Set([...REGISTRY_ADAPTERS.values()].flatMap((adapter) => adapter.upstreamHosts))];
  const pinned = buildPinnedFetch({ allowedHosts: [...upstreamHosts, "api.osv.dev"] });
  const upstream = createRegistryUpstream(pinned);
  const metadataTimeoutMs = positiveInt(env.REGISTRY_METADATA_TIMEOUT_MS, 30_000);
  const maxMetadataBytes = positiveInt(env.REGISTRY_MAX_METADATA_MB, 64) * MIB;
  const registry = new RegistryService({
    adapters: REGISTRY_ADAPTERS,
    store: new PrismaRegistryStore(options.registryDb ?? options.db),
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

  const startServer = options.startServer ?? startCodingProxyServer;
  const server = await startServer(proxy, {
    host: "0.0.0.0",
    port: CODING_PROXY_PORT,
    expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    registry,
    onRequest: options.onRequest,
  });
  let deny: DenyPortListenerHandle;
  try {
    deny = await (options.startDenyPort ?? startDenyPortListener)("0.0.0.0", CODING_PROXY_DENY_PORT);
  } catch (error) {
    // A proxy without its witness must not stay up: the launcher's gate would never be able to
    // prove a policy is enforced, and every launch would fail at the gate instead of at startup.
    await server.close();
    throw error;
  }
  return {
    port: server.port,
    close: async () => {
      await deny.close();
      await server.close();
    },
  };
}
