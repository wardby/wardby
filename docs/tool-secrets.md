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

## OAuth secrets

Some services, such as a hosted MCP server, only offer OAuth sign-in and give
you no API key to paste. An **OAuth secret** connects one of them once, as a
shared service identity: you sign in as a dedicated service user, and Wardby
keeps the resulting access token (and refresh token) as a brokered secret.
Agents then use the service as that user, so create or pick a service account
whose permissions are what you want every agent using the secret to have.

### Connect

1. Call `create_secret { name, oauth: { resource, scope?, clientId? } }`.
   `resource` is the service's URL, for example `https://mcp.example.com/mcp`
   (https only). Do not also pass `value` or `broker`; Wardby sets the broker
   itself: the access token as `Authorization: Bearer {value}` to the
   resource's host only.
2. The call returns `status: "pending"` and a `url`. Open it in your browser
   and sign in as the service user.
3. The page shows a confirmation code. Call
   `create_secret { name, confirmationCode }` with the same name. The result is
   `{ name, kind: "oauth", status: "connected", expiresAt }`. The code is checked against the
   same owner who started the sign-in, and has a limited number of attempts;
   when they run out or the request expired, start again from step 1.

Connecting needs Wardby's HTTP transport, because the provider sends the
browser back to `https://<your-wardby-host>/oauth/callback` (the host of
`MCP_CANONICAL_URI`). Over stdio the call is refused.

Provider requirements:

- The service publishes OAuth metadata (protected-resource and
  authorization-server metadata, with PKCE `S256`). Otherwise the call fails
  with [`secret_oauth_discovery_failed`](../help/errors/secret-oauth-discovery-failed.md).
- Wardby registers itself with the provider (dynamic client registration). If
  the provider does not offer that, register a client yourself with the redirect
  URI `https://<your-wardby-host>/oauth/callback` and pass its id as
  `oauth.clientId`; without it the call fails with
  [`secret_oauth_client_id_required`](../help/errors/secret-oauth-client-id-required.md).
- `oauth.scope` asks for specific scopes. Omit it to use what the provider
  grants by default; pick the narrowest scope that does the job, since the
  signed-in user's access is what every agent gets.
- Wardby's requests to the provider send `User-Agent: wardby/<version>`.

### Refresh, reconnect, disconnect

- **Refresh is automatic.** Wardby refreshes the access token when the secret is
  used within 60 seconds of its expiry or after it has expired (there is no background
  refresher), and once more, with a single retry of the request, when a
  brokered request to the service gets a 401. Refresh tokens that rotate are
  stored as they change.
- **When it cannot refresh.** If the provider refuses the grant or the client
  (`invalid_grant`, `invalid_client`), the token is past its expiry with no
  refresh token (`expired`), or the service refuses the token with a 401 before
  its expiry and there is no refresh token (`rejected`), the secret becomes `reauth_required` and uses of
  it fail with [`secret_reauth_required`](../help/errors/secret-reauth-required.md).
  A provider that is only unreachable or answers badly leaves the secret as it
  was; see [`secret_oauth_refresh_unavailable`](../help/errors/secret-oauth-refresh-unavailable.md)
  and [`secret_oauth_refresh_failed`](../help/errors/secret-oauth-refresh-failed.md).
  If the provider issued new tokens but Wardby could not store them, the log
  records the reason `rotated_unsaved`: a provider that rotates refresh tokens
  may then refuse the stored one, and the secret will need connecting again.
- **Reconnect** by running the connect steps again under the **same name**. The
  secret is updated in place, so attachments and MCP servers that use it keep
  working.
- **Disconnect** with `delete_secret`. Wardby first revokes the tokens at the
  provider when it has a revocation endpoint (best effort: a failure does not
  stop the delete), and the disconnect is audited. A secret still used by an MCP
  server or host provider is not deleted until you update or delete them.
- `list_secrets` shows `kind: "oauth"` and an `oauth` object with the
  `resource`, `status` (`connected` or `reauth_required`), `expiresAt`,
  `connectedAt` and, when reconnecting is needed, `reauthReason`. It never
  shows token values.

### Rules

- Token values are never readable: `secrets.get` fails as for any brokered
  secret, and they are scrubbed from responses and console output.
- The value and broker of an OAuth secret cannot be set by hand. `set_secret_broker` and
  similar changes are refused with
  [`secret_oauth_managed`](../help/errors/secret-oauth-managed.md); connect
  again instead.
- A name already used by an ordinary secret is refused with
  [`secret_oauth_name_taken`](../help/errors/secret-oauth-name-taken.md).
- Everyone an MCP server (or agent) is shared with uses the same service
  identity, with the owner's credentials: share it as carefully as the access
  of the signed-in user. If the owner's OAuth secret needs reconnecting (or its
  credentials otherwise can't be used), a user the server is shared with sees only
  "The MCP server's credentials can't be used; ask its owner to check it." They
  never see the owner's secret name or `secret_reauth_required`; only the owner
  sees the specific error and can reconnect. When the refresh only failed for
  now (the provider could not be reached, or another request held the secret
  too long), they see "The MCP server's credentials could not be refreshed just
  now; try again shortly." instead.

