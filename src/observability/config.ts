import type { MetricsServerConfig } from "./metrics-server.js";

export interface MetricsConfig {
  bind?: MetricsServerConfig;
}

function parseBind(value: string, allowNonLoopback: boolean): MetricsServerConfig {
  const match = /^(127\.0\.0\.1|::1|0\.0\.0\.0):([0-9]{1,5})$/.exec(value);
  if (!match) {
    throw new Error("METRICS_BIND must be 127.0.0.1:port, ::1:port, or 0.0.0.0:port");
  }
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("METRICS_BIND port must be between 1 and 65535");
  }
  if (match[1] === "0.0.0.0" && !allowNonLoopback) {
    throw new Error("METRICS_BIND may use 0.0.0.0 only when METRICS_ALLOW_NON_LOOPBACK=true");
  }
  return { host: match[1], port };
}

/** Metrics remain off unless an operator explicitly configures a bind address. */
export function loadMetricsConfig(env: NodeJS.ProcessEnv = process.env): MetricsConfig {
  if (!env.METRICS_BIND) return {};
  return { bind: parseBind(env.METRICS_BIND, env.METRICS_ALLOW_NON_LOOPBACK === "true") };
}
