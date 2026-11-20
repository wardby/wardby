/**
 * Request leases in the coding proxy: how long a reserved request stays leased to the process
 * relaying it, how often that process renews its leases, and how often every process looks for
 * requests whose lease ran out (their process died).
 *
 * leaseMs is CODING_PROXY_LEASE_SECONDS, heartbeatMs CODING_PROXY_HEARTBEAT_SECONDS and sweepMs
 * CODING_PROXY_SWEEP_SECONDS.
 */
import { assertLeaseConfig, type LeaseConfig } from "../core/request-lease.js";

export type CodingProxyLeaseConfig = LeaseConfig;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function loadCodingProxyLeaseConfig(env: NodeJS.ProcessEnv = process.env): CodingProxyLeaseConfig {
  const leaseSeconds = positiveInteger(env, "CODING_PROXY_LEASE_SECONDS", 30);
  const heartbeatSeconds = positiveInteger(env, "CODING_PROXY_HEARTBEAT_SECONDS", 10);
  const sweepSeconds = positiveInteger(env, "CODING_PROXY_SWEEP_SECONDS", 15);
  const config = { leaseMs: leaseSeconds * 1000, heartbeatMs: heartbeatSeconds * 1000, sweepMs: sweepSeconds * 1000 };
  assertLeaseConfig(config, { lease: "CODING_PROXY_LEASE_SECONDS", heartbeat: "CODING_PROXY_HEARTBEAT_SECONDS" });
  return config;
}
