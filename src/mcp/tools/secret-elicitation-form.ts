/**
 * The one-time browser form a secret-elicitation URL points to — shared by
 * both hosts: stdio's ephemeral loopback server (secret-elicitation-server.ts)
 * and the HTTP transport's mounted route (wired in streamable-http.ts). No
 * JavaScript: a plain HTML form POST is enough for one password field (plus
 * the optional broker fields, shown and hidden by a CSS `:checked` rule), so
 * CSP can forbid scripts outright rather than needing a nonce.
 *
 * Two pages share the route, chosen by the signed payload's `kind`: "create"
 * (enter a value, optionally brokered) and "unbroker" (a person confirms
 * removing a secret's broker config by typing its name). An unbroker link
 * never shows or accepts a value.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import type { SecretCipher } from "../../providers/secrets/types.js";
import {
  fulfillSecretElicitation,
  fulfillUnbrokerElicitation,
  type SecretElicitationPayload,
} from "./secret-elicitation.js";
import { listSecrets } from "../../core/secrets.js";
import { parseSecretBrokerConfig, type SecretBrokerConfig } from "../../core/secret-broker-config.js";
import { PAGE_STYLE } from "../shared/page-style.js";

/** The HTTP-transport route path this form is mounted at (see streamable-http.ts). */
export const SECRET_ELICITATION_PATH = "/elicit/secret";

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

const BROKER_WARNING =
  "If this is not brokered, any tool attached with this secret can read its value and send it anywhere that tool can fetch — including when a prompt-injected agent tells it to.";
const BROKER_COMPAT =
  'Brokered secrets only work with tools that call <code>fetch(url, { secrets: ["NAME"] })</code>. A tool that reads the value with <code>secrets.get()</code> will fail with <code>secret_brokered</code>.';

/** Script-free toggle: the fields after the checkbox show only while it is checked. */
const BROKER_STYLE = `
.broker-toggle { display: inline-block; margin: 0 0 12px 6px; color: var(--ink); }
.broker-fields { display: none; }
#brokered:checked ~ .broker-fields { display: block; }
.warning { border-left: 3px solid #b45309; padding-left: 8px; color: var(--ink); }
.broker-fields input, .broker-fields textarea, .broker-fields select, input[name="confirm"] {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 10px 12px;
  font: inherit;
  font-size: 14px;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
}
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
code { overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; }
.hint { margin: 4px 0 12px; }
.broker-summary { margin: 0 0 12px; padding: 10px 10px 10px 28px; background: var(--paper); border: 1px solid var(--line); border-radius: 10px; color: var(--ink); }
.broker-summary li { margin: 2px 0; }
/* Show only the selected placement's fields; browsers without :has() show them all. */
@supports selector(:has(*)) {
  .placement { display: none; }
  .broker-fields:has(option[value="header"]:checked) .placement-header,
  .broker-fields:has(option[value="query"]:checked) .placement-query,
  .broker-fields:has(option[value="body"]:checked) .placement-body,
  .broker-fields:has(option[value="aws-sigv4"]:checked) .placement-aws-sigv4 { display: block; }
}
`;

