/**
 * Per-agent tunnel hosts (codingProfile.tunnelHosts): the hosts an agent's coding runs may reach through
 * the coding proxy's CONNECT tunnel, on top of the server list (CODING_TUNNEL_ALLOWED_HOSTS).
 *
 * A pattern is one of:
 * - `api.example.com`: that exact host;
 * - `*.example.com`: any subdomain of example.com, at any depth, but not example.com itself;
 * - `*`: any public host.
 *
 * Patterns are matched on the CONNECT target's hostname, after the same normalisation the listener
 * applies (normalizeHost: lower case, trailing dots dropped, IDNs as punycode). Matching never widens
 * what a destination may resolve to: the listener's fetch policy still refuses private, link-local and
 * metadata addresses, whatever the pattern.
 *
 * The operator's ceiling (CODING_TUNNEL_AGENT_HOSTS) decides which kinds an agent may hold: `off` (none,
 * the default), `exact`, `pattern` (also `*.domain`) or `any` (also `*`).
 */
import { isIP } from "node:net";
import { getPublicSuffix } from "tldts";
import { normalizeHost } from "../sandbox/fetch-policy.js";

/** The code every save-time refusal of codingProfile.tunnelHosts carries. */
export const TUNNEL_HOSTS_INVALID = "tunnel_hosts_invalid";

export const MAX_TUNNEL_HOSTS = 50;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** The operator's ceiling, lowest first. */
export const TUNNEL_AGENT_HOST_LEVELS = ["off", "exact", "pattern", "any"] as const;
export type TunnelAgentHostLevel = (typeof TUNNEL_AGENT_HOST_LEVELS)[number];

export type TunnelHostKind = "exact" | "suffix" | "any";

/** The lowest ceiling that allows a pattern of this kind. */
const LEVEL_FOR_KIND: Record<TunnelHostKind, TunnelAgentHostLevel> = { exact: "exact", suffix: "pattern", any: "any" };

export const ANY_TUNNEL_HOST = "*";

export type TunnelHostParse =
  { ok: true; pattern: string; kind: TunnelHostKind } | { ok: false; reason: TunnelHostRefusalReason };

export type TunnelHostRefusalReason =
  "empty" | "scheme_port_or_path" | "wildcard_inside_label" | "ip_address" | "not_a_hostname" | "public_suffix";

const REASON_TEXT: Record<TunnelHostRefusalReason, string> = {
  empty: "is empty",
  scheme_port_or_path: "has a scheme, port, path, user or query (give a bare hostname)",
  wildcard_inside_label: 'has * other than a whole leading label ("*.example.com") or alone ("*")',
  ip_address: "is an IP address (give a hostname)",
  not_a_hostname: "is not a valid hostname",
  public_suffix: "is a top-level domain or public suffix (for example com or co.uk), which would cover unrelated sites",
};

/** A refusal's sentence, for an error message. Never contains the refused text. */
export function tunnelHostRefusalText(reason: TunnelHostRefusalReason): string {
  return REASON_TEXT[reason];
}

/**
 * Parses and normalises one pattern. Refuses IP addresses, ports, schemes, paths, `*` anywhere but a
 * whole leading label or alone, single-label names, and public suffixes: a `*.` pattern on any suffix
 * of the public suffix list (its private section included, so `*.github.io` is refused too), and an
 * exact host that is a top-level domain or an ICANN public suffix (`com`, `co.uk`).
 */
