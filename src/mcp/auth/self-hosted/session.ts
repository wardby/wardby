import type { PrismaClient } from "@prisma/client";
import type { Credentials} from "./credentials.js";
import { DAY, lockUser, type AuthDb } from "./credentials.js";

export class Sessions {
  constructor(readonly db: PrismaClient, readonly credentials: Credentials) {}
  async challenge(purpose: "login" | "consent" | "logout", sessionId: string | null, binding: string) {
    const challenge = this.credentials.create("rvc");
    await this.db.authFormChallenge.create({ data: { challengeId: challenge.id, sessionId, purpose, binding: this.credentials.hash(binding), secretHash: challenge.hash, expiresAt: new Date(Date.now() + 600_000) } });
    return challenge.token;
  }
  async consumeChallenge(tx: AuthDb, token: string, purpose: string, sessionId: string | null, binding: string) {
    const id = this.credentials.id(token, "rvc");
    if (!id) throw new Error("Invalid form challenge.");
    const row = await tx.authFormChallenge.findUnique({ where: { challengeId: id } });
    if (!this.credentials.matches(token, row?.secretHash)) throw new Error("Invalid form challenge.");
    const result = await tx.authFormChallenge.updateMany({ where: { challengeId: id, purpose, sessionId, binding: this.credentials.hash(binding), consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } });
    if (result.count !== 1) throw new Error("Invalid form challenge.");
  }
  async login(loginKey: string, challenge: string, binding: string, previousSession?: string) {
    // A failed credential attempt still consumes its challenge.
    await this.consumeChallenge(this.db, challenge, "login", null, binding);
    const keyId = this.credentials.id(loginKey, "rvk");
    const key = keyId ? await this.db.authLoginKey.findUnique({ where: { keyId } }) : null;
    if (!this.credentials.matches(loginKey, key?.secretHash) || !key) throw new Error("Invalid credentials.");
    return this.db.$transaction(async (tx) => {
      await lockUser(tx, key.userId);
      const valid = await tx.authLoginKey.updateMany({ where: { keyId: key.keyId, revokedAt: null, expiresAt: { gt: new Date() } }, data: { lastUsedAt: new Date() } });
      if (valid.count !== 1) throw new Error("Invalid credentials.");
      if (previousSession) {
        const previousId = this.credentials.id(previousSession, "rvs");
        if (previousId) await tx.authSession.updateMany({ where: { sessionId: previousId, secretHash: this.credentials.hash(previousSession) }, data: { revokedAt: new Date() } });
      }
      const session = this.credentials.create("rvs");
      await tx.authSession.create({ data: { sessionId: session.id, userId: key.userId, secretHash: session.hash, expiresAt: new Date(Date.now() + 30 * DAY) } });
      return session.token;
    });
  }
  async get(token: string, tx: AuthDb = this.db) {
    const sessionId = this.credentials.id(token, "rvs");
    if (!sessionId) throw new Error("Invalid session.");
    const session = await tx.authSession.findUnique({ where: { sessionId }, include: { user: { include: { principal: true } } } });
    if (!session || !this.credentials.matches(token, session.secretHash) || session.user.status !== "enabled") throw new Error("Invalid session.");
    const now = new Date();
    const live = await tx.authSession.updateMany({ where: { sessionId, revokedAt: null, expiresAt: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - DAY / 2) } }, data: { lastSeenAt: now } });
    if (live.count !== 1) throw new Error("Invalid session.");
    return session;
  }
  async logout(token: string, challenge: string) {
    await this.db.$transaction(async (tx) => {
      const session = await this.get(token, tx);
      await this.consumeChallenge(tx, challenge, "logout", session.sessionId, "logout");
      await tx.authSession.update({ where: { sessionId: session.sessionId }, data: { revokedAt: new Date() } });
    });
  }
}
