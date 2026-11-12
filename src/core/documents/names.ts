const FORBIDDEN = /\b(agent|via)\b/i;

/** Returns the trimmed guest name, or throws `guest_name_invalid`. */
export function validateGuestName(name: string, takenNames: string[]): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (
    n.length < 1 ||
    n.length > 40 ||
    FORBIDDEN.test(n) ||
    takenNames.some((t) => t.toLowerCase() === n.toLowerCase())
  ) {
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
