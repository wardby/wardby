import type { PrismaClient } from "#prisma";

/** The slice of the Prisma client (or a transaction) the profile helpers use. */
export type ProfileDb = Pick<PrismaClient, "principalProfile">;

export const MAX_DISPLAY_NAME_CHARS = 80;
export type ProfileSource = "oidc" | "self-hosted" | "operator";

/** Trims and caps a display name; blank becomes null. */
export function cleanDisplayName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_DISPLAY_NAME_CHARS) : null;
}

/**
 * Creates or updates a principal's profile. Values given here replace the
 * stored ones (and `source` always follows the latest writer); a field left
 * undefined keeps what is stored.
 */
export async function upsertProfile(
  db: ProfileDb,
  principalId: string,
  input: { displayName?: string | null; email?: string | null; source: ProfileSource },
): Promise<void> {
  const data: { displayName?: string | null; email?: string | null; source: ProfileSource } = { source: input.source };
  if (input.displayName !== undefined) data.displayName = cleanDisplayName(input.displayName);
  if (input.email !== undefined) data.email = input.email?.trim() || null;
  await db.principalProfile.upsert({ where: { principalId }, create: { principalId, ...data }, update: data });
}

/** Display names for the given principals. Only ids with a non-empty name appear; email is never returned. */
export async function profileNames(db: ProfileDb, principalIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(principalIds)];
  if (ids.length === 0) return out;
  const rows = await db.principalProfile.findMany({
    where: { principalId: { in: ids } },
    select: { principalId: true, displayName: true },
  });
  for (const r of rows) if (r.displayName) out.set(r.principalId, r.displayName);
  return out;
}
