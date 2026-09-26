import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost, HostPermission } from "../providers/review-host/types.js";
import { ReviewHostError } from "../providers/review-host/types.js";
import { atLeast, createRepoAccessGate, requiredLevel } from "./repo-access.js";

const REPO = "chfields/knock-knock-jokes";

interface Identity {
  principalId: string;
  provider: string;
  hostUserId: string;
  login: string;
}

function setup(
  opts: {
    identities?: Identity[];
    level?: HostPermission | (() => HostPermission);
    ttlMs?: number;
    maxEntries?: number;
  } = {},
) {
  const identities = [
    ...(opts.identities ?? [{ principalId: "p1", provider: "github", hostUserId: "42", login: "octo" }]),
  ];
  let clock = 1_000_000;
  const repositoryPermission = vi.fn(async (_repository: string, user: { id: string; login: string }) => ({
    level: typeof opts.level === "function" ? opts.level() : (opts.level ?? "write"),
    login: user.login,
  }));
  const host = { provider: "github", repositoryPermission } as unknown as CodeReviewHost;
  const db = {
    hostIdentity: {
      findUnique: vi.fn(
        async ({ where }: { where: { principalId_provider: { principalId: string; provider: string } } }) => {
          const k = where.principalId_provider;
          return identities.find((i) => i.principalId === k.principalId && i.provider === k.provider) ?? null;
        },
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Partial<Identity>; data: { login: string } }) => {
        const hit = identities.filter((i) => i.principalId === where.principalId && i.hostUserId === where.hostUserId);
        for (const i of hit) i.login = data.login;
        return { count: hit.length };
      }),
    },
  };
  const gate = createRepoAccessGate({
    db: db as never,
    hosts: { github: host },
    ttlMs: opts.ttlMs,
    maxEntries: opts.maxEntries,
    now: () => clock,
  });
  return { gate, repositoryPermission, db, identities, advance: (ms: number) => (clock += ms) };
}

const use = (overrides: Record<string, unknown> = {}) => ({
  ownerId: "p1",
  provider: "github",
  repository: REPO,
  required: "write" as HostPermission,
  authorizedVia: "host_permission" as string | null,
  ...overrides,
});

describe("permission ranks", () => {
  it("ranks none < read < triage < write < maintain < admin", () => {
    expect(atLeast("admin", "write")).toBe(true);
    expect(atLeast("maintain", "write")).toBe(true);
    expect(atLeast("write", "write")).toBe(true);
    expect(atLeast("triage", "write")).toBe(false);
    expect(atLeast("read", "read")).toBe(true);
    expect(atLeast("none", "read")).toBe(false);
  });

  it("needs write for coding, write links and mentions, and read for read links", () => {
    expect(requiredLevel("coding")).toBe("write");
    expect(requiredLevel("write")).toBe("write");
    expect(requiredLevel("mention")).toBe("write");
    expect(requiredLevel("read")).toBe("read");
  });
});

describe("RepoAccessGate.authorizeUse", () => {
  it("refuses an owner-less agent whatever the stamp", async () => {
    const { gate, repositoryPermission } = setup();
    for (const authorizedVia of ["admin", "grandfathered", "host_permission", null]) {
      expect(await gate.authorizeUse(use({ ownerId: null, authorizedVia }))).toEqual({
        ok: false,
        reason: "owner_required",
      });
    }
    expect(repositoryPermission).not.toHaveBeenCalled();
  });

  it("passes admin and grandfathered stamps without asking the host", async () => {
    const { gate, repositoryPermission } = setup({ identities: [] });
    expect(await gate.authorizeUse(use({ authorizedVia: "admin" }))).toEqual({ ok: true });
    expect(await gate.authorizeUse(use({ authorizedVia: "grandfathered" }))).toEqual({ ok: true });
    expect(repositoryPermission).not.toHaveBeenCalled();
  });

  it("fails closed on a missing or unknown stamp", async () => {
    const { gate, repositoryPermission } = setup();
    expect(await gate.authorizeUse(use({ authorizedVia: null }))).toEqual({ ok: false, reason: "not_authorized" });
    expect(await gate.authorizeUse(use({ authorizedVia: "sure" }))).toEqual({ ok: false, reason: "not_authorized" });
    expect(repositoryPermission).not.toHaveBeenCalled();
  });

  it("re-checks a host_permission stamp against the owner's linked identity", async () => {
    const none = setup({ identities: [] });
    expect(await none.gate.authorizeUse(use())).toEqual({ ok: false, reason: "identity_not_linked" });

    const triage = setup({ level: "triage" });
    expect(await triage.gate.authorizeUse(use())).toEqual({
      ok: false,
      reason: "insufficient_permission",
      level: "triage",
    });
    expect(await triage.gate.authorizeUse(use({ required: "read" }))).toEqual({ ok: true, level: "triage" });

    const write = setup({ level: "write" });
    expect(await write.gate.authorizeUse(use())).toEqual({ ok: true, level: "write" });
    expect(write.repositoryPermission).toHaveBeenCalledWith(REPO, { id: "42", login: "octo" });
  });

  it("fails closed when the host errors or is not configured", async () => {
    const { gate } = setup({
      level: () => {
        throw new ReviewHostError("host_api_error");
      },
    });
    expect(await gate.authorizeUse(use())).toEqual({ ok: false, reason: "check_failed" });
    expect(
      await gate.authorizeHostUser({
        provider: "gitlab",
        repository: REPO,
        user: { id: "42", login: "octo" },
        required: "read",
      }),
    ).toEqual({ ok: false, reason: "check_failed" });
  });
});

