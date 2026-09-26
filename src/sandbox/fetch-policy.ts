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
  // Zone-scoped (fe80::1%eth0) answers are link-local by nature; never global.
  if (address.includes("%")) return false;
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
/**
 * Cloud instance-metadata endpoints: GCP/AWS/Azure IMDS, GKE metadata proxy,
 * ECS task credentials, EKS Pod Identity, Alibaba Cloud; plus the AWS, EKS and
 * GCE IPv6 addresses.
 */
const METADATA_V4 = new Set([
  "169.254.169.254",
  "169.254.169.252",
  "169.254.170.2",
  "169.254.170.23",
  "100.100.100.200",
]);
const METADATA_V6 = new Set(["fd00:ec2::254", "fd00:ec2::23", "fd20:ce::254"].map(v6));
const METADATA_HOSTNAMES = new Set(["metadata.google.internal", "metadata"]);
const NAT64_WELL_KNOWN = v6("64:ff9b::") >> 32n;
const NAT64_LOCAL_USE = v6("64:ff9b:1::") >> 80n;
const SIX_TO_FOUR = 0x2002n;
function v4FromBits(bits: bigint): string {
  const n = Number(bits & 0xffffffffn);
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join(".");
}
/**
 * True for a cloud metadata address, including IPv6 encodings of the IPv4
 * ones: IPv4-mapped/-compatible (::ffff:0:0/96, ::/96), NAT64 well-known
 * (64:ff9b::/96), RFC 8215 local-use NAT64 (64:ff9b:1::/48, /96 and RFC 6052
 * /48 layouts) and 6to4 (2002::/16). A zone id is ignored for the comparison.
 */
export function isCloudMetadataAddress(address: string): boolean {
  const bare = address.split("%")[0];
  if (isIP(bare) === 4) return METADATA_V4.has(bare);
  if (isIP(bare) !== 6) return false;
  const n = v6(new URL("http://[" + bare + "]").hostname.slice(1, -1));
  if (METADATA_V6.has(n)) return true;
  const embedded: bigint[] = [];
  const high96 = n >> 32n;
  if (high96 === 0n || high96 === 0xffffn || high96 === NAT64_WELL_KNOWN) embedded.push(n);
  if (n >> 80n === NAT64_LOCAL_USE) embedded.push(n, (((n >> 64n) & 0xffffn) << 16n) | ((n >> 40n) & 0xffffn));
  if (n >> 112n === SIX_TO_FOUR) embedded.push(n >> 80n);
  return embedded.some((bits) => METADATA_V4.has(v4FromBits(bits)));
}
export function normalizeHost(host: string): string {
  if (!host || /[\s*/@?#\\]/.test(host)) throw new FetchPolicyError();
  if (host.startsWith("[") !== host.endsWith("]")) throw new FetchPolicyError();
  const value = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(value))
    return new URL(isIP(value) === 6 ? "http://[" + value + "]" : "http://" + value).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  if (host.includes(":")) throw new FetchPolicyError();
  const name = new URL("http://" + host).hostname.toLowerCase().replace(/\.+$/, "");
  if (!name) throw new FetchPolicyError();
  return name;
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
        a.address.includes("%") ||
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
