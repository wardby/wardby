---
id: errors/secret-oauth-managed
title: An OAuth secret cannot be changed by hand
summary: The secret is managed by its OAuth connection; its value and broker cannot be set directly.
audience: operator
tags: [error, secrets, oauth, secret_oauth_managed]
appliesTo: ">=0.9.11"
---

# An OAuth secret cannot be changed by hand

## What happened

The message is `secret_oauth_managed: this secret is managed by its OAuth connection; connect again with create_secret and oauth`. You tried to change the value or the broker config of an OAuth secret (for example with `set_secret_broker`). Wardby sets both itself: the access token goes only to the resource's host as a Bearer header.

## What to do

1. To change which account or scope the secret uses, connect again with `create_secret { name, oauth: { resource } }` under the same name.
2. To stop using it, `delete_secret`.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
