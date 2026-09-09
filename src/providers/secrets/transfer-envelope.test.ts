import { describe, it, expect } from "vitest";
import {
  generateKeyPairSync, diffieHellman, hkdfSync, randomBytes,
  createCipheriv, createPublicKey, type KeyObject, type CipherGCM,
} from "node:crypto";
import {
  loadTransferPrivateKey, transferKeyIdOf, decryptTransferEnvelope, type TransferEnvelope,
} from "./transfer-envelope.js";

const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const INFO = Buffer.from("reevo-secret-transfer-v1");
const rawOf = (k: KeyObject) => (k.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);

// Test-only sealer matching spec §5.3 (mirrors the exporter).
function seal(plaintext: string, name: string, recipientPub: KeyObject): TransferEnvelope {
  const { privateKey: esk, publicKey: epk } = generateKeyPairSync("x25519");
  const epkRaw = rawOf(epk);
  const shared = diffieHellman({ privateKey: esk, publicKey: recipientPub });
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkRaw, rawOf(recipientPub)]), INFO, 32));
  const nonce = randomBytes(12);
  const c = createCipheriv("chacha20-poly1305", okm, nonce, { authTagLength: 16 }) as CipherGCM;
  c.setAAD(Buffer.from(name, "utf8"));
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return { v: 1, alg: "x25519-hkdf-sha256-chacha20poly1305-v1",
    epk: epkRaw.toString("hex"), nonce: nonce.toString("hex"),
    ct: ct.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

describe("transfer-envelope decrypt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const priv = loadTransferPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }) as string);

  it("round-trips a sealed secret", () => {
    const env = seal("s3cr3t-value", "API_KEY", publicKey);
    expect(decryptTransferEnvelope(env, "API_KEY", priv)).toBe("s3cr3t-value");
  });

  it("fails when the AAD (secret name) differs", () => {
    const env = seal("v", "API_KEY", publicKey);
    expect(() => decryptTransferEnvelope(env, "OTHER_NAME", priv)).toThrow();
  });

  it("fails on a tampered ciphertext", () => {
    const env = seal("v", "API_KEY", publicKey);
    const bad = { ...env, ct: env.ct.replace(/.$/, (c) => (c === "0" ? "1" : "0")) };
    expect(() => decryptTransferEnvelope(bad, "API_KEY", priv)).toThrow();
  });

  it("rejects a non-X25519 PEM", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => loadTransferPrivateKey(rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string)).toThrow();
  });

  it("derives the 16-hex transferKeyId of the public half", () => {
    expect(transferKeyIdOf(priv)).toMatch(/^[0-9a-f]{16}$/);
  });
});
