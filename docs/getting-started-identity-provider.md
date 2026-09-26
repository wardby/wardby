# Bring your own identity provider

This guide connects a deployed Wardby control plane to an existing OAuth/OIDC
identity provider for remote MCP access. Wardby calls this **delegating mode**:
your provider authenticates users and issues access tokens; Wardby acts only as
the protected resource that verifies those tokens and enforces their scopes.

Use this mode for a shared HTTPS deployment. Local stdio MCP created by
`wardby quickstart` trusts the local operator and does not use OAuth.

## What Wardby requires

Your provider must issue signed JWT access tokens with:

- `iss` exactly equal to the configured issuer;
- `aud` equal to Wardby's canonical MCP URI;
- a stable, nonblank `sub` identifying the user or workload;
- a future `exp` expiration; and
- Wardby permissions in either the `scope` or `scp` claim.

The signing key must be published at an HTTPS JWKS endpoint reachable from the
Wardby control plane. `email` and `roles` are retained when present, but tool
authorization is based on scopes, not those optional claims.

Wardby does not call the provider's user-info endpoint, exchange authorization
codes, refresh tokens, or administer users in delegating mode. The MCP client
performs the provider's authorization flow and sends the resulting bearer
access token to Wardby.

## 1. Choose the canonical resource

Use the final public HTTPS MCP URL as the resource identifier. For example:

```text
https://wardby.example.com/mcp
```

Use that exact value for all three of these:

- the IdP API, resource, or audience identifier;
- `MCP_CANONICAL_URI`; and
- `AUTH_AUDIENCE`.

Wardby refuses to start when the two environment values are not the same
normalized URL. A trailing slash on a non-root path is significant, so prefer
copying the canonical URI exactly rather than typing it separately in each
system.

## 2. Register Wardby as an API or resource

Create an API, resource server, or equivalent object in the identity provider.
Set its audience or identifier to the canonical URI and configure signed JWT
access tokens for that audience.

Create these scopes in the provider:

| Scope                 | Capability                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `agents:read`         | Inspect agents, models, runs, memory, and attached resources.     |
| `agents:write`        | Create and modify agents, schedules, and sub-agent relationships. |
| `runs:trigger`        | Start agent runs.                                                 |
| `tools:write`         | Create, attach, and manage tools.                                 |
| `datastore:write`     | Create, attach, query, and modify datastores.                     |
| `secrets:write`       | Create, attach, rotate, and remove secret bindings.               |
| `webhooks:write`      | Create and manage webhook triggers.                               |
| `budget_groups:write` | Create and manage shared budget groups.                           |
| `packages:approve`    | Approve coding agents' package allowlists.                        |
| `agents:admin`        | Reassign agent ownership; reserve for administrators.             |

MCP clients discover this list from Wardby's protected-resource metadata and
may request every advertised scope. Define all ten in the provider even when
policy grants a particular client or user only a subset. Ensure granted scopes
are emitted in the access token's `scope` or `scp` claim; defining them only in
the provider UI is not sufficient.

## 3. Register an MCP client

Most enterprise providers disable anonymous dynamic client registration. In
that case, register the MCP client manually as a **public/native application**:

- require authorization code flow with PKCE S256;
- do not issue or embed a client secret in a desktop client;
- register the client's exact loopback callback URI; and
- allow it to request the Wardby audience and scopes.

For Claude Code, a fixed callback port makes the redirect URI predictable:

```sh
claude mcp add --transport http wardby https://wardby.example.com/mcp \
  --client-id YOUR_PUBLIC_CLIENT_ID \
  --callback-port 8765
```

Register the callback URI shown by the client for port `8765` in the identity
provider. Other MCP clients need an equivalent way to supply a pre-registered
public client ID. If a client supports only dynamic registration, either enable
that feature with suitable provider-side restrictions or use Wardby's
self-hosted authentication mode.

## 4. Configure Wardby

Inject these settings through the deployment's secret/configuration mechanism:

