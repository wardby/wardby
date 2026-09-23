import type { PrismaClient } from "@prisma/client";
import { CODING_PROXY_ALIAS, CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { startDenyPortListener } from "./deny-port.js";
import { EnvironmentCredentialResolver } from "./environment-credentials.js";
import { CodingProxy } from "./proxy.js";
import { PrismaProxyLedger } from "./prisma-ledger.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";
import type { ProxyAuditSink } from "./types.js";

export interface CodingProxyRuntimeOptions {
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
  startServer?: typeof startCodingProxyServer;
  startDenyPort?: typeof startDenyPortListener;
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
  const startServer = options.startServer ?? startCodingProxyServer;
  const server = await startServer(proxy, {
    host: "0.0.0.0",
    port: CODING_PROXY_PORT,
    expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    onRequest: options.onRequest,
  });
  let deny;
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
