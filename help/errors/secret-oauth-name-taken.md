---
id: errors/secret-oauth-name-taken
title: That name belongs to a secret that is not an OAuth secret
summary: Connecting an OAuth secret failed because an ordinary secret already has that name.
audience: operator
tags: [error, secrets, oauth, secret_oauth_name_taken]
appliesTo: ">=0.9.10"
---

# That name belongs to a secret that is not an OAuth secret

## What happened

The message is `secret_oauth_name_taken: a secret with this name already exists and is not an OAuth secret; choose another name`. An OAuth connection can only create a new secret or update an existing OAuth secret.

## What to do

1. Choose another name for the OAuth secret.
2. Or, if the old secret is no longer needed, `delete_secret` it first (detach it from agents and servers that use it).

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
