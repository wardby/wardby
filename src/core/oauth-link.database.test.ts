import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrismaClient } from "./db.js";
import {
  completeOAuthCallback,
  confirmOAuthLink,
  OAuthLinkError,
  startOAuthLink,
  type OAuthLinkAdapter,
} from "./oauth-link.js";

const logged = vi.hoisted(() => vi.fn());
vi.mock("./logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./logger.js")>();
  const child = real.logger.child.bind(real.logger);
  vi.spyOn(real.logger, "child").mockImplementation((bindings, options) => {
    const log = child(bindings, options);
    if (bindings.module === "oauth-link") {
      for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
        vi.spyOn(log, level).mockImplementation(logged);
      }
    }
    return log;
  });
  return real;
});

const db = createPrismaClient();
const principalIds: string[] = [];
const REDIRECT = "https://wardby.example/oauth/callback";

async function principal() {
  const p = await db.principal.create({ data: { subject: `oauth-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

// Test adapter: counts complete() calls, returns a fake token payload.
const calls: { code: string; codeVerifier: string; redirectUri: string; context: unknown; iss?: string }[] = [];
const testAdapter: OAuthLinkAdapter<{ label: string }, { login: string }> = {
  purpose: "test",
  authorizeUrl: ({ state, codeChallenge, redirectUri, context }) =>
    `https://idp.invalid/authorize?${new URLSearchParams({ state, code_challenge: codeChallenge, redirect_uri: redirectUri, label: context.label }).toString()}`,
  complete: async ({ code, codeVerifier, redirectUri, context, iss }) => {
    calls.push({ code, codeVerifier, redirectUri, context, ...(iss !== undefined ? { iss } : {}) });
    if (code === "bad") throw new Error("idp refused: fake-access-AAAA");
    return { result: { login: "svc-user" }, payload: JSON.stringify({ accessToken: "fake-access-AAAA" }) };
  },
  describe: (r) => ({ signedInAs: r.login, target: "test target", tool: "test_tool" }),
};
const adapters = new Map([["test", testAdapter]]);
const cipher = {
  encrypt: async (v: string) => `enc:${Buffer.from(v).toString("base64")}`,
  decrypt: async (v: string) => Buffer.from(v.slice(4), "base64").toString(),
};
const messages = { noPending: "none pending", usedUp: "used up" };

async function link(principalId: string, opts: { label?: string; code?: string; now?: Date } = {}) {
  const started = await startOAuthLink({
    db,
    adapter: testAdapter,
    principalId,
    context: { label: opts.label ?? "one" },
    redirectUri: REDIRECT,
    now: opts.now,
  });
  const params = new URL(started.authorizeUrl).searchParams;
  const outcome = await completeOAuthCallback({
    db,
    adapters,
    cipher,
    state: params.get("state"),
    code: opts.code ?? "idp-code",
    redirectUri: REDIRECT,
    now: opts.now,
  });
  return { started, params, outcome };
}

function confirm(
  principalId: string,
  code: string,
  extra: Partial<Parameters<typeof confirmOAuthLink<{ login: string }, unknown, unknown>>[0]> = {},
) {
  return confirmOAuthLink<{ login: string }, unknown, unknown>({
    db,
    purpose: "test",
    principalId,
    confirmationCode: code,
    cipher,
    finish: async (_tx, done) => done,
    messages,
    ...extra,
  });
}

describe.skipIf(!process.env.DATABASE_URL)("shared OAuth link flow (PostgreSQL)", () => {
  beforeEach(() => {
    calls.length = 0;
  });
  afterAll(async () => {
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("links through state, PKCE, and a one-time code confirmed by the same principal", async () => {
    const p = await principal();
    const { started, params, outcome } = await link(p.id);
    expect(started.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("redirect_uri")).toBe(REDIRECT);
    expect(calls).toHaveLength(1);
    expect(createHash("sha256").update(calls[0].codeVerifier).digest("base64url")).toBe(params.get("code_challenge"));
    expect(calls[0]).toMatchObject({ code: "idp-code", redirectUri: REDIRECT, context: { label: "one" } });
    const stored = await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: p.id } });
    expect(stored.stateHash).not.toBe(params.get("state"));
    expect(stored.codeVerifier).toBe("");

    expect(outcome).toMatchObject({
      kind: "confirm",
      signedInAs: "svc-user",
      target: "test target",
      tool: "test_tool",
      subject: p.subject,
    });
    if (outcome.kind !== "confirm") throw new Error("unreachable");
    expect(outcome.code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(stored.confirmHash).not.toContain(outcome.code.replace("-", ""));

    const finish = vi.fn(async (_tx: unknown, done: { result: { login: string }; payload?: string }) => done);
    await expect(confirm(p.id, outcome.code.toLowerCase(), { finish })).resolves.toMatchObject({
      result: { login: "svc-user" },
      context: { label: "one" },
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(await db.oAuthLinkRequest.count({ where: { principalId: p.id } })).toBe(0);
  });

  it("stores the payload encrypted and hands it decrypted to finish", async () => {
    const p = await principal();
    const { outcome } = await link(p.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const stored = await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: p.id } });
    expect(stored.payloadCiphertext).not.toBeNull();
    expect(stored.payloadCiphertext).not.toContain("fake-access-AAAA");
    expect(stored.payloadCiphertext).not.toBe(JSON.stringify({ accessToken: "fake-access-AAAA" }));
    expect(JSON.stringify(stored.result)).not.toContain("fake-access-AAAA");
    const done = (await confirm(p.id, outcome.code)) as { payload?: string };
    expect(JSON.parse(done.payload ?? "{}")).toEqual({ accessToken: "fake-access-AAAA" });
  });

  it("refuses a replayed state without calling the adapter again", async () => {
    const p = await principal();
    const { params } = await link(p.id);
    const replay = await completeOAuthCallback({
      db,
      adapters,
      cipher,
      state: params.get("state"),
      code: "idp-code",
      redirectUri: REDIRECT,
    });
    expect(replay).toEqual({ kind: "invalid" });
    expect(calls).toHaveLength(1);
    for (const state of [null, "", "unknown-state"]) {
      expect(await completeOAuthCallback({ db, adapters, cipher, state, code: "c", redirectUri: REDIRECT })).toEqual({
        kind: "invalid",
      });
    }
    expect(calls).toHaveLength(1);
  });

  it("refuses a request whose purpose has no adapter", async () => {
    const p = await principal();
    const { params } = await (async () => {
      const started = await startOAuthLink({
        db,
        adapter: { ...testAdapter, purpose: "other" },
        principalId: p.id,
        context: { label: "x" },
        redirectUri: REDIRECT,
      });
      return { params: new URL(started.authorizeUrl).searchParams };
    })();
    expect(
      await completeOAuthCallback({
        db,
        adapters,
        cipher,
        state: params.get("state"),
        code: "c",
        redirectUri: REDIRECT,
      }),
    ).toEqual({ kind: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("refuses an expired request at the callback and at confirmation", async () => {
    const p = await principal();
    const past = new Date(Date.now() - 11 * 60_000);
    const started = await startOAuthLink({
      db,
      adapter: testAdapter,
      principalId: p.id,
      context: { label: "one" },
      redirectUri: REDIRECT,
      now: past,
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    expect(await completeOAuthCallback({ db, adapters, cipher, state, code: "c", redirectUri: REDIRECT })).toEqual({
      kind: "invalid",
    });
    expect(calls).toHaveLength(0);

    // Completed in time, but confirmed too late.
    const q = await principal();
    const early = new Date(Date.now() - 10 * 60_000 + 1000);
    const { outcome } = await link(q.id, { now: early });
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    await new Promise((r) => setTimeout(r, 1100));
    await expect(confirm(q.id, outcome.code)).rejects.toMatchObject({ status: 404 });
  });

  it("binds the code to the initiating principal: another principal cannot use it", async () => {
    const attacker = await principal();
    const victim = await principal();
    const { outcome } = await link(attacker.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    expect(outcome.subject).toBe(attacker.subject);
    const err = await confirm(victim.id, outcome.code).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthLinkError);
    expect((err as OAuthLinkError).status).toBe(404);
    expect((err as OAuthLinkError).message).toBe("none pending");
  });

  it("kills the request after 5 wrong codes", async () => {
    const p = await principal();
    const { outcome } = await link(p.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const wrong = outcome.code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    for (let i = 0; i < 5; i++) await expect(confirm(p.id, wrong)).rejects.toMatchObject({ status: 400 });
    await expect(confirm(p.id, outcome.code)).rejects.toMatchObject({ status: 404 });
  });

  it("counts attempts atomically: concurrent wrong guesses get at most 5 comparisons", async () => {
    const p = await principal();
    const { outcome } = await link(p.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const wrong = outcome.code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        confirm(p.id, wrong).then(
          () => 0,
          (e: OAuthLinkError) => e.status,
        ),
      ),
    );
    expect(results.filter((s) => s === 400).length).toBeLessThanOrEqual(5);
    expect(results.every((s) => s === 400 || s === 404)).toBe(true);
    expect((await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: p.id } })).attempts).toBe(5);
    await expect(confirm(p.id, outcome.code)).rejects.toMatchObject({ status: 404 });
  });

  it("says 'used up' with the caller's wording on the fifth wrong code", async () => {
    const p = await principal();
    const { outcome } = await link(p.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const wrong = outcome.code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    for (let i = 0; i < 4; i++) await expect(confirm(p.id, wrong)).rejects.toThrow(/attempt/);
    await expect(confirm(p.id, wrong)).rejects.toMatchObject({ status: 400, message: "used up" });
  });

  it("refuses a malformed code without spending an attempt", async () => {
    const p = await principal();
    const { outcome } = await link(p.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    await expect(confirm(p.id, "not-a-code!")).rejects.toMatchObject({ status: 400 });
    expect((await db.oAuthLinkRequest.findFirstOrThrow({ where: { principalId: p.id } })).attempts).toBe(0);
  });

  it("marks a request dead when the exchange fails, never logs its message, and limits pending requests", async () => {
    const p = await principal();
    logged.mockClear();
    const { outcome, params } = await link(p.id, { code: "bad" });
    expect(outcome).toEqual({ kind: "failed" });
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain("fake-access-AAAA");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("idp refused");
    expect(
      await completeOAuthCallback({
        db,
        adapters,
        cipher,
        state: params.get("state"),
        code: "c",
        redirectUri: REDIRECT,
      }),
    ).toEqual({ kind: "invalid" });
    expect(await db.oAuthLinkRequest.count({ where: { principalId: p.id } })).toBe(0);

    const q = await principal();
    for (let i = 0; i < 5; i++) await link(q.id, { code: "never" }).catch(() => undefined);
    await expect(
      startOAuthLink({
        db,
        adapter: testAdapter,
        principalId: q.id,
        context: { label: "one" },
        redirectUri: REDIRECT,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("contextMatch picks the request whose context matches", async () => {
    const p = await principal();
    const a = await link(p.id, { label: "alpha" });
    const b = await link(p.id, { label: "beta" });
    if (a.outcome.kind !== "confirm" || b.outcome.kind !== "confirm") throw new Error("expected codes");
    // The newest request is beta's, but alpha's code with an alpha match finds alpha's.
    const done = (await confirm(p.id, a.outcome.code, {
      contextMatch: (c) => (c as { label: string }).label === "alpha",
    })) as { context: { label: string } };
    expect(done.context.label).toBe("alpha");
    await expect(
      confirm(p.id, b.outcome.code, { contextMatch: (c) => (c as { label: string }).label === "gamma" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(confirm(p.id, b.outcome.code)).resolves.toBeTruthy();
  });

  it("runs prepare once after a correct code, outside the transaction, and passes its value to finish", async () => {
    const p = await principal();
    const { outcome } = await link(p.id);
    if (outcome.kind !== "confirm") throw new Error("expected a code");
    const prepare = vi.fn(async () => "prepared-value");
    const finish = vi.fn(async (_tx: unknown, _done: unknown, prepared: unknown) => prepared);
    const wrong = outcome.code.startsWith("A") ? "BBBB-BBBB" : "AAAA-AAAA";
    await expect(confirm(p.id, wrong, { prepare, finish })).rejects.toMatchObject({ status: 400 });
    expect(prepare).not.toHaveBeenCalled();
    await expect(confirm(p.id, outcome.code, { prepare, finish })).resolves.toBe("prepared-value");
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][2]).toBe("prepared-value");
  });

  it("fails closed when a step after the exchange throws: row gone, failed, nothing logged", async () => {
    const p = await principal();
    const failing = {
      encrypt: async (v: string) => {
        throw new Error(`kms down for ${v}`);
      },
    };
    const started = await startOAuthLink({
      db,
      adapter: testAdapter,
      principalId: p.id,
      context: { label: "one" },
      redirectUri: REDIRECT,
    });
    logged.mockClear();
    const outcome = await completeOAuthCallback({
      db,
      adapters,
      cipher: failing,
      state: new URL(started.authorizeUrl).searchParams.get("state"),
      code: "idp-code",
      redirectUri: REDIRECT,
    });
    expect(outcome).toEqual({ kind: "failed" });
    expect(await db.oAuthLinkRequest.count({ where: { principalId: p.id } })).toBe(0);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toEqual({ purpose: "test" });
    const text = JSON.stringify(logged.mock.calls);
    expect(text).not.toContain("fake-access-AAAA");
    expect(text).not.toContain("kms down");
  });
  it("logs only the adapter's fixed safeReason when the exchange fails, never the error text", async () => {
    const p = await principal();
    const withReason: OAuthLinkAdapter<{ label: string }, { login: string }> = {
      ...testAdapter,
      complete: async () => {
        throw new Error("github_oauth_exchange_failed:redirect_uri_mismatch: fake-access-AAAA leaked");
      },
      safeReason: (err) => (err instanceof Error ? err.message.split(":").slice(0, 2).join(":") : "unknown"),
    };
    const started = await startOAuthLink({
      db,
      adapter: withReason,
      principalId: p.id,
      context: { label: "one" },
      redirectUri: REDIRECT,
    });
    logged.mockClear();
    const outcome = await completeOAuthCallback({
      db,
      adapters: new Map([["test", withReason]]),
      cipher,
      state: new URL(started.authorizeUrl).searchParams.get("state"),
      code: "idp-code",
      redirectUri: REDIRECT,
    });
    expect(outcome).toEqual({ kind: "failed" });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0][0]).toEqual({
      purpose: "test",
      reason: "github_oauth_exchange_failed:redirect_uri_mismatch",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("fake-access-AAAA");
  });

  it("passes iss to the adapter's complete, and refuses an over-long one before using the state", async () => {
    const p = await principal();
    const started = await startOAuthLink({
      db,
      adapter: testAdapter,
      principalId: p.id,
      context: { label: "iss" },
      redirectUri: REDIRECT,
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    const long = await completeOAuthCallback({
      db,
      adapters,
      cipher,
      state,
      code: "idp-code",
      iss: "a".repeat(2049),
      redirectUri: REDIRECT,
    });
    expect(long).toEqual({ kind: "invalid" });
    expect(calls).toHaveLength(0);
    const ok = await completeOAuthCallback({
      db,
      adapters,
      cipher,
      state,
      code: "idp-code",
      iss: "https://idp.invalid",
      redirectUri: REDIRECT,
    });
    expect(ok.kind).toBe("confirm");
    expect(calls[0]).toMatchObject({ iss: "https://idp.invalid" });
  });
});
