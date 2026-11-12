---
id: errors/secret-oauth-registration-failed
title: The OAuth provider refused to register Wardby
summary: Connecting an OAuth secret failed because the provider's dynamic client registration refused Wardby or answered with an unusable reply.
audience: operator
tags: [error, secrets, oauth, secret_oauth_registration_failed, loopback, invalid_redirect_uri]
appliesTo: ">=0.9.12"
---

# The OAuth provider refused to register Wardby

## What happened

The message is `secret_oauth_registration_failed: the OAuth provider refused to register Wardby (<code>, HTTP <status>)`. Wardby registers itself with the provider (RFC 7591 dynamic client registration) before it starts the sign-in, and the provider said no. `<code>` is the provider's error code when it sent a short one (such as `invalid_redirect_uri` or `invalid_client_metadata`); the provider's description text is not shown to the caller and goes only to the operator log of the host.

Two related messages use the same code: the provider's reply was unusable (no `client_id`), or it registered Wardby with a client authentication method Wardby does not support (it supports `none`, `client_secret_post` and `client_secret_basic`).

## What to do

1. For `invalid_redirect_uri` on the default web flow, the provider may accept only loopback callbacks. Connect with `oauth.callback` set to `"loopback"` and finish the sign-in with the Wardby CLI.
2. For `invalid_redirect_uri` on the loopback flow, the provider refused even a `127.0.0.1` callback. Register a client with the provider yourself and pass it as `oauth.clientId`.
3. For other codes or a bare HTTP status, check with the provider that it allows dynamic client registration for your account, or pass `oauth.clientId`.
4. The host's operator log has a `registration_failed` warning with the host, status, error code and the provider's (bounded) description.

See the [secrets guide](../../docs/tool-secrets.md#oauth-secrets).
