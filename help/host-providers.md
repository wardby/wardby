---
id: host-providers
title: Add a code host with your own tools (host providers)
summary: Register a code host implemented by custom tools, approve changes to them, and test them with read-only calls. Agents can't use a provider yet.
audience: operator
tags: [host provider, register_host_provider, approve_host_provider_tools, hosts:admin, host-manager]
appliesTo: >=0.8.0
---

# Host providers

A host provider adds a code host using your own custom tools. This release lets you register
a provider, approve its tools and test them. Agents can't use a registered provider yet.

You need the `hosts:admin` scope and a role that grants it (`admin` or `host-manager`). See
[Identity and access](identity-and-access.md).

1. Write one tool per operation with `create_tool`.
2. Broker each credential with `set_secret_broker`, allowing the API hosts and the git host. The
   permission credential needs only the API hosts ([Brokered secrets](brokered-secrets.md)).
3. Call `register_host_provider`. No restart is needed today, because agents can't use a provider
   yet; a new provider will need one once they can. A refusal has a
   [`host_provider_*` code](errors/host-provider-error.md).
4. Call `test_host_provider` to check each read-only tool. Failures have
   [fixed codes](errors/host-tool-failed.md).

`update_tool` changes nothing until you call `approve_host_provider_tools`. See which tools have
changes with `get_host_provider`.

A bound tool reaches only the provider's API hosts, inside one repository's path, and Wardby
follows no redirects; the tool must fetch the `Location` itself. Any host manager can read and re-register any
provider.

Replacing a secret a provider uses, or changing its broker config, needs `hosts:admin` as well as
`secrets:write`. A webhook secret stays at 16 characters or more.

Keep provider credentials unattached: an agent's own tools can use an attached one without the
provider's path guard.

See [docs/host-providers.md](../docs/host-providers.md) for the full guide.
