/**
 * Rate limits on what share-link guests can do: register (each registration
 * creates a guest and a web session) and comment. Members are not counted
 * here. Every limit is per hour and lives in this one table.
 *
 * Counting reuses the self-hosted login's Postgres limiter (`AuthRateLimit`).
 * Its keys are hashed; the web surface has no self-hosted credential key in
 * delegating mode, so keys are a domain-separated SHA-256 of
 * bucket, identity and window. Identities are a share link id, a guest id or
 * the client address — never a token.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { PostgresRateLimiter, type RateLimiter } from "../mcp/auth/self-hosted/rate-limit.js";

export const WEB_RATE_WINDOW_MS = 60 * 60 * 1000;

export const GUEST_RATE_LIMITS = {
  /** Guest registrations on one share link per hour. */
  registrationsPerLink: 20,
  /** Threads plus replies by one guest per hour. */
  commentsPerGuest: 30,
} as const;

export type GuestRateLimits = { [K in keyof typeof GUEST_RATE_LIMITS]: number };

export const WEB_RATE_BUCKETS = {
  registrationPerLink: "web-guest-register-link",
  commentsPerGuest: "web-guest-comment",
} as const;

/** The key hash for web rate-limit rows (no secret key needed; identities are not secrets). */
export const webRateKeyHasher = {
  hash: (value: string): string => createHash("sha256").update(`wardby/web/rate-limit/v1:${value}`).digest("hex"),
};

export function webRateLimiter(db: PrismaClient): RateLimiter {
  return new PostgresRateLimiter(db, webRateKeyHasher, WEB_RATE_WINDOW_MS);
}
