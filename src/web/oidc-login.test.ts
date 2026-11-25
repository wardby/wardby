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
  });
});

describe("loadWebOidcConfig subject settings", () => {
  it("defaults to sub and reads a claim", () => {
    expect(loadWebOidcConfig({}).subjectClaim).toBe("sub");
    expect(loadWebOidcConfig({ WEB_OIDC_SUBJECT_CLAIM: " wardby_sub " }).subjectClaim).toBe("wardby_sub");
  });

  it("refuses an invalid claim name", () => {
    expect(() => loadWebOidcConfig({ WEB_OIDC_SUBJECT_CLAIM: "has space" })).toThrow(/WEB_OIDC_SUBJECT_CLAIM/);
  });
});
