import type { PrismaClient } from "#prisma";
import { logger } from "../logger.js";
import { sweepExports } from "./exports.js";

const log = logger.child({ module: "documents-sweep" });

/**
 * Deletes rows that can never be used again: document-page sessions past
 * their absolute expiry (an idle-ended session goes when that passes too; both
 * deletes use the expiresAt index), and expired rate-limit windows, and exports past their hour (jobs stuck queued or running fail). The
 * self-hosted provider's cleanup sweeps AuthRateLimit too, but in delegating
 * mode nothing else does, and document sends and guest comments count there
 * in both modes. Called by the reconciler each pass. Never throws.
 */
export async function sweepExpiredDocumentRows(
  db: Pick<PrismaClient, "webSession" | "authRateLimit" | "documentExport">,
  now: Date = new Date(),
): Promise<{ webSessions: number; rateLimits: number; exports: { deleted: number; failed: number } }> {
  try {
    const sessions = await db.webSession.deleteMany({ where: { expiresAt: { lt: now } } });
    const limits = await db.authRateLimit.deleteMany({ where: { expiresAt: { lt: now } } });
    const exports = await sweepExports(db, now);
    return { webSessions: sessions.count, rateLimits: limits.count, exports };
  } catch (err) {
    log.warn({ errorName: err instanceof Error ? err.name : typeof err }, "could not sweep expired document rows");
    return { webSessions: 0, rateLimits: 0, exports: { deleted: 0, failed: 0 } };
  }
}
