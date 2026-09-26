/**
 * The browser end of link_host_account: GitHub redirects here after the user
 * authorizes the App (GET /hosts/github/user-callback?code&state). Mounted in
 * streamable-http.ts behind its canonical-Host check, and only when the App's
 * OAuth client credentials are configured. It shows the one-time
 * confirmation code the initiating principal must submit over MCP, never a
 * token. No script, no forms, no framing, nothing cached, no referrer.
 */
import type { ServerResponse } from "node:http";
import type { PrismaClient } from "#prisma";
import { completeHostIdentityCallback } from "../../core/host-identity-links.js";
import type { HostUserAuthorizer } from "../../providers/review-host/types.js";
import { PAGE_STYLE } from "../shared/page-style.js";

export interface HostUserCallbackDeps {
  db: Pick<PrismaClient, "hostIdentityLinkRequest">;
  authorizer: HostUserAuthorizer;
  /** Exactly the redirect_uri the authorize URL carried (the App's registered Callback URL). */
  redirectUri: string;
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

export async function handleHostUserCallback(url: URL, res: ServerResponse, deps: HostUserCallbackDeps): Promise<void> {
  const error = url.searchParams.get("error");
  if (error !== null) {
    if (error === "access_denied") {
      page(
        res,
        200,
        "Linking cancelled",
        "<p>You cancelled on GitHub. Nothing was linked; you can close this page.</p>",
      );
    } else {
      page(res, 400, "Linking failed", "<p>GitHub did not authorize the link. Start again from your MCP client.</p>");
    }
    return;
  }
  const outcome = await completeHostIdentityCallback({
    db: deps.db,
    authorizer: deps.authorizer,
    state: url.searchParams.get("state"),
    code: url.searchParams.get("code"),
    redirectUri: deps.redirectUri,
  });
  if (outcome.kind === "invalid") {
    page(
      res,
      400,
      "Link not valid",
      "<p>This link is invalid or has expired. Start again from your MCP client with <code>link_host_account</code>.</p>",
    );
    return;
  }
  if (outcome.kind === "failed") {
    page(res, 502, "Linking failed", "<p>GitHub did not complete the sign-in. Start again from your MCP client.</p>");
    return;
  }
  page(
    res,
    200,
    "Confirm the link",
    `<p>Signed in to GitHub as <strong>@${escape(outcome.login)}</strong>, to be linked to the wardby account ` +
      `<strong>${escape(outcome.subject)}</strong>.</p>` +
      `<p>Give your MCP client this code (call <code>link_host_account</code> with <code>confirmationCode</code>):</p>` +
      `<p style="font-size:2em;font-family:monospace;letter-spacing:.1em"><strong>${escape(outcome.code)}</strong></p>` +
      `<p>It works once, within 10 minutes. <strong>If you did not start this, close this page</strong> and do not ` +
      `share the code: someone may be trying to use your GitHub account's access.</p>`,
  );
}
