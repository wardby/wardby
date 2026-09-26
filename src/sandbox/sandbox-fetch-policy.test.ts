import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  resolveDestination,
  isCloudMetadataAddress,
  isGlobalAddress,
  normalizeHost,
  parseAllowedHosts,
  type Resolver,
} from "./fetch-policy.js";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch.js";
import { sandboxFetchPolicy } from "./host-functions.js";

// Regression suite for S2-1: a tool's own allowedHosts must only NARROW egress;
// only the operator's WARDBY_FETCH_ALLOWED_HOSTS may open a private destination,
// and cloud metadata endpoints are blocked unconditionally. No real network:
// every hostname goes through an injected resolver, every connection is faked.

const dns =
  (table: Record<string, string>): Resolver =>
  async (host) => {
    const address = table[host] ?? "93.184.216.34";
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };
const resolve = dns({
  "rfc1918.attacker.test": "10.0.0.5",
  "linklocal.attacker.test": "169.254.10.1",
  "metadata-ip.attacker.test": "169.254.169.254",
  "loopback6.attacker.test": "::1",
  "mapped.attacker.test": "::ffff:169.254.169.254",
  localhost: "127.0.0.1",
  "db.internal.test": "10.1.2.3",
  "metadata.google.internal": "169.254.169.254",
  metadata: "169.254.169.254",
  "api.public.test": "93.184.216.34",
});

async function check(url: string, toolHosts: string[], operatorHosts: string[] = []) {
  return resolveDestination(url, { ...sandboxFetchPolicy(toolHosts, operatorHosts), resolve });
}
async function expectBlocked(url: string, toolHosts: string[], operatorHosts: string[] = []) {
  await expect(check(url, toolHosts, operatorHosts)).rejects.toThrow("fetch_destination_blocked");
}

describe("sandbox fetch policy: a tool's allowedHosts cannot open private destinations", () => {
  it.each([
    ["http://169.254.169.254/computeMetadata/v1/", "169.254.169.254"],
    ["http://127.0.0.1:5432/", "127.0.0.1"],
    ["http://localhost:8080/", "localhost"],
    ["http://[::1]/", "[::1]"],
    ["http://rfc1918.attacker.test/", "rfc1918.attacker.test"],
    ["http://linklocal.attacker.test/", "linklocal.attacker.test"],
    ["http://metadata-ip.attacker.test/", "metadata-ip.attacker.test"],
    ["http://loopback6.attacker.test/", "loopback6.attacker.test"],
    ["http://mapped.attacker.test/", "mapped.attacker.test"],
    ["http://[::ffff:169.254.169.254]/", "[::ffff:169.254.169.254]"],
    ["http://2130706433/", "2130706433"], // decimal 127.0.0.1
    ["http://0177.0.0.1/", "0177.0.0.1"], // octal 127.0.0.1
    ["http://0xa9fea9fe/", "0xa9fea9fe"], // hex 169.254.169.254
    ["http://2852039166/", "2852039166"], // decimal 169.254.169.254
  ])("blocks %s when the tool lists %s", async (url, host) => {
    await expectBlocked(url, [host]);
  });

  it("allows a public host that is in the tool's list", async () => {
    await expect(check("https://api.public.test/v1", ["api.public.test"])).resolves.toMatchObject({
      address: "93.184.216.34",
    });
  });

  it("blocks a public host that is not in the tool's list (unchanged)", async () => {
    await expectBlocked("https://other.public.test/", ["api.public.test"]);
  });

  it("allows a private host listed by BOTH the operator and the tool", async () => {
    await expect(check("http://db.internal.test/", ["db.internal.test"], ["db.internal.test"])).resolves.toMatchObject({
      address: "10.1.2.3",
    });
  });

  it("blocks an operator-listed private host the tool did not list", async () => {
    await expectBlocked("http://db.internal.test/", ["api.public.test"], ["db.internal.test"]);
  });

  it("wildcard tools keep the operator private-host allowlist, and nothing more", async () => {
    await expect(check("http://db.internal.test/", ["*"], ["db.internal.test"])).resolves.toMatchObject({
      address: "10.1.2.3",
    });
    await expect(check("https://anything.public.test/", ["*"])).resolves.toBeDefined();
    await expectBlocked("http://rfc1918.attacker.test/", ["*"], ["db.internal.test"]);
  });
});

