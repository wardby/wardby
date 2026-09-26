import { availableParallelism } from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#prisma";

/**
 * Connection-pool sizing for the node-postgres pool behind @prisma/adapter-pg.
 *
 * Prisma 6's query engine owned the pool: `connection_limit` defaulted to
 * cpus * 2 + 1 and a caller waited at most `pool_timeout` = 10 s for a free
 * connection (then P2024). Prisma 7 hands the pool to `pg`, whose defaults are
 * max = 10 and connectionTimeoutMillis = 0 — wait for a connection *forever*,
 * so a saturated pool would hang requests instead of failing them. Both values
 * are therefore set explicitly, to Prisma 6's defaults:
 *
 * - max: availableParallelism() * 2 + 1 (Prisma 6 counted physical cores; the
 *   logical count is the closest portable Node equivalent).
 * - connectionTimeoutMillis: 10 000 (Prisma 6's pool_timeout). A timeout now
 *   surfaces as a pg "timeout exceeded when trying to connect" error, not P2024.
 *
 * `pg` ignores Prisma's own URL parameters, so the two that tuned these same
 * knobs (`connection_limit`, `pool_timeout` in seconds) are still honoured here
 * for URLs that set them. idleTimeoutMillis stays at pg's 10 s default.
 *
 * TLS is whatever the URL asks for (`sslmode`, `sslrootcert`, ...); certificate
 * validation is never disabled here.
 */
export const DEFAULT_POOL_TIMEOUT_MS = 10_000;

export function defaultPoolMax(): number {
  return availableParallelism() * 2 + 1;
}

export interface PoolSettings {
  max: number;
  connectionTimeoutMillis: number;
}

export function poolSettings(connectionString: string): PoolSettings {
  const settings: PoolSettings = { max: defaultPoolMax(), connectionTimeoutMillis: DEFAULT_POOL_TIMEOUT_MS };
  let params: URLSearchParams;
  try {
    params = new URL(connectionString).searchParams;
  } catch {
    return settings;
  }
  const limit = Number(params.get("connection_limit"));
  if (Number.isInteger(limit) && limit > 0) settings.max = limit;
  const timeout = params.get("pool_timeout");
  if (timeout !== null && timeout !== "" && Number.isFinite(Number(timeout)) && Number(timeout) >= 0) {
    // Prisma's pool_timeout=0 meant "no timeout"; pg's 0 means the same.
    settings.connectionTimeoutMillis = Number(timeout) * 1000;
  }
  return settings;
}

/**
 * Without a URL, pg would silently fall back to PGHOST/localhost:5432 as the
 * OS user. Prisma 6 failed the first query instead ("Environment variable not
 * found: DATABASE_URL"); keep that: construction succeeds, connecting fails.
 */
class MissingUrlAdapter extends PrismaPg {
  override async connect(): Promise<never> {
    throw new Error("DATABASE_URL is not set: cannot connect to the database.");
  }
}

/**
 * The one way wardby builds a Prisma client. `url` defaults to DATABASE_URL
 * as read at call time.
 */
/** `poolMax` overrides the pool size for a caller that sizes its own pools
 *  (the coding proxy keeps its ledger and its package registry apart). */
export function createPrismaClient(
  url: string | undefined = process.env.DATABASE_URL,
  options: { poolMax?: number } = {},
): PrismaClient {
  const adapter = url
    ? new PrismaPg({
        connectionString: url,
        ...poolSettings(url),
        ...(options.poolMax !== undefined ? { max: options.poolMax } : {}),
      })
    : new MissingUrlAdapter({ connectionString: "" });
  return new PrismaClient({ adapter });
}

export const prisma = createPrismaClient();
