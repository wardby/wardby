---
id: errors/secret-broker-changed
title: Brokering changed since the link was created
summary: A browser link to remove brokering was created before the secret's broker config changed, so it no longer applies.
audience: operator
tags: [error, secrets, secret_broker_changed]
appliesTo: ">=0.6.0"
---

# Brokering changed since the link was created

`secret_broker_changed` means the browser link for removing brokering was minted
for a broker config that has since changed or been removed. A link only ever
removes the exact config it was created for.

1. Call `set_secret_broker` with `broker: null` again to get a new link.
2. Check the config shown on the new page before confirming removal.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
