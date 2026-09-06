import { describe, it, expect } from "vitest";
import { AppKeySecretCipher } from "./app-key.js";

const key = "0".repeat(64); // 32 bytes hex

describe("AppKeySecretCipher", () => {
  it("round-trips and never emits plaintext", async () => {
    const c = new AppKeySecretCipher(key);
    const ct = await c.encrypt("s3cr3t");
    expect(ct).not.toContain("s3cr3t");
    expect(await c.decrypt(ct)).toBe("s3cr3t");
    expect(c.keyId()).toMatch(/^appkey:/);
  });

  it("distinct ciphertexts for same plaintext (random IV)", async () => {
    const c = new AppKeySecretCipher(key);
    expect(await c.encrypt("x")).not.toBe(await c.encrypt("x"));
  });

  it("tampered ciphertext fails auth tag", async () => {
    const c = new AppKeySecretCipher(key);
    const ct = await c.encrypt("x");
    await expect(c.decrypt(ct.slice(0, -2) + "00")).rejects.toThrow();
  });

  it("rejects a key that isn't 32 bytes of hex", () => {
    expect(() => new AppKeySecretCipher("too-short")).toThrow();
  });
});
