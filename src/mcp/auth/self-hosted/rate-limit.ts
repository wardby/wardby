import type { PrismaClient } from "#prisma";
import type { Credentials } from "./credentials.js";
export interface RateLimiter {
  check(bucket: string, identity: string, limit: number): Promise<void>;
}
export class RateLimitError extends Error {}
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private db: PrismaClient,
    private credentials: Credentials,
  ) {}
  async check(bucket: string, identity: string, limit: number) {
    const window = Math.floor(Date.now() / 60_000);
    const key = this.credentials.hash(`${bucket}:${identity}:${window}`);
    const expires = new Date((window + 2) * 60_000);
    const rows = await this.db.$queryRaw<{ hits: number }[]>`
      INSERT INTO "AuthRateLimit" ("key", "hits", "expiresAt") VALUES (${key}, 1, ${expires})
      ON CONFLICT ("key") DO UPDATE SET "hits" = "AuthRateLimit"."hits" + 1 RETURNING "hits"`;
    if (rows[0].hits > limit) throw new RateLimitError("Rate limited.");
  }
}
