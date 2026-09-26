import { describe, it, expect } from "vitest";
import { authConfigWarnings, buildAuthProvider, DelegatingAuthProvider, SelfHostedAuthProvider } from "./index.js";

// buildAuthProvider's own branching (which adapter, self-hosted's required
// config) is otherwise untested — a fake PrismaClient is enough since
// neither branch queries the DB during construction.
const fakeDb = {} as unknown as Parameters<typeof buildAuthProvider>[2];

describe("buildAuthProvider", () => {
  it("builds a DelegatingAuthProvider for delegating (default)", () => {
    const provider = buildAuthProvider(
      "delegating",
      { issuer: "https://idp.example.com", audience: "https://host/mcp", jwksUri: "https://idp.example.com/jwks" },
      fakeDb,
    );
    expect(provider).toBeInstanceOf(DelegatingAuthProvider);
  });

  it("builds a SelfHostedAuthProvider when all keys are configured", () => {
    const provider = buildAuthProvider(
      "self-hosted",
      {
        audience: "https://host/mcp",
        signingKey: "a1".repeat(32),
        credentialHashKey: "b2".repeat(32),
      },
      fakeDb,
    );
    expect(provider).toBeInstanceOf(SelfHostedAuthProvider);
  });

  it("throws for self-hosted with missing audience or keys", () => {
    expect(() => buildAuthProvider("self-hosted", {}, fakeDb)).toThrow(/AUTH_AUDIENCE/);
  });
});

describe("authConfigWarnings", () => {
  it("warns that AUTH_ROLE_CLAIM / AUTH_ROLE_MAP are ignored in self-hosted mode", () => {
    const warnings = authConfigWarnings("self-hosted", { roleClaim: "groups", roleMap: "a=admin" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/AUTH_ROLE_CLAIM.*AUTH_ROLE_MAP.*ignored.*self-hosted.*auth user grant/s);
    expect(authConfigWarnings("self-hosted", { roleMap: "a=admin" })).toHaveLength(1);
  });
  it("is silent when unset in self-hosted mode, and in delegating mode", () => {
    expect(authConfigWarnings("self-hosted", {})).toEqual([]);
    expect(authConfigWarnings("delegating", { roleClaim: "groups", roleMap: "a=admin" })).toEqual([]);
  });
});
