const FORBIDDEN = /\b(agent|via)\b/i;

/** NFKC-folds, trims and collapses whitespace, so look-alike forms compare equal. */
function foldName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ");
}

/**
 * Returns the normalized (NFKC), trimmed guest name, or throws `guest_name_invalid`.
 * The 1-40 limit counts code points, and comparison with `takenNames` is
 * case-insensitive after the same normalization.
 */
export function validateGuestName(name: string, takenNames: string[]): string {
  const n = foldName(name);
  const length = Array.from(n).length;
  const lower = n.toLowerCase();
  if (length < 1 || length > 40 || FORBIDDEN.test(n) || takenNames.some((t) => foldName(t).toLowerCase() === lower)) {
    throw new Error("guest_name_invalid");
  }
  return n;
}

/** Name shown for a principal: profile name, then GitHub login, then a short subject tail. */
export function displayNameFor(p: {
  profileName?: string | null;
  githubLogin?: string | null;
  subject: string;
}): string {
  if (p.profileName?.trim()) return p.profileName.trim().slice(0, 80);
  if (p.githubLogin) return `@${p.githubLogin}`;
  const tail = p.subject.split(/[|:]/).pop() ?? p.subject;
  return `user·${tail.slice(0, 4)}`;
}
