---
id: errors/secret-reauth-required
title: An OAuth secret must be connected again
summary: An OAuth secret can no longer be refreshed; connect it again with create_secret and oauth.
audience: operator
tags: [error, secrets, oauth, secret_reauth_required, reauth, connect, create_secret oauth]
appliesTo: ">=0.9.11"
---

# An OAuth secret must be connected again

## What happened

The secret's OAuth connection is no longer usable. Wardby marks it `reauth_required` (visible in `list_secrets`, with a `reauthReason`) when the provider refuses the refresh token (`invalid_grant`) or the client (`invalid_client`), or the access token expired and there is no refresh token (`expired`), or the service refused the access token (HTTP 401) before its expiry and there is no refresh token to get a new one (`rejected`). Typical causes are a revoked grant, a changed password, or a removed client registration. Uses of the secret, including MCP server calls, fail with `secret_reauth_required: secret "<name>" needs connecting again (create_secret with oauth)`.

## What to do

1. Run `create_secret { name, oauth: { resource } }` again under the **same name**, open the link, and sign in as the service user.
2. Call `create_secret { name, confirmationCode }` with the code the page shows.
3. Attachments and MCP servers that use the secret keep working; no other change is needed.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
