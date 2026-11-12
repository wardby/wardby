---
id: oauth-loopback-connect
title: Connect an OAuth secret through the Wardby CLI (loopback sign-in)
summary: For providers that accept only 127.0.0.1 callbacks, such as BrowserStack's MCP server, call create_secret with oauth.callback "loopback", run wardby secret connect - on your computer, then confirm with the code it prints.
audience: operator
tags: [oauth, loopback, secret connect, browserstack, invalid_redirect_uri, callback loopback]
appliesTo: ">=0.9.12"
---

# Connect an OAuth secret through the Wardby CLI

Some providers register Wardby only for loopback callbacks (`http://127.0.0.1:<port>/callback`), so the default
sign-in link fails with [`secret_oauth_registration_failed`](errors/secret-oauth-registration-failed.md) and
`invalid_redirect_uri`. BrowserStack's hosted MCP server is one. Use the loopback flow, which works over HTTP and
stdio.

## Steps

1. `create_secret { name, oauth: { resource, scope?, clientId?, callback: "loopback" } }`. For BrowserStack,
   `resource` is `https://mcp.browserstack.com/mcp`. Do not pass `value`, `broker` or `confirmationCode`. The
   result has `status: "pending"`, a `command` (`npx @wardby/cli@latest secret connect -`), a `link` and
   `expiresAt` (10 minutes).
2. On your own computer, run the `command` in a terminal. When it asks "Paste the connect link:", paste the
   `link`. The CLI opens your browser to the provider (`--no-browser` prints the address instead); sign in as
   the service user. It prints `Confirmation code: XXXX-XXXX` and the `create_secret` call to make.
3. `create_secret { name, confirmationCode }` with the same name. The secret is connected; use it like any
   [OAuth secret](oauth-secrets.md).

## What you need

- Node.js 24 or later, and a browser on the same machine as the CLI (the provider redirects the browser to
  `127.0.0.1` on that machine).
- That machine can reach your Wardby server at its canonical URL. A link to a plain `http` address is refused
  unless it is `127.0.0.1`, `localhost` or `[::1]`.

## Safety

- The link is a credential for 10 minutes for one owner and one secret name. At most 5 sign-ins can be waiting for
  your account at once; each expires after 10 minutes. Do not share it. The CLI reads it
  from standard input, so it stays out of shell history.
- Only the owner named in the link can redeem the confirmation code.
- If the provider refuses even a loopback callback, register a client yourself and pass `oauth.clientId`; it
  must allow `http://127.0.0.1:<any port>/callback`.

## If the CLI fails

The CLI prints one line, and the fix depends on it:

- Could not reach the Wardby server: check the address in the link and your network, then run the command again
  with the same link if it has not expired.
- The link is invalid or has expired (also shown when the link expires while you sign in): get a new link with
  `create_secret`.
- Too many sign-ins are waiting for your account (at most 5 at once; each expires after 10 minutes): wait a few
  minutes, then run the command again.
- Wardby refused to start the sign-in, followed by a code such as `secret_oauth_registration_failed` and the
  server's message: act on that message. See the matching article under `errors/`; for `invalid_redirect_uri`
  on this flow, register a client and pass `oauth.clientId` (see Safety).
- Could not listen on this machine: free local ports or a firewall rule is blocking `127.0.0.1`; run it again.
- The sign-in was cancelled or refused at the provider, the provider returned an error, the redirect was
  incomplete, it timed out (after 10 minutes at most, or when the link expires), or Wardby could not finish the
  sign-in: get a new link with `create_secret` and start again.

Full guide: [`docs/tool-secrets.md`](../docs/tool-secrets.md#providers-that-accept-only-loopback-callbacks).
