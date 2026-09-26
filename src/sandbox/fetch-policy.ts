import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;
export interface FetchPolicyOptions {
  /**
   * Egress allowlist, enforced only with `restrictToAllowedHosts`. It can only
   * NARROW where fetch may go: a listed host must still resolve exclusively to
   * global addresses. Tool-controlled lists belong here.
   */
  allowedHosts?: string[];
  restrictToAllowedHosts?: boolean;
  /**
   * Hosts that may resolve to a non-global (private/loopback/link-local)
   * address. Operator-controlled ONLY (WARDBY_FETCH_ALLOWED_HOSTS) — never
   * populate it from a tool's or caller's own capability list. Cloud metadata
   * endpoints stay blocked even when listed here.
   */
  privateHostAllowlist?: string[];
  resolve?: Resolver;
}
export class FetchPolicyError extends Error {
  constructor() {
    super("fetch_destination_blocked");
  }
}
const blockedV4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
function v4(ip: string) {
  return ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
}
function v6(ip: string): bigint {
  const [left, right] = ip.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const groups = ip.includes("::") ? [...a, ...new Array<string>(8 - a.length - b.length).fill("0"), ...b] : a;
  return groups.reduce((n: bigint, g: string) => (n << 16n) + BigInt("0x" + g), 0n);
}
export function isGlobalAddress(address: string): boolean {
  if (isIP(address) === 4)
    return !blockedV4.some(([net, prefix]) => v4(address) >>> (32 - prefix) === v4(net) >>> (32 - prefix));
  if (isIP(address) !== 6) return false;
  const normalized = new URL("http://[" + address + "]").hostname.slice(1, -1);
  const n = v6(normalized);
  // Conservative global-unicast subset; exclude transition, protocol, and documentation space.
  return (
    n >> 125n === 1n &&
    ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
    ].some(([net, prefix]) => {
      const shift = 128n - BigInt(prefix);
      return n >> shift === v6(net as string) >> shift;
    })
  );
}
/** Cloud instance-metadata endpoints (GCP/AWS/Azure IMDS, GKE metadata proxy, ECS task creds, AWS IMDS IPv6). */
const METADATA_V4 = new Set(["169.254.169.254", "169.254.169.252", "169.254.170.2"]);
const METADATA_V6 = v6("fd00:ec2::254");
const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata"]);
/** True for a cloud metadata address, including IPv4-mapped/-compatible and NAT64 (64:ff9b::/96) IPv6 forms. */
export function isCloudMetadataAddress(address: string): boolean {
  if (isIP(address) === 4) return METADATA_V4.has(address);
  if (isIP(address) !== 6) return false;
  const n = v6(new URL("http://[" + address + "]").hostname.slice(1, -1));
  if (n === METADATA_V6) return true;
  const high = n >> 32n;
  if (high !== 0n && high !== 0xffffn && high !== v6("64:ff9b::") >> 32n) return false;
  const low = Number(n & 0xffffffffn);
  return METADATA_V4.has([24, 16, 8, 0].map((shift) => (low >>> shift) & 0xff).join("."));
}
export function normalizeHost(host: string): string {
  if (!host || /[\s*/@?#\\]/.test(host)) throw new FetchPolicyError();
  const value = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(value))
    return new URL(isIP(value) === 6 ? "http://[" + value + "]" : "http://" + value).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  if (host.includes(":")) throw new FetchPolicyError();
  return new URL("http://" + host).hostname.toLowerCase().replace(/\.$/, "");
}
export function parseAllowedHosts(value: string | undefined): string[] {
  return value === undefined || value === "" ? [] : value.split(",").map((host) => normalizeHost(host.trim()));
}
export async function resolveDestination(urlString: string, options: FetchPolicyOptions = {}) {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new FetchPolicyError();
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || urlString.length > 8192)
    throw new FetchPolicyError();
  const hostname = normalizeHost(url.hostname);
  if (METADATA_HOSTNAMES.has(hostname)) throw new FetchPolicyError();
  const allowed = (options.allowedHosts ?? []).map(normalizeHost).includes(hostname);
  if (options.restrictToAllowedHosts && !allowed) throw new FetchPolicyError();
  // Only the operator list may open a non-global destination; a restricted
  // caller additionally needs the host in its own list (checked just above).
  const privateAllowed = (options.privateHostAllowlist ?? []).map(normalizeHost).includes(hostname);
  const version = isIP(hostname);
  const addresses = version
    ? [{ address: hostname, family: version }]
    : await (options.resolve ?? ((host) => lookup(host, { all: true })))(hostname);
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !isIP(a.address) ||
        isIP(a.address) !== a.family ||
        isCloudMetadataAddress(a.address) ||
        (!isGlobalAddress(a.address) && !privateAllowed),
    )
  )
    throw new FetchPolicyError();
  return { url, hostname, address: addresses[0].address, family: addresses[0].family };
}
export async function assertFetchDestinationAllowed(url: string, options: FetchPolicyOptions = {}): Promise<void> {
  await resolveDestination(url, options);
}
