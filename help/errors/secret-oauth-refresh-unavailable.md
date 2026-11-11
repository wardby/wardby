---
id: errors/secret-oauth-refresh-unavailable
title: The OAuth provider could not be reached to refresh the token
summary: A refresh failed because the provider was unreachable or busy; nothing changed, so try again.
audience: operator
tags: [error, secrets, oauth, secret_oauth_refresh_unavailable]
appliesTo: ">=0.9.11"
---

# The OAuth provider could not be reached to refresh the token

## What happened

The message is `secret_oauth_refresh_unavailable: the OAuth provider could not be reached to refresh the token; try again`. The provider timed out, returned a server error, or rate limited the refresh. The stored token is unchanged.

## What to do

1. Try the call again.
2. If it persists, check the provider's status and Wardby's outbound network access to it.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
