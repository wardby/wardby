/**
 * Destination policy for the sandbox's `fetch` host bridge. The sandbox
 * contains CPU/memory/globals tightly, then — without this — hands tool
 * code an unfiltered outbound socket carrying the *host's* network
 * identity: cloud instance metadata (169.254.169.254 → IAM credentials),
 * loopback (the host's own Postgres, other local services), and RFC-1918
 * internal services are all reachable from inside a tool by default.
 * Tolerable when tools are authored by a trusted local operator; a real
 * exposure once tool authoring is opened up (e.g. remote MCP, LLM-authored
 * tools) on a server that has cloud IAM. Blocked by default; an operator
 * who genuinely needs a tool to reach an internal service opts a specific
 * hostname in via REEVO_FETCH_ALLOWED_HOSTS (comma-separated), rather than
 * this being an implicit wide-open default.
 *
 * Resolves the hostname and checks the *resolved* IP (not just the literal
 * string in the URL) — otherwise a hostname that DNS-resolves to a
 * blocked address would sail through a check that only looked at the URL.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

// [network, prefix length]
const BLOCKED_V4_RANGES: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud instance metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC 1918
  ["192.168.0.0", 16], // RFC 1918
];

function isBlockedV4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  return BLOCKED_V4_RANGES.some(([network, prefixLen]) => {
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    return (ipInt & mask) === (ipv4ToInt(network) & mask);
  });
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified

  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4 address too.
  // Node's URL/dns normalize this to hex-group form (e.g. "::ffff:7f00:1"
  // for 127.0.0.1), not the dotted-quad suffix, so both forms need handling.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mappedDotted) return isBlockedV4(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    const embeddedV4 = [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(".");
    return isBlockedV4(embeddedV4);
  }

  const firstGroup = lower.split(":")[0];
  // fe80::/10 (link-local): first 10 bits fixed -> first group "fe80".."febf".
  if (/^fe[89ab][0-9a-f]?$/.test(firstGroup)) return true;
  // fc00::/7 (unique local): first 7 bits fixed -> first group starts "fc" or "fd".
  if (/^f[cd][0-9a-f]{0,2}$/.test(firstGroup)) return true;
  return false;
}

export interface FetchPolicyOptions {
  /** Hostnames exempted from the block list (e.g. via REEVO_FETCH_ALLOWED_HOSTS). */
  allowedHosts?: string[];
}

/** Throws if `urlString`'s host (after DNS resolution) is a blocked network. */
export async function assertFetchDestinationAllowed(
  urlString: string,
  options: FetchPolicyOptions = {},
): Promise<void> {
  const url = new URL(urlString);
  // WHATWG URL keeps brackets around an IPv6 literal host (e.g. "[::1]"),
  // but net.isIP() and dns.lookup() both expect the bracket-free form.
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;

  if (options.allowedHosts?.includes(hostname)) return;

  if (hostname === "localhost") {
    throw new Error(`fetch to "${hostname}" is blocked (loopback). Add it to REEVO_FETCH_ALLOWED_HOSTS to allow it.`);
  }

  const literalVersion = isIP(hostname);
  const addresses = literalVersion
    ? [{ address: hostname, family: literalVersion }]
    : await lookup(hostname, { all: true });

  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isBlockedV4(address) : family === 6 ? isBlockedV6(address) : false;
    if (blocked) {
      throw new Error(
        `fetch to "${hostname}" (resolves to ${address}) is blocked (private/loopback/link-local network). ` +
          `Add "${hostname}" to REEVO_FETCH_ALLOWED_HOSTS to allow it.`,
      );
    }
  }
}
