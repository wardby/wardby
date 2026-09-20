#!/usr/bin/env bash
#
# Provision a throwaway Keycloak realm that issues tokens reevo's delegating
# AuthProvider (AUTH_PROVIDER=delegating) accepts. Destroys and recreates the
# realm on every run, so it is safe to re-run while iterating.
#
#   docker compose -f deploy/keycloak-test/docker-compose.yml up -d
#   ./deploy/keycloak-test/setup-realm.sh
#
# Creates two clients, because the two things worth testing need different ones:
#   - a confidential client with a service account, for scripted
#     client_credentials token fetches (curl, CI)
#   - a public PKCE client, for a real MCP client (Claude Code) driving the
#     browser flow with a pre-registered --client-id
#
# Note on style: every JSON body is built with printf into a variable and only
# then passed to curl. Inlining JSON at the call site invites bash to strip the
# quotes and brace-expand `{"a":1,"b":2}` on the comma into two arguments.
set -euo pipefail

KC=${KC:-http://localhost:8081}
REALM=${REALM:-reevo}
M2M_CLIENT=${M2M_CLIENT:-reevo-mcp-client}
M2M_SECRET=${M2M_SECRET:-test-client-secret}
PUB_CLIENT=${PUB_CLIENT:-reevo-mcp-cli}
USERNAME=${USERNAME:-reevo-user}
PASSWORD=${PASSWORD:-reevo-password}
# Must equal reevo's MCP_CANONICAL_URI. Defaults to the trailing-slash form
# because that is what reevo's protected-resource metadata advertises as
# `resource`, and therefore what a spec-compliant client asks the IdP for.
AUDIENCE=${AUDIENCE:-http://127.0.0.1:8099/}
# Every scope reevo lists in SCOPES_SUPPORTED (src/mcp/auth/resource-server.ts).
# All of them must exist in the realm: a spec-compliant client reads
# scopes_supported from the protected-resource metadata and asks for the lot,
# and Keycloak rejects the whole authorization request with invalid_scope if
# even one is unknown.
ALL_SCOPES=${ALL_SCOPES:-"agents:read agents:write tools:write runs:trigger datastore:write secrets:write webhooks:write budget_groups:write agents:admin"}
# Deliberately narrower for the machine client, so scope enforcement stays
# observable: a token with these may call list_agents but not create_secret.
M2M_SCOPES=${M2M_SCOPES:-"agents:read agents:write runs:trigger"}

need() { command -v "$1" >/dev/null || { echo "missing required command: $1" >&2; exit 1; }; }
need curl; need python3

echo "==> waiting for Keycloak at $KC"
for _ in $(seq 1 60); do
  curl -sf "$KC/realms/master" >/dev/null 2>&1 && break
  sleep 2
done
curl -sf "$KC/realms/master" >/dev/null 2>&1 || {
  echo "Keycloak did not become ready. Is the compose stack up?" >&2; exit 1; }

echo "==> admin token ($KC)"
TOKEN=$(curl -sS -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d client_id=admin-cli -d username=admin -d password=admin -d grant_type=password \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

api() { # api METHOD PATH [BODY]
  local method=$1 path=$2 body=${3-}
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$KC/admin/realms$path" "${AUTH[@]}" \
      --data-binary "$body" -o /dev/null -w "%{http_code}"
  else
    curl -sS -X "$method" "$KC/admin/realms$path" "${AUTH[@]}" -o /dev/null -w "%{http_code}"
  fi
}
client_uuid() {
  curl -sS "$KC/admin/realms/$REALM/clients?clientId=$1" -H "Authorization: Bearer $TOKEN" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if d else "")'
}
scope_id() {
  curl -sS "$KC/admin/realms/$REALM/client-scopes" -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import sys,json;print(next((c['id'] for c in json.load(sys.stdin) if c['name']=='$1'),''))"
}

echo "==> realm $REALM (recreated)"
curl -sS -X DELETE "$KC/admin/realms/$REALM" -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
body=$(printf '{"realm":"%s","enabled":true}' "$REALM")
code=$(api POST "" "$body")
echo "    create: HTTP $code"

echo "==> client scopes"
# reevo authorizes per-tool on the token's `scope` claim, so each reevo scope
# must exist as a client scope and be included in the token.
for s in $ALL_SCOPES; do
  body=$(printf '{"name":"%s","protocol":"openid-connect","attributes":{"include.in.token.scope":"true","display.on.consent.screen":"false"}}' "$s")
  code=$(api POST "/$REALM/client-scopes" "$body")
  echo "    $s: HTTP $code"
done

configure_client() { # configure_client UUID LABEL SCOPES
  local uuid=$1 label=$2 scopes=$3 body code sid
  # Keycloak's default audience is the client itself; reevo requires the
  # resource it protects, so map it explicitly.
  body=$(printf '{"name":"reevo-audience","protocol":"openid-connect","protocolMapper":"oidc-audience-mapper","config":{"included.custom.audience":"%s","access.token.claim":"true","id.token.claim":"false"}}' "$AUDIENCE")
  code=$(api POST "/$REALM/clients/$uuid/protocol-mappers/models" "$body")
  echo "    $label audience -> $AUDIENCE: HTTP $code"
  for s in $scopes; do
    sid=$(scope_id "$s")
    api PUT "/$REALM/clients/$uuid/default-client-scopes/$sid" >/dev/null
  done
  echo "    $label default scopes: $scopes"
}

echo "==> confidential client $M2M_CLIENT (service account)"
body=$(printf '{"clientId":"%s","enabled":true,"publicClient":false,"secret":"%s","serviceAccountsEnabled":true,"standardFlowEnabled":false,"directAccessGrantsEnabled":false,"attributes":{"access.token.lifespan":"28800"}}' "$M2M_CLIENT" "$M2M_SECRET")
code=$(api POST "/$REALM/clients" "$body")
echo "    create: HTTP $code"
configure_client "$(client_uuid "$M2M_CLIENT")" "$M2M_CLIENT" "$M2M_SCOPES"

echo "==> public client $PUB_CLIENT (PKCE S256, no secret)"
# Public + PKCE rather than a secret: a client_secret sitting in every user's
# local MCP config is not meaningfully secret, and OAuth 2.1 recommends
# public+PKCE for native/CLI clients. Pre-registered on purpose — most IdPs
# disable anonymous dynamic client registration, so clients pass --client-id.
body=$(printf '{"clientId":"%s","enabled":true,"publicClient":true,"standardFlowEnabled":true,"serviceAccountsEnabled":false,"directAccessGrantsEnabled":false,"redirectUris":["http://localhost:*","http://127.0.0.1:*"],"webOrigins":["+"],"attributes":{"pkce.code.challenge.method":"S256","access.token.lifespan":"3600"}}' "$PUB_CLIENT")
code=$(api POST "/$REALM/clients" "$body")
echo "    create: HTTP $code"
configure_client "$(client_uuid "$PUB_CLIENT")" "$PUB_CLIENT" "$ALL_SCOPES"

echo "==> user $USERNAME"
body=$(printf '{"username":"%s","enabled":true,"emailVerified":true,"email":"%s@example.com","firstName":"Reevo","lastName":"Tester","requiredActions":[],"credentials":[{"type":"password","value":"%s","temporary":false}]}' "$USERNAME" "$USERNAME" "$PASSWORD")
code=$(api POST "/$REALM/users" "$body")
echo "    create: HTTP $code"

cat <<EOF

Realm ready. Point reevo at it with:

  AUTH_PROVIDER=delegating
  AUTH_ISSUER=$KC/realms/$REALM
  AUTH_JWKS_URI=$KC/realms/$REALM/protocol/openid-connect/certs
  AUTH_AUDIENCE=${AUDIENCE%/}
  MCP_CANONICAL_URI=${AUDIENCE%/}

Machine token (no browser):

  curl -s -X POST $KC/realms/$REALM/protocol/openid-connect/token \\
    -d client_id=$M2M_CLIENT -d client_secret=$M2M_SECRET \\
    -d grant_type=client_credentials | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'

Real MCP client (browser, pre-registered client id):

  claude mcp add --transport http reevo-idp ${AUDIENCE%/}/mcp \\
    --client-id $PUB_CLIENT --callback-port 8765
  # then /mcp -> Authenticate, and log in as $USERNAME / $PASSWORD
EOF
