import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  createDecipheriv,
  createHash,
  type KeyObject,
} from "node:crypto";

const ALG = "x25519-hkdf-sha256-chacha20poly1305-v1";
const INFO = Buffer.from("reevo-secret-transfer-v1");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex"); // X25519 SPKI DER header

export interface TransferEnvelope {
  v: number;
  alg: string;
  epk: string;
  nonce: string;
  ct: string;
  tag: string;
}

function rawFromSpki(key: KeyObject): Buffer {
  return (key.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
}

export function loadTransferPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem.trim());
  if (key.asymmetricKeyType !== "x25519") {
    throw new Error("transfer private key must be an X25519 PKCS8 private key");
  }
  return key;
}

export function transferKeyIdOf(privateKey: KeyObject): string {
  const pubRaw = rawFromSpki(createPublicKey(privateKey));
  return createHash("sha256").update(pubRaw).digest("hex").slice(0, 16);
}

function publicFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

export function decryptTransferEnvelope(env: TransferEnvelope, secretName: string, privateKey: KeyObject): string {
  if (env.alg !== ALG) throw new Error(`unsupported envelope alg: ${env.alg}`);
  const epkRaw = Buffer.from(env.epk, "hex");
  const shared = diffieHellman({ privateKey, publicKey: publicFromRaw(epkRaw) });
  const recipientRaw = rawFromSpki(createPublicKey(privateKey));
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkRaw, recipientRaw]), INFO, 32));
  // Supplying the plaintext length satisfies Node's generic AEAD typing and
  // keeps the authenticated-data call explicit for chacha20-poly1305.
  const d = createDecipheriv("chacha20-poly1305", okm, Buffer.from(env.nonce, "hex"), { authTagLength: 16 });
  d.setAAD(Buffer.from(secretName, "utf8"), { plaintextLength: Buffer.byteLength(env.ct, "hex") });
  d.setAuthTag(Buffer.from(env.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(env.ct, "hex")), d.final()]).toString("utf8");
}
