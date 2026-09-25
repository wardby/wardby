/**
 * The one-time browser form a secret-elicitation URL points to — shared by
 * both hosts: stdio's ephemeral loopback server (secret-elicitation-server.ts)
 * and the HTTP transport's mounted route (wired in streamable-http.ts). No
 * JavaScript: a plain HTML form POST is enough for one password field, so
 * CSP can forbid scripts outright rather than needing a nonce.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import type { SecretCipher } from "../../providers/secrets/types.js";
import { fulfillSecretElicitation, type SecretElicitationPayload } from "./secret-elicitation.js";
import { PAGE_STYLE } from "../shared/page-style.js";

/** The HTTP-transport route path this form is mounted at (see streamable-http.ts). */
export const SECRET_ELICITATION_PATH = "/elicit/secret";

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function html(res: ServerResponse, status: number, body: string): void {
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  // Not no-referrer: under it a browser sends `Origin: null` on this page's native
  // form POST, even to the same origin, and the HTTP transport rejects that as
  // invalid_origin. same-origin keeps the Origin and still sends nothing,
  // token-bearing URL included, to any other site. (The login page solves the
  // same problem with a fetch() instead; this page runs no script at all.)
  res.setHeader("referrer-policy", "same-origin");
  res
    .writeHead(status, { "content-type": "text/html; charset=utf-8" })
    .end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>wardby secret entry</title><style>${PAGE_STYLE}</style><body><div class="card"><div class="kicker">wardby</div>${body}</div></body></html>`,
    );
}

export interface SecretFormDeps {
  verify: (token: string) => Promise<SecretElicitationPayload>;
  secrets: SecretCipher;
  db: PrismaClient;
}

/** Handles one GET (render) or POST (submit) for the secret-entry form at the given token. */
export async function handleSecretElicitationForm(
  method: string | undefined,
  token: string | null,
  readFormBody: () => Promise<URLSearchParams>,
  res: ServerResponse,
  deps: SecretFormDeps,
): Promise<void> {
  let payload: SecretElicitationPayload;
  try {
    if (!token) throw new Error("missing token");
    payload = await deps.verify(token);
  } catch {
    html(
      res,
      400,
      "<h1>Link expired</h1><p>This link is invalid or has expired. Return to your MCP client and try again.</p>",
    );
    return;
  }

  if (method === "GET") {
    html(
      res,
      200,
      `<h1>Enter secret value</h1><p>Name: <strong>${escape(payload.secretName)}</strong></p>` +
        `<form method="post"><label>Secret value` +
        `<input type="password" name="value" autocomplete="off" required autofocus placeholder="Paste the value here"></label>` +
        `<button type="submit">Save</button></form>`,
    );
    return;
  }

  if (method === "POST") {
    const body = await readFormBody();
    const value = body.get("value") ?? "";
    if (!value) {
      html(res, 400, "<h1>A value is required.</h1>");
      return;
    }
    const outcome = await fulfillSecretElicitation(payload, value, deps.secrets, deps.db);
    if (outcome.ok) html(res, 200, "<h1>Saved</h1><p>You can close this tab and return to your MCP client.</p>");
    else html(res, 400, `<h1>Could not save</h1><p>${escape(outcome.error)}</p>`);
    return;
  }

  res.writeHead(405).end();
}

/** Reads a small `application/x-www-form-urlencoded` body (8 KiB cap — a secret value, nothing more). */
export function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}
