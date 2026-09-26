import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { resolveDestination, isCloudMetadataAddress, type Resolver } from "./fetch-policy.js";
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
