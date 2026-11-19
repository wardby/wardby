import { expect, it, vi } from "vitest";
import { requireSubject } from "./subject.js";
import { resolvePrincipal } from "../../mcp/auth/principal.js";
import type { PrismaClient } from "#prisma";

it.each([undefined, null, 123, "", " \t\n", "a".repeat(513), "é".repeat(257)])(
  "rejects invalid subjects before database access: %j",
  async (sub) => {
    const upsert = vi.fn();
    expect(() => requireSubject(sub)).toThrow();
    await expect(
      resolvePrincipal(sub as string, { principal: { upsert } } as unknown as PrismaClient),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  },
);
it("preserves issuer-defined case and spacing", () => expect(requireSubject(" User-A ")).toBe(" User-A "));

// A team's backing principal has a `team:` subject (ADR 0003). No token may carry
// one, or an IdP-minted subject could act as a team and own or read its resources.
it.each(["team:abc", "team:", "team:administrators"])(
  "rejects the reserved team subject %j before database access",
  async (sub) => {
    const upsert = vi.fn();
    expect(() => requireSubject(sub)).toThrow(/reserved/i);
    await expect(resolvePrincipal(sub, { principal: { upsert } } as unknown as PrismaClient)).rejects.toThrow(
      /reserved/i,
    );
    expect(upsert).not.toHaveBeenCalled();
  },
);

it("only reserves the exact team: prefix", () => {
  expect(requireSubject("teams:abc")).toBe("teams:abc");
  expect(requireSubject("Team:abc")).toBe("Team:abc");
  expect(requireSubject("auth0|team:abc")).toBe("auth0|team:abc");
});
