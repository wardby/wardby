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

The message is `secret_oauth_refresh_unavailable: the OAuth provider could not be reached to refresh the token; try again`. The provider timed out, returned a server error, or rate limited the refresh; or the refresh could not take its turn because another request held the secret for too long, or the store failed. A call that was stopped while the token was being refreshed gets this error too, at once; when no other call was waiting for that refresh it is cancelled, and the server log records the reason `aborted`. The stored token is unchanged.

If the provider did issue new tokens but Wardby could not store them, the server log records the reason `rotated_unsaved`. A provider that rotates refresh tokens may then refuse the stored one, and the secret becomes `reauth_required` on its next refresh; connect it again if so.

A user an MCP server is shared with does not see this message: their call fails with "The MCP server's credentials could not be refreshed just now; try again shortly."

## What to do

1. Try the call again.
2. If it persists, check the provider's status and Wardby's outbound network access to it.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
