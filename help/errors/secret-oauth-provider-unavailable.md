---
id: errors/secret-oauth-provider-unavailable
title: The OAuth provider could not be reached
summary: Connecting an OAuth secret failed because the provider was unreachable or busy; nothing changed, so try again.
audience: operator
tags: [error, secrets, oauth, secret_oauth_provider_unavailable]
appliesTo: ">=0.9.11"
---

# The OAuth provider could not be reached

## What happened

The message is `secret_oauth_provider_unavailable: the OAuth provider could not be reached; try again`. While connecting an OAuth secret (looking up the service's metadata, registering a client, or finishing the sign-in), the provider timed out, returned a server error, or rate limited the request. Nothing was saved.

## What to do

1. Run `create_secret` with `oauth` again.
2. If it persists, check the provider's status and Wardby's outbound network access to it.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
