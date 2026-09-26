import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { resolveCliAgentOwner } from "./grants-cli.js";

function db(existing: string[]) {
  return {
    principal: {
      findUnique: vi.fn(async ({ where }: { where: { subject: string } }) =>
        existing.includes(where.subject) ? { id: `id-${where.subject}`, subject: where.subject } : null,
      ),
      upsert: vi.fn(async ({ where }: { where: { subject: string } }) => ({
        id: `id-${where.subject}`,
        subject: where.subject,
      })),
    },
  } as unknown as PrismaClient & { principal: { upsert: ReturnType<typeof vi.fn> } };
}

describe("resolveCliAgentOwner (wardby agent create)", () => {
  it("--owner must name an existing principal; a typo never creates one", async () => {
    const fake = db(["alice"]);
    expect(await resolveCliAgentOwner(fake, "alice", "local")).toBe("id-alice");
    await expect(resolveCliAgentOwner(fake, "alcie", "local")).rejects.toThrow(/alcie/);
    expect(fake.principal.upsert).not.toHaveBeenCalled();
  });

  it("defaults to the local operator (LOCAL_PRINCIPAL), found or created like stdio's", async () => {
    const fake = db([]);
    expect(await resolveCliAgentOwner(fake, undefined, "operator")).toBe("id-operator");
    expect(fake.principal.upsert).toHaveBeenCalledOnce();
  });
});
