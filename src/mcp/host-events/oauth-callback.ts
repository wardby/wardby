/**
 * The browser end of the shared OAuth link flow (core/oauth-link.ts): the
 * provider redirects here after the user signs in (GET /oauth/callback, and
 * GET /hosts/github/user-callback for link_host_account, the GitHub App's
 * registered Callback URL). Mounted in streamable-http.ts behind its
 * canonical-Host check, and only when a link adapter is configured. It shows
 * the one-time confirmation code the initiating principal must submit over
 * MCP, never a token. No script, no forms, no framing, nothing cached, no
 * referrer.
 */
import type { ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import { completeOAuthCallback, OAUTH_ISS_MAX_LENGTH, type OAuthLinkAdapter } from "../../core/oauth-link.js";
import type { SecretCipher } from "../../providers/secrets/types.js";
import { PAGE_STYLE } from "../shared/page-style.js";

export interface OAuthCallbackDeps {
  db: Pick<PrismaClient, "oAuthLinkRequest">;
  /** Encrypts a purpose's secret payload before it is stored. */
  cipher: Pick<SecretCipher, "encrypt">;
  /** One adapter per purpose; a request whose purpose has none is "not valid". */
  adapters: ReadonlyMap<string, OAuthLinkAdapter<unknown, unknown>>;
  /** Exactly the redirect_uri a purpose's authorize URL carried. */
  redirectUri: (purpose: string) => string;
}

/** What the route already knows before the state is read: who sent the browser back, and which tool to restart with. */
export interface OAuthCallbackRoute {
  target?: string;
  tool?: string;
  /** Only requests of these purposes are completed here; any other state is "not valid". */
  purposePrefix?: string;
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("x-content-type-options", "nosniff");
  res
    .writeHead(status, { "content-type": "text/html; charset=utf-8" })
    .end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>wardby: ${escape(title)}</title><style>${PAGE_STYLE}</style><body><div class="card"><div class="kicker">wardby</div>` +
        `<h1>${escape(title)}</h1>${body}</div></body></html>`,
    );
}

function restart(tool: string | undefined): string {
  return tool ? ` with <code>${escape(tool)}</code>` : "";
}

export async function handleOAuthCallback(
  url: URL,
  res: ServerResponse,
  deps: OAuthCallbackDeps,
  route: OAuthCallbackRoute = {},
): Promise<void> {
  const target = route.target ?? "the provider";
  const Target = target.charAt(0).toUpperCase() + target.slice(1);
  const error = url.searchParams.get("error");
  if (error !== null) {
    if (error === "access_denied") {
      page(
        res,
        200,
        "Linking cancelled",
        `<p>You cancelled on ${escape(target)}. Nothing was linked; you can close this page.</p>`,
      );
    } else {
      page(
        res,
        400,
        "Linking failed",
        `<p>${escape(Target)} did not authorize the link. Start again from your MCP client.</p>`,
      );
    }
    return;
  }
  // RFC 9207: the issuer that sent the browser back, checked by an adapter that knows its issuer.
  const iss = url.searchParams.get("iss") ?? undefined;
  const outcome =
    iss !== undefined && iss.length > OAUTH_ISS_MAX_LENGTH
      ? ({ kind: "invalid" } as const)
      : await completeOAuthCallback({
          db: deps.db,
          adapters: route.purposePrefix
            ? new Map([...deps.adapters].filter(([purpose]) => purpose.startsWith(route.purposePrefix!)))
            : deps.adapters,
          cipher: deps.cipher,
          state: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
          ...(iss !== undefined ? { iss } : {}),
          redirectUri: deps.redirectUri,
        });
  if (outcome.kind === "invalid") {
    page(
      res,
      400,
      "Link not valid",
      `<p>This link is invalid or has expired. Start again from your MCP client${restart(route.tool)}.</p>`,
    );
    return;
  }
  if (outcome.kind === "failed") {
    page(
      res,
      502,
      "Linking failed",
      `<p>${escape(Target)} did not complete the sign-in. Start again from your MCP client.</p>`,
    );
    return;
  }
  page(
    res,
    200,
    "Confirm the link",
    (outcome.signedInAs === undefined
      ? `<p>Signed in to ${escape(outcome.target)}, to be connected to the wardby account ` +
        `<strong>${escape(outcome.subject)}</strong>.</p>`
      : `<p>Signed in to ${escape(outcome.target)} as <strong>${escape(outcome.signedInAs)}</strong>, to be linked to the wardby account ` +
        `<strong>${escape(outcome.subject)}</strong>.</p>`) +
      `<p>Give your MCP client this code (call <code>${escape(outcome.tool)}</code> with <code>confirmationCode</code>):</p>` +
      `<p style="font-size:2em;font-family:monospace;letter-spacing:.1em"><strong>${escape(outcome.code)}</strong></p>` +
      `<p>It works once, within 10 minutes. <strong>If you did not start this, close this page</strong> and do not ` +
      `share the code: someone may be trying to use your ${escape(outcome.target)} account's access.</p>`,
  );
}
