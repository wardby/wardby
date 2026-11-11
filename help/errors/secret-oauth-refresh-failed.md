---
id: errors/secret-oauth-refresh-failed
title: The OAuth provider did not refresh the token
summary: A refresh got an answer Wardby could not use; nothing changed. Try again, or connect again.
audience: operator
tags: [error, secrets, oauth, secret_oauth_refresh_failed]
appliesTo: ">=0.9.10"
---

# The OAuth provider did not refresh the token

## What happened

The message is `secret_oauth_refresh_failed: the OAuth provider did not refresh the token; try again, or connect again with create_secret and oauth`. The provider answered the refresh with something unusable. The stored token is unchanged.

## What to do

1. Try the call again.
2. If it repeats, connect the secret again with `create_secret` and `oauth` under the same name (see [`secret_reauth_required`](secret-reauth-required.md)).

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
