---
id: errors/secret-broker-body-invalid
title: Secret broker body invalid
summary: Body placement needs a JSON-object or form-encoded request body with a matching content-type.
audience: operator
tags: [error, secrets, secret_broker_body_invalid]
appliesTo: ">=0.6.0"
---

# Secret broker body invalid

`secret_broker_body_invalid` means a secret placed in the request body could not
be added to the body the tool sent. Body placement needs one of:

- a JSON object body with `content-type: application/json` (or a `+json` type);
- a form body with `content-type: application/x-www-form-urlencoded`.

The request must have a body, valid JSON that is an object (not an array or a
scalar), and a matching `content-type` header.

1. Send a body of a supported type and set the `content-type` header to match.
2. If the API expects the credential elsewhere, change the placement with
   `set_secret_broker` to `header` or `query`.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