/** The "Brokered (recommended)" checkbox, warning, compatibility note, and broker fields, pre-filled from `prefill`. */
export function brokerFieldset(prefill?: SecretBrokerConfig): string {
  const p = prefill?.placement;
  const sel = (kind: string) => (p?.kind === kind ? " selected" : "");
  return (
    `<input type="checkbox" id="brokered" name="brokered" value="1"${prefill ? " checked" : ""}>` +
    `<label class="broker-toggle" for="brokered">Brokered (recommended)</label>` +
    `<p class="warning">${escape(BROKER_WARNING)}</p>` +
    `<p>${BROKER_COMPAT}</p>` +
    `<div class="broker-fields">` +
    `<label>Allowed hosts (one per line)<textarea name="hosts" rows="2">${escape(prefill?.hosts.join("\n") ?? "")}</textarea></label>` +
    `<label>Path prefixes (optional, one per line)<textarea name="pathPrefixes" rows="2">${escape(prefill?.pathPrefixes?.join("\n") ?? "")}</textarea></label>` +
    `<label>Placement<select name="placement">` +
    `<option value="header"${sel("header")}>Header</option><option value="query"${sel("query")}>Query parameter</option>` +
    `<option value="body"${sel("body")}>Body field</option><option value="aws-sigv4"${sel("aws-sigv4")}>AWS SigV4</option></select></label>` +
    `<div class="placement placement-header">` +
    `<label>Header name<input name="headerName" value="${escape(p?.kind === "header" ? p.name : "Authorization")}"></label>` +
    `<label>Header format<input name="headerFormat" value="${escape(p?.kind === "header" ? p.format : "Bearer {value}")}"></label>` +
    `<p class="hint"><code>{value}</code> is replaced with the secret.</p>` +
    `</div>` +
    `<div class="placement placement-query">` +
    `<label>Query parameter name<input name="queryName" value="${escape(p?.kind === "query" ? p.name : "")}"></label>` +
    `</div>` +
    `<div class="placement placement-body">` +
    `<label>Body field name<input name="bodyField" value="${escape(p?.kind === "body" ? p.field : "")}"></label>` +
    `<p class="hint">A top-level field of a JSON-object or form-encoded body.</p>` +
    `</div>` +
    `<div class="placement placement-aws-sigv4">` +
    `<label>AWS region<input name="awsRegion" value="${escape(p?.kind === "aws-sigv4" ? p.region : "")}"></label>` +
    `<label>AWS service<input name="awsService" value="${escape(p?.kind === "aws-sigv4" ? p.service : "")}"></label>` +
    `<p class="hint">For AWS SigV4 the secret value is JSON (session token optional):</p>` +
    `<pre>{\n  "accessKeyId": "…",\n  "secretAccessKey": "…",\n  "sessionToken": "…"\n}</pre>` +
    `</div>` +
    `</div>`
  );
}

