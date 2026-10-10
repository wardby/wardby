---
id: errors/secret-broker-value-invalid
title: Secret broker value invalid
summary: A brokered value is shorter than 6 characters, or an AWS SigV4 secret is not the expected JSON.
audience: operator
tags: [error, secrets, secret_broker_value_invalid]
appliesTo: ">=0.6.0"
---

# Secret broker value invalid

`secret_broker_value_invalid` means the stored value cannot be brokered under its
config. It is returned when saving a config and when a tool uses the secret.

- A brokered value must be at least 6 characters.
- An AWS SigV4 secret's value must be JSON
  `{"accessKeyId": "...", "secretAccessKey": "...", "sessionToken": "..."}` with
  no other keys. `sessionToken` is optional; the secret access key and session
  token must each be at least 6 characters.

1. Re-enter the value with `create_secret` using the same name; it rotates the
   value in place. Leave out `broker`: a rotation without one keeps the
   existing broker config. In the browser form, correct the value and submit
   the same link again.
2. For SigV4, store the credentials as that JSON object.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
