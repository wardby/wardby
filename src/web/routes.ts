/**
 * The browser surface for documents: the page at /d/<id>, share links at
 * /s/<token>, sign-in under /web/, the bundle at /web/static/ and the JSON
 * API at /d/api/.
 *
 * Security rules applied here, on every request:
 * - The web session is re-validated with its share link (R9a); a dead link
 *   means no session.
 * - Every state-changing request needs Origin = the canonical origin and the
 *   session's CSRF value in `x-wardby-csrf` (logout included, R9b).
 * - Sign-in, the self-hosted bridge and guest registration end the request's
 *   existing web session before creating a new one (R9c).
 * - A member's web session is principal-only. A share link raises a member's
 *   access per request: the page served at /s/<token> hands the token to the
 *   app, which sends it as `x-wardby-share`; access is then the higher of the
 *   member's own grant and the live link's permission, on that link's
 *   document only. Opening a link never changes the session.
 * - Guests are rate-limited (rate-limits.ts): registrations per link,
 *   comments per guest. Nothing is limited per client address (R12).
 * - Responses carry fixed error codes only (R10); unknown errors are logged
 *   by name, never by message.
 *
 * Guest registration and CSRF. A first-time visitor of /s/<token> has no
 * session to bind a CSRF value to, so the page mints a pre-session value:
 * 32 random bytes, set as an HttpOnly SameSite=Strict cookie (`__Host-` on
 * https) and handed to the page in the bootstrap. POST /s/<token>/guest
 * needs Origin and an `x-wardby-csrf` header equal to that cookie (compared
 * in constant time) — or the CSRF value of a live session. A cross-site page
 * can neither read the value nor send the Origin. The cookie is cleared when
 * the guest session is created.
 *
 * Secrets: session tokens travel only in Set-Cookie; CSRF values and the
 * share token only in the page bootstrap or a same-origin JSON response to
 * their holder. None is logged (the transport logs paths with /s/<token>
 * masked, and this module logs error names only).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../core/logger.js";
import { documentAccess, type Viewer } from "../core/documents/access.js";
import { notifyDocumentChange } from "../core/documents/events.js";
import { principalNames } from "../core/documents/comments.js";
import { registerGuest, resolveShareToken } from "../core/documents/share-links.js";
import { readCookie } from "../mcp/auth/self-hosted/cookies.js";
import {
  describeViewer,
  documentPayload,
  getDocumentJson,
  getFrames,
  getMentions,
  getReviewCandidates,
  postShareLink,
  getVersionJson,
  listVersionsJson,
  patchComment,
  postFidelity,
  postReview,
  postReply,
  postSend,
  postStatus,
  postThread,
  putContent,
  removeComment,
  restoreVersionJson,
} from "./api.js";
import { getExportBytes, getExportFile, getExportStatus, postExport } from "./exports-api.js";
import {
  addCookie,
  cookieOptions,
  errorCode,
  isJsonObject,
  requestViewer,
  resolveContext,
  SHARE_HEADER,
  sendWebJson,
  type WebContext,
  type WebDeps,
} from "./context.js";
import { clearLoginStateCookie } from "./oidc-login.js";
import { sendDocumentPage, sendErrorPage, type PageBootstrap, type PageViewer } from "./page.js";
import { GUEST_RATE_LIMITS, WEB_RATE_BUCKETS, webRateLimiter } from "./rate-limits.js";
import { isSafeReturnTo } from "./return-to.js";
import { assertCsrf, assertSameOrigin } from "./security.js";
import {
  bridgeSelfHostedSession,
  createWebSession,
  endWebSession,
  readWebSession,
  type WebCookieOptions,
} from "./session.js";
import { openDocumentStream } from "./events.js";
import { postLiveTicket } from "./live/ticket.js";
import { DEFAULT_ASSETS_ROOT, readIntegrity, readManifest, serveStatic, STATIC_PREFIX } from "./static.js";

const routesLog = logger.child({ module: "web" });

export type { WebDeps } from "./context.js";

const ID = "[A-Za-z0-9_-]{1,64}";
const DOC_PAGE = new RegExp(`^/d/(${ID})$`);
const SHARE_PAGE = /^\/s\/([A-Za-z0-9_-]{1,200})$/;
const SHARE_GUEST = /^\/s\/([A-Za-z0-9_-]{1,200})\/guest$/;
const API_DOC = new RegExp(
  `^/d/api/(${ID})(?:/(content|threads|send|mentions|fidelity|frames|export|exports|review|review-candidates|share-links|live-ticket))?$`,
);
const API_THREAD = new RegExp(`^/d/api/threads/(${ID})/(replies|status)$`);
const API_COMMENT = new RegExp(`^/d/api/comments/(${ID})$`);
const API_VERSIONS = new RegExp(`^/d/api/(${ID})/versions(?:/([1-9][0-9]{0,8})(/restore)?)?$`);
const API_EXPORT = new RegExp(`^/d/api/exports/(${ID})(/file)?$`);
const API_EVENTS = new RegExp(`^/d/api/(${ID})/events$`);
const WEB_PREFIXES = /^\/(?:d|s|web)\//;
const LOGOUT_URL = "/web/logout";
const WHOAMI_URL = "/web/whoami";
const PRE_MAX_AGE_SECONDS = 60 * 60;
const PRE_VALUE = /^[A-Za-z0-9_-]{43}$/;

const loginUrl = (returnTo: string) => `/web/login?returnTo=${encodeURIComponent(returnTo)}`;

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
}

// ---- pre-session CSRF (guest registration) --------------------------------

const preCookieName = (o: WebCookieOptions) => (o.secure ? "__Host-wardby-web-pre" : "wardby-dev-web-pre");
const preCookie = (o: WebCookieOptions, value: string, maxAge: number) =>
  `${preCookieName(o)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${o.secure ? "; Secure" : ""}`;

function preCsrfMatches(req: IncomingMessage, o: WebCookieOptions): boolean {
  const cookie = readCookie(req.headers.cookie, preCookieName(o));
  const sent = req.headers["x-wardby-csrf"];
  if (!cookie || !PRE_VALUE.test(cookie) || typeof sent !== "string") return false;
  const a = createHash("sha256").update(cookie).digest();
  const b = createHash("sha256").update(sent).digest();
  return timingSafeEqual(a, b);
}

function sessionCsrfMatches(req: IncomingMessage, ctx: WebContext): boolean {
  if (ctx.kind === "none") return false;
  try {
    assertCsrf(req, ctx.session);
    return true;
  } catch {
    return false;
  }
}

// ---- entry ----------------------------------------------------------------

/**
 * Handles the request when its path belongs to the web surface (/d/, /s/,
 * /web/) and returns true; returns false for any other path. `body` is the
 * transport's parsed body (JSON object, form params or undefined).
 */
