---
id: brokered-secrets
title: Brokered and OAuth secrets and the secret broker
summary: Let tools use a secret only by sending it to hosts you choose, without ever reading its value, including OAuth secrets for OAuth-only services.
audience: operator
tags: [secrets, brokered, secret broker, security, tools, fetch, sigv4, set_secret_broker, oauth, browserstack, connect, reauth, create_secret oauth]
appliesTo: >=0.6.0
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

## OAuth secrets

For a service that only offers OAuth sign-in, such as a hosted MCP server, connect it once
instead of pasting a token:

1. `create_secret { name, oauth: { resource, scope?, clientId? } }` returns a sign-in `url`.
   Over HTTP only; `resource` must be https.
2. Open it, sign in as a service user, and copy the confirmation code.
3. Call `create_secret { name, confirmationCode }` with the same name. The secret is now
   brokered to the resource's host as `Authorization: Bearer`.

Wardby refreshes the token before it expires and retries once on a 401. Add `clientId` only
when the provider has no dynamic client registration; register it with the redirect URI
`https://<your-wardby-host>/oauth/callback`. To reconnect, repeat the steps under the same
name. `delete_secret` disconnects (and revokes at the provider where supported). `list_secrets`
shows `status` (`connected` or `reauth_required`), never a token. Everything signed in as
that user is shared by all agents using the secret. Use it with a server as in
[Remote MCP servers](mcp-servers.md#oauth-only-servers).

## Related

- [Host providers](../docs/host-providers.md): a provider's credentials must be brokered
  secrets
- [Remote MCP servers](../docs/mcp-servers.md) (0.8.0+): a server's credentials are brokered secrets
- Full guide: [`docs/tool-secrets.md`](../docs/tool-secrets.md)
- [Use native agents, tools, and data](native-capabilities.md)
- Errors: [`secret_brokered`](errors/secret-brokered.md),
  [`secret_not_brokered`](errors/secret-not-brokered.md),
  [`secret_broker_destination_denied`](errors/secret-broker-destination-denied.md),
  [`secret_broker_conflict`](errors/secret-broker-conflict.md),
  [`secret_broker_body_invalid`](errors/secret-broker-body-invalid.md),
  [`secret_broker_value_invalid`](errors/secret-broker-value-invalid.md),
  [`secret_broker_changed`](errors/secret-broker-changed.md),
  [`secret_broker_config_invalid`](errors/secret-broker-config-invalid.md),
  [`secret_reauth_required`](errors/secret-reauth-required.md),
  [`secret_oauth_discovery_failed`](errors/secret-oauth-discovery-failed.md),
  [`secret_oauth_managed`](errors/secret-oauth-managed.md),
  [`secret_oauth_name_taken`](errors/secret-oauth-name-taken.md),
  [`secret_oauth_client_id_required`](errors/secret-oauth-client-id-required.md),
  [`secret_oauth_encryption_failed`](errors/secret-oauth-encryption-failed.md),
  [`secret_oauth_refresh_unavailable`](errors/secret-oauth-refresh-unavailable.md),
  [`secret_oauth_refresh_failed`](errors/secret-oauth-refresh-failed.md)
