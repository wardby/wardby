/**
 * The certificate authority behind the tunnel's TLS interception: one CA per deployment, valid for the
 * intercept hosts only. The proxy holds its key; a run gets the public certificate and trusts it for those
 * hosts. A leaf certificate is minted on demand, for exactly one intercept host, and lives a day.
 *
 * Defence in depth: `generateInterceptCa` makes a CA name-constrained (a critical X.509 name-constraints
 * extension), so a client that checks constraints rejects a certificate for any other host even if the key
 * leaks, and sets path length 0. `loadInterceptCa` also accepts a CA with no name constraint, so one CA can
 * serve any host the proxy has a rule for; a leaked key can then sign for any host to a client that trusts it,
 * and `InterceptCa.constrained` tells the caller so it can warn. A name constraint that is present must be
 * critical and permit every intercept host. A path length above 0 is refused; none is accepted, which is what
 * cert-manager issues (it cannot set one). The proxy itself only ever mints a leaf for an intercept host.
 *
 * Secrets: the CA key and every leaf key stay in memory. An error names what is wrong, never a PEM, a
 * path or a key byte, so none of them can reach a log.
 */
import { randomBytes, type webcrypto } from "node:crypto";
// The certificate library's dependency injection needs this polyfill loaded before it.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { normalizeHost } from "../../sandbox/fetch-policy.js";

const ECDSA = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const NAME_CONSTRAINTS_OID = "2.5.29.30";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const BACKDATE_MS = 5 * MINUTE_MS;
const LEAF_VALIDITY_MS = DAY_MS;
/** A cached leaf is replaced once less than this remains, so a connection never starts on a nearly expired one. */
const LEAF_REFRESH_MS = 60 * MINUTE_MS;
const DEFAULT_CA_VALIDITY_DAYS = 365;

/** A CA that cannot be used, or a host it must not serve. The message is fixed text. */
export class InterceptCaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterceptCaError";
  }
}

export interface InterceptLeaf {
  certificatePem: string;
  privateKeyPem: string;
  notAfter: Date;
}

export interface InterceptCa {
  /** The CA certificate a run trusts. Public. */
  certificatePem: string;
  /** The hosts this CA serves, normalized. */
  hosts: readonly string[];
  /** Whether the CA certificate carries a name constraint limiting it to the hosts. */
  constrained: boolean;
  /** A leaf for one intercept host: cached, replaced before it expires. Any other host is refused. */
  leafFor(host: string): Promise<InterceptLeaf>;
}

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const size = body.length;
  const length =
    size < 0x80
      ? Buffer.from([size])
      : size < 0x100
        ? Buffer.from([0x81, size])
        : Buffer.from([0x82, size >> 8, size & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

/** NameConstraints with permittedSubtrees listing dNSName entries (RFC 5280 4.2.1.10). */
function nameConstraintsValue(hosts: readonly string[]): Buffer {
  const subtrees = hosts.map((host) => der(0x30, der(0x82, Buffer.from(host, "ascii"))));
  return der(0x30, der(0xa0, ...subtrees));
}

/** The dNSName entries of a NameConstraints value's permittedSubtrees, or undefined when it has none. */
function permittedDnsNames(value: Buffer): string[] | undefined {
  const read = (buffer: Buffer, offset: number): { tag: number; start: number; end: number } => {
    const tag = buffer[offset];
    let length = buffer[offset + 1];
    let start = offset + 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + buffer[start + i];
      start += count;
    }
    const end = start + length;
    if (tag === undefined || start > buffer.length || end > buffer.length) throw new Error("malformed");
    return { tag, start, end };
  };
  try {
    const outer = read(value, 0);
    if (outer.tag !== 0x30) return undefined;
    const body = value.subarray(outer.start, outer.end);
    const permitted = read(body, 0);
    if (permitted.tag !== 0xa0) return undefined;
    const names: string[] = [];
    const subtrees = body.subarray(permitted.start, permitted.end);
    for (let offset = 0; offset < subtrees.length;) {
      const subtree = read(subtrees, offset);
      const inner = subtrees.subarray(subtree.start, subtree.end);
      const base = read(inner, 0);
      if (base.tag === 0x82) names.push(inner.subarray(base.start, base.end).toString("ascii").toLowerCase());
      offset = subtree.end;
    }
    return names;
  } catch {
    return undefined;
  }
}

function covers(permitted: readonly string[], host: string): boolean {
  return permitted.some((name) => host === name || host.endsWith(`.${name.replace(/^\./, "")}`));
}

function normalizeHosts(hosts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const host of hosts) {
    let normalized: string;
    try {
      normalized = normalizeHost(host);
    } catch {
      throw new InterceptCaError("The intercept hosts must be bare hostnames.");
    }
    if (/^[\d.]+$/.test(normalized) || normalized.includes(":"))
      throw new InterceptCaError("The intercept hosts must be bare hostnames.");
    out.add(normalized);
  }
  if (out.size === 0) throw new InterceptCaError("At least one intercept host is required.");
  return [...out];
}

