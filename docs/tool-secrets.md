# Secrets and tools

> **Brokered secrets require Wardby 0.6.0 or later.** The readable-secret
> guidance applies to earlier releases.

A native agent's tools can use secrets such as API keys. This guide covers how
secrets reach tools, the difference between readable and brokered secrets, and
how to make a secret brokered so a tool can send it to hosts you choose without
ever reading its value.

## Secrets and tools

1. **Create** the secret with `create_secret`. Omit `value` to enter it through a
   one-time browser link instead of passing it as a plaintext argument. Secrets
   are encrypted at rest and never returned by any MCP tool; `list_secrets`
   returns names, metadata, and any broker config only.
2. **Attach** it to an agent with `attach_secret`. You can attach under an alias
   with `alias`; the alias is the name tools use.
3. **Grant it to a tool** by listing its name in the `allowedSecrets` of the
   tool's attachment (`attach_tool`). A tool can use only the secrets its own
   attachment lists.
4. A tool reads a readable secret with `await secrets.get("NAME")`.

Only the agent's owner can bind secrets and grant them to tools. A binding
resolves only while the secret's owner is the agent's current owner.

## Readable vs brokered

A **readable** secret (the default) hands its value to tool code. Any tool that
is granted it can read the value and send it anywhere the tool is allowed to
fetch. That includes a tool with untrusted code, and a tool that a
prompt-injected agent talks into sending the value somewhere unintended.

A **brokered** secret never reaches tool code. The owner fixes where the value
may be sent (exact hosts, optional path prefixes) and how it is placed in the
request. The tool names the secret in a `fetch` call and the Wardby host adds
the value to the outgoing request itself. Reading a brokered secret with
`secrets.get` fails with [`secret_brokered`](../help/errors/secret-brokered.md).