export async function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
  deps: WebDeps,
): Promise<boolean> {
  const path = url.pathname;
  if (!WEB_PREFIXES.test(path)) return false;
  const method = req.method ?? "GET";
  let m: RegExpExecArray | null;
  if (method === "GET" && (m = API_EVENTS.exec(path))) {
    await guardJson(res, () => openDocumentStream(req, res, m![1], deps));
    return true;
  }
  if (path.startsWith("/d/api/")) {
    await guardJson(res, () => handleApi(req, res, url, method, body, deps));
    return true;
  }
  if (method === "GET" && path.startsWith(STATIC_PREFIX)) {
    await serveStatic(res, path, deps.assetsRoot ?? DEFAULT_ASSETS_ROOT);
    return true;
  }
  if (method === "GET" && (m = DOC_PAGE.exec(path))) {
    await guardPage(res, () => documentPage(req, res, m![1], deps));
    return true;
  }
  if (method === "GET" && (m = SHARE_PAGE.exec(path))) {
    await guardPage(res, () => sharePage(req, res, m![1], deps));
    return true;
  }
  if (method === "POST" && (m = SHARE_GUEST.exec(path))) {
    await guardJson(res, () => registerGuestRoute(req, res, m![1], body, deps));
    return true;
  }
  if (method === "GET" && path === "/web/login") {
    await guardPage(res, () => login(req, res, url, deps), "web_login_failed");
    return true;
  }
  if (method === "GET" && path === "/web/callback" && deps.authMode === "delegating") {
    await callback(req, res, deps);
    return true;
  }
  if (method === "POST" && path === LOGOUT_URL) {
    await guardJson(res, () => logout(req, res, deps));
    return true;
  }
  if (method === "GET" && path === WHOAMI_URL) {
    await guardJson(res, () => whoami(req, res, deps));
    return true;
  }
  sendWebJson(res, 404, { error: "not_found" });
  return true;
}

