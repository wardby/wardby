---
id: errors/secret-brokered
title: Secret is brokered and cannot be read
summary: A tool called secrets.get on a brokered secret; brokered secrets are only sent with fetch(url, { secrets }).
audience: operator
tags: [error, secrets, secret_brokered]
appliesTo: ">=0.6.0"
---

# Secret is brokered and cannot be read

`secret_brokered` means a tool called `secrets.get(name)` on a secret that is
brokered. A brokered secret never exposes its value to tool code.

1. Update the tool to send the secret with
   `fetch(url, { secrets: ["NAME"] })`; the host places the value in the request.
2. Or, if the tool really must read the value, have the secret owner remove
   brokering with `set_secret_broker` and `broker: null`, confirmed in the
   browser. This makes the value readable by every tool granted it.
3. `attach_tool` and `set_secret_broker` warn when a granted tool calls
   `secrets.get`; that scan is best-effort.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
