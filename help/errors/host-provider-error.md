---
id: errors/host-provider-error
title: Host provider refused (host_provider_*)
summary: Registering a host provider, approving its tools or rotating its secrets was refused with a host_provider_ code. Each code has one cause and one fix.
audience: operator
tags: [host_provider_not_found, host_provider_in_use, host_provider_webhook_secret_short, host provider, error]
appliesTo: >=0.8.0
---

# Host provider refused

Nothing was changed. The message holds a code and secret or tool names, never a value.

## Registering or approving

- `host_provider_not_found`: no provider has that name. Check it, or register it.
- `host_provider_missing_operation`: a required operation has no tool. Bind it in `tools`.
- `host_provider_operation_not_bound`: that isn't a known operation, or this provider doesn't bind it. Check the name.
- `host_provider_tool_not_found`: you own no tool with that name. Create it, or fix the name.
- `host_provider_tool_deleted`: the tool behind this operation was deleted, so there's nothing to approve. Bind a new one by registering again.
- `host_provider_secret_not_found`: you own no secret with that name. Create it, or fix the name.
- `host_provider_secret_not_brokered`: a credential isn't brokered. Broker it with `set_secret_broker`.
- `host_provider_secret_hosts`: its broker config misses a host. Allow every API host, and the git host for a repository credential.
- `host_provider_secret_placement`: it isn't placed in a header or query parameter. Change its placement.
- `host_provider_permission_secret_shared`: the permission secret is also a credential, or is used by another provider. Give it its own secret.
- `host_provider_webhook_secret_shared`: the webhook secret is also a credential or permission secret, or is attached to an agent. Give it its own secret, and detach it.
- `host_provider_webhook_secret_short`: the webhook secret is under 16 characters. Store a longer one.
- `host_provider_username_is_secret`: `gitUsername` equals a credential's value. Use the host's token username.

## Using a provider's secrets

- `host_provider_webhook_secret_attached`: `attach_secret` or `wardby import` tried to attach a webhook secret to an agent. Don't: no tool may read it.
- `host_provider_secret_link_stale`: the browser link was requested before a provider used this secret. Request a new one with `hosts:admin`.
- `host_provider_webhook_secret_short` also refuses a rotation to a value under 16 characters. Enter a longer one; the same link still works.

## Deleting

- `host_provider_in_use`: an agent links to one of its repositories. Remove those links first.

See [Host providers](../host-providers.md).