describe("sandbox fetch policy: cloud metadata is always blocked, even if the operator lists it", () => {
  it.each([
    ["http://169.254.169.254/", "169.254.169.254"],
    ["http://169.254.169.252:988/", "169.254.169.252"],
    ["http://169.254.170.2/v2/credentials", "169.254.170.2"],
    ["http://[fd00:ec2::254]/", "[fd00:ec2::254]"],
    ["http://[::ffff:169.254.169.254]/", "[::ffff:169.254.169.254]"],
    ["http://metadata.google.internal/computeMetadata/v1/", "metadata.google.internal"],
    ["http://METADATA.google.internal./", "metadata.google.internal"],
    ["http://metadata/computeMetadata/v1/", "metadata"],
    ["http://metadata-ip.attacker.test/", "metadata-ip.attacker.test"],
    ["http://mapped.attacker.test/", "mapped.attacker.test"],
  ])("blocks %s with %s in both the operator and the tool list", async (url, host) => {
    await expectBlocked(url, [host], [host]);
    await expectBlocked(url, ["*"], [host]);
  });

  it.each([
    "169.254.169.254",
    "169.254.169.252",
    "169.254.170.2",
    "fd00:ec2::254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
  ])("recognizes %s as a cloud metadata address", (address) => {
    expect(isCloudMetadataAddress(address)).toBe(true);
  });

  it.each(["169.254.169.253", "10.0.0.1", "8.8.8.8", "fd00:ec2::253", "::1"])(
    "does not flag %s as metadata",
    (address) => expect(isCloudMetadataAddress(address)).toBe(false),
  );
});

describe("sandbox fetch policy through safeFetch redirects", () => {
  function response(status: number, headers: Record<string, string> = {}, body = ""): IncomingMessage {
    return Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
      statusCode: status,
      statusMessage: "OK",
      headers,
    }) as unknown as IncomingMessage;
  }

  it.each([
    "http://169.254.169.254/computeMetadata/v1/",
    "http://metadata.google.internal/",
    "http://rfc1918.attacker.test/",
    "http://[::ffff:169.254.169.254]/",
    "http://127.0.0.1/",
  ])("blocks a redirect from an allowed public host to %s, even if the tool lists it", async (location) => {
    const target = new URL(location).hostname.replace(/^\[|\]$/g, "");
    const connect = vi.fn<NonNullable<SafeFetchOptions["connect"]>>(async () => response(302, { location }));
    await expect(
      safeFetch(
        "https://api.public.test/",
        {},
        { ...sandboxFetchPolicy(["api.public.test", target], []), resolve, connect },
      ),
    ).rejects.toThrow("fetch_destination_blocked");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect to an operator-listed metadata host", async () => {
    const connect = vi.fn<NonNullable<SafeFetchOptions["connect"]>>(async () =>
      response(302, { location: "http://metadata.google.internal/" }),
    );
    await expect(
      safeFetch(
        "https://api.public.test/",
        {},
        {
          ...sandboxFetchPolicy(["*"], ["metadata.google.internal", "169.254.169.254"]),
          resolve,
          connect,
        },
      ),
    ).rejects.toThrow("fetch_destination_blocked");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to an operator+tool listed private host", async () => {
    const connect = vi
      .fn<NonNullable<SafeFetchOptions["connect"]>>()
      .mockResolvedValueOnce(response(302, { location: "http://db.internal.test/x" }))
      .mockResolvedValueOnce(response(200, {}, "ok"));
    const result = await safeFetch(
      "https://api.public.test/",
      {},
      { ...sandboxFetchPolicy(["api.public.test", "db.internal.test"], ["db.internal.test"]), resolve, connect },
    );
    expect(result.status).toBe(200);
    expect(connect.mock.calls[1][0].address).toBe("10.1.2.3");
  });
});

