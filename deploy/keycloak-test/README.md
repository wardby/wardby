# Keycloak test harness (delegating auth)

A throwaway OIDC provider for exercising `AUTH_PROVIDER=delegating` — the mode
where reevo is **only** a resource server and an external IdP issues the
tokens. Local-only: dev-mode Keycloak, in-memory storage, HTTP, hardcoded
`admin/admin`. Never point anything real at it.

The built-in `self-hosted` auth mode needs none of this; it is reevo's own
bootstrap/demo authorization server. This harness exists because most
deployments bring their own IdP, and that path is otherwise only covered by
unit tests with a hand-minted JWKS.

## Run it

```bash
docker compose -f deploy/keycloak-test/docker-compose.yml up -d
./deploy/keycloak-test/setup-realm.sh          # prints the env + commands to use
```

Then start reevo against it (the script prints these values):

```bash
DATABASE_URL="postgresql://reevo:reevo@localhost:55432/reevo" \
MCP_TRANSPORT=http MCP_HTTP_BIND=127.0.0.1:8099 \
MCP_CANONICAL_URI=http://127.0.0.1:8099 \
AUTH_PROVIDER=delegating \
AUTH_ISSUER=http://localhost:8081/realms/reevo \
AUTH_JWKS_URI=http://localhost:8081/realms/reevo/protocol/openid-connect/certs \
AUTH_AUDIENCE=http://127.0.0.1:8099 \
npm run cli -- mcp
```

Tear down with `docker compose -f deploy/keycloak-test/docker-compose.yml down`.

## What it sets up, and why

| Object                            | Why it exists                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Realm `reevo`                     | Isolation; recreated on every `setup-realm.sh` run                                                                       |
| Client scopes (`agents:read`, …)  | reevo authorizes per-tool off the token's `scope` claim, so its scopes must exist in the IdP and be emitted in the token |
| Audience mapper                   | Keycloak's default `aud` is the client itself; reevo requires the resource it protects                                   |
| `reevo-mcp-client` (confidential) | `client_credentials` tokens for scripted/curl testing                                                                    |
| `reevo-mcp-cli` (public, PKCE)    | A real MCP client driving the browser flow with a **pre-registered** client id                                           |
| User `reevo-user`                 | Someone to log in as in the browser flow                                                                                 |

## Things this harness exists to keep us honest about

**The audience must match what the metadata advertises.** reevo's
protected-resource metadata reports `resource` in normalized form — with a
trailing slash for an origin (`https://host/`). A spec-compliant client asks
its IdP for exactly that, so the IdP mints `aud` with the slash, while an
operator configuring `AUTH_AUDIENCE` by hand usually omits it. `aud` is an
exact string match, so these disagreed and every real token was rejected with
an opaque `invalid_token` — while startup validation passed, because it
normalizes both sides before comparing. `DelegatingAuthProvider` now accepts
both spellings of an origin; this harness is how that gets verified against a
real IdP rather than a hand-minted token.

**Scopes must be mapped into the token, not just requested.** A token that
authenticates fine will still fail per-tool authorization if the `scope` claim
does not carry reevo's scopes. The harness attaches them as _default_ client
scopes so they are always present; a real deployment may prefer optional
scopes and explicit requests.

**Dynamic client registration is usually disabled.** Keycloak returns `403` for
anonymous DCR out of the box, and enterprise IdPs typically keep it that way on
purpose. MCP clients self-register by default, so the realistic path is an admin
pre-registering one client and users passing it explicitly — `claude mcp add
--client-id …`, with `--callback-port` when the IdP will not accept wildcard
localhost redirect URIs. Nothing in reevo can paper over this; it is a client/IdP
concern, which is exactly why it is written down here.

**No local user provisioning is involved.** In delegating mode `verifyBearer`
never reads the database, and `resolvePrincipal` find-or-creates a `Principal`
row from the token's subject on first use. Users are administered entirely in
the IdP — reevo's `auth user create` CLI and login keys belong to `self-hosted`
mode only.
