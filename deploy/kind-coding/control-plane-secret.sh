#!/usr/bin/env bash
#
# Creates (or updates) the wardby-control-plane-env Secret the in-cluster
# control plane reads, from the operator's own .env.local plus the database URL
# the proxy is already using.
#
#   KUBE_CONTEXT=<context> deploy/kind-coding/control-plane-secret.sh
#
# No secret value is ever passed as a command-line argument: the Secret manifest
# is assembled with printf and piped into `kubectl apply -f -`, so nothing lands
# in any process's argv (the same reason up.sh stopped using --from-literal).
# Nothing is echoed either; the script prints only which keys it set.
#
# Contains no project, cluster, region or registry identity — every such value
# comes from the environment or from the cluster it is pointed at.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -z "${KUBE_CONTEXT:-}" ]]; then
  echo "control-plane-secret.sh: set KUBE_CONTEXT to the target cluster's kubectl context." >&2
  exit 1
fi

NAMESPACE="${NAMESPACE:-wardby-coding}"

# Reads one key out of .env.local and base64-encodes it, using the project's own
# dotenv-flow loader rather than grep.
#
# up.sh's line-oriented extractor is NOT good enough here, and this is not
# hypothetical: GITHUB_APP_PRIVATE_KEY is a quoted, genuinely multi-line PEM, so
# a grep for its line captures the BEGIN header and nothing else. That produced a
# Secret the server accepted at startup and then rejected on the first coding
# run — `github_app_private_key_invalid`, a scheduled run refused in 82 ms.
# Parsing dotenv with a regex is the bug; using the same parser the application
# uses is the fix, and it covers every future multi-line value too.
#
# The value goes straight from node's stdout into a shell variable: never an
# argument, never echoed. Only the key's NAME is ever passed on a command line.
env_b64() {
  node -e '
    const name = process.argv[1];
    require("dotenv-flow").config({ silent: true });
    const value = process.env[name];
    if (!value) {
      console.error(`control-plane-secret.sh: ${name} must be set in .env.local.`);
      process.exit(1);
    }
    process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
  ' "$1"
}

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

# The database URL is taken from the proxy's Secret rather than from .env.local:
# the proxy already resolves the database by its in-cluster Service name, which
# is exactly what the control plane needs and is NOT what an operator's
# .env.local says (that points at a port-forward or a local Postgres).
DATABASE_URL_B64="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  get secret wardby-coding-proxy-env -o jsonpath='{.data.DATABASE_URL}')"
if [[ -z "$DATABASE_URL_B64" ]]; then
  echo "control-plane-secret.sh: wardby-coding-proxy-env has no DATABASE_URL; apply the overlay first." >&2
  exit 1
fi

# The OAuth keys are generated once and then preserved across re-runs: rotating
# the signing key would invalidate every token already issued to a registered
# client. They are independent by construction — SelfHostedAuthProvider refuses
# to start if they are equal.
existing_auth_key() {
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get secret wardby-control-plane-env \
    -o jsonpath="{.data.$1}" 2>/dev/null || true
}
AUTH_SIGNING_KEY_B64="$(existing_auth_key AUTH_SIGNING_KEY)"
AUTH_CREDENTIAL_HASH_KEY_B64="$(existing_auth_key AUTH_CREDENTIAL_HASH_KEY)"
if [[ -z "$AUTH_SIGNING_KEY_B64" ]]; then
  AUTH_SIGNING_KEY_B64="$(b64 "$(openssl rand -hex 32)")"
  AUTH_CREDENTIAL_HASH_KEY_B64="$(b64 "$(openssl rand -hex 32)")"
  echo "==> generated a new AUTH_SIGNING_KEY and AUTH_CREDENTIAL_HASH_KEY"
fi

# SECRET_APP_KEY must be the operator's existing key, not a fresh one: it
# decrypts the credentials already stored in this database. A new key would
# leave every stored secret unreadable, which surfaces much later as a failing
# run rather than as a startup error.
SECRET_APP_KEY_B64="$(env_b64 SECRET_APP_KEY)"
OPENAI_API_KEY_B64="$(env_b64 OPENAI_API_KEY)"
ANTHROPIC_API_KEY_B64="$(env_b64 ANTHROPIC_API_KEY)"
GITHUB_APP_ID_B64="$(env_b64 GITHUB_APP_ID)"
GITHUB_APP_PRIVATE_KEY_B64="$(env_b64 GITHUB_APP_PRIVATE_KEY)"

{
  printf 'apiVersion: v1\n'
  printf 'kind: Secret\n'
  printf 'type: Opaque\n'
  printf 'metadata:\n'
  printf '  name: wardby-control-plane-env\n'
  printf '  namespace: %s\n' "$NAMESPACE"
  printf 'data:\n'
  printf '  DATABASE_URL: %s\n' "$DATABASE_URL_B64"
  printf '  SECRET_APP_KEY: %s\n' "$SECRET_APP_KEY_B64"
  printf '  OPENAI_API_KEY: %s\n' "$OPENAI_API_KEY_B64"
  printf '  ANTHROPIC_API_KEY: %s\n' "$ANTHROPIC_API_KEY_B64"
  printf '  GITHUB_APP_ID: %s\n' "$GITHUB_APP_ID_B64"
  printf '  GITHUB_APP_PRIVATE_KEY: %s\n' "$GITHUB_APP_PRIVATE_KEY_B64"
  printf '  AUTH_PROVIDER: %s\n' "$(b64 self-hosted)"
  printf '  AUTH_SIGNING_KEY: %s\n' "$AUTH_SIGNING_KEY_B64"
  printf '  AUTH_CREDENTIAL_HASH_KEY: %s\n' "$AUTH_CREDENTIAL_HASH_KEY_B64"
} | kubectl --context "$KUBE_CONTEXT" apply -f -

unset DATABASE_URL_B64 SECRET_APP_KEY_B64 OPENAI_API_KEY_B64 ANTHROPIC_API_KEY_B64 \
  GITHUB_APP_ID_B64 GITHUB_APP_PRIVATE_KEY_B64 AUTH_SIGNING_KEY_B64 AUTH_CREDENTIAL_HASH_KEY_B64

echo "==> wardby-control-plane-env applied to ${NAMESPACE}"
