---
id: errors/web-login-failed
title: Browser sign-in failed (web_login_failed)
summary: The identity provider sign-in could not be completed.
audience: operator
tags: [error, documents, web_login_failed]
appliesTo: ">=0.10.0"
---

# Browser sign-in failed

`web_login_failed` (HTTP 400). The sign-in returned an error, the ID token failed verification, or the page asked to return somewhere that is not on this server. Nothing was signed in. Start again from the document link. If it keeps failing, check that the web client's redirect URI is registered exactly, that its ID tokens carry the same `sub` as the access tokens, and that the issuer and clock are right. See [Browser sign-in](../web-sign-in.md).

See [Documents](../documents.md).
