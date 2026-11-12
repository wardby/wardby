---
id: web-sign-in
title: Browser sign-in for document pages
summary: How members sign in to /d/ pages, and the identity-provider web client (WEB_OIDC_CLIENT_ID, redirect URI) a delegating deployment needs.
audience: operator
tags: [documents, sign-in, oidc, WEB_OIDC_CLIENT_ID, WEB_OIDC_CLIENT_SECRET, WEB_OIDC_SCOPES, delegating]
appliesTo: ">=0.10.0"
---

# Browser sign-in for document pages

- Self-hosted auth (`AUTH_PROVIDER=self-hosted`): the page reuses the Wardby login you already have. Nothing to configure.
- Delegating auth (`AUTH_PROVIDER=delegating`): create a second client at your identity provider for the browser (authorization code with PKCE) and set:

| Variable                 | Meaning                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- |
| `WEB_OIDC_CLIENT_ID`     | The web client's ID. Unset turns member sign-in off (share links still work). |
| `WEB_OIDC_CLIENT_SECRET` | Only for a confidential client; leave unset for a public client.              |
| `WEB_OIDC_SCOPES`        | Space-separated; default `openid profile email`.                              |

Register the redirect URI `https://<your-host>/web/callback` (the origin of `MCP_CANONICAL_URI`). The client's ID tokens must carry the same `sub` as the access tokens MCP clients get, so both map to one person. The issuer is `AUTH_ISSUER`.

A sign-in must finish in 10 minutes in the same browser. Sessions end after 12 hours idle or 7 days. Errors: `web_login_not_configured`, `web_login_failed`, `web_login_state_invalid`, `web_csrf_failed`, `web_origin_rejected`. See [Documents](documents.md).

## Related

- [Documents](documents.md)
