import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { escapeHtml, scriptJson } from "../core/html-escape.js";
import { logger } from "../core/logger.js";
import { pageHeaders } from "./security.js";
import { STATIC_PREFIX, type AssetManifest } from "./static.js";

/** Who the page is for, as the browser app sees it. Names only: never an email. */
export interface PageViewer {
  kind: "member" | "guest" | "anonymous";
  name: string | null;
  access: string;
}

/** The bootstrap the page hands the browser app as `window.__WARDBY__`. */
export interface PageBootstrap {
  documentId: string;
  /** Which app the page runs: the Markdown editor or the design boards. */
  kind: "document" | "design";
  /** This session's CSRF value (or, on a share-link page without a session, the pre-session one). */
  csrf: string;
  viewer: PageViewer;
  /**
   * Present on /s/<token> pages. The app sends it as `x-wardby-share` on every API request from this
   * page: an anonymous visitor reads with it, and a signed-in member gets the link's permission with it
   * (their session never carries the link). It also addresses guest registration.
   */
  shareToken?: string;
  loginUrl: string;
  logoutUrl: string;
}

export { escapeHtml, scriptJson };

const pageLog = logger.child({ module: "web" });

const newNonce = () => randomBytes(18).toString("base64");

/** The `integrity` and `crossorigin` attributes for a bundle file, or nothing without a digest. */
const sri = (digest: string | undefined) =>
  digest ? ` integrity="${escapeHtml(digest)}" crossorigin="anonymous"` : "";

/**
 * The document or design page: an empty #app, the nonce'd bootstrap and the hashed bundle from the
 * manifest, with Subresource Integrity from integrity.json. A missing or malformed digest serves the
 * page without integrity (one warning, naming the bundle only); the CSP still limits scripts to 'self'.
 */
export function sendDocumentPage(
  res: ServerResponse,
  input: {
    title: string;
    bootstrap: PageBootstrap;
    manifest: AssetManifest;
    bundle: "documents" | "designs";
    integrity: Record<string, string> | null;
  },
): void {
  const nonce = newNonce();
  const { bundle } = input;
  const js = input.manifest[`${bundle}.js`];
  const css = input.manifest[`${bundle}.css`];
  const jsDigest = input.integrity?.[`${bundle}.js`];
  const cssDigest = input.integrity?.[`${bundle}.css`];
  if ((js && !jsDigest) || (css && !cssDigest)) {
    pageLog.warn({ bundle }, "web asset integrity missing; serving the page without integrity attributes");
  }
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(input.title)} · Wardby</title>` +
    (css ? `<link rel="stylesheet" href="${STATIC_PREFIX}${escapeHtml(css)}"${sri(cssDigest)}>` : "") +
    '</head><body><div id="app"></div>' +
    `<script nonce="${nonce}">window.__WARDBY__ = ${scriptJson(input.bootstrap)};</script>` +
    (js ? `<script src="${STATIC_PREFIX}${escapeHtml(js)}"${sri(jsDigest)}></script>` : "") +
    "</body></html>";
  res
    .writeHead(200, {
      ...pageHeaders(nonce, { boardStyles: bundle === "designs" }),
      "content-type": "text/html; charset=utf-8",
    })
    .end(html);
}

/** A plain error page carrying only a fixed error code (never a message). */
export function sendErrorPage(res: ServerResponse, status: number, code: string, extraHeaders = {}): void {
  const nonce = newNonce();
  const safe = escapeHtml(code);
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>Wardby</title></head><body><main><h1>This page can't be shown</h1>` +
    `<p>Error code: <code>${safe}</code></p></main></body></html>`;
  res
    .writeHead(status, { ...pageHeaders(nonce), "content-type": "text/html; charset=utf-8", ...extraHeaders })
    .end(html);
}
