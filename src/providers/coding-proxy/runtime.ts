import type { PrismaClient } from "@prisma/client";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT } from "../jobs/docker-isolation.js";
import { EnvironmentCredentialResolver } from "./environment-credentials.js";
import { CodingProxy } from "./proxy.js";
import { PrismaProxyLedger } from "./prisma-ledger.js";
import { startCodingProxyServer, type CodingProxyServerHandle } from "./server.js";
import type { ProxyAuditSink } from "./types.js";

export interface CodingProxyRuntimeOptions {
  db: PrismaClient;
  env?: NodeJS.ProcessEnv;
  startServer?: typeof startCodingProxyServer;
  audit?: ProxyAuditSink;
  onRequest?: (event: {
    protocol: "openai-responses" | "anthropic-messages" | "other";
    status: number;
    durationMs: number;
  }) => void;
}

/** Starts the trusted proxy with the fixed worker-only Docker endpoint. */
export async function startConfiguredCodingProxy(options: CodingProxyRuntimeOptions): Promise<CodingProxyServerHandle> {
  const env = options.env ?? process.env;
  const proxy = new CodingProxy({
    ledger: new PrismaProxyLedger(options.db),
    credentials: new EnvironmentCredentialResolver(env),
    audit: options.audit,
  });
  const startServer = options.startServer ?? startCodingProxyServer;
  return startServer(proxy, {
    host: "0.0.0.0",
    port: CODING_PROXY_PORT,
    expectedHost: `${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
    onRequest: options.onRequest,
  });
}