async function guardJson(res: ServerResponse, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const { code, status, requestId, problems } = errorCode(err);
    sendWebJson(res, status, {
      error: code,
      ...(requestId ? { id: requestId } : {}),
      ...(problems ? { problems } : {}),
    });
  }
}

async function guardPage(res: ServerResponse, run: () => Promise<void>, fallback?: "web_login_failed"): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const { code, status } = errorCode(err, fallback);
    sendErrorPage(res, status, code);
  }
}

// ---- pages ----------------------------------------------------------------

async function pageDocument(deps: WebDeps, documentId: string): Promise<{ title: string; kind: string }> {
  const doc = await deps.db.document.findUnique({ where: { id: documentId }, select: { title: true, kind: true } });
  if (!doc) throw new Error("document_not_found");
  return doc;
}

/** The manifest and integrity digests, or web_assets_missing without a manifest. */
async function pageAssets(deps: WebDeps) {
  const root = deps.assetsRoot ?? DEFAULT_ASSETS_ROOT;
  const manifest = await readManifest(root);
  if (!manifest) throw new Error("web_assets_missing");
  return { manifest, integrity: await readIntegrity(root) };
}

/** A design runs the designs bundle (and its CSP); every other document the Markdown editor. */
const pageKind = (kind: string) =>
  kind === "design"
    ? ({ kind: "design", bundle: "designs" } as const)
    : ({ kind: "document", bundle: "documents" } as const);

async function documentPage(req: IncomingMessage, res: ServerResponse, id: string, deps: WebDeps): Promise<void> {
  const ctx = await resolveContext(req, deps);
  if (ctx.kind === "none") return redirect(res, loginUrl(`/d/${id}`));
  if ((await documentAccess(deps.db, id, ctx.viewer)) === "none") throw new Error("document_not_found");
  const assets = await pageAssets(deps);
  const doc = await pageDocument(deps, id);
  const { kind, bundle } = pageKind(doc.kind);
  const bootstrap: PageBootstrap = {
    documentId: id,
    kind,
    csrf: ctx.csrf,
    viewer: await describeViewer(deps, id, ctx.viewer),
    loginUrl: loginUrl(`/d/${id}`),
    logoutUrl: LOGOUT_URL,
  };
  // The document itself, for the first frame; if building it fails, the page fetches it as before.
  try {
    bootstrap.initial = await documentPayload(deps, id, ctx.viewer, false);
  } catch (err) {
    // The page still works (it fetches the document); say why the first frame needs a request. Names and fixed
    // codes only, never a message that could carry content.
    const code = err instanceof Error && /^[a-z_]{1,64}$/.test(err.message) ? err.message : undefined;
    routesLog.warn(
      { errorName: err instanceof Error ? err.name : typeof err, ...(code ? { code } : {}) },
      "page bootstrap without the document; the page fetches it",
    );
  }
  sendDocumentPage(res, { title: doc.title, bootstrap, bundle, ...assets });
}

const linkLevel = (permission: string) =>
  permission === "comment" ? "comment" : permission === "view" ? "read" : "none";

async function sharePage(req: IncomingMessage, res: ServerResponse, token: string, deps: WebDeps): Promise<void> {
  const resolved = await resolveShareToken(deps.db, token);
  if (!resolved) throw new Error("share_link_invalid");
  const { link, document } = resolved;
  const options = cookieOptions(deps);
  let ctx = await resolveContext(req, deps);
  // A guest of another link is a stranger here (their session is left alone).
  if (ctx.kind === "guest" && ctx.shareLinkId !== link.id) ctx = { kind: "none" };

  const assets = await pageAssets(deps);
  let csrf: string;
  let viewer: PageViewer;
  if (ctx.kind === "none") {
    csrf = randomBytes(32).toString("base64url");
    addCookie(res, preCookie(options, csrf, PRE_MAX_AGE_SECONDS));
    viewer = { kind: "anonymous", name: null, access: linkLevel(link.permission) };
  } else {
    csrf = ctx.csrf;
    // A member is shown the higher of their grant and this link; the session is not touched (the app
    // sends the token with each request to get the same access).
    const shown: Viewer = ctx.kind === "member" ? { ...ctx.viewer, shareLinkId: link.id } : ctx.viewer;
    viewer = await describeViewer(deps, document.id, shown);
  }
  const { kind, bundle } = pageKind(document.kind);
  sendDocumentPage(res, {
    title: document.title,
    ...assets,
    bundle,
    bootstrap: {
      documentId: document.id,
      kind,
      csrf,
      viewer,
      shareToken: token,
      loginUrl: loginUrl(`/s/${token}`),
      logoutUrl: LOGOUT_URL,
    },
  });
}

