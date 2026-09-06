/**
 * The one-time browser form a secret-elicitation URL points to — shared by
 * both hosts: stdio's ephemeral loopback server (secret-elicitation-server.ts)
 * and the HTTP transport's mounted route (wired in streamable-http.ts). No
 * JavaScript: a plain HTML form POST is enough for one password field, so
 * CSP can forbid scripts outright rather than needing a nonce.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "@prisma/client";
import type { SecretCipher } from "../../providers/secrets/types.js";
import { fulfillSecretElicitation, type SecretElicitationPayload } from "./secret-elicitation.js";

/** The HTTP-transport route path this form is mounted at (see streamable-http.ts). */
export const SECRET_ELICITATION_PATH = "/elicit/secret";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: #f5f5f7; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.card { background: #fff; border-radius: 14px; box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 8px 24px rgba(0,0,0,.08);
  padding: 36px; max-width: 480px; width: 100%; }
h1 { margin: 0 0 10px; font-size: 21px; }
p { margin: 0 0 24px; color: #555; font-size: 14px; line-height: 1.5; }
p strong { color: #111; }
input[type=password] { display: block; width: 100%; padding: 16px 18px; font-size: 17px; letter-spacing: .02em;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border: 1px solid #d1d1d6; border-radius: 10px;
  margin-bottom: 18px; }
input[type=password]:focus { outline: none; border-color: #0071e3; box-shadow: 0 0 0 3px rgba(0,113,227,.15); }
button { width: 100%; padding: 15px; font-size: 15px; font-weight: 600; color: #fff; background: #0071e3;
  border: none; border-radius: 10px; cursor: pointer; }
button:hover { background: #0077ed; }
@media (prefers-color-scheme: dark) {
  body { background: #1c1c1e; }
  .card { background: #2c2c2e; box-shadow: none; }
  h1 { color: #f5f5f7; }
  p { color: #a1a1a6; }
  p strong { color: #f5f5f7; }
  input[type=password] { background: #1c1c1e; border-color: #48484a; color: #f5f5f7; }
}`;

function html(res: ServerResponse, status: number, body: string): void {
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>reevo secret entry</title><style>${STYLE}</style><body><div class="card">${body}</div></body></html>`,
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
    html(res, 400, "<h1>Link expired</h1><p>This link is invalid or has expired. Return to your MCP client and try again.</p>");
    return;
  }

  if (method === "GET") {
    html(
      res,
      200,
      `<h1>Enter secret value</h1><p>Name: <strong>${escape(payload.secretName)}</strong></p>` +
        `<form method="post"><input type="password" name="value" autocomplete="off" required autofocus placeholder="Paste the value here">` +
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
