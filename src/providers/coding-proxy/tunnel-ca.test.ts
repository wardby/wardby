// Loaded first: the certificate library the tests use directly needs it before it is imported.
import "reflect-metadata";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { generateInterceptCa, InterceptCaError, loadInterceptCa, reloadingInterceptCa } from "./tunnel-ca.js";

const HOST = "europe-docker.pkg.dev";
const ECDSA = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

async function load(hosts = [HOST], now?: () => Date) {
  const ca = await generateInterceptCa({ hosts });
  const loaded = await loadInterceptCa({ ...ca, hosts, ...(now ? { now } : {}) });
  return { ca, loaded };
}

/** Whether a real TLS client that trusts only `caPem` accepts a server presenting `leaf` for `servername`. */
async function handshake(
  leaf: { certificatePem: string; privateKeyPem: string },
  caPem: string,
  servername: string,
): Promise<"accepted" | "rejected"> {
  const server = createTlsServer({ cert: leaf.certificatePem, key: leaf.privateKeyPem }, (socket) => socket.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = tlsConnect({
      host: "127.0.0.1",
      port: (server.address() as AddressInfo).port,
      servername,
      ca: caPem,
    });
    const outcome = await new Promise<"accepted" | "rejected">((resolve) => {
      client.once("secureConnect", () => resolve("accepted"));
      client.once("error", () => resolve("rejected"));
    });
    client.destroy();
    return outcome;
  } finally {
    server.close();
  }
}

describe("generateInterceptCa", () => {
  it("makes a path-length-0 CA whose critical name constraint lists the hosts", async () => {
    const { certificatePem } = await generateInterceptCa({ hosts: [HOST, "Other.Example."] });
    const cert = new x509.X509Certificate(certificatePem);
    const basic = cert.getExtension(x509.BasicConstraintsExtension);
    expect(basic).toMatchObject({ ca: true, pathLength: 0, critical: true });
    const constraints = cert.getExtension("2.5.29.30");
    expect(constraints?.critical).toBe(true);
    const text = Buffer.from(constraints?.value ?? new ArrayBuffer(0)).toString("latin1");
    expect(text).toContain(HOST);
    expect(text).toContain("other.example");
  });

  it("refuses IP literals, an empty list and a bad validity", async () => {
    await expect(generateInterceptCa({ hosts: ["10.0.0.1"] })).rejects.toBeInstanceOf(InterceptCaError);
    await expect(generateInterceptCa({ hosts: [] })).rejects.toBeInstanceOf(InterceptCaError);
    await expect(generateInterceptCa({ hosts: [HOST], validityDays: 0 })).rejects.toBeInstanceOf(InterceptCaError);
  });
});

