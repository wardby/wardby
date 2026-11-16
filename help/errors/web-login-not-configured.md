---
id: errors/web-login-not-configured
title: Browser sign-in not configured (web_login_not_configured)
summary: WEB_OIDC_CLIENT_ID is not set.
audience: operator
tags: [error, documents, web_login_not_configured]
appliesTo: ">=0.10.0"
---

# Browser sign-in not configured

`web_login_not_configured` (HTTP 503). With `AUTH_PROVIDER=delegating`, the document pages need an identity-provider web client: set `WEB_OIDC_CLIENT_ID` (and `WEB_OIDC_CLIENT_SECRET` for a confidential client), register `https://<your-host>/web/callback` and restart. See [Browser sign-in](../web-sign-in.md). Share links work without it.

See [Documents](../documents.md).