/** A random positive serial, as the hex string the library takes. */
function serialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x01;
  return bytes.toString("hex");
}

/**
 * A new CA: ECDSA P-256, path length 0, name-constrained to the hosts, or with no name constraint when
 * `unconstrained` is set (then `hosts` must be empty). For the operator to run once and keep the key in a
 * Secret; the proxy never calls it at runtime.
 */
export async function generateInterceptCa(options: {
  hosts: readonly string[];
  unconstrained?: boolean;
  commonName?: string;
  validityDays?: number;
  now?: Date;
}): Promise<{ certificatePem: string; privateKeyPem: string }> {
  if (options.unconstrained && options.hosts.length > 0)
    throw new InterceptCaError("An unconstrained CA takes no hosts.");
  const hosts = options.unconstrained ? [] : normalizeHosts(options.hosts);
  const days = options.validityDays ?? DEFAULT_CA_VALIDITY_DAYS;
  if (!Number.isInteger(days) || days <= 0)
    throw new InterceptCaError("The CA validity must be a positive number of days.");
  const now = (options.now ?? new Date()).getTime();
  const keys = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(),
    name: `CN=${options.commonName ?? "wardby coding proxy intercept CA"}`,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter: new Date(now + days * DAY_MS),
    signingAlgorithm: ECDSA,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      ...(options.unconstrained ? [] : [new x509.Extension(NAME_CONSTRAINTS_OID, true, nameConstraintsValue(hosts))]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
  return { certificatePem: certificate.toString("pem"), privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY") };
}

/**
 * Loads the deployment's CA and checks it is safe to serve the given hosts with: a CA certificate with
 * path length 0 or none, with no name constraint or a critical one that permits every host, still valid, whose
 * public key matches the private key. Anything else throws a fixed message.
 */
export async function loadInterceptCa(options: {
  certificatePem: string;
  privateKeyPem: string;
  hosts: readonly string[];
  now?: () => Date;
}): Promise<InterceptCa> {
  const hosts = normalizeHosts(options.hosts);
  const now = options.now ?? (() => new Date());

  let caCertificate: x509.X509Certificate;
  try {
    caCertificate = new x509.X509Certificate(options.certificatePem);
  } catch {
    throw new InterceptCaError("The intercept CA certificate could not be read.");
  }
  const basic = caCertificate.getExtension(x509.BasicConstraintsExtension);
  if (!basic?.ca || (basic.pathLength !== undefined && basic.pathLength !== 0))
    throw new InterceptCaError("The intercept CA certificate must be a CA with path length 0 or none.");
  const constraints = caCertificate.getExtension(NAME_CONSTRAINTS_OID);
  if (constraints) {
    const permitted = constraints.critical ? permittedDnsNames(Buffer.from(constraints.value)) : undefined;
    if (!permitted || hosts.some((host) => !covers(permitted, host)))
      throw new InterceptCaError("The intercept CA certificate's name constraint must permit the intercept hosts.");
  }
  const started = now().getTime();
  if (started < caCertificate.notBefore.getTime() || started >= caCertificate.notAfter.getTime())
    throw new InterceptCaError("The intercept CA certificate is not currently valid.");

  let signingKey: webcrypto.CryptoKey;
  try {
    signingKey = await crypto.subtle.importKey(
      "pkcs8",
      x509.PemConverter.decodeFirst(options.privateKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new InterceptCaError("The intercept CA key could not be read.");
  }
  const probe = randomBytes(32);
  // The library's typings name the DOM CryptoKey, which this project's lib does not have.
  const verifyKey = (await caCertificate.publicKey.export(ECDSA, ["verify"])) as webcrypto.CryptoKey;
  const signature = await crypto.subtle.sign(ECDSA, signingKey, probe);
  if (!(await crypto.subtle.verify(ECDSA, verifyKey, signature, probe)))
    throw new InterceptCaError("The intercept CA key does not match its certificate.");

  // A leaf names its issuer by the CA's own key identifier, which a client matches to find the CA. Computing it
  // here would give this library's SHA-1 form, which a CA from elsewhere need not use (cert-manager's Go writes a
  // truncated SHA-256), so it is copied, and computed only for a CA that has none.
  const caKeyId = caCertificate.getExtension(x509.SubjectKeyIdentifierExtension)?.keyId;
  const authorityKeyId = caKeyId
    ? new x509.AuthorityKeyIdentifierExtension(caKeyId)
    : await x509.AuthorityKeyIdentifierExtension.create(caCertificate);

  const cache = new Map<string, Promise<InterceptLeaf>>();
  const mint = async (host: string): Promise<InterceptLeaf> => {
    const issued = now().getTime();
    const notAfter = Math.min(issued + LEAF_VALIDITY_MS, caCertificate.notAfter.getTime());
    if (notAfter - issued < LEAF_REFRESH_MS)
      throw new InterceptCaError("The intercept CA certificate is about to expire.");
    const keys = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
    const certificate = await x509.X509CertificateGenerator.create({
      serialNumber: serialNumber(),
      subject: `CN=${host}`,
      issuer: caCertificate.subject,
      notBefore: new Date(issued - BACKDATE_MS),
      notAfter: new Date(notAfter),
      signingAlgorithm: ECDSA,
      publicKey: keys.publicKey,
      signingKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }]),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
        authorityKeyId,
      ],
    });
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    return {
      certificatePem: certificate.toString("pem"),
      privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
      notAfter: new Date(notAfter),
    };
  };

  return {
    certificatePem: caCertificate.toString("pem"),
    hosts,
    constrained: Boolean(constraints),
    async leafFor(requested: string): Promise<InterceptLeaf> {
      let host: string;
      try {
        host = normalizeHost(requested);
      } catch {
        throw new InterceptCaError("Not an intercept host.");
      }
      if (!hosts.includes(host)) throw new InterceptCaError("Not an intercept host.");
      const cached = cache.get(host);
      if (cached) {
        // A failed or nearly expired entry is replaced; concurrent callers share one in-flight mint.
        const leaf = await cached.catch(() => undefined);
        if (leaf && leaf.notAfter.getTime() - now().getTime() >= LEAF_REFRESH_MS) return leaf;
        if (cache.get(host) === cached) cache.delete(host);
      }
      const pending = cache.get(host) ?? mint(host);
      cache.set(host, pending);
      return pending;
    },
  };
}

