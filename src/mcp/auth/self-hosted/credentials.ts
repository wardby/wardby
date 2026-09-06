import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { requireSubject } from "../../../providers/auth/subject.js";

export type AuthDb = Prisma.TransactionClient;
export const DAY = 86_400_000;
export function decodeKey(value: string, name: string): Buffer {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error(`${name} must be 32 random bytes encoded as 64 hex characters.`);
  return Buffer.from(value, "hex");
}
export class Credentials {
  private readonly key: Buffer;
  constructor(value: string) { this.key = decodeKey(value, "AUTH_CREDENTIAL_HASH_KEY"); }
  hash(value: string): string { return createHmac("sha256", this.key).update(value).digest("hex"); }
  create(prefix: string) {
    const id = randomUUID();
    const token = `${prefix}_${id}.${randomBytes(32).toString("base64url")}`;
    return { id, token, hash: this.hash(token) };
  }
  id(token: string, prefix: string): string | undefined {
    const match = new RegExp(`^${prefix}_([a-f0-9-]{36})\\.([A-Za-z0-9_-]{43})$`).exec(token);
    return match?.[1];
  }
  matches(token: string, hash: string | undefined): boolean {
    const expected = hash && /^[a-f\d]{64}$/i.test(hash) ? Buffer.from(hash, "hex") : Buffer.alloc(32);
    return timingSafeEqual(Buffer.from(this.hash(token), "hex"), expected) && !!hash;
  }
}
export async function lockUser(tx: AuthDb, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "AuthUser" WHERE "id" = ${id} FOR UPDATE`;
  const user = await tx.authUser.findUnique({ where: { id }, include: { principal: true } });
  if (!user || user.status !== "enabled") throw new Error("Invalid credentials.");
  requireSubject(user.principal.subject);
  return user;
}
export class IdentityService {
  readonly credentials: Credentials;
  constructor(readonly db: PrismaClient, hashKey: string) { this.credentials = new Credentials(hashKey); }
  async createUser(subject: string) {
    requireSubject(subject);
    return this.db.$transaction(async (tx) => {
      const principal = await tx.principal.upsert({ where: { subject }, create: { subject }, update: {} });
      const user = await tx.authUser.create({ data: { principalId: principal.id } });
      const key = this.credentials.create("rvk");
      await tx.authLoginKey.create({ data: { keyId: key.id, userId: user.id, secretHash: key.hash, expiresAt: new Date(Date.now() + 365 * DAY) } });
      return { userId: user.id, subject, loginKey: key.token };
    });
  }
  async createKey(subject: string) {
    const user = await this.db.authUser.findFirst({ where: { principal: { subject: requireSubject(subject) } } });
    if (!user) throw new Error("Unknown user.");
    return this.db.$transaction(async (tx) => {
      await lockUser(tx, user.id);
      const key = this.credentials.create("rvk");
      await tx.authLoginKey.create({ data: { keyId: key.id, userId: user.id, secretHash: key.hash, expiresAt: new Date(Date.now() + 365 * DAY) } });
      return key.token;
    });
  }
  async disableUser(subject: string) {
    const user = await this.db.authUser.findFirst({ where: { principal: { subject: requireSubject(subject) } } });
    if (!user) throw new Error("Unknown user.");
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AuthUser" WHERE "id" = ${user.id} FOR UPDATE`;
      const now = new Date();
      await tx.authUser.update({ where: { id: user.id }, data: { status: "disabled" } });
      await tx.authLoginKey.updateMany({ where: { userId: user.id }, data: { revokedAt: now } });
      await tx.authSession.updateMany({ where: { userId: user.id }, data: { revokedAt: now } });
      await tx.oAuthFamily.updateMany({ where: { userId: user.id }, data: { revokedAt: now } });
    });
  }
  async revokeKey(keyId: string) {
    const key = await this.db.authLoginKey.findUnique({ where: { keyId } });
    if (!key) return;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AuthUser" WHERE "id" = ${key.userId} FOR UPDATE`;
      await tx.authLoginKey.update({ where: { keyId }, data: { revokedAt: new Date() } });
      await tx.authSession.updateMany({ where: { userId: key.userId }, data: { revokedAt: new Date() } });
      await tx.oAuthFamily.updateMany({ where: { userId: key.userId }, data: { revokedAt: new Date() } });
    });
  }
  listUsers() { return this.db.authUser.findMany({ select: { id: true, status: true, displayName: true, principal: { select: { subject: true } } } }); }
  listKeys(subject: string) { return this.db.authLoginKey.findMany({ where: { user: { principal: { subject: requireSubject(subject) } } }, select: { keyId: true, createdAt: true, expiresAt: true, lastUsedAt: true, revokedAt: true } }); }
}
