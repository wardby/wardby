import { describe, it, expect } from "vitest";
import { buildSecretCipher, AppKeySecretCipher } from "./index.js";

describe("buildSecretCipher", () => {
  it("builds an AppKeySecretCipher for app-key with a configured key", () => {
    const cipher = buildSecretCipher({ secrets: "app-key" }, { SECRET_APP_KEY: "0".repeat(64) });
    expect(cipher).toBeInstanceOf(AppKeySecretCipher);
  });

  it("throws for kms (reserved, no adapter)", () => {
    expect(() => buildSecretCipher({ secrets: "kms" }, {})).toThrow(/reserved/);
  });

  it("throws for app-key with no SECRET_APP_KEY set", () => {
    expect(() => buildSecretCipher({ secrets: "app-key" }, {})).toThrow(/SECRET_APP_KEY/);
  });
});