const lines = (v: string | null) =>
  (v ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The form's broker config: null when the box is unchecked; throws secret_broker_config_invalid when it doesn't validate. */
export function brokerConfigFromForm(body: URLSearchParams): SecretBrokerConfig | null {
  if (body.get("brokered") !== "1") return null;
  const kind = body.get("placement");
  const placement =
    kind === "header"
      ? { kind, name: body.get("headerName") ?? "", format: body.get("headerFormat") ?? "" }
      : kind === "query"
        ? { kind, name: body.get("queryName") ?? "" }
        : kind === "body"
          ? { kind, field: body.get("bodyField") ?? "" }
          : kind === "aws-sigv4"
            ? { kind, region: body.get("awsRegion") ?? "", service: body.get("awsService") ?? "" }
            : { kind };
  const prefixes = lines(body.get("pathPrefixes"));
  return parseSecretBrokerConfig({
    hosts: lines(body.get("hosts")),
    ...(prefixes.length > 0 && { pathPrefixes: prefixes }),
    placement,
  });
}

function html(res: ServerResponse, status: number, body: string, extraStyle = ""): void {
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
        `<title>wardby secret entry</title><style>${PAGE_STYLE}${extraStyle}</style><body><div class="card"><div class="kicker">wardby</div>${body}</div></body></html>`,
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

  if ((payload.kind ?? "create") === "unbroker") {
    await handleUnbroker(method, payload, readFormBody, res, deps);
    return;
  }

  if (method === "GET") {
    html(
      res,
      200,
      `<h1>Enter secret value</h1><p>Name: <strong>${escape(payload.secretName)}</strong></p>` +
        `<form method="post"><label>Secret value` +
        `<input type="password" name="value" autocomplete="off" required autofocus placeholder="Paste the value here"></label>` +
        brokerFieldset(payload.broker) +
        `<button type="submit">Save</button></form>`,
      BROKER_STYLE,
    );
    return;
  }

  if (method === "POST") {
    const body = await readBodyOr413(readFormBody, res);
    if (!body) return;
    const value = body.get("value") ?? "";
    if (!value) {
      html(res, 400, "<h1>A value is required.</h1>");
      return;
    }
    let broker: SecretBrokerConfig | null;
    try {
      broker = brokerConfigFromForm(body);
    } catch (err) {
      html(res, 400, `<h1>Could not save</h1><p>${escape(err instanceof Error ? err.message : String(err))}</p>`);
      return;
    }
    const outcome = await fulfillSecretElicitation(payload, value, deps.secrets, deps.db, broker);
    if (outcome.ok) html(res, 200, "<h1>Saved</h1><p>You can close this tab and return to your MCP client.</p>");
    else html(res, 400, `<h1>Could not save</h1><p>${escape(outcome.error)}</p>`);
    return;
  }

  res.writeHead(405).end();
}

/** Reads the POST body, or answers 413 (over the cap) and returns undefined. */
async function readBodyOr413(
  readFormBody: () => Promise<URLSearchParams>,
  res: ServerResponse,
): Promise<URLSearchParams | undefined> {
  try {
    return await readFormBody();
  } catch (err) {
    if (!(err instanceof Error && err.message === "body_too_large")) throw err;
    res.setHeader("connection", "close");
    html(res, 413, "<h1>Value too large</h1><p>The form was larger than this page accepts.</p>");
    return undefined;
  }
}

/** A readable, escaped summary of a broker config for the unbroker page. */
function describeBroker(broker: SecretBrokerConfig | null): string {
  if (!broker) return "<p>(not brokered)</p>";
  const p = broker.placement;
  const placement =
    p.kind === "header"
      ? `header <code>${escape(p.name)}: ${escape(p.format)}</code>`
      : p.kind === "query"
        ? `query parameter <code>${escape(p.name)}</code>`
        : p.kind === "body"
          ? `body field <code>${escape(p.field)}</code>`
          : `AWS SigV4 (region <code>${escape(p.region)}</code>, service <code>${escape(p.service)}</code>)`;
  const list = (items: readonly string[]) => items.map((item) => `<code>${escape(item)}</code>`).join(", ");
  return (
    `<ul class="broker-summary">` +
    `<li>Hosts: ${list(broker.hosts)}</li>` +
    (broker.pathPrefixes?.length ? `<li>Paths: ${list(broker.pathPrefixes)}</li>` : "") +
    `<li>Sent as: ${placement}</li>` +
    `</ul>`
  );
}

/** The unbroker link's page: show what is brokered now, and remove it only when the person types the secret's name. */
async function handleUnbroker(
  method: string | undefined,
  payload: SecretElicitationPayload,
  readFormBody: () => Promise<URLSearchParams>,
  res: ServerResponse,
  deps: SecretFormDeps,
): Promise<void> {
  if (method === "GET") {
    const current = (await listSecrets(payload.ownerId, deps.db)).find((s) => s.name === payload.secretName);
    html(
      res,
      200,
      `<h1>Remove brokering</h1><p>Name: <strong>${escape(payload.secretName)}</strong></p>` +
        `<p>Currently brokered as:</p>${describeBroker(current?.broker ?? null)}` +
        `<p class="warning">${escape(BROKER_WARNING)}</p>` +
        `<form method="post"><label>Type the secret's name to confirm` +
        `<input name="confirm" autocomplete="off" required autofocus></label>` +
        `<button type="submit">Remove brokering</button></form>`,
      BROKER_STYLE,
    );
    return;
  }

  if (method === "POST") {
    const body = await readBodyOr413(readFormBody, res);
    if (!body) return;
    if (body.get("confirm") !== payload.secretName) {
      html(res, 400, `<h1>${escape("Type the secret's name to confirm.")}</h1>`);
      return;
    }
    const outcome = await fulfillUnbrokerElicitation(payload, deps.secrets, deps.db);
    if (outcome.ok) {
      html(res, 200, "<h1>Brokering removed</h1><p>You can close this tab and return to your MCP client.</p>");
    } else {
      html(res, 400, `<h1>Could not remove brokering</h1><p>${escape(outcome.error)}</p>`);
    }
    return;
  }

  res.writeHead(405).end();
}

/**
 * The largest form body accepted: room for the largest valid AWS SigV4 value
 * (an 8 KiB session token, up to 3x after URL encoding) plus the broker fields.
 */
export const FORM_BODY_LIMIT = 32 * 1024;

/**
 * Reads a small `application/x-www-form-urlencoded` body. Over FORM_BODY_LIMIT it
 * rejects with `body_too_large` and discards the rest of the upload, so the
 * handler can still answer 413 on the same connection.
 */
export function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > FORM_BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
  });
}
