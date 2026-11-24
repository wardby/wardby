/**
 * The coding proxy's CONNECT tunnel (off unless CODING_TUNNEL_PORT is set): the port it listens on,
 * the hostnames a run may tunnel to, and the limits on each run's tunnels.
 *
 * CODING_TUNNEL_PORT, CODING_TUNNEL_ALLOWED_HOSTS (comma-separated bare hostnames),
 * CODING_TUNNEL_MAX_CONNECTIONS (open tunnels per run), CODING_TUNNEL_MAX_BYTES (bytes per run, both
 * directions), CODING_TUNNEL_IDLE_MS and CODING_TUNNEL_MAX_DURATION_MS (per tunnel).
 *
 * TLS interception (off unless set, all three together): CODING_TUNNEL_INTERCEPT_RULES, a JSON array of
 * `{host, scheme, credential[, username | usernameCredential]}` for the allowed hosts whose traffic the proxy decrypts to attach a
 * credential, and CODING_TUNNEL_INTERCEPT_CA_CERT_FILE / _KEY_FILE, the files of the CA that signs for them.
 * This loader only checks their shape: it runs in the control plane too, which holds neither the files nor
 * the credentials. The proxy resolves them at start-up.
 *
 * CODING_TUNNEL_TRUST_CA_CERT_FILE (optional): the absolute path of a CA certificate (public, never the key)
 * the control plane hands to each run so its tools trust the proxy's interception. It is read where runs are
 * launched, not here: this loader only checks the path, since it runs in the proxy too.
 *
 * An error names the setting, never its value.
 */
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { normalizeHost } from "../sandbox/fetch-policy.js";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../providers/jobs/docker-isolation.js";

/**
 * How the credential for an intercepted host goes into its `Authorization` header: `bearer` or `basic` with a
 * credential from the proxy's environment, or `gcp`, an access token for the proxy's own Google service
 * account (Workload Identity), fetched from the metadata server and refreshed as it expires.
 */
export interface CodingTunnelInterceptRule {
  host: string;
  scheme: "bearer" | "basic" | "gcp";
  /** Basic only: the user name, written out; the credential is the password. */
  username?: string;
  /** Basic only, instead of `username`: an `env:NAME` reference to the user name, resolved at start-up. */
  usernameCredential?: string;
  /** Bearer and basic: an `env:NAME` reference, resolved from the proxy's environment at start-up. Never with gcp. */
  credential?: string;
}

export interface CodingTunnelInterceptConfig {
  rules: CodingTunnelInterceptRule[];
  /** The CA certificate and key each come from exactly one of a file path or the PEM text itself. */
  caCertFile?: string;
  caCertPem?: string;
  caKeyFile?: string;
  caKeyPem?: string;
}

export interface CodingTunnelConfig {
  port: number;
  allowedHosts: string[];
  maxConnections: number;
  maxBytes: number;
  idleMs: number;
  maxDurationMs: number;
  /** Absent: every tunnel is blind. */
  intercept?: CodingTunnelInterceptConfig;
  /** Absent (with `trustCaCertPem`): runs are given no CA to trust. Only the launching control plane reads it. */
  trustCaCertFile?: string;
  /** The same certificate as PEM text, instead of a file. At most one of the two is set. */
  trustCaCertPem?: string;
}

const MIB = 1024 * 1024;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function loadPort(raw: string): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error("CODING_TUNNEL_PORT must be a port number from 1 to 65535.");
  if (value === CODING_PROXY_PORT || value === CODING_PROXY_DENY_PORT)
    throw new Error("CODING_TUNNEL_PORT must differ from the proxy's own ports.");
  return value;
}

function loadAllowedHosts(env: NodeJS.ProcessEnv): string[] {
  const entries = (env.CODING_TUNNEL_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new Error("CODING_TUNNEL_ALLOWED_HOSTS must list at least one host.");
  const hosts = new Set<string>();
  for (const entry of entries) {
    let host: string | undefined;
    try {
      host = normalizeHost(entry);
    } catch {
      host = undefined;
    }
    if (host === undefined || isIP(host) !== 0)
      throw new Error("CODING_TUNNEL_ALLOWED_HOSTS must list bare hostnames only.");
    hosts.add(host);
  }
  return [...hosts];
}

/** A Basic user name: printable characters, no colon (the colon separates it from the password). */
const USERNAME = /^[\x21-\x39\x3b-\x7e]{1,128}$/;
const RULES = "CODING_TUNNEL_INTERCEPT_RULES";
const RULE_KEYS = new Set(["host", "scheme", "credential", "username", "usernameCredential"]);
const ENV_REFERENCE = /^env:[A-Z][A-Z0-9_]{0,127}$/;

function loadInterceptRules(raw: string, allowedHosts: readonly string[]): CodingTunnelInterceptRule[] {
  const shape = `${RULES} must be a JSON array of {host, scheme, credential} objects (basic also takes username or usernameCredential; gcp takes no credential).`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(shape);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(shape);
  const seen = new Set<string>();
  return parsed.map((entry: unknown): CodingTunnelInterceptRule => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(shape);
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !RULE_KEYS.has(key))) throw new Error(shape);
    const { host: rawHost, scheme, credential, username, usernameCredential } = fields;
    if (typeof rawHost !== "string") throw new Error(shape);
    let host: string | undefined;
    try {
      host = normalizeHost(rawHost);
    } catch {
      host = undefined;
    }
    if (host === undefined || isIP(host) !== 0) throw new Error(`${RULES} must name bare hostnames only.`);
    if (!allowedHosts.includes(host))
      throw new Error(`${RULES} must name only hosts listed in CODING_TUNNEL_ALLOWED_HOSTS.`);
    if (seen.has(host)) throw new Error(`${RULES} must name each host once.`);
    seen.add(host);
    if (scheme !== "bearer" && scheme !== "basic" && scheme !== "gcp")
      throw new Error(`${RULES} scheme must be "bearer", "basic" or "gcp".`);
    if (scheme === "gcp") {
      if (credential !== undefined || username !== undefined || usernameCredential !== undefined)
        throw new Error(`${RULES} gcp uses the proxy's own service account and takes no credential or username.`);
      return { host, scheme };
    }
    if (typeof credential !== "string" || !ENV_REFERENCE.test(credential))
      throw new Error(`${RULES} credential must be an env:NAME reference.`);
    if (scheme === "bearer") {
      if (username !== undefined || usernameCredential !== undefined)
        throw new Error(`${RULES} username applies to the basic scheme only.`);
      return { host, scheme, credential };
    }
    if ((username === undefined) === (usernameCredential === undefined))
      throw new Error(`${RULES} basic needs exactly one of username and usernameCredential.`);
    if (usernameCredential !== undefined) {
      if (typeof usernameCredential !== "string" || !ENV_REFERENCE.test(usernameCredential))
        throw new Error(`${RULES} usernameCredential must be an env:NAME reference.`);
      return { host, scheme, usernameCredential, credential };
    }
    if (typeof username !== "string" || !USERNAME.test(username))
      throw new Error(`${RULES} basic needs a username of printable characters without a colon.`);
    return { host, scheme, username, credential };
  });
}

