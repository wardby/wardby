---
id: errors/secret-broker-destination-denied
title: Secret broker destination denied
summary: A fetch with a brokered secret targeted a URL that is not https, uses a non-default port, or is outside the allowed hosts or path prefixes.
audience: operator
tags: [error, secrets, secret_broker_destination_denied]
appliesTo: ">=0.6.0"
---

# Secret broker destination denied

`secret_broker_destination_denied` means a brokered secret may not be sent to
the requested URL. The message says which check failed:

- the URL is not `https`, or names a port other than the default;
- the host is not in the secret's `hosts` (exact match, no wildcards);
- the path does not start with any of the secret's `pathPrefixes`, or, for a
  secret with `pathPrefixes`, contains an encoded slash or backslash (`%2F`,
  `%5C`).

1. Correct the URL in the tool.
2. If the destination is intended, the secret's owner updates the config with
   `set_secret_broker`, adding the host or path prefix.
3. Make sure the tool attachment's `allowedHosts` also lists the host; a host
   missing there is refused by the normal fetch policy.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