describe("review follow-ups", () => {
  // M1: other clouds' metadata endpoints and transition encodings of them.
  it.each([
    "169.254.170.23", // EKS Pod Identity
    "fd00:ec2::23", // EKS Pod Identity (IPv6)
    "fd20:ce::254", // GCE metadata (IPv6)
    "100.100.100.200", // Alibaba Cloud
    "2002:a9fe:a9fe::", // 6to4 of 169.254.169.254
    "2002:a9fe:a9fe:1::5", // 6to4, any interface id
    "2002:6464:64c8::1", // 6to4 of 100.100.100.200
    "64:ff9b::a9fe:aa17", // NAT64 well-known of 169.254.170.23
    "64:ff9b:1::a9fe:a9fe", // RFC 8215 local-use NAT64, /96 layout
    "64:ff9b:1:a9fe:a9:fe00::", // RFC 8215 local-use NAT64, RFC 6052 /48 layout
    "::ffff:100.100.100.200",
  ])("M1: treats %s as cloud metadata", (address) => expect(isCloudMetadataAddress(address)).toBe(true));

  it.each([
    "169.254.170.23",
    "100.100.100.200",
    "[fd20:ce::254]",
    "[fd00:ec2::23]",
    "[2002:a9fe:a9fe::]",
    "[64:ff9b:1::a9fe:a9fe]",
  ])("M1: blocks %s even when both the operator and the tool list it", async (host) => {
    await expectBlocked(`http://${host}/`, [host], [host]);
    await expectBlocked(`http://${host}/`, ["*"], [host]);
  });

  it.each(["2002:808:808::1", "64:ff9b:1::808:808"])("M1: does not flag %s as metadata", (address) =>
    expect(isCloudMetadataAddress(address)).toBe(false),
  );

  // M2: every trailing dot is stripped, so the metadata hostname check can't be dodged.
  it("M2: strips all trailing dots when normalizing", () => {
    expect(normalizeHost("Example.COM..")).toBe("example.com");
    expect(normalizeHost("metadata.google.internal...")).toBe("metadata.google.internal");
  });
  it.each(["http://metadata.google.internal../", "http://metadata../"])(
    "M2: blocks %s by name even if it resolved to a public address",
    async (url) => {
      const publicOnly: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
      await expect(resolveDestination(url, { ...sandboxFetchPolicy(["*"], []), resolve: publicOnly })).rejects.toThrow(
        "fetch_destination_blocked",
      );
    },
  );

  // M3: a bracketed IPv6 literal must be closed.
  it.each(["[::1", "[fd00::1", "[", "[::1]x"])("M3: rejects the malformed bracketed host %s", (host) => {
    expect(() => normalizeHost(host)).toThrow("fetch_destination_blocked");
    expect(() => parseAllowedHosts(host)).toThrow("fetch_destination_blocked");
  });
  it("M3: still accepts a well-formed bracketed IPv6 literal", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
  });

  // M5: zone-scoped answers fail as a policy block, not a raw TypeError.
  it("M5: never treats a zone-scoped address as global or throws on it", () => {
    expect(isGlobalAddress("fe80::1%eth0")).toBe(false);
    expect(isGlobalAddress("2001:4860:4860::8888%eth0")).toBe(false);
    expect(() => isCloudMetadataAddress("fe80::1%eth0")).not.toThrow();
  });
  it.each(["fe80::1%eth0", "2001:4860:4860::8888%1", "fd00:ec2::254%eth0"])(
    "M5: a resolver answer of %s is fetch_destination_blocked, even for an operator-listed host",
    async (address) => {
      const scoped: Resolver = async () => [{ address, family: 6 }];
      const err = await resolveDestination("http://db.internal.test/", {
        ...sandboxFetchPolicy(["db.internal.test"], ["db.internal.test"]),
        resolve: scoped,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("fetch_destination_blocked");
    },
  );
});