To use an OAuth secret with a remote MCP server, see
[OAuth-only servers](mcp-servers.md#oauth-only-servers).

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

A host provider's credentials must be brokered secrets, placed in a header or
query parameter. See [host-providers.md](host-providers.md).

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

## Secret values are never stored

Wardby refuses to store a secret's value anywhere it could be read back. A
datastore or agent memory write (from a tool in either run mode, from the MCP
`datastore_set` or `set_agent_memory` tools, or from a bundle import) is refused
with [`secret_in_value`](../help/errors/secret-in-value.md) when the value or the key
contains the value of a secret attached to the agent. The error names the
secret, and nothing is stored. Store the secret's name and read the secret when
it is needed, with `secrets.get` or `fetch(url, { secrets })`.

- Matching is by exact value, including JSON-escaped forms and, for brokered
  secrets, the encoded forms the broker scrubs. Values shorter than 6
  characters are not matched.
- If the agent's secrets cannot be read to check a value, the write is refused
  with [`secret_check_unavailable`](../help/errors/secret-in-value.md) and nothing
  is stored.
- A bundle import skips a seeded datastore entry (per-agent or shared) whose key
  or value contains an attached secret's value and reports a warning that names
  the secret; the entry's key is withheld from the warning.
- A native run's final text and error, and comments, reviews, and Jira posts
  made through built-in tools, have attached secret values replaced with
  `[REDACTED]`. So does the task text of a `delegate_to_*` call, using the
  delegating agent's secrets, before the sub-agent's run is created, in both run
  modes. If the secrets cannot be read when a run ends, its stored final text
  and error are `[withheld: this text could not be checked for secret values]`.
  A posting tool or `delegate_to_*` call that cannot read the secrets returns
  `secret_check_unavailable` and posts nothing or creates no sub-agent run.
- Values that are split, re-encoded, or otherwise transformed are not detected,
  and values stored before this check existed are not scanned.

## Errors

| Code                                                                                       | Meaning                                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`secret_brokered`](../help/errors/secret-brokered.md)                                     | A tool read a brokered secret with `secrets.get`.                          |
| [`secret_not_brokered`](../help/errors/secret-not-brokered.md)                             | `fetch` named a secret that is not brokered or not granted to the tool.    |
| [`secret_broker_destination_denied`](../help/errors/secret-broker-destination-denied.md)   | The URL is not https, or its host, port, or path is outside the config.    |
| [`secret_broker_conflict`](../help/errors/secret-broker-conflict.md)                       | The request sets what a broker places, or brokers collide.                 |
| [`secret_broker_body_invalid`](../help/errors/secret-broker-body-invalid.md)               | Body placement needs a JSON-object or form-encoded body.                   |
| [`secret_broker_value_invalid`](../help/errors/secret-broker-value-invalid.md)             | The value is too short, or is not the JSON a SigV4 secret needs.           |
| [`secret_broker_changed`](../help/errors/secret-broker-changed.md)                         | A removal link was created before the broker config last changed.          |
| [`secret_broker_config_invalid`](../help/errors/secret-broker-config-invalid.md)           | The broker config failed validation.                                       |
| [`secret_reauth_required`](../help/errors/secret-reauth-required.md)                       | An OAuth secret must be connected again.                                   |
| [`secret_oauth_discovery_failed`](../help/errors/secret-oauth-discovery-failed.md)         | The service has no usable OAuth metadata.                                  |
| [`secret_oauth_managed`](../help/errors/secret-oauth-managed.md)                           | An OAuth secret's value or broker cannot be changed by hand.               |
| [`secret_oauth_name_taken`](../help/errors/secret-oauth-name-taken.md)                     | The name belongs to a secret that is not an OAuth secret.                  |
| [`secret_oauth_client_id_required`](../help/errors/secret-oauth-client-id-required.md)     | The provider needs a `clientId` you registered.                            |
| [`secret_oauth_encryption_failed`](../help/errors/secret-oauth-encryption-failed.md)       | The OAuth secret could not be encrypted or decrypted.                      |
| [`secret_oauth_provider_unavailable`](../help/errors/secret-oauth-provider-unavailable.md) | The provider could not be reached while connecting.                        |
| [`secret_oauth_refresh_unavailable`](../help/errors/secret-oauth-refresh-unavailable.md)   | The provider could not be reached to refresh the token.                    |
| [`secret_oauth_refresh_failed`](../help/errors/secret-oauth-refresh-failed.md)             | The provider did not refresh the token.                                    |
| [`secret_in_value`](../help/errors/secret-in-value.md)                                     | A datastore or memory write contains an attached secret's value.           |
| [`secret_check_unavailable`](../help/errors/secret-in-value.md)                            | The write or posting could not be checked because secrets were unreadable. |

See also the short help article
[Brokered secrets](../help/brokered-secrets.md).
