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

describe("displayNameFor", () => {
  it("falls back to GitHub login, then a short subject", () => {
    expect(displayNameFor({ profileName: "Ana Ruiz", subject: "s" })).toBe("Ana Ruiz");
    expect(displayNameFor({ profileName: null, githubLogin: "chfields", subject: "s" })).toBe("@chfields");
    expect(displayNameFor({ subject: "auth0|3f9a8b7c6d" })).toBe("user·3f9a");
  });
});