```dotenv
MCP_TRANSPORT=http
MCP_HTTP_BIND=0.0.0.0:8080
MCP_CANONICAL_URI=https://wardby.example.com/mcp

AUTH_PROVIDER=delegating
AUTH_ISSUER=https://identity.example.com/your-tenant/
AUTH_JWKS_URI=https://identity.example.com/your-tenant/.well-known/jwks.json
AUTH_AUDIENCE=https://wardby.example.com/mcp
```

Copy `AUTH_ISSUER` exactly from the token's `iss` claim or the provider's
metadata. Copy `AUTH_JWKS_URI` from the provider's metadata rather than
guessing its path. Keep the application port private behind the TLS-terminating
proxy or load balancer; only the public HTTPS hostname should be reachable by
MCP clients.

`AUTH_SIGNING_KEY`, `AUTH_CREDENTIAL_HASH_KEY`, local login keys, and
`wardby auth user` commands belong to self-hosted mode and are not used here.
`SECRET_APP_KEY` remains required because it encrypts Wardby's stored
application secrets.

For the portable container deployment, place these values in the protected
production environment described by
[the production boundary](../deploy/production/README.md). The GKE deployment
helper uses self-hosted authentication by default; replace the control-plane
secret's auth settings with the delegated values before rollout and preserve
that customization in your deployment automation so a later `up.sh` does not
restore self-hosted mode.

## 5. Verify discovery

After deploying, request Wardby's protected-resource metadata:

```sh
curl --fail --silent --show-error \
  https://wardby.example.com/.well-known/oauth-protected-resource/mcp | jq
```

Confirm that:

- `resource` is the canonical MCP URI;
- `authorization_servers` contains the external issuer; and
- `scopes_supported` contains all ten Wardby scopes.

An unauthenticated MCP request must return `401` with a `WWW-Authenticate`
challenge pointing back to that metadata document.

## 6. Verify a provider token

Obtain an access token through the registered MCP client or your provider's
approved test flow. Inspect its claims locally; do not paste a production token
into a third-party JWT debugger:

```sh
TOKEN='REPLACE_WITH_SHORT_LIVED_TEST_TOKEN' node -e '
const token = process.env.TOKEN;
const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
console.log(JSON.stringify({
  iss: payload.iss,
  aud: payload.aud,
  sub: payload.sub,
  exp: payload.exp,
  scope: payload.scope ?? payload.scp
}, null, 2));
'
```

Check that the issuer and audience match the configured values and that the
token carries the scopes needed by the requested Wardby operation. Then connect
the MCP client and list agents. Wardby creates a local `Principal` for the
validated `sub` on first use; users remain managed entirely in the external
provider.

## 7. Rehearse locally with Keycloak

Before changing a production provider, exercise the complete delegated flow
with the repository's disposable Keycloak harness:

```sh
docker compose -f deploy/keycloak-test/docker-compose.yml up -d
./deploy/keycloak-test/setup-realm.sh
```

The script recreates a local realm, API audience, all Wardby scopes, a machine
client, and a public PKCE client, then prints the exact environment and Claude
Code command to use. It uses development HTTP and hardcoded credentials; never
expose it or reuse it for production. See
[the harness documentation](../deploy/keycloak-test/README.md) for the full
test procedure and cleanup.

## Troubleshooting

| Symptom                                       | Most likely cause                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| Authorization fails with `invalid_scope`      | One or more advertised Wardby scopes do not exist in the provider.                   |
| Wardby returns `401 Invalid token`            | Wrong issuer/audience, expired token, missing `sub`, unknown key, or bad signature.  |
| Wardby returns `403 insufficient_scope`       | The token is valid but `scope`/`scp` lacks the operation's required permission.      |
| Client registration returns `403`             | Anonymous dynamic registration is disabled; pre-register a public client.            |
| Browser flow rejects the redirect             | The provider's registered loopback callback does not exactly match the client.       |
| Wardby cannot validate any newly issued token | The control plane cannot reach the JWKS URI, or provider key rotation is incomplete. |
| One person appears as multiple principals     | The provider is emitting different or pairwise `sub` values for different clients.   |

Keep JWKS access on the deployment egress allowlist, use short-lived access
tokens, grant `agents:admin` only to trusted administrators, and monitor
authentication failures without logging bearer tokens. Review the broader
[security deployment guide](security-deployment.md) before production use.