describe("RepoAccessGate cache", () => {
  it("answers from cache within the TTL and re-queries after it", async () => {
    const { gate, repositoryPermission, advance } = setup();
    await gate.authorizeUse(use());
    await gate.authorizeUse(use());
    expect(repositoryPermission).toHaveBeenCalledTimes(1);
    advance(5 * 60_000 + 1);
    await gate.authorizeUse(use());
    expect(repositoryPermission).toHaveBeenCalledTimes(2);
  });

  it("caches negative results too, and a fresh lookup bypasses and refreshes the cache", async () => {
    let level: HostPermission = "read";
    const { gate, repositoryPermission } = setup({ level: () => level });
    expect((await gate.authorizeUse(use())).ok).toBe(false);
    level = "write";
    expect((await gate.authorizeUse(use())).ok).toBe(false);
    expect(repositoryPermission).toHaveBeenCalledTimes(1);
    expect(
      await gate.authorizePrincipal({
        principalId: "p1",
        provider: "github",
        repository: REPO,
        required: "write",
        fresh: true,
      }),
    ).toEqual({
      ok: true,
      level: "write",
    });
    expect((await gate.authorizeUse(use())).ok).toBe(true);
    expect(repositoryPermission).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed lookup", async () => {
    let fail = true;
    const { gate, repositoryPermission } = setup({
      level: () => {
        if (fail) throw new Error("boom");
        return "write";
      },
    });
    expect((await gate.authorizeUse(use())).ok).toBe(false);
    fail = false;
    expect((await gate.authorizeUse(use())).ok).toBe(true);
    expect(repositoryPermission).toHaveBeenCalledTimes(2);
  });

  it("is bounded by maxEntries, evicting the oldest", async () => {
    const { gate, repositoryPermission } = setup({ maxEntries: 2 });
    for (const repository of ["o/a", "o/b", "o/c"]) await gate.authorizeUse(use({ repository }));
    expect(repositoryPermission).toHaveBeenCalledTimes(3);
    await gate.authorizeUse(use({ repository: "o/c" }));
    expect(repositoryPermission).toHaveBeenCalledTimes(3);
    await gate.authorizeUse(use({ repository: "o/a" }));
    expect(repositoryPermission).toHaveBeenCalledTimes(4);
  });

  it("is keyed by host user id, not login", async () => {
    const { gate, repositoryPermission } = setup();
    await gate.authorizeHostUser({
      provider: "github",
      repository: REPO,
      user: { id: "42", login: "octo" },
      required: "write",
    });
    await gate.authorizeHostUser({
      provider: "github",
      repository: REPO,
      user: { id: "42", login: "OCTO-renamed" },
      required: "write",
    });
    expect(repositoryPermission).toHaveBeenCalledTimes(1);
    await gate.authorizeHostUser({
      provider: "github",
      repository: REPO,
      user: { id: "43", login: "octo" },
      required: "write",
    });
    expect(repositoryPermission).toHaveBeenCalledTimes(2);
  });
});

describe("RepoAccessGate identity upkeep", () => {
  it("updates the stored login when the host reports a rename", async () => {
    const { gate, repositoryPermission, identities } = setup();
    repositoryPermission.mockResolvedValueOnce({ level: "write", login: "octo-new" });
    expect((await gate.authorizeUse(use())).ok).toBe(true);
    expect(identities[0].login).toBe("octo-new");
  });

  it("authorizePrincipal reports an unlinked identity", async () => {
    const { gate } = setup({ identities: [] });
    expect(
      await gate.authorizePrincipal({ principalId: "p1", provider: "github", repository: REPO, required: "read" }),
    ).toEqual({ ok: false, reason: "identity_not_linked" });
  });
});
