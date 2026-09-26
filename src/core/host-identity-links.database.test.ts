import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HostUserAuthorizer } from "../providers/review-host/types.js";
import { createPrismaClient } from "./db.js";
import {
  completeHostIdentityCallback,
  confirmHostIdentityLink,
  HostLinkError,
  startHostIdentityLink,
} from "./host-identity-links.js";

const db = createPrismaClient();
const principalIds: string[] = [];
const REDIRECT = "https://wardby.example/hosts/github/user-callback";

async function principal() {
  const p = await db.principal.create({ data: { subject: `link-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

/** A fake GitHub web flow: the authorize URL carries state and challenge; complete answers as `user`. */
function fakeAuthorizer(user: { hostUserId: string; login: string } | Error) {
  const complete = vi.fn(async (_input: { code: string; codeVerifier: string; redirectUri: string }) => {
    if (user instanceof Error) throw user;
    return user;
  });
  const authorizer: HostUserAuthorizer = {
    provider: "github",
    authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
      `https://github.example/authorize?${new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri }).toString()}`,
    complete,
  };
  return { authorizer, complete };
}

const uniqueUserId = () => String(Math.floor(Math.random() * 1e12) + 1);

async function linkThroughCallback(principalId: string, authorizer: HostUserAuthorizer, now?: Date) {
  const started = await startHostIdentityLink({ db, authorizer, principalId, redirectUri: REDIRECT, now });
  const params = new URL(started.authorizeUrl).searchParams;
  const outcome = await completeHostIdentityCallback({
    db,
    authorizer,
    state: params.get("state"),
    code: "gh-code",
    redirectUri: REDIRECT,
    now,
  });
  return { started, params, outcome };
}

describe.skipIf(!process.env.DATABASE_URL)("host identity linking (PostgreSQL)", () => {
  afterAll(async () => {
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("links through state, PKCE, and a one-time code confirmed by the same principal", async () => {
    const p = await principal();
    const hostUserId = uniqueUserId();
    const { authorizer, complete } = fakeAuthorizer({ hostUserId, login: "octo" });
    const { started, params, outcome } = await linkThroughCallback(p.id, authorizer);

    expect(started.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    const { codeVerifier } = complete.mock.calls[0][0];
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(createHash("sha256").update(codeVerifier).digest("base64url")).toBe(params.get("code_challenge"));
    expect(complete.mock.calls[0][0]).toMatchObject({ code: "gh-code", redirectUri: REDIRECT });
    // Neither the state nor the confirmation code is stored in the clear.
    const stored = await db.hostIdentityLinkRequest.findFirstOrThrow({ where: { principalId: p.id } });
    expect(stored.stateHash).not.toBe(params.get("state"));

    expect(outcome).toMatchObject({ kind: "confirm", login: "octo", subject: p.subject });
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    expect(outcome.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(stored.confirmHash).not.toContain(outcome.code.replace("-", ""));

    await expect(
      confirmHostIdentityLink({
        db,
        principalId: p.id,
        provider: "github",
        confirmationCode: outcome.code.toLowerCase(),
      }),
    ).resolves.toEqual({ hostUserId, login: "octo" });
    expect(
      await db.hostIdentity.findUnique({ where: { principalId_provider: { principalId: p.id, provider: "github" } } }),
    ).toMatchObject({
      hostUserId,
      login: "octo",
    });
    expect(await db.hostIdentityLinkRequest.count({ where: { principalId: p.id } })).toBe(0);
  });

  it("refuses a replayed state without calling the host again", async () => {
    const p = await principal();
    const { authorizer, complete } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "octo" });
    const { params } = await linkThroughCallback(p.id, authorizer);
    const replay = await completeHostIdentityCallback({
      db,
      authorizer,
      state: params.get("state"),
      code: "gh-code",
      redirectUri: REDIRECT,
    });
    expect(replay).toEqual({ kind: "invalid" });
    expect(complete).toHaveBeenCalledTimes(1);
    for (const state of [null, "", "unknown-state"]) {
      expect(await completeHostIdentityCallback({ db, authorizer, state, code: "c", redirectUri: REDIRECT })).toEqual({
        kind: "invalid",
      });
    }
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("refuses an expired request at the callback and at confirmation", async () => {
    const p = await principal();
    const { authorizer, complete } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "octo" });
    const past = new Date(Date.now() - 11 * 60_000);
    const started = await startHostIdentityLink({
      db,
      authorizer,
      principalId: p.id,
      redirectUri: REDIRECT,
      now: past,
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    expect(await completeHostIdentityCallback({ db, authorizer, state, code: "c", redirectUri: REDIRECT })).toEqual({
      kind: "invalid",
    });
    expect(complete).not.toHaveBeenCalled();

    // Completed in time, but confirmed too late.
    const q = await principal();
    const early = new Date(Date.now() - 10 * 60_000 + 1000);
    const { outcome } = await linkThroughCallback(q.id, authorizer, early);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    await new Promise((r) => setTimeout(r, 1100));
    await expect(
      confirmHostIdentityLink({ db, principalId: q.id, provider: "github", confirmationCode: outcome.code }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("binds the code to the initiating principal: another principal cannot use it", async () => {
    const attacker = await principal();
    const victim = await principal();
    const { authorizer } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "victim" });
    const { outcome } = await linkThroughCallback(attacker.id, authorizer);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    // The callback page names whose wardby account is being linked.
    expect(outcome.subject).toBe(attacker.subject);
    const err = await confirmHostIdentityLink({
      db,
      principalId: victim.id,
      provider: "github",
      confirmationCode: outcome.code,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostLinkError);
    expect((err as HostLinkError).status).toBe(404);
    expect(await db.hostIdentity.count({ where: { principalId: victim.id } })).toBe(0);
  });

  it("kills the request after 5 wrong codes", async () => {
    const p = await principal();
    const { authorizer } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "octo" });
    const { outcome } = await linkThroughCallback(p.id, authorizer);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const wrong = outcome.code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    for (let i = 0; i < 5; i++) {
      await expect(
        confirmHostIdentityLink({ db, principalId: p.id, provider: "github", confirmationCode: wrong }),
      ).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      confirmHostIdentityLink({ db, principalId: p.id, provider: "github", confirmationCode: outcome.code }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.hostIdentity.count({ where: { principalId: p.id } })).toBe(0);
  });

  it("counts attempts atomically: concurrent wrong guesses get at most 5 comparisons", async () => {
    const p = await principal();
    const { authorizer } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "octo" });
    const { outcome } = await linkThroughCallback(p.id, authorizer);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const wrong = outcome.code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        confirmHostIdentityLink({ db, principalId: p.id, provider: "github", confirmationCode: wrong }).then(
          () => 0,
          (e: HostLinkError) => e.status,
        ),
      ),
    );
    expect(results.filter((s) => s === 400).length).toBeLessThanOrEqual(5);
    expect(results.every((s) => s === 400 || s === 404)).toBe(true);
    expect((await db.hostIdentityLinkRequest.findFirstOrThrow({ where: { principalId: p.id } })).attempts).toBe(5);
    await expect(
      confirmHostIdentityLink({ db, principalId: p.id, provider: "github", confirmationCode: outcome.code }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a malformed code without spending an attempt", async () => {
    const p = await principal();
    const { authorizer } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "octo" });
    const { outcome } = await linkThroughCallback(p.id, authorizer);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    await expect(
      confirmHostIdentityLink({ db, principalId: p.id, provider: "github", confirmationCode: "not-a-code!" }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await db.hostIdentityLinkRequest.findFirstOrThrow({ where: { principalId: p.id } })).attempts).toBe(0);
  });

  it("refuses a GitHub account already linked to another principal (409), and relinks the same principal", async () => {
    const first = await principal();
    const second = await principal();
    const hostUserId = uniqueUserId();
    const { authorizer } = fakeAuthorizer({ hostUserId, login: "shared" });
    const a = await linkThroughCallback(first.id, authorizer);
    if (a.outcome.kind !== "confirm") throw new Error("expected a code");
    await confirmHostIdentityLink({ db, principalId: first.id, provider: "github", confirmationCode: a.outcome.code });

    const b = await linkThroughCallback(second.id, authorizer);
    if (b.outcome.kind !== "confirm") throw new Error("expected a code");
    const err = await confirmHostIdentityLink({
      db,
      principalId: second.id,
      provider: "github",
      confirmationCode: b.outcome.code,
    }).catch((e: unknown) => e as HostLinkError);
    expect(err).toMatchObject({ status: 409 });
    expect((err as Error).message).toMatch(/operator/);
    expect((err as Error).message).not.toContain(first.subject);

    const other = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "renamed-account" });
    const c = await linkThroughCallback(first.id, other.authorizer);
    if (c.outcome.kind !== "confirm") throw new Error("expected a code");
    await confirmHostIdentityLink({ db, principalId: first.id, provider: "github", confirmationCode: c.outcome.code });
    expect(await db.hostIdentity.findMany({ where: { principalId: first.id } })).toEqual([
      expect.objectContaining({ login: "renamed-account" }),
    ]);
  });

  it("marks a request dead when the host exchange fails, and limits pending requests", async () => {
    const p = await principal();
    const failing = fakeAuthorizer(new Error("exchange failed"));
    const { outcome, params } = await linkThroughCallback(p.id, failing.authorizer);
    expect(outcome).toEqual({ kind: "failed" });
    expect(
      await completeHostIdentityCallback({
        db,
        authorizer: failing.authorizer,
        state: params.get("state"),
        code: "c",
        redirectUri: REDIRECT,
      }),
    ).toEqual({ kind: "invalid" });

    const q = await principal();
    const { authorizer } = fakeAuthorizer({ hostUserId: uniqueUserId(), login: "octo" });
    for (let i = 0; i < 5; i++)
      await startHostIdentityLink({ db, authorizer, principalId: q.id, redirectUri: REDIRECT });
    await expect(
      startHostIdentityLink({ db, authorizer, principalId: q.id, redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
