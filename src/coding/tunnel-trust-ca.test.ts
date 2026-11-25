import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TUNNEL_CA_BYTES, parseTunnelCaCert, readTunnelCaCert, tunnelCaCertSource } from "./tunnel-trust-ca.js";

const BODY = "ZmFrZS1jZXJ0aWZpY2F0ZS1ib2R5LWZvci1hLXRlc3Q=";
const CERT = `-----BEGIN CERTIFICATE-----\n${BODY}\n-----END CERTIFICATE-----`;

describe("parseTunnelCaCert", () => {
  it("returns the certificate with one trailing newline", () => {
    expect(parseTunnelCaCert(`\n${CERT}\n\n`)).toBe(`${CERT}\n`);
  });

  it("normalizes CRLF line ends and keeps every block", () => {
    const crlf = `${CERT}\n${CERT}`.replace(/\n/g, "\r\n");
    expect(parseTunnelCaCert(crlf)).toBe(`${CERT}\n${CERT}\n`);
  });

  it("refuses text that is not only certificate blocks, without echoing it", () => {
    const secret = "fake-private-key-body-123";
    const key = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(secret).toString("base64")}\n-----END PRIVATE KEY-----`;
    for (const text of ["", "  ", "not a certificate", key, `${CERT}\n${key}`, `${CERT}\n${secret}`]) {
      let message = "";
      try {
        parseTunnelCaCert(text);
      } catch (error) {
        message = String(error instanceof Error ? error.message : error);
      }
      expect(message).toBe("tunnel_ca_invalid");
      expect(message).not.toContain(secret);
    }
  });

  it("refuses a file past the tool runner's per-file limit", () => {
    const big = `-----BEGIN CERTIFICATE-----\n${"A".repeat(MAX_TUNNEL_CA_BYTES)}\n-----END CERTIFICATE-----`;
    expect(() => parseTunnelCaCert(big)).toThrow("tunnel_ca_invalid");
  });
});

describe("readTunnelCaCert", () => {
  it("reads and checks the file, and names a missing one without its path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tunnel-ca-"));
    try {
      const file = join(dir, "ca.crt");
      writeFileSync(file, `${CERT}\n`);
      expect(readTunnelCaCert(file)).toBe(`${CERT}\n`);
      expect(() => readTunnelCaCert(join(dir, "missing.crt"))).toThrow(/^tunnel_ca_unreadable$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tunnelCaCertSource", () => {
  it("throws at start-up for a bad file, then reads the file again on every call", () => {
    const dir = mkdtempSync(join(tmpdir(), "tunnel-ca-"));
    try {
      const file = join(dir, "ca.crt");
      expect(() => tunnelCaCertSource(file)).toThrow(/^tunnel_ca_unreadable$/);
      writeFileSync(file, `${CERT}\n`);
      const source = tunnelCaCertSource(file);
      expect(source()).toBe(`${CERT}\n`);
      const rotated = CERT.replace(BODY, Buffer.from("rotated-certificate").toString("base64"));
      writeFileSync(file, `${rotated}\n`);
      expect(source()).toBe(`${rotated}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the last good certificate when a read fails, and reports the code only", () => {
    const dir = mkdtempSync(join(tmpdir(), "tunnel-ca-"));
    try {
      const file = join(dir, "ca.crt");
      writeFileSync(file, `${CERT}\n`);
      const codes: string[] = [];
      const source = tunnelCaCertSource(file, (code) => codes.push(code));
      writeFileSync(file, "not a certificate");
      expect(source()).toBe(`${CERT}\n`);
      rmSync(file);
      expect(source()).toBe(`${CERT}\n`);
      expect(codes).toEqual(["tunnel_ca_invalid", "tunnel_ca_unreadable"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
