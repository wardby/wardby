---
id: web-sign-in
title: Browser sign-in for document pages
summary: How members sign in to /d/ pages, and the identity-provider web client (WEB_OIDC_CLIENT_ID, redirect URI) a delegating deployment needs.
audience: operator
tags:
  [
    documents,
    sign-in,
    oidc,
    WEB_OIDC_CLIENT_ID,
    WEB_OIDC_CLIENT_SECRET,
    WEB_OIDC_SCOPES,
    WEB_OIDC_SUBJECT_CLAIM,
    WEB_OIDC_SUBJECT_EMAIL_DOMAIN,
    document_not_found,
    two principals,
    whoami,
    /web/whoami,
    delegating,
  ]
appliesTo: ">=0.10.0"
---

# Browser sign-in for document pages

- Self-hosted auth (`AUTH_PROVIDER=self-hosted`): the page reuses the Wardby login you already have. Nothing to configure.
- Delegating auth (`AUTH_PROVIDER=delegating`): create a second client at your identity provider for the browser (authorization code with PKCE) and set:

| Variable                        | Meaning                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `WEB_OIDC_CLIENT_ID`            | The web client's ID. Unset turns member sign-in off (share links still work).   |
| `WEB_OIDC_CLIENT_SECRET`        | Only for a confidential client; leave unset for a public client.                |
| `WEB_OIDC_SCOPES`               | Space-separated; default `openid profile email`.                                |
| `WEB_OIDC_SUBJECT_CLAIM`        | The ID token claim the person is read from; default `sub`.                      |
| `WEB_OIDC_SUBJECT_EMAIL_DOMAIN` | Read it from the local part of a verified email at exactly this domain instead. |

Register the redirect URI `https://<your-host>/web/callback` (the origin of `MCP_CANONICAL_URI`). The client's ID tokens must carry the same `sub` as the access tokens MCP clients get, so both map to one person. The issuer is `AUTH_ISSUER`.

## Browser and MCP sign-in land on different people

If `/d/<id>` answers `document_not_found` for your own documents, or a reviewer gets no Approve button, the browser sign-in made a second Wardby person. Some providers (Okta, for one) always put their own user id in the ID token's `sub`, while the access token's `sub` can be a username. Fix it with one of:

- `WEB_OIDC_SUBJECT_CLAIM`: add a claim to the web client's ID token carrying the access token's `sub` value, and name it here.
- `WEB_OIDC_SUBJECT_EMAIL_DOMAIN`: when the access token's `sub` is the local part of the user's email, set the email domain. Only a verified email (`email_verified: true`) at exactly that domain is used.

Set one, not both. A sign-in without a usable value fails with `web_login_failed`; it never falls back to `sub`. The MCP sign-in is unchanged. A second person an earlier browser sign-in made stays in the users list, owning nothing.

## Check who the browser signed you in as

Open `https://<your-host>/web/whoami` in the signed-in browser. It returns your Wardby person (`principal.id`, `principal.subject`, the name you are shown as, the email from your profile), where the subject came from (`signIn.subjectFrom`: `{ "claim": "sub" }` by default, the claim `WEB_OIDC_SUBJECT_CLAIM` names, or `{ "emailDomain": … }`), and when the session expires. Compare `principal.subject` with the subject your MCP client resolves to: if they differ, the two sign-ins are different people. A share-link guest sees only their own name and the link's document and permission. It never returns the session cookie, the CSRF value, or an identity-provider token (none is kept after sign-in). Without a session it answers `web_session_required` (401).

A sign-in must finish in 10 minutes in the same browser. Sessions end after 12 hours idle or 7 days. Errors: `web_login_not_configured`, `web_login_failed`, `web_login_state_invalid`, `web_csrf_failed`, `web_origin_rejected`. See [Documents](documents.md).

## Related

- [Documents](documents.md)