function loadFile(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute file path.`);
  return value;
}

const CA_CERT = "CODING_TUNNEL_INTERCEPT_CA_CERT";
const CA_KEY = "CODING_TUNNEL_INTERCEPT_CA_KEY";

/** Whether `name` (PEM text) or `name_FILE` (a path) is set; both is an error. Never echoes a value. */
function pemSetting(env: NodeJS.ProcessEnv, name: string): "pem" | "file" | undefined {
  const pem = Boolean(env[name]?.trim());
  const file = Boolean(env[`${name}_FILE`]?.trim());
  if (pem && file) throw new Error(`${name} and ${name}_FILE are mutually exclusive.`);
  return pem ? "pem" : file ? "file" : undefined;
}

function loadIntercept(
  env: NodeJS.ProcessEnv,
  allowedHosts: readonly string[],
): CodingTunnelInterceptConfig | undefined {
  const cert = pemSetting(env, CA_CERT);
  const key = pemSetting(env, CA_KEY);
  const rules = Boolean(env[RULES]?.trim());
  if (!rules && !cert && !key) return undefined;
  if (!rules || !cert || !key)
    throw new Error(
      `${RULES}, the CA certificate (${CA_CERT} or ${CA_CERT}_FILE) and the CA key (${CA_KEY} or ${CA_KEY}_FILE) must be set together.`,
    );
  return {
    rules: loadInterceptRules(env[RULES]!.trim(), allowedHosts),
    ...(cert === "pem" ? { caCertPem: env[CA_CERT]! } : { caCertFile: loadFile(env, `${CA_CERT}_FILE`) }),
    ...(key === "pem" ? { caKeyPem: env[CA_KEY]! } : { caKeyFile: loadFile(env, `${CA_KEY}_FILE`) }),
  };
}

/** The tunnel's settings, or undefined when it is off. Throws on an invalid combination, before anything listens. */
export function loadCodingTunnelConfig(env: NodeJS.ProcessEnv = process.env): CodingTunnelConfig | undefined {
  const rawPort = env.CODING_TUNNEL_PORT?.trim();
  if (!rawPort) {
    const otherSet = Object.keys(env).some(
      (name) => name.startsWith("CODING_TUNNEL_") && name !== "CODING_TUNNEL_PORT" && env[name]?.trim(),
    );
    if (otherSet) throw new Error("CODING_TUNNEL_PORT is required when another CODING_TUNNEL_* setting is set.");
    return undefined;
  }
  const port = loadPort(rawPort);
  const allowedHosts = loadAllowedHosts(env);
  const idleMs = positiveInteger(env, "CODING_TUNNEL_IDLE_MS", 120_000);
  const maxDurationMs = positiveInteger(env, "CODING_TUNNEL_MAX_DURATION_MS", 1_800_000);
  if (idleMs > maxDurationMs) throw new Error("CODING_TUNNEL_IDLE_MS must not exceed CODING_TUNNEL_MAX_DURATION_MS.");
  const intercept = loadIntercept(env, allowedHosts);
  const trust = pemSetting(env, "CODING_TUNNEL_TRUST_CA_CERT");
  const trustCaCertFile = trust === "file" ? loadFile(env, "CODING_TUNNEL_TRUST_CA_CERT_FILE") : undefined;
  const trustCaCertPem = trust === "pem" ? env.CODING_TUNNEL_TRUST_CA_CERT! : undefined;
  return {
    port,
    allowedHosts,
    maxConnections: positiveInteger(env, "CODING_TUNNEL_MAX_CONNECTIONS", 16),
    maxBytes: positiveInteger(env, "CODING_TUNNEL_MAX_BYTES", 4096 * MIB),
    idleMs,
    maxDurationMs,
    ...(intercept ? { intercept } : {}),
    ...(trustCaCertFile ? { trustCaCertFile } : {}),
    ...(trustCaCertPem ? { trustCaCertPem } : {}),
  };
}
