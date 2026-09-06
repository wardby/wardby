/**
 * AES-256-GCM SecretCipher adapter, keyed by a single app-wide master key
 * (SECRET_APP_KEY, 32 bytes hex). Ciphertext is a self-describing
 * `iv:tag:ciphertext` base64url blob — random per-call IV (never reused),
 * auth tag verified on decrypt so a tampered ciphertext throws rather than
 * silently returning corrupted plaintext.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export class AppKeySecretCipher {
  private readonly key: Buffer;
  private readonly id: string;

  constructor(hexKey: string) {
    const key = Buffer.from(hexKey, "hex");
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `SECRET_APP_KEY must be ${KEY_BYTES} bytes of hex (${KEY_BYTES * 2} hex chars); got ${key.length} bytes.`,
      );
    }
    this.key = key;
    this.id = `appkey:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
  }

  keyId(): string {
    return this.id;
  }

  async encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${b64url(iv)}:${b64url(tag)}:${b64url(ciphertext)}`;
  }

  async decrypt(blob: string): Promise<string> {
    const parts = blob.split(":");
    if (parts.length !== 3) {
      throw new Error("Malformed ciphertext blob — expected iv:tag:ciphertext.");
    }
    const [ivPart, tagPart, ciphertextPart] = parts;
    const iv = Buffer.from(ivPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  }
}
