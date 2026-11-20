---
id: errors/secret-link-superseded
title: Secret entry link superseded
summary: A browser link for entering a secret's value was created before a later value was entered for that name, or before the secret was deleted.
audience: operator
tags: [error, secrets, secret_link_superseded, create_secret, rotate secret, update secret, browser link]
appliesTo: ">=0.10.2"
---

# Secret entry link superseded

`secret_link_superseded` means the browser link you submitted is out of date.
Since it was created, either:

- a value was entered for the same secret name through a newer link, or
- the secret was deleted with `delete_secret`.

The value was not saved. This stops an old form left open in a tab from
overwriting a newer value or bringing back a deleted secret.

1. Call `create_secret` again with the same name to get a new link.
2. Enter the value in the new link, then call `create_secret` once more to finish.

Submitting the link that was actually used a second time is not an error: it
answers with what that submission did and writes nothing.

See [Changing a secret's value](../../docs/tool-secrets.md#changing-a-secrets-value)
and [Brokered secrets](../brokered-secrets.md).
