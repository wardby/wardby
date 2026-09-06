import { describe, it, expect } from "vitest";
import { buildAuthProvider, DelegatingAuthProvider, SelfHostedAuthProvider } from "./index.js";

// buildAuthProvider's own branching (which adapter, self-hosted's required
// config) is otherwise untested — a fake PrismaClient is enough since
// neither branch queries the DB during construction.
const fakeDb = {} as unknown as Parameters<typeof buildAuthProvider>[2];

describe("buildAuthProvider", () => {
  it("builds a DelegatingAuthProvider for delegating (default)", () => {
    const provider = buildAuthProvider("delegating", { issuer: "https://idp.example.com", audience: "https://host/mcp", jwksUri: "https://idp.example.com/jwks" }, fakeDb);
    expect(provider).toBeInstanceOf(DelegatingAuthProvider);
  });

  it("quarantines self-hosted even with keys configured", () => {
    expect(() => buildAuthProvider("self-hosted", { audience: "https://host/mcp", signingKey: "s".repeat(32) }, fakeDb)).toThrow(/quarantined/);
  });

  it("throws for self-hosted with missing audience/signingKey", () => {
    expect(() => buildAuthProvider("self-hosted", {}, fakeDb)).toThrow(/quarantined/);
  });
});
