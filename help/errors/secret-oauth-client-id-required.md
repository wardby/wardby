---
id: errors/secret-oauth-client-id-required
title: The provider needs a registered client id
summary: The provider does not offer dynamic client registration, so connecting needs oauth.clientId.
audience: operator
tags: [error, secrets, oauth, secret_oauth_client_id_required]
appliesTo: ">=0.9.10"
---

# The provider needs a registered client id

## What happened

The message is `secret_oauth_client_id_required: the provider does not offer dynamic client registration; pass oauth.clientId (a client registered with the provider)`.

## What to do

1. Register an OAuth client with the provider, using the redirect URI `https://<your-wardby-host>/oauth/callback` (the host of `MCP_CANONICAL_URI`).
2. Call `create_secret { name, oauth: { resource, clientId } }` with that client id.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
