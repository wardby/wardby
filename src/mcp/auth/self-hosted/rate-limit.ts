import type { PrismaClient } from "#prisma";
import type { Credentials } from "./credentials.js";
export interface RateLimiter {
  check(bucket: string, identity: string, limit: number): Promise<void>;
}
export class RateLimitError extends Error {}
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private db: PrismaClient,
    private credentials: Pick<Credentials, "hash">,
    /** The fixed window a limit counts over; one minute unless a caller needs longer. */
    private windowMs = 60_000,
  ) {}
  async check(bucket: string, identity: string, limit: number) {
    const window = Math.floor(Date.now() / this.windowMs);
    const key = this.credentials.hash(`${bucket}:${identity}:${window}`);
    const expires = new Date((window + 2) * this.windowMs);
    const rows = await this.db.$queryRaw<{ hits: number }[]>`
      INSERT INTO "AuthRateLimit" ("key", "hits", "expiresAt") VALUES (${key}, 1, ${expires})
      ON CONFLICT ("key") DO UPDATE SET "hits" = "AuthRateLimit"."hits" + 1 RETURNING "hits"`;
    if (rows[0].hits > limit) throw new RateLimitError("Rate limited.");
  }
}
