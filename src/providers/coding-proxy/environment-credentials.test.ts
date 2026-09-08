import { describe, expect, it } from "vitest";
import { EnvironmentCredentialResolver } from "./environment-credentials.js";

describe("EnvironmentCredentialResolver", () => {
  it("resolves only uppercase environment references", async () => {
    const resolver = new EnvironmentCredentialResolver({ OPENAI_API_KEY: "test-secret" });
    await expect(resolver.resolve("env:OPENAI_API_KEY")).resolves.toBe("test-secret");
    await expect(resolver.resolve("env:openai_api_key")).rejects.toThrow("coding_credential_reference_invalid");
    await expect(resolver.resolve("vault:openai")).rejects.toThrow("coding_credential_reference_invalid");
  });

  it("does not fabricate unavailable credentials", async () => {
    const resolver = new EnvironmentCredentialResolver({});
    await expect(resolver.resolve("env:OPENAI_API_KEY")).rejects.toThrow("coding_credential_unavailable");
  });
});