describe("loadInterceptCa", () => {
  it("serves a leaf a TLS client that trusts only the CA accepts for the intercept host", async () => {
    const { ca, loaded } = await load();
    const leaf = await loaded.leafFor(HOST);
    expect(await handshake(leaf, ca.certificatePem, HOST)).toBe("accepted");
    const cert = new x509.X509Certificate(leaf.certificatePem);
    const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
    expect(san?.names.items.map((name) => name.value)).toEqual([HOST]);
    expect(cert.getExtension(x509.BasicConstraintsExtension)?.ca).toBe(false);
  });

  it("is rejected by a TLS client for a name the leaf does not carry", async () => {
    const { ca, loaded } = await load();
    expect(await handshake(await loaded.leafFor(HOST), ca.certificatePem, "other.example")).toBe("rejected");
  });

  it("makes a client reject a certificate the CA signs for a host outside its constraint", async () => {
    // Signed with the real CA key, as if the key leaked: only the name constraint stops it.
    const { ca } = await load();
    const caCertificate = new x509.X509Certificate(ca.certificatePem);
    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      x509.PemConverter.decodeFirst(ca.privateKeyPem),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const forge = async (host: string) => {
      const keys = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
      const cert = await x509.X509CertificateGenerator.create({
        subject: `CN=${host}`,
        issuer: caCertificate.subject,
        signingAlgorithm: ECDSA,
        publicKey: keys.publicKey,
        signingKey,
        extensions: [new x509.SubjectAlternativeNameExtension([{ type: "dns", value: host }])],
      });
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
      return { certificatePem: cert.toString("pem"), privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY") };
    };
    expect(await handshake(await forge(HOST), ca.certificatePem, HOST)).toBe("accepted");
    expect(await handshake(await forge("evil.example"), ca.certificatePem, "evil.example")).toBe("rejected");
  });

  it("mints only for an intercept host", async () => {
    const { loaded } = await load();
    await expect(loaded.leafFor("evil.example")).rejects.toThrow("Not an intercept host.");
    await expect(loaded.leafFor("10.0.0.1")).rejects.toThrow("Not an intercept host.");
    await expect(loaded.leafFor("")).rejects.toThrow("Not an intercept host.");
    expect((await loaded.leafFor("EUROPE-DOCKER.PKG.DEV.")).certificatePem).toContain("BEGIN CERTIFICATE");
  });

  it("caches a leaf, shares a concurrent mint, and replaces one that is nearly expired", async () => {
    let now = new Date();
    const { loaded } = await load([HOST], () => now);
    const [a, b] = await Promise.all([loaded.leafFor(HOST), loaded.leafFor(HOST)]);
    expect(b).toBe(a);
    expect(await loaded.leafFor(HOST)).toBe(a);
    now = new Date(now.getTime() + 23.5 * 60 * 60 * 1000);
    const c = await loaded.leafFor(HOST);
    expect(c).not.toBe(a);
    expect(c.certificatePem).not.toBe(a.certificatePem);
  });

  it("never gives a leaf a longer life than the CA", async () => {
    const ca = await generateInterceptCa({ hosts: [HOST], validityDays: 1 });
    const loaded = await loadInterceptCa({ ...ca, hosts: [HOST] });
    const leaf = await loaded.leafFor(HOST);
    expect(leaf.notAfter.getTime()).toBeLessThanOrEqual(new x509.X509Certificate(ca.certificatePem).notAfter.getTime());
  });

  it("refuses an unsafe or unusable CA with a fixed message and no key material", async () => {
    const good = await generateInterceptCa({ hosts: [HOST] });
    const other = await generateInterceptCa({ hosts: [HOST] });
    const cases: Array<[string, Parameters<typeof loadInterceptCa>[0], string]> = [
      ["garbage certificate", { ...good, certificatePem: "nope", hosts: [HOST] }, "certificate could not be read"],
      ["garbage key", { ...good, privateKeyPem: "nope", hosts: [HOST] }, "key could not be read"],
      ["mismatched key", { ...good, privateKeyPem: other.privateKeyPem, hosts: [HOST] }, "does not match"],
      ["host outside the constraint", { ...good, hosts: ["evil.example"] }, "name constraint must permit"],
      [
        "expired",
        { ...good, hosts: [HOST], now: () => new Date(Date.now() + 400 * 86_400_000) },
        "not currently valid",
      ],
    ];
    for (const [, options, message] of cases) {
      const error = await loadInterceptCa(options).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InterceptCaError);
      expect((error as Error).message).toContain(message);
      expect((error as Error).message).not.toContain("PRIVATE KEY");
      expect((error as Error).message).not.toContain("nope");
    }
  });

  /** A CA as cert-manager issues it for `isCA` with critical `nameConstraints`: no path length, PKCS8 key. */
  async function constrainedCa(pathLength: number | undefined, extra: x509.Extension[] = []) {
    const keys = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
    const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag, body.length]), body]);
    const permitted = tlv(0x30, tlv(0xa0, tlv(0x30, tlv(0x82, Buffer.from(HOST, "ascii")))));
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      name: "CN=cert-manager shaped",
      signingAlgorithm: ECDSA,
      keys,
      extensions: [
        new x509.BasicConstraintsExtension(true, pathLength, true),
        new x509.Extension("2.5.29.30", true, permitted),
        ...extra,
      ],
    });
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
    return {
      certificatePem: certificate.toString("pem"),
      privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
      hosts: [HOST],
    };
  }

  it("accepts a name-constrained CA with no path length, as cert-manager issues one", async () => {
    const ca = await constrainedCa(undefined);
    const loaded = await loadInterceptCa(ca);
    expect(await handshake(await loaded.leafFor(HOST), ca.certificatePem, HOST)).toBe("accepted");
  });

  it("names the issuer by the CA's own key identifier, not one it computes", async () => {
    // Go (so cert-manager) writes a truncated SHA-256 identifier; the library would compute SHA-1, and a client
    // that looks the issuer up by it would not find the CA.
    const keyId = "e6d8eef6872184e3d28bad0367960d2d94b12376";
    const ca = await constrainedCa(undefined, [new x509.SubjectKeyIdentifierExtension(keyId)]);
    const leaf = new x509.X509Certificate((await (await loadInterceptCa(ca)).leafFor(HOST)).certificatePem);
    expect(leaf.getExtension(x509.AuthorityKeyIdentifierExtension)?.keyId).toBe(keyId);
  });

  it("refuses a CA whose path length is above 0", async () => {
    await expect(loadInterceptCa(await constrainedCa(1))).rejects.toThrow("path length 0 or none");
  });

  describe("a CA with no name constraint", () => {
    it("is made on request, has no name-constraints extension and still has path length 0", async () => {
      const open = await generateInterceptCa({ hosts: [], unconstrained: true });
      const certificate = new x509.X509Certificate(open.certificatePem);
      expect(certificate.getExtension("2.5.29.30")).toBeNull();
      expect(certificate.getExtension(x509.BasicConstraintsExtension)?.pathLength).toBe(0);
    });

    it("is not made by mistake: hosts and `unconstrained` are exclusive, and one of them is needed", async () => {
      await expect(generateInterceptCa({ hosts: [HOST], unconstrained: true })).rejects.toThrow("takes no hosts");
      await expect(generateInterceptCa({ hosts: [] })).rejects.toThrow("At least one intercept host");
    });

    it("is loaded, reports that it is unconstrained and serves a leaf a client accepts", async () => {
      const open = await generateInterceptCa({ hosts: [], unconstrained: true });
      const loaded = await loadInterceptCa({ ...open, hosts: [HOST] });
      expect(loaded.constrained).toBe(false);
      expect(await handshake(await loaded.leafFor(HOST), open.certificatePem, HOST)).toBe("accepted");
    });

    it("still mints a leaf only for an intercept host", async () => {
      const open = await generateInterceptCa({ hosts: [], unconstrained: true });
      const loaded = await loadInterceptCa({ ...open, hosts: [HOST] });
      await expect(loaded.leafFor("other.example.com")).rejects.toThrow("Not an intercept host");
    });

    it("is not accepted from a CA that has a constraint which excludes the hosts", async () => {
      const constrained = await generateInterceptCa({ hosts: [HOST] });
      expect((await loadInterceptCa({ ...constrained, hosts: [HOST] })).constrained).toBe(true);
      await expect(loadInterceptCa({ ...constrained, hosts: ["other.example.com"] })).rejects.toThrow(
        "name constraint must permit",
      );
    });

    it("is still refused with a path length above 0", async () => {
      const keys = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
      const open = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=open",
        signingAlgorithm: ECDSA,
        keys,
        extensions: [new x509.BasicConstraintsExtension(true, 1, true)],
      });
      const pkcs8 = await crypto.subtle.exportKey("pkcs8", keys.privateKey);
      await expect(
        loadInterceptCa({
          certificatePem: open.toString("pem"),
          privateKeyPem: x509.PemConverter.encode(pkcs8, "PRIVATE KEY"),
          hosts: [HOST],
        }),
      ).rejects.toThrow("path length 0 or none");
    });
  });
});

