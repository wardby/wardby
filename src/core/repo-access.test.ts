import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost, HostPermission } from "../providers/review-host/types.js";
import { ReviewHostError } from "../providers/review-host/types.js";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { child: () => log } }));

const { atLeast, createRepoAccessGate, describeDenial, requiredLevel, trustedAccountsFailure } =
  await import("./repo-access.js");

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
    teams?: { principalId: string; personal?: boolean; members: string[] }[];
    /** A host user id's level, overriding `level`. */
    levels?: Record<string, HostPermission>;
    level?: HostPermission | (() => HostPermission);
    ttlMs?: number;
    maxEntries?: number;
    trustedAccounts?: () => Promise<ReadonlySet<string> | undefined>;
  } = {},
) {
  const identities = [
    ...(opts.identities ?? [{ principalId: "p1", provider: "github", hostUserId: "42", login: "octo" }]),
  ];
  let clock = 1_000_000;
  const repositoryPermission = vi.fn(async (_repository: string, user: { id: string; login: string }) => ({
    level: opts.levels?.[user.id] ?? (typeof opts.level === "function" ? opts.level() : (opts.level ?? "write")),
    login: user.login,
  }));
  const host = { provider: "github", repositoryPermission } as unknown as CodeReviewHost;
  const teams = opts.teams ?? [];
  const db = {
    team: {
      findUnique: vi.fn(async ({ where }: { where: { principalId: string } }) => {
        const t = teams.find((x) => x.principalId === where.principalId);
        return t ? { personal: t.personal ?? false, members: t.members.map((principalId) => ({ principalId })) } : null;
      }),
    },
    hostIdentity: {
      findMany: vi.fn(async ({ where }: { where: { provider: string; principalId: { in: string[] } } }) =>
        identities.filter((i) => i.provider === where.provider && where.principalId.in.includes(i.principalId)),
      ),
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
    trustedAccounts: opts.trustedAccounts,
    now: () => clock,
    sleep: async () => undefined,
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

describe("team-owned agents", () => {
  const ident = (principalId: string, hostUserId: string): Identity => ({
    principalId,
    provider: "github",
    hostUserId,
    login: `login-${hostUserId}`,
  });
  const team = (members: string[], personal = false) => [{ principalId: "team1", personal, members }];

  it("passes when one member has enough access and the rest have none or are unlinked", async () => {
    const { gate } = setup({
      identities: [ident("m1", "1"), ident("m2", "2")],
      teams: team(["m1", "m2", "m3"]),
      levels: { "1": "read", "2": "write" },
    });
    expect(await gate.authorizeUse(use({ ownerId: "team1" }))).toEqual({ ok: true, level: "write" });
  });

  it("needs only read for a read link", async () => {
    const { gate } = setup({ identities: [ident("m1", "1")], teams: team(["m1"]), levels: { "1": "read" } });
    expect(await gate.authorizeUse(use({ ownerId: "team1", required: "read" }))).toEqual({ ok: true, level: "read" });
    expect(await gate.authorizeUse(use({ ownerId: "team1", required: "write" }))).toEqual({
      ok: false,
      reason: "insufficient_permission",
      level: "read",
    });
  });

  it("fails again once the last member with access is removed", async () => {
    const members = ["m1", "m2"];
    const teams = [{ principalId: "team1", members }];
    const { gate } = setup({
      identities: [ident("m1", "1"), ident("m2", "2")],
      teams,
      levels: { "1": "write", "2": "read" },
    });
    expect((await gate.authorizeUse(use({ ownerId: "team1" }))).ok).toBe(true);
    members.splice(0, 1); // m1 leaves; the cached GitHub answer for m1 must not count
    expect(await gate.authorizeUse(use({ ownerId: "team1" }))).toEqual({
      ok: false,
      reason: "insufficient_permission",
      level: "read",
    });
  });

  it("is identity_not_linked when no member has a linked account, or the team is empty", async () => {
    const none = setup({ identities: [], teams: team(["m1", "m2"]) });
    expect(await none.gate.authorizeUse(use({ ownerId: "team1" }))).toEqual({
      ok: false,
      reason: "identity_not_linked",
    });
    expect(none.repositoryPermission).not.toHaveBeenCalled();
    const empty = setup({ identities: [], teams: team([]) });
    expect(await empty.gate.authorizeUse(use({ ownerId: "team1" }))).toEqual({
      ok: false,
      reason: "identity_not_linked",
    });
  });

  it("denies when a member's lookup fails and nobody else passes (fail closed)", async () => {
    const { gate, repositoryPermission } = setup({
      identities: [ident("m1", "1"), ident("m2", "2")],
      teams: team(["m1", "m2"]),
      levels: { "2": "read" },
    });
    repositoryPermission.mockImplementationOnce(async () => {
      throw new ReviewHostError("host_api_error", "github_api_error:500");
    });
    expect(await gate.authorizeUse(use({ ownerId: "team1" }))).toEqual({ ok: false, reason: "check_failed" });
  });

  it("still passes when one member's lookup fails but another has access", async () => {
    const { gate, repositoryPermission } = setup({
      identities: [ident("m1", "1"), ident("m2", "2")],
      teams: team(["m1", "m2"]),
      levels: { "2": "write" },
    });
    repositoryPermission.mockImplementationOnce(async () => {
      throw new ReviewHostError("host_api_error", "github_api_error:500");
    });
    expect((await gate.authorizeUse(use({ ownerId: "team1" }))).ok).toBe(true);
  });

  describe("which members passed", () => {
    const passedLines = () => log.debug.mock.calls.filter(([, msg]) => /passed the repository access check/.test(msg));

    it("logs only the member who passed, with their id and level, at debug level", async () => {
      log.debug.mockClear();
      log.info.mockClear();
      const { gate } = setup({
        identities: [ident("m1", "1"), ident("m2", "2")],
        teams: team(["m1", "m2", "m3"]),
        levels: { "1": "read", "2": "admin" },
      });
      await gate.authorizeUse(use({ ownerId: "team1" }));
      expect(passedLines()).toHaveLength(1);
      expect(passedLines()[0][0]).toEqual({
        provider: "github",
        repository: REPO,
        members: 3,
        linked: 2,
        passed: [{ hostUserId: "2", level: "admin", cached: false }],
      });
      expect(log.info).not.toHaveBeenCalled();
    });

    it("logs every member who passed, the same line whatever order the database returns them in", async () => {
      const lineFor = async (identities: Identity[]) => {
        log.debug.mockClear();
        const { gate } = setup({
          identities,
          teams: team(["m1", "m2", "m3"]),
          levels: { "1": "write", "2": "write", "3": "read" },
        });
        await gate.authorizeUse(use({ ownerId: "team1" }));
        return passedLines().map(([fields]) => fields);
      };
      const forward = await lineFor([ident("m1", "1"), ident("m2", "2"), ident("m3", "3")]);
      const reversed = await lineFor([ident("m3", "3"), ident("m2", "2"), ident("m1", "1")]);
      expect(forward).toEqual([
        {
          provider: "github",
          repository: REPO,
          members: 3,
          linked: 3,
          passed: [
            { hostUserId: "1", level: "write", cached: false },
            { hostUserId: "2", level: "write", cached: false },
          ],
        },
      ]);
      expect(reversed).toEqual(forward);
    });

    it("says per member when the answer came from the cache", async () => {
      log.debug.mockClear();
      const { gate } = setup({ identities: [ident("m1", "1")], teams: team(["m1"]) });
      await gate.authorizeUse(use({ ownerId: "team1" }));
      await gate.authorizeUse(use({ ownerId: "team1" }));
      expect(passedLines().map(([fields]) => fields.passed)).toEqual([
        [{ hostUserId: "1", level: "write", cached: false }],
        [{ hostUserId: "1", level: "write", cached: true }],
      ]);
    });

    it("lists no unlinked or under-privileged member, and logs nothing at debug when none passes", async () => {
      log.debug.mockClear();
      log.info.mockClear();
      const { gate } = setup({ identities: [ident("m1", "1")], teams: team(["m1", "m2"]), level: "read" });
      await gate.authorizeUse(use({ ownerId: "team1" }));
      expect(passedLines()).toHaveLength(0);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ members: 2, linked: 1, reasons: ["insufficient_permission"] }),
        "no team member passed the repository access check",
      );
    });

    it("never logs a fake secret from a host error, or a login", async () => {
      for (const fn of Object.values(log)) fn.mockClear();
      const { gate, repositoryPermission } = setup({
        identities: [ident("m1", "1"), ident("m2", "2")],
        teams: team(["m1", "m2"]),
        levels: { "2": "write" },
      });
      repositoryPermission.mockImplementationOnce(async () => {
        throw new ReviewHostError("host_api_error", "github_api_error:500 ghs_FAKEINSTALLATIONTOKEN");
      });
      expect((await gate.authorizeUse(use({ ownerId: "team1" }))).ok).toBe(true);
      const debugLines = JSON.stringify(log.debug.mock.calls);
      expect(debugLines).toContain('"hostUserId":"2"');
      expect(debugLines).toContain('"level":"write"');
      expect(debugLines).not.toContain("ghs_FAKEINSTALLATIONTOKEN");
      expect(debugLines).not.toContain("login-");
    });
  });

  it("treats a personal team as the user: the owner's own identity decides", async () => {
    const { gate, db } = setup({
      identities: [ident("p1", "1")],
      teams: [{ principalId: "p1", personal: true, members: ["p1"] }],
    });
    expect((await gate.authorizeUse(use({ ownerId: "p1" }))).ok).toBe(true);
    expect(db.hostIdentity.findMany).not.toHaveBeenCalled();
  });

  it("checks at most the oldest 20 members", async () => {
    const members = Array.from({ length: 30 }, (_, i) => `m${i}`);
    const { gate, db } = setup({
      identities: members.map((m, i) => ident(m, String(i))),
      teams: team(members),
      level: "read",
    });
    await gate.authorizeUse(use({ ownerId: "team1" }));
    const asked = db.hostIdentity.findMany.mock.calls[0][0].where.principalId.in;
    expect(asked).toHaveLength(20);
  });

  it("denies when the member lookup itself throws", async () => {
    const { gate, db } = setup({ teams: team(["m1"]) });
    db.team.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await gate.authorizeUse(use({ ownerId: "team1" }))).toEqual({ ok: false, reason: "check_failed" });
  });
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
    expect(requiredLevel("coding_read")).toBe("read");
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

describe("RepoAccessGate transient host errors (runs in flight)", () => {
  const transient = () => new ReviewHostError("host_api_error", "github_api_error:502");

  it("retries a transient error once for an in-flight use, then fails closed as check_unavailable", async () => {
    const { gate, repositoryPermission } = setup({
      level: () => {
        throw transient();
      },
    });
    expect(await gate.authorizeUse({ ...use(), retryTransient: true })).toEqual({
      ok: false,
      reason: "check_unavailable",
    });
    expect(repositoryPermission).toHaveBeenCalledTimes(2);
  });

  it("succeeds when the retry does", async () => {
    let calls = 0;
    const { gate } = setup({
      level: () => {
        if (calls++ === 0) throw new ReviewHostError("host_api_error", "github_api_unavailable");
        return "write";
      },
    });
    expect(await gate.authorizeUse({ ...use(), retryTransient: true })).toEqual({ ok: true, level: "write" });
  });

  it("classifies rate limits and 5xx as transient, other errors as check_failed without retry", async () => {
    for (const message of ["github_api_error:429", "github_api_error:403:abc", "github_api_error:503"]) {
      const { gate } = setup({
        level: () => {
          throw new ReviewHostError("host_api_error", message);
        },
      });
      expect((await gate.authorizeUse({ ...use(), retryTransient: true })) as unknown, message).toEqual({
        ok: false,
        reason: "check_unavailable",
      });
    }
    const { gate, repositoryPermission } = setup({
      level: () => {
        throw new ReviewHostError("host_not_installed", "github_app_not_installed");
      },
    });
    expect(await gate.authorizeUse({ ...use(), retryTransient: true })).toEqual({ ok: false, reason: "check_failed" });
    expect(repositoryPermission).toHaveBeenCalledTimes(1);
  });

  it("stays strict (no retry, check_failed) without retryTransient", async () => {
    const { gate, repositoryPermission } = setup({
      level: () => {
        throw transient();
      },
    });
    expect(await gate.authorizeUse(use())).toEqual({ ok: false, reason: "check_failed" });
    expect(repositoryPermission).toHaveBeenCalledTimes(1);
  });
});

describe("RepoAccessGate.authorizeUse on local repositories", () => {
  async function withRepo() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "local-gate-")));
    execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
    return root;
  }
  const gateWith = (roots: string[]) =>
    createRepoAccessGate({ db: {} as never, hosts: {}, localRoots: () => roots, sleep: async () => undefined });

  it("allows a repository inside the roots with no owner, host or stamp", async () => {
    const root = await withRepo();
    try {
      const decision = await gateWith([root]).authorizeUse(
        use({ ownerId: null, provider: "github", repository: `local:${root}`, authorizedVia: null }),
      );
      expect(decision).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("denies with local_repo_not_allowed once the roots no longer cover it", async () => {
    const root = await withRepo();
    try {
      const decision = await gateWith(["/nonexistent-root"]).authorizeUse(
        use({ repository: `local:${root}`, authorizedVia: "local_root" }),
      );
      expect(decision).toEqual({ ok: false, reason: "local_repo_not_allowed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("RepoAccessGate trusted GitHub accounts", () => {
  const trusted =
    (...logins: string[]) =>
    async () =>
      new Set(logins) as ReadonlySet<string>;

  it("refuses a repository outside the trusted set before any stamp, owner check, or host call", async () => {
    const { gate, repositoryPermission } = setup({ trustedAccounts: trusted("acme") });
    for (const authorizedVia of ["admin", "grandfathered", "host_permission"]) {
      expect(await gate.authorizeUse(use({ authorizedVia }))).toEqual({
        ok: false,
        reason: "github_account_not_allowed",
      });
    }
    expect(await gate.authorizeUse(use({ ownerId: null }))).toEqual({
      ok: false,
      reason: "github_account_not_allowed",
    });
    expect(
      await gate.authorizePrincipal({ principalId: "p1", provider: "github", repository: REPO, required: "write" }),
    ).toEqual({ ok: false, reason: "github_account_not_allowed" });
    expect(
      await gate.authorizeHostUser({
        provider: "github",
        repository: REPO,
        user: { id: "42", login: "octo" },
        required: "write",
      }),
    ).toEqual({ ok: false, reason: "github_account_not_allowed" });
    expect(await gate.checkAccount!("github", REPO)).toEqual({ ok: false, reason: "github_account_not_allowed" });
    expect(repositoryPermission).not.toHaveBeenCalled();
  });

  it("passes a repository whose owner is trusted (case-insensitive)", async () => {
    const { gate } = setup({ trustedAccounts: trusted("chfields") });
    expect(await gate.authorizeUse(use({ repository: "ChFields/knock-knock-jokes", authorizedVia: "admin" }))).toEqual({
      ok: true,
    });
    expect(await gate.checkAccount!("github", REPO)).toBeUndefined();
  });

  it("fails closed when the trusted set can't be read", async () => {
    const { gate } = setup({
      trustedAccounts: async () => {
        throw new Error("github_api_unavailable");
      },
    });
    expect(await gate.authorizeUse(use({ authorizedVia: "admin" }))).toEqual({ ok: false, reason: "check_failed" });
  });

  it("skips the check when no GitHub App is configured", async () => {
    const { gate } = setup({ trustedAccounts: async () => undefined });
    expect(await gate.authorizeUse(use({ authorizedVia: "admin" }))).toEqual({ ok: true });
  });

  it("keeps the allowlist a hard limit for a coding read link, admin approval included", async () => {
    const saved = process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS;
    process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = "acme";
    try {
      const host = {
        provider: "github",
        repositoryPermission: vi.fn(),
        appOwnerLogin: async () => "owner-org",
      } as unknown as CodeReviewHost;
      const gate = createRepoAccessGate({ db: {} as never, hosts: { github: host } });
      const input = (repository: string) =>
        use({ required: requiredLevel("coding_read"), repository, authorizedVia: "admin" });
      expect(await gate.authorizeUse(input("outside-org/upstream"))).toEqual({
        ok: false,
        reason: "github_account_not_allowed",
      });
      process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = "acme,outside-org";
      expect(await gate.authorizeUse(input("outside-org/upstream"))).toEqual({ ok: true });
    } finally {
      if (saved === undefined) delete process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS;
      else process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = saved;
    }
  });

  it("defaults to the App owner plus WARDBY_GITHUB_ALLOWED_ACCOUNTS", async () => {
    const saved = process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS;
    process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = "acme";
    try {
      const host = {
        provider: "github",
        repositoryPermission: vi.fn(),
        appOwnerLogin: async () => "owner-org",
      } as unknown as CodeReviewHost;
      const gate = createRepoAccessGate({ db: {} as never, hosts: { github: host } });
      expect(await gate.checkAccount!("github", "owner-org/x")).toBeUndefined();
      expect(await gate.checkAccount!("github", "ACME/x")).toBeUndefined();
      expect(await gate.checkAccount!("github", "stranger/x")).toEqual({
        ok: false,
        reason: "github_account_not_allowed",
      });
    } finally {
      if (saved === undefined) delete process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS;
      else process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = saved;
    }
  });

  it("fails closed on a malformed WARDBY_GITHUB_ALLOWED_ACCOUNTS", async () => {
    const saved = process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS;
    process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = "acme,not a login";
    try {
      const host = {
        provider: "github",
        repositoryPermission: vi.fn(),
        appOwnerLogin: async () => "owner-org",
      } as unknown as CodeReviewHost;
      const gate = createRepoAccessGate({ db: {} as never, hosts: { github: host } });
      expect(await gate.checkAccount!("github", "owner-org/x")).toEqual({ ok: false, reason: "check_failed" });
    } finally {
      if (saved === undefined) delete process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS;
      else process.env.WARDBY_GITHUB_ALLOWED_ACCOUNTS = saved;
    }
  });

  it("reduces a lookup failure to a fixed code, never the error's own text", () => {
    expect(trustedAccountsFailure(new Error("github_allowed_accounts_invalid"))).toBe(
      "github_allowed_accounts_invalid",
    );
    expect(trustedAccountsFailure(new Error("github_api_unavailable"))).toBe("github_api_unavailable");
    expect(trustedAccountsFailure(new Error("github_api_error:502:ABC"))).toBe("github_api_error");
    expect(trustedAccountsFailure(new Error('WARDBY_GITHUB_ALLOWED_ACCOUNTS: "x y" is not a GitHub login.'))).toBe(
      "unexpected_error",
    );
    expect(trustedAccountsFailure("boom")).toBe("unexpected_error");
  });

  it("describes the denial with its code", () => {
    expect(describeDenial({ ok: false, reason: "github_account_not_allowed" }, REPO)).toMatch(
      /^github_account_not_allowed: .*WARDBY_GITHUB_ALLOWED_ACCOUNTS/,
    );
  });
});
