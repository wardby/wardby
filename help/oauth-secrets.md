---
id: oauth-secrets
title: OAuth secrets for OAuth-only services and MCP servers
summary: Connect a service that only offers OAuth sign-in with create_secret and oauth, then use it from a remote MCP server such as BrowserStack's; Wardby refreshes the token and you reconnect when it cannot.
audience: operator
tags: [oauth, oauth secret, create_secret oauth, reauth, browserstack mcp, oauth mcp server, secret_reauth_required]
appliesTo: ">=0.9.11"
---

# OAuth secrets

Some hosted services, including remote MCP servers, only offer OAuth sign-in and have no token to paste. Connect
the service once as an OAuth secret instead. The token is held by Wardby, brokered to the service's host as
`Authorization: Bearer`, and never readable by an agent, a tool or you.

## Connect

1. `create_secret { name, oauth: { resource, scope?, clientId? } }` returns a sign-in `url`. This works over
   HTTP only (not stdio), and `resource` must be an https URL.
2. Open the link, sign in as a service user, and copy the confirmation code the page shows.
3. Call `create_secret { name, confirmationCode }` with the same name. The secret is now connected.

Add `clientId` only when the provider has no dynamic client registration; register that client with the redirect
URI `https://<your-wardby-host>/oauth/callback`. Without it you get
[`secret_oauth_client_id_required`](errors/secret-oauth-client-id-required.md). The account you sign in with
sets what every agent using the secret can do.

From 0.9.12, a provider that accepts only loopback redirect addresses (BrowserStack's registration is one) is
connected with `oauth.callback: "loopback"` and the Wardby CLI instead of the sign-in link. See the help article
`oauth-loopback-connect`.

## Refresh, reauth and reconnecting

Wardby refreshes the token when the secret is used within 60 seconds of its expiry (or after it), not in the background, and retries once on a 401. A refresh that cannot reach the provider
or gets an unusable answer changes nothing; try again
([`secret_oauth_refresh_unavailable`](errors/secret-oauth-refresh-unavailable.md),
[`secret_oauth_refresh_failed`](errors/secret-oauth-refresh-failed.md)). When the provider refuses the refresh
token or client, or (0.9.12 and later) the service refuses an access token that has no refresh token with an
attributable 401 (see `rejected` below), the secret's `status` in `list_secrets` becomes `reauth_required` (with a `reauthReason`) and
uses fail with [`secret_reauth_required`](errors/secret-reauth-required.md). To reconnect, repeat the connect
steps under the **same name**; attachments and MCP servers keep working. `list_secrets` shows `status`
(`connected` or `reauth_required`) and never a token.

From 0.9.12, uses of one secret that need a refresh at the same time on one Wardby server share a single refresh.
A call that is stopped (its run stopped, or its MCP call timed out) stops waiting at once: a tool's brokered
`fetch` fails with `secret_oauth_refresh_unavailable`, and an MCP tool call stopped while its secrets load fails
with `mcp_call_timeout` ("The call was stopped."). A refresh no call still waits for is cancelled if it has not
yet contacted the provider, leaving the secret unchanged (the server log records the reason `aborted`); a refresh
already sent completes and is saved. If the provider issued new tokens but Wardby could not store them, the log
records `rotated_unsaved`, and the secret may need connecting again.

The `reauthReason` is `invalid_grant`, `invalid_client`, `expired` or (0.9.12 and later) `rejected`. A secret
with no refresh token is marked `rejected` only when the request carried that one OAuth secret and the service
answered 401 with `WWW-Authenticate: Bearer` and `error="invalid_token"`. Any other 401 (no such header, another
error, or a request that carried several OAuth secrets) leaves the secret connected and returns the 401 to the
call. A secret with a refresh token is refreshed once and the request retried once on any 401.

## Delete and revocation

`delete_secret` disconnects the secret. Wardby first revokes the tokens at the provider when it has a
revocation endpoint (best effort: a failure does not stop the delete), and the disconnect is audited. A secret
still used by an MCP server or host provider is not deleted until you update or delete them.

## Guards

- The value and broker of an OAuth secret cannot be set by hand; `set_secret_broker` and similar changes fail
  with [`secret_oauth_managed`](errors/secret-oauth-managed.md). Connect again instead.
- A name already used by an ordinary secret fails with
  [`secret_oauth_name_taken`](errors/secret-oauth-name-taken.md).
- A provider without usable OAuth metadata fails with
  [`secret_oauth_discovery_failed`](errors/secret-oauth-discovery-failed.md).
- If the provider cannot be reached while you connect, you get
  [`secret_oauth_provider_unavailable`](errors/secret-oauth-provider-unavailable.md); try again.
- A resource that is not an https URL with a host name fails with `secret_oauth_resource_invalid`, and an over-long name, scope or client id with `secret_oauth_input_too_long` (0.9.12 and later; see the secrets guide). Send `confirmationCode` on its own with the name; combining it with `value`, `broker` or `oauth` is refused.
- If tokens cannot be encrypted or decrypted you get
  [`secret_oauth_encryption_failed`](errors/secret-oauth-encryption-failed.md); check the secret key.

## What a grantee sees

Everyone an MCP server or agent is shared with uses the same service identity, with the owner's credentials, so
share it as carefully as the signed-in user's access. If the owner's OAuth secret needs reconnecting, or its
credentials otherwise cannot be used, a user the server is shared with sees only "The MCP server's credentials
can't be used; ask its owner to check it." They never see the secret name or `secret_reauth_required`; only the
owner sees the specific error and can reconnect. If the refresh only failed for now (the provider could not be
reached, or another request held the secret too long), they see "The MCP server's credentials could not be
refreshed just now; try again shortly." instead (0.9.12 and later); retry later.

## Example: BrowserStack's MCP server

1. `create_secret { name: "browserstack", oauth: { resource: "https://mcp.browserstack.com/mcp" } }`, open the
   link, sign in as a service user, and copy the code.
2. `create_secret { name: "browserstack", confirmationCode }`.
3. `register_mcp_server` with that URL and `secretNames: ["browserstack"]`, then `attach_mcp_server` with an
   allowlist of tools, as in [Remote MCP servers](mcp-servers.md).
4. If calls later fail with `secret_reauth_required`, connect the secret again under the same name.

## Related

- [Brokered secrets](brokered-secrets.md) and [Remote MCP servers](mcp-servers.md)
- Full guide: [`docs/tool-secrets.md`](../docs/tool-secrets.md)
- Errors: [`secret_reauth_required`](errors/secret-reauth-required.md),
  [`secret_oauth_discovery_failed`](errors/secret-oauth-discovery-failed.md),
  [`secret_oauth_managed`](errors/secret-oauth-managed.md),
  [`secret_oauth_name_taken`](errors/secret-oauth-name-taken.md),
  [`secret_oauth_client_id_required`](errors/secret-oauth-client-id-required.md),
  [`secret_oauth_encryption_failed`](errors/secret-oauth-encryption-failed.md),
  [`secret_oauth_provider_unavailable`](errors/secret-oauth-provider-unavailable.md),
  [`secret_oauth_refresh_unavailable`](errors/secret-oauth-refresh-unavailable.md),
  [`secret_oauth_refresh_failed`](errors/secret-oauth-refresh-failed.md)