async function registerGuestRoute(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  body: unknown,
  deps: WebDeps,
): Promise<void> {
  assertSameOrigin(req, deps.canonicalUri);
  const resolved = await resolveShareToken(deps.db, token);
  if (!resolved) throw new Error("share_link_invalid");
  const options = cookieOptions(deps);
  const ctx = await resolveContext(req, deps);
  if (!sessionCsrfMatches(req, ctx) && !preCsrfMatches(req, options)) throw new Error("web_csrf_failed");
  if (!isJsonObject(body)) throw new Error("expected_json_object");
  if (resolved.link.permission !== "comment") throw new Error("document_access_denied");
  const limits = { ...GUEST_RATE_LIMITS, ...deps.guestLimits };
  const limiter = deps.rateLimiter ?? webRateLimiter(deps.db);
  // No per-address limit: Wardby has no trusted client-address source, and behind a proxy or load balancer
  // every guest shares the proxy's address, so one would throttle all guests together.
  await limiter.check(WEB_RATE_BUCKETS.registrationPerLink, resolved.link.id, limits.registrationsPerLink);
  const name = body.name;
  const email = body.email;
  if (typeof name !== "string" || (email !== undefined && email !== null && typeof email !== "string")) {
    throw new Error("invalid_request");
  }
  // A guest of this link who changes their name stays the same guest (same session), so their
  // earlier comments show the new name.
  const own = ctx.kind === "guest" && ctx.shareLinkId === resolved.link.id ? ctx : null;
  const { guestId } = await registerGuest(deps.db, {
    shareLinkId: resolved.link.id,
    name,
    ...(typeof email === "string" ? { email } : {}),
    ...(own ? { guestId: own.guestId } : {}),
  });
  if (own && guestId === own.guestId) {
    const guest = await deps.db.documentGuest.findUnique({ where: { id: guestId }, select: { name: true } });
    // Open pages redraw the threads, so the guest's earlier comments show the new name.
    await notifyDocumentChange(deps.db, resolved.document.id, "thread");
    sendWebJson(res, 200, { csrf: own.csrf, me: { kind: "guest", name: guest?.name ?? name, access: "comment" } });
    return;
  }
  await endWebSession(deps.db, req.headers.cookie, options);
  const created = await createWebSession(deps.db, { guestId, shareLinkId: resolved.link.id }, options);
  addCookie(res, created.cookie);
  addCookie(res, preCookie(options, "", 0));
  const guest = await deps.db.documentGuest.findUnique({ where: { id: guestId }, select: { name: true } });
  sendWebJson(res, 200, { csrf: created.csrf, me: { kind: "guest", name: guest?.name ?? name, access: "comment" } });
}

// ---- sign-in --------------------------------------------------------------

async function login(req: IncomingMessage, res: ServerResponse, url: URL, deps: WebDeps): Promise<void> {
  const returnTo = url.searchParams.get("returnTo") ?? "";
  if (!isSafeReturnTo(returnTo)) throw new Error("web_login_failed");
  const options = cookieOptions(deps);
  if (deps.authMode === "self-hosted") {
    const principalId = deps.selfHosted
      ? await bridgeSelfHostedSession(deps.db, deps.selfHosted, req.headers.cookie)
      : null;
    if (!principalId) return redirect(res, `/login?return=${encodeURIComponent(returnTo)}`);
    await endWebSession(deps.db, req.headers.cookie, options);
    const created = await createWebSession(deps.db, { principalId }, options);
    addCookie(res, created.cookie);
    return redirect(res, returnTo);
  }
  if (!deps.oidc?.configured) throw new Error("web_login_not_configured");
  const { redirectUrl, stateCookie } = await deps.oidc.startLogin({ returnTo });
  addCookie(res, stateCookie);
  redirect(res, redirectUrl);
}