export function parseTunnelHostPattern(raw: string): TunnelHostParse {
  const value = raw.trim().toLowerCase();
  if (value === "") return { ok: false, reason: "empty" };
  if (value === ANY_TUNNEL_HOST) return { ok: true, pattern: ANY_TUNNEL_HOST, kind: "any" };
  if (value.length > MAX_HOST_LENGTH + 2) return { ok: false, reason: "not_a_hostname" };
  if (/[\s:/@?#\\[\]%]/.test(value)) return { ok: false, reason: "scheme_port_or_path" };
  const suffix = value.startsWith("*.");
  const name = suffix ? value.slice(2) : value;
  if (name.includes("*")) return { ok: false, reason: "wildcard_inside_label" };
  let host: string;
  try {
    host = normalizeHost(name);
  } catch {
    return { ok: false, reason: "not_a_hostname" };
  }
  if (isIP(host) !== 0) return { ok: false, reason: "ip_address" };
  const labels = host.split(".");
  if (host.length > MAX_HOST_LENGTH || labels.some((label) => !MAX_LABEL.test(label))) {
    return { ok: false, reason: "not_a_hostname" };
  }
  if (labels.length < 2) return { ok: false, reason: "public_suffix" };
  const publicSuffix = getPublicSuffix(host, { allowPrivateDomains: suffix, extractHostname: false });
  if (publicSuffix === host) return { ok: false, reason: "public_suffix" };
  return suffix ? { ok: true, pattern: `*.${host}`, kind: "suffix" } : { ok: true, pattern: host, kind: "exact" };
}

/** The kind of an already-normalised pattern (as stored). */
export function tunnelHostKind(pattern: string): TunnelHostKind {
  if (pattern === ANY_TUNNEL_HOST) return "any";
  return pattern.startsWith("*.") ? "suffix" : "exact";
}

function levelRank(level: TunnelAgentHostLevel): number {
  return TUNNEL_AGENT_HOST_LEVELS.indexOf(level);
}

/** Whether the ceiling allows a pattern of this kind. */
export function ceilingAllows(level: TunnelAgentHostLevel, kind: TunnelHostKind): boolean {
  return level !== "off" && levelRank(level) >= levelRank(LEVEL_FOR_KIND[kind]);
}

/** The patterns the ceiling allows, in their order; every other one is left out. */
export function tunnelHostsWithinCeiling(patterns: readonly string[], level: TunnelAgentHostLevel): string[] {
  return patterns.filter((pattern) => ceilingAllows(level, tunnelHostKind(pattern)));
}

/**
 * The pattern that allows `host` (a hostname already normalised with normalizeHost, never an IP
 * literal), or undefined. Exact patterns match the whole name; `*.example.com` matches a name ending
 * in `.example.com` (on a label boundary, so `evilexample.com` does not match, and neither does
 * `example.com` itself); `*` matches every name.
 */
export function matchTunnelHost(host: string, patterns: readonly string[]): string | undefined {
  const name = host.toLowerCase();
  if (name === "" || isIP(name) !== 0) return undefined;
  for (const pattern of patterns) {
    const kind = tunnelHostKind(pattern);
    if (kind === "any") return pattern;
    if (kind === "exact" ? name === pattern : name.endsWith(pattern.slice(1))) return pattern;
  }
  return undefined;
}

/**
 * The operator's ceiling from CODING_TUNNEL_AGENT_HOSTS: `off` when unset. Throws on any other value,
 * naming the setting, never the value.
 */
export function loadTunnelAgentHostLevel(env: NodeJS.ProcessEnv = process.env): TunnelAgentHostLevel {
  const raw = env.CODING_TUNNEL_AGENT_HOSTS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return "off";
  if (!(TUNNEL_AGENT_HOST_LEVELS as readonly string[]).includes(raw)) {
    throw new Error('CODING_TUNNEL_AGENT_HOSTS must be "off", "exact", "pattern" or "any".');
  }
  return raw as TunnelAgentHostLevel;
}

/**
 * The ceiling as the control plane applies it when an agent is saved and when a run is dispatched: off
 * unless the tunnel itself is on (CODING_TUNNEL_PORT), and off on an invalid setting (which already
 * stopped start-up where the tunnel is loaded).
 */
export function currentTunnelAgentHostLevel(env: NodeJS.ProcessEnv = process.env): TunnelAgentHostLevel {
  if (!env.CODING_TUNNEL_PORT?.trim()) return "off";
  try {
    return loadTunnelAgentHostLevel(env);
  } catch {
    return "off";
  }
}
