import { createHash, timingSafeEqual } from "node:crypto";

/** The request fields these checks read (an IncomingMessage satisfies it). */
export interface WebRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

const NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Headers for every document page: strict CSP with a per-request script nonce. A design page
 * (boardStyles) also allows inline <style> and data: fonts: GrapesJS renders each board's CSS in
 * <style> elements inside its canvas, its icon font is inlined, and the canvas and srcdoc frames
 * inherit this policy, so no script can run there either way. A document page keeps no inline
 * styles. Never 'unsafe-eval', never inline scripts.
 */
export function pageHeaders(nonce: string, opts: { boardStyles?: boolean } = {}): Record<string, string> {
  if (!NONCE.test(nonce)) throw new Error("invalid nonce");
  const style = opts.boardStyles ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
  const font = opts.boardStyles ? "font-src 'self' data:" : "font-src 'self'";
  return {
    "content-security-policy": `default-src 'none'; script-src 'self' 'nonce-${nonce}'; ${style}; img-src 'self' data:; connect-src 'self'; ${font}; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function header(req: WebRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * State-changing requests must carry an Origin header equal to the canonical
 * origin. Throws `web_origin_rejected` otherwise. Safe methods pass.
 */
export function assertSameOrigin(req: WebRequest, canonicalOrigin: string): void {
  if (SAFE_METHODS.has((req.method ?? "GET").toUpperCase())) return;
  if (header(req, "origin") !== new URL(canonicalOrigin).origin) throw new Error("web_origin_rejected");
}

/**
 * The `x-wardby-csrf` header must hash to the session's stored csrfHash.
 * Compared in constant time; throws `web_csrf_failed` (never echoing the value).
 */
export function assertCsrf(req: WebRequest, session: { csrfHash: string }): void {
  const sent = header(req, "x-wardby-csrf");
  if (!sent || !/^[0-9a-f]{64}$/.test(session.csrfHash)) throw new Error("web_csrf_failed");
  const actual = Buffer.from(createHash("sha256").update(sent).digest("hex"), "hex");
  const expected = Buffer.from(session.csrfHash, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("web_csrf_failed");
}
