---
id: errors/web-login-state-invalid
title: Browser sign-in state invalid (web_login_state_invalid)
summary: The sign-in took longer than 10 minutes, or was opened in another browser.
audience: operator
tags: [error, documents, web_login_state_invalid]
appliesTo: ">=0.10.0"
---

# Browser sign-in state invalid

`web_login_state_invalid` (HTTP 400). The sign-in must finish in the browser that started it within 10 minutes. This also happens when cookies are blocked or the callback is opened twice. Open the document link again and sign in once.

See [Documents](../documents.md).
