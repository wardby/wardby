---
id: errors/secret-oauth-resource-invalid
title: The OAuth resource is not a usable URL
summary: oauth.resource must be an https URL with a host name that wardby can send a token to.
audience: operator
tags: [error, secrets, oauth, secret_oauth_resource_invalid]
appliesTo: ">=0.9.12"
---

# The OAuth resource is not a usable URL

## What happened

The message is `secret_oauth_resource_invalid: the OAuth resource must be an https URL with a host name`.
`create_secret` with `oauth` refused `oauth.resource` before any sign-in started.

## What to do

Pass the service's URL as `https://<host>/<path>` with:

- the `https` scheme (plain `http` is accepted only for a host your operator allow-listed);
- a host name, not an IP address;
- no username or password, no `#fragment`, and the default port.

Then call `create_secret { name, oauth: { resource } }` again.

See the [secrets guide](../../docs/tool-secrets.md#oauth-secrets).