/** How often a reloading CA reads its source again. */
export const INTERCEPT_CA_RELOAD_MS = 60 * 1000;

/**
 * A CA that follows its source: at most once per `intervalMs`, on the next leaf request, it reads the
 * certificate and key again and, when either changed, loads the new pair with every check `loadInterceptCa`
 * makes. A rotated CA (cert-manager renews the Secret, the kubelet swaps the mounted files) is then served
 * without a restart, and its leaves replace the old CA's. A pair that cannot be read or fails a check (a
 * read that straddles the swap, say) keeps the current CA and is tried again next interval; `onError`
 * gets the fixed message only.
 */
export function reloadingInterceptCa(options: {
  initial: InterceptCa;
  /** The pair `initial` was loaded from, so an unchanged source is not loaded again. */
  source: { certificatePem: string; privateKeyPem: string };
  read: () => Promise<{ certificatePem: string; privateKeyPem: string }>;
  intervalMs?: number;
  now?: () => Date;
  onReload?: () => void;
  onError?: (message: string) => void;
}): InterceptCa {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? INTERCEPT_CA_RELOAD_MS;
  let current = options.initial;
  let source = options.source;
  let checkedAt = now().getTime();
  let pending: Promise<void> | undefined;

  const reload = async (): Promise<void> => {
    try {
      const next = await options.read();
      if (next.certificatePem === source.certificatePem && next.privateKeyPem === source.privateKeyPem) return;
      current = await loadInterceptCa({ ...next, hosts: current.hosts, now });
      source = next;
      options.onReload?.();
    } catch (error) {
      options.onError?.(error instanceof InterceptCaError ? error.message : "The intercept CA could not be read.");
    }
  };

  return {
    get certificatePem() {
      return current.certificatePem;
    },
    get hosts() {
      return current.hosts;
    },
    get constrained() {
      return current.constrained;
    },
    async leafFor(host: string): Promise<InterceptLeaf> {
      if (!pending && now().getTime() - checkedAt >= intervalMs) {
        checkedAt = now().getTime();
        pending = reload().finally(() => {
          pending = undefined;
        });
      }
      // Concurrent requests during a reload wait for it, so none is served by a CA that was just replaced.
      if (pending) await pending;
      return current.leafFor(host);
    },
  };
}
