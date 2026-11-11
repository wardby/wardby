---
id: errors/secret-oauth-encryption-failed
title: The OAuth secret could not be encrypted or decrypted
summary: Wardby could not encrypt or decrypt an OAuth secret's tokens; try again, and check the secret key.
audience: operator
tags: [error, secrets, oauth, secret_oauth_encryption_failed]
appliesTo: ">=0.9.10"
---

# The OAuth secret could not be encrypted or decrypted

## What happened

The message is `secret_oauth_encryption_failed: the OAuth secret could not be encrypted or decrypted; try again`. The secret cipher (the configured key or KMS) failed. The cipher's own error text is never shown.

## What to do

1. Try again.
2. If it repeats, check that every Wardby process has the same `SECRET_APP_KEY` (or that the KMS key is reachable). If the key changed, connect the secret again.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md#oauth-secrets).