async function callback(req: IncomingMessage, res: ServerResponse, deps: WebDeps): Promise<void> {
  // Cleared on success and on failure (R10b).
  addCookie(res, clearLoginStateCookie(deps.canonicalUri));
  await guardPage(
    res,
    async () => {
      if (!deps.oidc?.configured) throw new Error("web_login_not_configured");
      const options = cookieOptions(deps);
      const done = await deps.oidc.finishLogin(deps.db, { url: req.url ?? "", cookieHeader: req.headers.cookie });
      if (!isSafeReturnTo(done.returnTo)) throw new Error("web_login_failed");
      await endWebSession(deps.db, req.headers.cookie, options);
      const created = await createWebSession(deps.db, { principalId: done.principalId }, options);
      addCookie(res, created.cookie);
      redirect(res, done.returnTo);
    },
    "web_login_failed",
  );
}

async function logout(req: IncomingMessage, res: ServerResponse, deps: WebDeps): Promise<void> {
  assertSameOrigin(req, deps.canonicalUri);
  const options = cookieOptions(deps);
  const session = await readWebSession(deps.db, req.headers.cookie, options);
  if (session) assertCsrf(req, session);
  addCookie(res, await endWebSession(deps.db, req.headers.cookie, options));
  sendWebJson(res, 200, { ok: true });
}

/**
 * GET /web/whoami: who this browser session is, for the person it belongs to. A member sees the principal
 * (id, subject, the name they are shown as, the profile email) and where a browser sign-in's subject comes
 * from, so they can compare it with the subject their MCP client resolves to. A guest sees their own name
 * and share link scope. Never the session token, the CSRF value, or any identity-provider token (none is
 * kept: the ID token is discarded at sign-in). Without a live session it answers web_session_required.
 */
async function whoami(req: IncomingMessage, res: ServerResponse, deps: WebDeps): Promise<void> {
  const ctx = await resolveContext(req, deps, { touch: false });
  if (ctx.kind === "none") throw new Error("web_session_required");
  const times = await deps.db.webSession.findUnique({
    where: { id: ctx.session.id },
    select: { expiresAt: true, lastSeenAt: true },
  });
  const session = { expiresAt: times?.expiresAt ?? null, lastSeenAt: times?.lastSeenAt ?? null };
  if (ctx.kind === "guest") {
    const guest = await deps.db.documentGuest.findUnique({ where: { id: ctx.guestId }, select: { name: true } });
    sendWebJson(res, 200, {
      kind: "guest",
      name: guest?.name ?? null,
      documentId: ctx.documentId,
      permission: ctx.viewer.permission,
      session,
    });
    return;
  }
  const [principal, profile, names] = await Promise.all([
    deps.db.principal.findUnique({ where: { id: ctx.principalId }, select: { id: true, subject: true } }),
    deps.db.principalProfile.findUnique({ where: { principalId: ctx.principalId }, select: { email: true } }),
    principalNames(deps.db, [ctx.principalId]),
  ]);
  if (!principal) throw new Error("web_session_required");
  sendWebJson(res, 200, {
    kind: "member",
    principal: {
      id: principal.id,
      subject: principal.subject,
      name: names.get(principal.id) ?? null,
      email: profile?.email ?? null,
    },
    signIn:
      deps.authMode === "delegating"
        ? { mode: "delegating", subjectFrom: deps.oidc?.subjectSource ?? { claim: "sub" } }
        : { mode: "self-hosted" },
    session,
  });
}

// ---- JSON API -------------------------------------------------------------

type ApiRoute = {
  write: boolean;
  /** GET /d/api/<id> (its version history and frames) may also be read with a share token by a visitor without a session. */
  shareReadable?: string;
  run(viewer: Viewer, anonymous: boolean, body: Record<string, unknown>): Promise<void>;
};

