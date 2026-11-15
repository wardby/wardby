import { describe, expect, it, vi } from "vitest";
import type { RepoAccessGate } from "./repo-access.js";
import { authorizeRepositoryLink } from "./runner.js";

function setup(row: Record<string, unknown> | null) {
  const authorizeUse = vi.fn(async () => ({ ok: true as const }));
  const db = { agentRepository: { findUnique: vi.fn(async () => row) } };
  return { authorizeUse, db: db as never, gate: { authorizeUse } as unknown as RepoAccessGate };
}
const row = (over: Record<string, unknown> = {}) => ({
  provider: "github",
  repository: "acme/web",
  access: "write",
  authorizedVia: null,
  agent: { ownerId: "o1" },
  ...over,
});
const link = { provider: "github", repository: "acme/web", access: "write" };

describe("authorizeRepositoryLink", () => {
  it("authorizes a matching link", async () => {
    const s = setup(row());
    expect(await authorizeRepositoryLink(s.db, s.gate, "a1", link)).toEqual({ ok: true });
  });
  it("refuses when the stored provider differs from the pinned link", async () => {
    const s = setup(row({ provider: "bitbucket" }));
    expect(await authorizeRepositoryLink(s.db, s.gate, "a1", link)).toEqual({ ok: false, reason: "not_authorized" });
    expect(s.authorizeUse).not.toHaveBeenCalled();
  });
  it("refuses when the stored repository differs", async () => {
    const s = setup(row({ repository: "acme/other" }));
    expect(await authorizeRepositoryLink(s.db, s.gate, "a1", link)).toEqual({ ok: false, reason: "not_authorized" });
  });
  it("refuses a removed link and a write link downgraded to read", async () => {
    expect((await authorizeRepositoryLink(setup(null).db, setup(null).gate, "a1", link)).ok).toBe(false);
    const s = setup(row({ access: "read" }));
    expect((await authorizeRepositoryLink(s.db, s.gate, "a1", link)).ok).toBe(false);
  });
});
