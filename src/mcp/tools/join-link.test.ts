import { describe, expect, it } from "vitest";
import {
  JOIN_LINK_GRACE_MS,
  JOIN_LINK_MAX_MS,
  isJoinLinkPayload,
  joinCommandWithLink,
  joinLink,
  joinSessionExpiry,
  parseJoinLink,
} from "./join-link.js";

describe("join link", () => {
  it("round-trips origin and token, with the token in the fragment only", () => {
    const link = joinLink("https://wardby.example.com/mcp", "fake-token");
    expect(link).toBe("https://wardby.example.com/join#fake-token");
    expect(parseJoinLink(link)).toEqual({ origin: "https://wardby.example.com", token: "fake-token" });
  });

  it.each([
    "not a url",
    "https://wardby.example.com/join",
    "https://wardby.example.com/join?t=fake#fake",
    "https://wardby.example.com/other#fake",
    "https://user:pass@wardby.example.com/join#fake",
    "ftp://wardby.example.com/join#fake",
  ])("refuses %s", (link) => {
    expect(parseJoinLink(link)).toBeNull();
  });

  it("ends the session at the run's deadline plus the grace, capped", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    const started = new Date(now - 60_000);
    expect(joinSessionExpiry(now, started, 1800)).toBe(started.getTime() + 1_800_000 + JOIN_LINK_GRACE_MS);
    expect(joinSessionExpiry(now, null, 600)).toBe(now + 600_000 + JOIN_LINK_GRACE_MS);
    expect(joinSessionExpiry(now, started, 10 * 24 * 3600)).toBe(now + JOIN_LINK_MAX_MS);
  });

  it("accepts the operator flag only on a stdio payload", () => {
    const base = { kind: "run-join", runId: "r", principalId: "p", exp: 1 };
    expect(isJoinLinkPayload({ ...base, aud: "stdio", operator: true })).toBe(true);
    expect(isJoinLinkPayload({ ...base, aud: "http", operator: true })).toBe(false);
    expect(isJoinLinkPayload({ ...base, kind: "run-transcript", aud: "http" })).toBe(false);
  });

  it("accepts the owner-all flag (and its roles) only on an HTTP payload", () => {
    const base = { kind: "run-join", runId: "r", principalId: "p", exp: 1 };
    expect(isJoinLinkPayload({ ...base, aud: "http", ownerAll: true, roles: ["wardby_owner"] })).toBe(true);
    expect(isJoinLinkPayload({ ...base, aud: "stdio", ownerAll: true })).toBe(false);
    expect(isJoinLinkPayload({ ...base, aud: "http", roles: ["wardby_owner"] })).toBe(false);
    expect(isJoinLinkPayload({ ...base, aud: "http", ownerAll: false })).toBe(false);
  });

  it("hands out the command with the link single-quoted, and the paste form for anything that could break the quoting", () => {
    expect(joinCommandWithLink("https://app.example.com/join#v1.abc_DEF-123")).toBe(
      "npx @wardby/cli@latest join 'https://app.example.com/join#v1.abc_DEF-123'",
    );
    expect(joinCommandWithLink("https://app.example.com/join#it's")).toBe("npx @wardby/cli@latest join -");
    expect(joinCommandWithLink("https://app.example.com/join#a b")).toBe("npx @wardby/cli@latest join -");
  });
});
