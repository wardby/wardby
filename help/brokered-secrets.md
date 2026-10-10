---
id: brokered-secrets
title: Brokered secrets and the secret broker
summary: Let tools use a secret only by sending it to hosts you choose, without ever reading its value.
audience: operator
tags: [secrets, brokered, secret broker, security, tools, fetch, sigv4, set_secret_broker]
appliesTo: ">=0.6.0"
---

# Brokered secrets and the secret broker

A readable secret hands its value to any tool that is granted it, so a tool with
untrusted code, or a prompt-injected agent, can send the value anywhere the tool
may fetch. A **brokered** secret never reaches tool code: you fix the hosts it
may be sent to and how it is placed, and the Wardby host adds it to the request.

## When to use it

Broker any secret that a tool only needs to send to an API, such as a bearer
token, an API key, or AWS credentials. Keep a secret readable only when the tool
must compute with the value itself.

## Set it up

1. Create the secret with a broker config, in one call or in the browser form's
   "Brokered" checkbox: `create_secret { name, broker }`. For an existing secret
   use `set_secret_broker { name, broker }`.
2. Attach it to the agent (`attach_secret`) and list its name in the tool
   attachment's `allowedSecrets` (`attach_tool`).
3. Include the host in the attachment's `allowedHosts` too. The normal fetch
   policy still applies on top of the broker.

The config is `{ hosts, pathPrefixes?, placement }`. Hosts are exact hostnames
such as `api.example.com`, and the request must use https on the default port.

## The four placements

- **header**: `{ "kind": "header", "name": "Authorization", "format": "Bearer {value}" }`
- **query**: `{ "kind": "query", "name": "api_key" }`
- **body**: `{ "kind": "body", "field": "token" }`, for a JSON-object or form body
- **aws-sigv4**: `{ "kind": "aws-sigv4", "region": "us-east-1", "service": "s3" }`,
  where the value is JSON `{ "accessKeyId", "secretAccessKey", "sessionToken?" }`

## Use it in a tool

```js
const response = await fetch("https://api.example.com/v1/items", {
  secrets: ["EXAMPLE_API_KEY"],
});
```

`secrets.get("EXAMPLE_API_KEY")` on a brokered secret throws
[`secret_brokered`](errors/secret-brokered.md). Redirects are not followed, and
the value is scrubbed from responses and console output.

## Change or remove brokering

Changing the config (hosts, path prefixes, or placement) with
`set_secret_broker` or `create_secret` takes effect immediately and is not
confirmed in a browser. Anyone who can act as the owner over MCP can send the
value to another host they also grant through `attach_tool` `allowedHosts`; the
operator's fetch policy still applies.

Only removal is confirmed: `set_secret_broker { name, broker: null }` returns a
browser link, and a person confirms by typing the secret's name. The MCP call
alone never removes it. Every change is audited.

## Related

- Full guide: [`docs/tool-secrets.md`](../docs/tool-secrets.md)
- [Use native agents, tools, and data](native-capabilities.md)
- Errors: [`secret_brokered`](errors/secret-brokered.md),
  [`secret_not_brokered`](errors/secret-not-brokered.md),
  [`secret_broker_destination_denied`](errors/secret-broker-destination-denied.md),
  [`secret_broker_conflict`](errors/secret-broker-conflict.md),
  [`secret_broker_body_invalid`](errors/secret-broker-body-invalid.md),
  [`secret_broker_value_invalid`](errors/secret-broker-value-invalid.md),
  [`secret_broker_changed`](errors/secret-broker-changed.md),
  [`secret_broker_config_invalid`](errors/secret-broker-config-invalid.md)
