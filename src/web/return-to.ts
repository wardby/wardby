const MAX_RETURN_TO = 2048;

/**
 * Only a same-origin path to a document (`/d/…`) or share link (`/s/…`): no
 * scheme or host, no `//` or backslash, no dot segments, nothing the URL
 * parser would rewrite (so what is checked is what the browser follows).
 */
export function isSafeReturnTo(value: string): boolean {
  if (!value || value.length > MAX_RETURN_TO) return false;
  if (!/^\/[ds]\/[^/]/.test(value) || value.includes("//") || value.includes("\\")) return false;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) <= 0x20 || value.charCodeAt(i) === 0x7f) return false;
  let u: URL;
  try {
    u = new URL(value, "https://return-to.invalid");
  } catch {
    return false;
  }
  return u.origin === "https://return-to.invalid" && u.pathname + u.search + u.hash === value;
}
