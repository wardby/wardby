---
id: errors/secret-not-brokered
title: Secret is not brokered
summary: A fetch named a secret that is readable, not attached to the agent, or not granted to the tool.
audience: operator
tags: [error, secrets, secret_not_brokered]
appliesTo: ">=0.6.0"
---

# Secret is not brokered

`secret_not_brokered` means `fetch(url, { secrets: [...] })` named a secret that
is not a brokered secret available to this tool: it is readable, it is not
attached to the agent, it is not listed in the attachment's `allowedSecrets`, or
the request named more than 8 secrets.

1. Check the name matches the alias the secret is attached under
   (`attach_secret`) and appears in the tool attachment's `allowedSecrets`.
2. To send the secret through `fetch`, make it brokered with
   `set_secret_broker { name, broker }`.
3. If the secret is meant to stay readable, read it with `secrets.get(name)`
   instead of naming it in `fetch`.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