function matchApi(res: ServerResponse, url: URL, method: string, deps: WebDeps): ApiRoute | null {
  const path = url.pathname;
  let m: RegExpExecArray | null;
  if ((m = API_VERSIONS.exec(path))) {
    const [, id, n, restore] = m;
    if (!n && method === "GET") {
      return { write: false, shareReadable: id, run: (v) => listVersionsJson(res, deps, id, v, url.searchParams) };
    }
    if (n && !restore && method === "GET") {
      return { write: false, shareReadable: id, run: (v) => getVersionJson(res, deps, id, v, Number(n)) };
    }
    if (n && restore && method === "POST") {
      return { write: true, run: (v, _a, b) => restoreVersionJson(res, deps, id, v, Number(n), b) };
    }
    return null;
  }
  if ((m = API_EXPORT.exec(path))) {
    const [, id, file] = m;
    if (method !== "GET") return null;
    return { write: false, run: (v) => (file ? getExportBytes(res, deps, id, v) : getExportStatus(res, deps, id, v)) };
  }
  if ((m = API_THREAD.exec(path)) && method === "POST") {
    const [, id, action] = m;
    return {
      write: true,
      run: (v, _a, b) => (action === "replies" ? postReply(res, deps, id, v, b) : postStatus(res, deps, id, v, b)),
    };
  }
  if ((m = API_COMMENT.exec(path))) {
    const id = m[1];
    if (method === "PATCH") return { write: true, run: (v, _a, b) => patchComment(res, deps, id, v, b) };
    if (method === "DELETE") return { write: true, run: (v) => removeComment(res, deps, id, v) };
    return null;
  }
  if ((m = API_DOC.exec(path))) {
    const [, id, sub] = m;
    if (!sub && method === "GET") {
      return { write: false, shareReadable: id, run: (v, a) => getDocumentJson(res, deps, id, v, a) };
    }
    if (sub === "mentions" && method === "GET") return { write: false, run: (v) => getMentions(res, deps, id, v) };
    if (sub === "content" && method === "PUT")
      return { write: true, run: (v, _a, b) => putContent(res, deps, id, v, b) };
    if (sub === "threads" && method === "POST")
      return { write: true, run: (v, _a, b) => postThread(res, deps, id, v, b) };
    if (sub === "send" && method === "POST") return { write: true, run: (v, _a, b) => postSend(res, deps, id, v, b) };
    if (sub === "review" && method === "POST")
      return { write: true, run: (v, _a, b) => postReview(res, deps, id, v, b) };
    if (sub === "review-candidates" && method === "GET")
      return { write: false, run: (v) => getReviewCandidates(res, deps, id, v) };
    if (sub === "share-links" && method === "POST") return { write: true, run: (v) => postShareLink(res, deps, id, v) };
    if (sub === "live-ticket" && method === "POST")
      return { write: true, run: (v) => postLiveTicket(res, deps, id, v) };
    if (sub === "fidelity" && method === "POST") {
      return { write: true, run: (v, _a, b) => postFidelity(res, deps, id, v, b) };
    }
    if (sub === "export" && method === "GET") {
      return { write: false, shareReadable: id, run: (v) => getExportFile(res, deps, id, v, url.searchParams) };
    }
    if (sub === "exports" && method === "POST") {
      // Share-readable only so an anonymous link reader reaches requestRenderedExport, which
      // refuses them (403 export_sign_in_required) before any write. assertSameOrigin still runs;
      // CSRF tokens need a session, and this path for an anonymous viewer can only refuse, never
      // change state. A writer with a session still needs the session and CSRF token below.
      return { write: true, shareReadable: id, run: (v, _a, b) => postExport(res, deps, id, v, b) };
    }
    if (sub === "frames" && method === "GET") {
      return { write: false, shareReadable: id, run: (v) => getFrames(res, deps, id, v, url.searchParams) };
    }
  }
  return null;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  body: unknown,
  deps: WebDeps,
): Promise<void> {
  const route = matchApi(res, url, method, deps);
  if (!route) throw new Error("not_found");
  if (route.write) assertSameOrigin(req, deps.canonicalUri);
  const ctx = await resolveContext(req, deps);
  if (ctx.kind === "none") {
    const shareToken = req.headers[SHARE_HEADER];
    if (route.shareReadable && typeof shareToken === "string") {
      const resolved = await resolveShareToken(deps.db, shareToken);
      if (resolved && resolved.document.id === route.shareReadable) {
        const permission = resolved.link.permission === "comment" ? "comment" : "view";
        // An anonymous reader: the link decides access; no guest id, so nothing is "mine".
        const viewer: Viewer = { kind: "guest", guestId: "", shareLinkId: resolved.link.id, permission };
        return route.run(viewer, true, isJsonObject(body) ? body : {});
      }
    }
    throw new Error("web_session_required");
  }
  if (route.write) {
    assertCsrf(req, ctx.session);
    if (method !== "DELETE" && !isJsonObject(body)) throw new Error("expected_json_object");
  }
  // Per-request link elevation for a member (requestViewer).
  const viewer = await requestViewer(req, deps, ctx);
  return route.run(viewer, false, isJsonObject(body) ? body : {});
}
