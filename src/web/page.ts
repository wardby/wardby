import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
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

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * JSON that is safe inside an inline <script>: "<", ">", "&" and the JS line
 * separators are written as \u escapes, so no value can close the element or
 * start a comment.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const newNonce = () => randomBytes(18).toString("base64");

function send(res: ServerResponse, status: number, html: string, nonce: string): void {
  res.writeHead(status, { ...pageHeaders(nonce), "content-type": "text/html; charset=utf-8" }).end(html);
}

/** The document page: an empty #app, the nonce'd bootstrap and the hashed bundle from the manifest. */
export function sendDocumentPage(
  res: ServerResponse,
  input: { title: string; bootstrap: PageBootstrap; manifest: AssetManifest },
): void {
  const nonce = newNonce();
  const js = input.manifest["documents.js"];
  const css = input.manifest["documents.css"];
  const html =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(input.title)} · Wardby</title>` +
    (css ? `<link rel="stylesheet" href="${STATIC_PREFIX}${escapeHtml(css)}">` : "") +
    '</head><body><div id="app"></div>' +
    `<script nonce="${nonce}">window.__WARDBY__ = ${scriptJson(input.bootstrap)};</script>` +
    (js ? `<script src="${STATIC_PREFIX}${escapeHtml(js)}"></script>` : "") +
    "</body></html>";
  send(res, 200, html, nonce);
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
