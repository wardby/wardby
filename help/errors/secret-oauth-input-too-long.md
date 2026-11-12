---
id: errors/secret-oauth-input-too-long
title: An OAuth secret input is too long
summary: The secret name, oauth.scope or oauth.clientId is over its length limit.
audience: operator
tags: [error, secrets, oauth, secret_oauth_input_too_long]
appliesTo: ">=0.9.12"
---

# An OAuth secret input is too long

## What happened

The message is `secret_oauth_input_too_long: the secret name, oauth.scope or oauth.clientId is too long`.
`create_secret` with `oauth` refused an input over its limit, before any sign-in started.

## What to do

Shorten the input and call `create_secret` again. The limits are 1024 bytes for the secret name and
`oauth.scope`, and 512 bytes for `oauth.clientId`.

See the [secrets guide](../../docs/tool-secrets.md#oauth-secrets).
Related: [`secret_oauth_resource_invalid`](secret-oauth-resource-invalid.md).
