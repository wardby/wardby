import { describe, expect, it } from "vitest";
import { displayNameFor, validateGuestName } from "./names.js";

describe("validateGuestName", () => {
  it("accepts and trims a normal guest name", () => {
    expect(validateGuestName("  Dana ", [])).toBe("Dana");
  });

  it.each(["", " ", "x".repeat(41), "Agent Smith", "Bob via Ana", "chris fields"])("rejects %j", (n) => {
    expect(() => validateGuestName(n, ["Chris Fields"])).toThrow("guest_name_invalid");
  });
});

describe("validateGuestName normalization", () => {
  it("treats full-width look-alikes of a member name as the same name", () => {
    expect(() => validateGuestName("\uFF23hris Fields", ["Chris Fields"])).toThrow("guest_name_invalid");
    expect(() => validateGuestName("Chris\u00A0\u00A0Fields", ["Chris Fields"])).toThrow("guest_name_invalid");
  });

  it("refuses full-width forms of the reserved words", () => {
    expect(() => validateGuestName("\uFF41\uFF47\uFF45\uFF4E\uFF54", [])).toThrow("guest_name_invalid");
  });

  it("counts code points, so 40 emoji pass and 41 do not", () => {
    expect(Array.from(validateGuestName("\u{1F600}".repeat(40), []))).toHaveLength(40);
    expect(() => validateGuestName("\u{1F600}".repeat(41), [])).toThrow("guest_name_invalid");
  });
});

describe("displayNameFor", () => {
  it("falls back to GitHub login, then a short subject", () => {
    expect(displayNameFor({ profileName: "Ana Ruiz", subject: "s" })).toBe("Ana Ruiz");
    expect(displayNameFor({ profileName: null, githubLogin: "chfields", subject: "s" })).toBe("@chfields");
    expect(displayNameFor({ subject: "auth0|3f9a8b7c6d" })).toBe("user·3f9a");
  });
});
