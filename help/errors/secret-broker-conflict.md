---
id: errors/secret-broker-conflict
title: Secret broker placement conflict
summary: The request already sets the header, parameter, or field a broker places, two brokers collide, or more than one SigV4 secret was named.
audience: operator
tags: [error, secrets, secret_broker_conflict]
appliesTo: ">=0.6.0"
---

# Secret broker placement conflict

`secret_broker_conflict` means the request would set the same spot twice. A
brokered value is never merged with or overridden by one from the tool. It
occurs when:

- the tool sets the header, query parameter, or body field that a brokered
  secret places (for SigV4: `authorization`, `x-amz-date`,
  `x-amz-security-token`, or `x-amz-content-sha256`);
- two named secrets place the same header, parameter, or field;
- more than one AWS SigV4 secret is named in one request.

1. Remove the conflicting header, parameter, or field from the tool's request.
2. Send secrets that place the same spot in separate requests.
3. Name at most one SigV4 secret per request.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
