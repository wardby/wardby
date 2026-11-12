import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import type { SelfHostedAuthProvider } from "../providers/auth/self-hosted.js";
import {
  bridgeSelfHostedSession,
  createWebSession,
  endWebSession,
  readWebSession,
  webCookieOptions,
  WEB_IDLE_MS,
  type SelfHostedSessionSource,
} from "./session.js";

// The real self-hosted provider is accepted by the bridge (compile-time check).
export type ProviderFitsBridge = SelfHostedAuthProvider extends SelfHostedSessionSource ? true : never;
const providerFitsBridge: ProviderFitsBridge = true;
void providerFitsBridge;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const cookieValue = (setCookie: string) => setCookie.split(";")[0];

describe.skipIf(!process.env.DATABASE_URL)("web sessions (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  let p: Principal;
  beforeAll(async () => {
    p = await db.principal.create({ data: { subject: `web-${s}` } });
  });
  afterAll(async () => {
    await db.webSession.deleteMany({ where: { principalId: p.id } });
    await db.principal.deleteMany({ where: { id: p.id } });
    await db.$disconnect();
  });

  it("stores only sha256 hashes of the token and the csrf value", async () => {
    const created = await createWebSession(db, { principalId: p.id });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.csrf).not.toBe(created.token);
    const row = await db.webSession.findUniqueOrThrow({ where: { tokenHash: sha(created.token) } });
    expect(row.csrfHash).toBe(sha(created.csrf));
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(created.token);
    expect(stored).not.toContain(created.csrf);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(7 * 86_400_000 - 60_000);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(7 * 86_400_000 + 60_000);
  });

  it("sets an HttpOnly, Secure, SameSite=Lax __Host- cookie by default", async () => {
    const { token, cookie } = await createWebSession(db, { principalId: p.id });
    expect(cookieValue(cookie)).toBe(`__Host-wardby-web=${token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("uses the dev cookie without Secure when the canonical origin is http", async () => {
    const dev = webCookieOptions("http://localhost:3000/mcp");
    const { token, cookie } = await createWebSession(db, { principalId: p.id }, dev);
    expect(cookieValue(cookie)).toBe(`wardby-dev-web=${token}`);
    expect(cookie).not.toContain("Secure");
    expect(await readWebSession(db, `wardby-dev-web=${token}`, dev)).toMatchObject({ principalId: p.id });
    expect(await readWebSession(db, `wardby-dev-web=${token}`)).toBeNull();
  });

  it("reads a live session and refreshes lastSeenAt", async () => {
    const { token, csrf, cookie } = await createWebSession(db, { principalId: p.id });
    await db.webSession.update({
      where: { tokenHash: sha(token) },
      data: { lastSeenAt: new Date(Date.now() - 60 * 60_000) },
    });
    const view = await readWebSession(db, `other=1; ${cookieValue(cookie)}`);
    expect(view).toMatchObject({ principalId: p.id, csrfHash: sha(csrf) });
    expect(view).not.toHaveProperty("tokenHash");
    const row = await db.webSession.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
    expect(Date.now() - row.lastSeenAt.getTime()).toBeLessThan(60_000);
  });

  it("refuses an idle session", async () => {
    const { token, cookie } = await createWebSession(db, { principalId: p.id });
    await db.webSession.update({
      where: { tokenHash: sha(token) },
      data: { lastSeenAt: new Date(Date.now() - WEB_IDLE_MS - 1000) },
    });
    expect(await readWebSession(db, cookieValue(cookie))).toBeNull();
  });

  it("refuses an expired session", async () => {
    const { token, cookie } = await createWebSession(db, { principalId: p.id });
    await db.webSession.update({ where: { tokenHash: sha(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await readWebSession(db, cookieValue(cookie))).toBeNull();
  });

  it("returns null for a missing, unknown, malformed or duplicated cookie", async () => {
    const { cookie } = await createWebSession(db, { principalId: p.id });
    expect(await readWebSession(db, undefined)).toBeNull();
    expect(await readWebSession(db, "")).toBeNull();
    expect(await readWebSession(db, `__Host-wardby-web=${"A".repeat(43)}`)).toBeNull();
    expect(await readWebSession(db, "__Host-wardby-web=not a token")).toBeNull();
    expect(await readWebSession(db, `${cookieValue(cookie)}; ${cookieValue(cookie)}`)).toBeNull();
  });

  it("refuses a session with neither a principal nor a guest", async () => {
    await expect(createWebSession(db, {})).rejects.toThrow();
  });

  it("endWebSession deletes the row and returns a clearing cookie", async () => {
    const { token, cookie } = await createWebSession(db, { principalId: p.id });
    const cleared = await endWebSession(db, cookieValue(cookie));
    expect(cleared).toMatch(/^__Host-wardby-web=; /);
    expect(cleared).toContain("Max-Age=0");
    expect(await db.webSession.findUnique({ where: { tokenHash: sha(token) } })).toBeNull();
    expect(await readWebSession(db, cookieValue(cookie))).toBeNull();
    expect(await endWebSession(db, undefined)).toContain("Max-Age=0");
  });
});

describe("bridgeSelfHostedSession", () => {
  const db = {} as never;
  const fake = (canonicalUri: string, principalId = "prin_1") => {
    const seen: string[] = [];
    return {
      seen,
      selfHosted: {
        config: { canonicalUri },
        sessions: {
          get: async (token: string) => {
            seen.push(token);
            if (token !== "rvs_good") throw new Error("Invalid session.");
            return { user: { principalId, principal: { id: principalId } } };
          },
        },
      },
    };
  };

  it("returns the principal id for a valid self-hosted session cookie", async () => {
    const f = fake("https://wardby.example.test/mcp");
    expect(await bridgeSelfHostedSession(db, f.selfHosted, "a=1; __Host-wardby-session=rvs_good")).toBe("prin_1");
    expect(f.seen).toEqual(["rvs_good"]);
  });

  it("reads the dev cookie name when the canonical URI is http", async () => {
    const f = fake("http://localhost:3000/mcp");
    expect(await bridgeSelfHostedSession(db, f.selfHosted, "wardby-dev-session=rvs_good")).toBe("prin_1");
    expect(await bridgeSelfHostedSession(db, f.selfHosted, "__Host-wardby-session=rvs_good")).toBeNull();
  });

  it("returns null (no throw) for a missing, invalid or duplicated cookie", async () => {
    const f = fake("https://wardby.example.test/mcp");
    expect(await bridgeSelfHostedSession(db, f.selfHosted, undefined)).toBeNull();
    expect(await bridgeSelfHostedSession(db, f.selfHosted, "__Host-wardby-session=rvs_bad")).toBeNull();
    expect(
      await bridgeSelfHostedSession(db, f.selfHosted, "__Host-wardby-session=rvs_good; __Host-wardby-session=x"),
    ).toBeNull();
    expect(f.seen).toEqual(["rvs_bad"]);
  });
});
