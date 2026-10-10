---
id: errors/secret-broker-config-invalid
title: Secret broker config invalid
summary: A broker config failed validation: hosts, path prefixes, or placement are malformed.
audience: operator
tags: [error, secrets, secret_broker_config_invalid]
appliesTo: ">=0.6.0"
---

# Secret broker config invalid

`secret_broker_config_invalid` means the broker config passed to `create_secret`,
`set_secret_broker`, or the browser form did not validate. The message lists
each problem. Common causes:

- `hosts` is empty, has more than 20 entries, or contains a scheme, port,
  wildcard, or IP address; use exact hostnames such as `api.example.com`;
- a `pathPrefixes` entry does not start with `/`;
- a header `format` does not contain `{value}` exactly once or contains a line
  break, or the header name is not allowed (`Host`, `Content-Length` and similar);
- an AWS `region` or `service` is malformed;
- the config has fields it does not define.

1. Fix the fields named in the message and retry.
2. The config shape is `{ hosts, pathPrefixes?, placement }`.

See [Brokered secrets](../brokered-secrets.md) and the
[secrets guide](../../docs/tool-secrets.md).
