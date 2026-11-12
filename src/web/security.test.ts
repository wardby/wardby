import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCsrf, assertSameOrigin, pageHeaders } from "./security.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const ORIGIN = "https://docs.example.test";
const req = (method: string, headers: Record<string, string | undefined> = {}) => ({ method, headers });

describe("pageHeaders", () => {
  it("returns the exact strict headers with the nonce and no 'unsafe-inline'", () => {
    const h = pageHeaders("abc123");
    expect(h).toEqual({
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'nonce-abc123'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
    });
    expect(JSON.stringify(h)).not.toContain("unsafe-inline");
  });

  it("refuses a nonce that could break out of the policy", () => {
    expect(() => pageHeaders("a'; script-src *")).toThrow();
    expect(() => pageHeaders("")).toThrow();
  });
});

describe("assertSameOrigin", () => {
  it("accepts a POST, PUT, PATCH and DELETE from the canonical origin", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"])
      expect(() => assertSameOrigin(req(m, { origin: ORIGIN }), `${ORIGIN}/some/path`)).not.toThrow();
  });

  it("throws web_origin_rejected for a cross-origin POST", () => {
    expect(() => assertSameOrigin(req("POST", { origin: "https://evil.example" }), ORIGIN)).toThrow(
      "web_origin_rejected",
    );
  });

  it("throws web_origin_rejected for a missing, null, or look-alike Origin", () => {
    expect(() => assertSameOrigin(req("POST"), ORIGIN)).toThrow("web_origin_rejected");
    expect(() => assertSameOrigin(req("POST", { origin: "null" }), ORIGIN)).toThrow("web_origin_rejected");
    expect(() => assertSameOrigin(req("DELETE", { origin: "http://docs.example.test" }), ORIGIN)).toThrow(
      "web_origin_rejected",
    );
    expect(() => assertSameOrigin(req("PUT", { origin: `${ORIGIN}.evil.example` }), ORIGIN)).toThrow(
      "web_origin_rejected",
    );
  });

  it("does not require Origin on GET or HEAD", () => {
    expect(() => assertSameOrigin(req("GET"), ORIGIN)).not.toThrow();
    expect(() => assertSameOrigin(req("HEAD"), ORIGIN)).not.toThrow();
  });
});

describe("assertCsrf", () => {
  const csrf = "Zm9vYmFyLWNzcmYtdG9rZW4tdmFsdWUtMzItYnl0ZXM";
  const session = { csrfHash: sha(csrf) };

  it("accepts the matching x-wardby-csrf header", () => {
    expect(() => assertCsrf(req("POST", { "x-wardby-csrf": csrf }), session)).not.toThrow();
  });

  it("throws web_csrf_failed on a mismatched header", () => {
    expect(() => assertCsrf(req("POST", { "x-wardby-csrf": csrf + "x" }), session)).toThrow("web_csrf_failed");
    expect(() => assertCsrf(req("POST", { "x-wardby-csrf": "wrong" }), session)).toThrow("web_csrf_failed");
  });

  it("throws web_csrf_failed on a missing header or a malformed stored hash", () => {
    expect(() => assertCsrf(req("DELETE"), session)).toThrow("web_csrf_failed");
    expect(() => assertCsrf(req("POST", { "x-wardby-csrf": csrf }), { csrfHash: "short" })).toThrow("web_csrf_failed");
  });

  it("never echoes the submitted value in the error", () => {
    try {
      assertCsrf(req("POST", { "x-wardby-csrf": "secret-csrf-value" }), session);
    } catch (e) {
      expect(String(e)).not.toContain("secret-csrf-value");
    }
  });
});
