import { expect, it, vi } from "vitest";
import { requireSubject } from "./subject.js";
import { resolvePrincipal } from "../../mcp/auth/principal.js";
import type { PrismaClient } from "@prisma/client";

it.each([undefined, null, 123, "", " \t\n", "a".repeat(513), "é".repeat(257)])("rejects invalid subjects before database access: %j", async (sub) => {
  const upsert = vi.fn();
  expect(() => requireSubject(sub)).toThrow();
  await expect(resolvePrincipal(sub as string, { principal: { upsert } } as unknown as PrismaClient)).rejects.toThrow();
  expect(upsert).not.toHaveBeenCalled();
});
it("preserves issuer-defined case and spacing", () => expect(requireSubject(" User-A ")).toBe(" User-A "));