Brokering guarantees the value is only ever sent to the destinations in the
broker config, and is scrubbed from what the tool receives back. It does not
stop a tool from misusing the access that the sent request itself grants; see
[Limits and choosing destinations](#limits-and-choosing-destinations).

## Making a secret brokered

There are three ways to set a broker config:

- **At creation**: `create_secret { name, broker }`, with or without `value`.
- **In the browser form**: the value-entry link shows a "Brokered
  (recommended)" checkbox with the config fields. The form warns that an
  unbrokered secret can be read and sent anywhere its tools can fetch, and that
  brokered secrets only work with tools that use `fetch(url, { secrets })`.
- **On an existing secret**: `set_secret_broker { name, broker }`.

The config has these fields. Unknown fields are rejected.

| Field          | Required | Meaning                                                                                                                                                           |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosts`        | yes      | 1 to 20 exact hostnames, for example `api.example.com`. No scheme, port, wildcard, or IP address (including short forms such as `127.1` or `0x7f.0.0.1`).         |
| `pathPrefixes` | no       | Up to 20 paths that each start with `/`, with no `?`, `#`, backslash, control character, `%2F`, or `%5C`. When set, the request path must start with one of them. |
| `placement`    | yes      | How the value is added to the request: `header`, `query`, `body`, or `aws-sigv4`. See [Placements](#placements).                                                  |

A config that fails validation is refused with
[`secret_broker_config_invalid`](../help/errors/secret-broker-config-invalid.md).
Setting a config also checks the stored value against it, so a value that
cannot be brokered is refused with
[`secret_broker_value_invalid`](../help/errors/secret-broker-value-invalid.md).
Every change is audited.

Updating a config with `set_secret_broker` returns the config before and after
and, when an attached tool still reads the secret with `secrets.get`, a
`warnings` list. `attach_tool` returns the same kind of warning when you grant a
brokered secret to a tool whose code calls `secrets.get`. The warnings are a
best-effort text scan and never block the call.

**The tool attachment's `allowedHosts` must also include the host.** The tool's
normal fetch policy still applies on top of the broker: a brokered request to a
host the attachment does not list is refused like any other fetch.

## Placements

Each placement is one example config. Replace the host with your service's.

**Header.** `format` must contain `{value}` exactly once and no line breaks.
Header names such as `Host`, `Content-Length`, and `Transfer-Encoding` cannot be
used.

```json
{
  "hosts": ["api.example.com"],
  "pathPrefixes": ["/v1/"],
  "placement": { "kind": "header", "name": "Authorization", "format": "Bearer {value}" }
}
```

**Query parameter.**

```json
{
  "hosts": ["api.example.com"],
  "placement": { "kind": "query", "name": "api_key" }
}
```

**Body field.** The tool's request must have a body that is a JSON object with a
JSON `content-type` (`application/json` or `+json`), or a form body with
`application/x-www-form-urlencoded`. The host adds the field to it.

```json
{
  "hosts": ["api.example.com"],
  "placement": { "kind": "body", "field": "token" }
}
```

**AWS SigV4.** The host signs the request with AWS's signer, so the tool gets an
authorized call without ever holding the keys. The secret's value must be JSON:

```json
{ "accessKeyId": "AKIA...", "secretAccessKey": "...", "sessionToken": "..." }
```

`sessionToken` is optional. The config names the region and service:

```json
{
  "hosts": ["my-bucket.s3.us-east-1.amazonaws.com"],
  "placement": { "kind": "aws-sigv4", "region": "us-east-1", "service": "s3" }
}
```

For `s3` the signer adds a payload checksum and does not double-encode the path;
other services use standard SigV4 path encoding. A request must not already set
`authorization`, `x-amz-date`, `x-amz-security-token`, or
`x-amz-content-sha256`. Give the secret an IAM identity with only the
permissions the tool needs, because the tool can make any call that identity is
allowed to.

## Using a brokered secret in a tool

Name the secret in the `secrets` option of `fetch`. The name is the one the tool
attachment grants in `allowedSecrets`.

```js
const response = await fetch("https://api.example.com/v1/items", {
  method: "GET",
  secrets: ["EXAMPLE_API_KEY"],
});
return await response.json();
```

A request can name up to 8 brokered secrets. Naming a secret that is readable,
or that the tool is not granted, fails with
[`secret_not_brokered`](../help/errors/secret-not-brokered.md).
`secrets.get("EXAMPLE_API_KEY")` on a brokered secret throws
[`secret_brokered`](../help/errors/secret-brokered.md), so update tools that read
the value to use `fetch` instead.

## What the host enforces

- **https only**, to the default port. Any other scheme or port is refused with
  [`secret_broker_destination_denied`](../help/errors/secret-broker-destination-denied.md).
- **Exact hosts and path prefixes.** Every secret in the request must allow the
  request's host and, when it sets `pathPrefixes`, its path. A secret with
  `pathPrefixes` is also refused for a path containing an encoded slash or
  backslash (`%2F`, `%5C`), which a server could decode into a separator.
- **No redirects.** A 3xx response is returned to the tool as is. Following it
  is a new request that is checked against the broker config again.
- **No overrides.** If the tool already sets the header, query parameter, or body
  field that a broker places, or two secrets place the same spot, or a request
  names more than one SigV4 secret, the call fails with
  [`secret_broker_conflict`](../help/errors/secret-broker-conflict.md).
  Body placement on an unsuitable body fails with
  [`secret_broker_body_invalid`](../help/errors/secret-broker-body-invalid.md).
- **Response scrubbing.** The value is replaced with `[REDACTED]` in the response
  body, headers, status text, and final URL, including its base64, URL-safe
  base64, and percent-encoded forms.
  For SigV4 the secret access key and session token are scrubbed.
- **Console redaction.** The value is redacted from the tool's console output.
- **Minimum length.** A brokered value must be at least 6 characters, so that
  scrubbing cannot redact ordinary short text. For SigV4, the secret access key
  and session token must each be at least 6 characters.

## Changing and removing brokering

Changing a broker config takes effect immediately and is not confirmed in a
browser. `set_secret_broker` with a new config, or `create_secret` with a
`broker`, replaces the hosts, path prefixes, and placement at once. Anyone who
can act as the secret's owner over MCP can therefore send the value to another
host, as long as they can also grant that host to a tool through `attach_tool`
`allowedHosts`. The operator's fetch policy still applies to every brokered
request. Only removing brokering needs a person's confirmation.

Removing brokering makes the value readable by tools again, so it is never done
by an MCP call alone. `set_secret_broker { name, broker: null }` returns a
browser link. A person opens it, sees the current config, and types the
secret's name to confirm. Call `set_secret_broker` with `broker: null` again to
see the outcome.

The link is tied to the config it was created for. If the config changed after
the link was created, submitting it fails with
[`secret_broker_changed`](../help/errors/secret-broker-changed.md); request a
new link.

The browser confirmation raises the cost of removal but has a limit: an agent
that has its own browser or HTTP tools running on the owner's machine could
open and submit the link itself. Do not give an untrusted agent such tools on
the machine of the person who owns the secret.

Every broker change, whether through MCP or the browser, is recorded in the
`SecretBrokerChange` table with the actor, the config before and after, and
whether it came from `mcp` or `browser`.

## Limits and choosing destinations

Brokering controls where the value goes, not what the destination does with a
request. Choose destinations with that in mind:

- Changing the config is not browser-confirmed (see
  [Changing and removing brokering](#changing-and-removing-brokering)), so
  brokering protects against tool code, not against someone who holds the
  owner's MCP access.
- An endpoint on an allowed host that stores or publishes what you send (a
  paste service, a public bucket, a webhook relay, a log collector that
  indexes request headers) can still expose the placed value. Allow only hosts
  that do not echo or publish credentials, and narrow them with
  `pathPrefixes`.
- Responses are scrubbed only for the encodings listed above. A destination
  that returns a transformed copy of the value (hashed, split, or re-encoded)
  is not covered.
- A signing or token-minting endpoint, and SigV4 itself, give the tool
  authorized calls rather than the key. The tool can still make every call the
  credential permits, so scope the credential to the least access needed.
- Brokering does not change who can attach tools or grant secrets. Keep
  `allowedSecrets` and `allowedHosts` narrow on each attachment.

## Errors

| Code                                                                                     | Meaning                                                                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`secret_brokered`](../help/errors/secret-brokered.md)                                   | A tool read a brokered secret with `secrets.get`.                       |
| [`secret_not_brokered`](../help/errors/secret-not-brokered.md)                           | `fetch` named a secret that is not brokered or not granted to the tool. |
| [`secret_broker_destination_denied`](../help/errors/secret-broker-destination-denied.md) | The URL is not https, or its host, port, or path is outside the config. |
| [`secret_broker_conflict`](../help/errors/secret-broker-conflict.md)                     | The request sets what a broker places, or brokers collide.              |
| [`secret_broker_body_invalid`](../help/errors/secret-broker-body-invalid.md)             | Body placement needs a JSON-object or form-encoded body.                |
| [`secret_broker_value_invalid`](../help/errors/secret-broker-value-invalid.md)           | The value is too short, or is not the JSON a SigV4 secret needs.        |
| [`secret_broker_changed`](../help/errors/secret-broker-changed.md)                       | A removal link was created before the broker config last changed.       |
| [`secret_broker_config_invalid`](../help/errors/secret-broker-config-invalid.md)         | The broker config failed validation.                                    |

See also the short help article
[Brokered secrets](../help/brokered-secrets.md).
