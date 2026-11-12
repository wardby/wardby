/**
 * The dev/secure cookie decision for browser pages served by the control
 * plane: `__Host-` cookies with `Secure` when the canonical URI is https, plain
 * `wardby-dev-*` cookies without `Secure` otherwise (local http development).
 */
export function secureCookies(canonicalUri: string): boolean {
  return new URL(canonicalUri).protocol === "https:";
}

export function selfHostedCookieNames(canonicalUri: string) {
  const secure = secureCookies(canonicalUri);
  return {
    secure,
    session: secure ? "__Host-wardby-session" : "wardby-dev-session",
    login: secure ? "__Host-wardby-login" : "wardby-dev-login",
  };
}

/**
 * The value of one cookie in a Cookie header. Returns null when it is absent
 * or appears more than once (a duplicate may be a planted cookie shadowing
 * the real one, so neither is trusted).
 */
export function readCookie(header: string | undefined, name: string): string | null {
  let found: string | null = null;
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    if (found !== null) return null;
    found = value.join("=");
  }
  return found;
}