describe("reloadingInterceptCa", () => {
  async function reloading() {
    let now = new Date();
    const first = await generateInterceptCa({ hosts: [HOST] });
    const initial = await loadInterceptCa({ ...first, hosts: [HOST], now: () => now });
    let source = first;
    const errors: string[] = [];
    let reloads = 0;
    let reads = 0;
    const ca = reloadingInterceptCa({
      initial,
      source: first,
      read: async () => {
        reads++;
        return source;
      },
      intervalMs: 60_000,
      now: () => now,
      onReload: () => reloads++,
      onError: (message) => errors.push(message),
    });
    return {
      ca,
      first,
      errors,
      reloads: () => reloads,
      reads: () => reads,
      setSource: (next: typeof first) => (source = next),
      advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    };
  }

  it("serves a rotated CA's leaves after the interval, and only reads its source once per interval", async () => {
    const r = await reloading();
    const before = await r.ca.leafFor(HOST);
    const rotated = await generateInterceptCa({ hosts: [HOST] });
    r.setSource(rotated);
    // Not yet due: the old CA still serves, and nothing is read.
    expect(await r.ca.leafFor(HOST)).toBe(before);
    expect(r.reads()).toBe(0);
    r.advance(60_000);
    const [after, concurrent] = await Promise.all([r.ca.leafFor(HOST), r.ca.leafFor(HOST)]);
    expect(r.reads()).toBe(1);
    expect(r.reloads()).toBe(1);
    expect(concurrent).toBe(after);
    expect(r.ca.certificatePem).toBe(new x509.X509Certificate(rotated.certificatePem).toString("pem"));
    expect(await handshake(after, rotated.certificatePem, HOST)).toBe("accepted");
    expect(await handshake(after, r.first.certificatePem, HOST)).toBe("rejected");
  });

  it("does not load an unchanged source again", async () => {
    const r = await reloading();
    const before = await r.ca.leafFor(HOST);
    r.advance(60_000);
    expect(await r.ca.leafFor(HOST)).toBe(before);
    expect(r.reads()).toBe(1);
    expect(r.reloads()).toBe(0);
  });

  it("keeps the current CA when the new pair fails a check, and tries again next interval", async () => {
    const r = await reloading();
    const before = await r.ca.leafFor(HOST);
    const rotated = await generateInterceptCa({ hosts: [HOST] });
    // A read that straddles the swap: the new certificate with the old key.
    r.setSource({ certificatePem: rotated.certificatePem, privateKeyPem: r.first.privateKeyPem });
    r.advance(60_000);
    expect(await r.ca.leafFor(HOST)).toBe(before);
    expect(r.errors).toEqual(["The intercept CA key does not match its certificate."]);
    expect(r.errors.join()).not.toContain("PRIVATE KEY");
    r.setSource(rotated);
    r.advance(60_000);
    expect(await handshake(await r.ca.leafFor(HOST), rotated.certificatePem, HOST)).toBe("accepted");
    expect(r.reloads()).toBe(1);
  });
});
