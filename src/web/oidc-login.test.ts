import { describe, expect, it } from "vitest";
import { loadWebOidcConfig } from "../config/providers.js";
import { webSubjectFromClaims } from "./oidc-login.js";

describe("webSubjectFromClaims", () => {
  it("reads sub by default, and the configured claim instead when set", () => {
    expect(webSubjectFromClaims({ sub: "00u1", login: "jane.doe" })).toBe("00u1");
    expect(webSubjectFromClaims({ sub: "00u1", login: "jane.doe" }, { subjectClaim: "login" })).toBe("jane.doe");
  });

  it("never falls back to sub when the claim is missing or not a usable string", () => {
    for (const value of [undefined, null, 42, "", "  ", ["jane.doe"]]) {
      expect(() => webSubjectFromClaims({ sub: "00u1", login: value }, { subjectClaim: "login" })).toThrow();
    }
    expect(() => webSubjectFromClaims({ sub: "00u1" }, { subjectClaim: "login" })).toThrow();
    // Only the token's own claims: nothing inherited from Object.prototype.
    expect(() => webSubjectFromClaims({ sub: "00u1" }, { subjectClaim: "constructor" })).toThrow();
  });

  it("refuses the reserved team prefix from any source", () => {
    expect(() => webSubjectFromClaims({ sub: "team:x" })).toThrow(/reserved/);
    expect(() => webSubjectFromClaims({ sub: "00u1", login: "team:x" }, { subjectClaim: "login" })).toThrow(/reserved/);
    expect(() =>
      webSubjectFromClaims(
        { sub: "00u1", email: "team:x@example.com", email_verified: true },
        { subjectEmailDomain: "example.com" },
      ),
    ).toThrow(/reserved/);
  });

  it("takes a verified email's local part at exactly the configured domain", () => {
    const domain = { subjectEmailDomain: "example.com" };
    expect(webSubjectFromClaims({ sub: "00u1", email: "jane.doe@Example.com", email_verified: true }, domain)).toBe(
      "jane.doe",
    );
    for (const claims of [
      { email: "jane.doe@example.com" },
      { email: "jane.doe@example.com", email_verified: "true" },
      { email: "jane.doe@example.com", email_verified: false },
      { email: "jane.doe@sub.example.com", email_verified: true },
      { email: "jane.doe@example.com.evil.test", email_verified: true },
      { email: "jane.doe@evil.test@example.com", email_verified: true },
      { email: "@example.com", email_verified: true },
      { email: "jane.doe", email_verified: true },
      { email_verified: true },
    ]) {
      expect(() => webSubjectFromClaims({ sub: "00u1", ...claims }, domain)).toThrow();
    }
  });
});

describe("loadWebOidcConfig subject settings", () => {
  it("defaults to sub and reads a claim or a lowercased email domain", () => {
    expect(loadWebOidcConfig({}).subjectClaim).toBe("sub");
    expect(loadWebOidcConfig({}).subjectEmailDomain).toBeUndefined();
    expect(loadWebOidcConfig({ WEB_OIDC_SUBJECT_CLAIM: " wardby_sub " }).subjectClaim).toBe("wardby_sub");
    expect(loadWebOidcConfig({ WEB_OIDC_SUBJECT_EMAIL_DOMAIN: " Example.COM " }).subjectEmailDomain).toBe(
      "example.com",
    );
  });

  it("refuses an invalid claim or domain, and both together", () => {
    expect(() => loadWebOidcConfig({ WEB_OIDC_SUBJECT_CLAIM: "has space" })).toThrow(/WEB_OIDC_SUBJECT_CLAIM/);
    for (const domain of ["@example.com", "example", "exa mple.com", "-x.com", "https://example.com"]) {
      expect(() => loadWebOidcConfig({ WEB_OIDC_SUBJECT_EMAIL_DOMAIN: domain })).toThrow(
        /WEB_OIDC_SUBJECT_EMAIL_DOMAIN/,
      );
    }
    expect(() =>
      loadWebOidcConfig({ WEB_OIDC_SUBJECT_CLAIM: "login", WEB_OIDC_SUBJECT_EMAIL_DOMAIN: "example.com" }),
    ).toThrow(/not both/);
  });
});
